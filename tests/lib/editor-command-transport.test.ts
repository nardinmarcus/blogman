/**
 * B2-05 — shared editor command transport tests (issue #28).
 *
 * Proves the INLINE editor's save path now goes through the same versioned
 * command transport as the main editor — never a direct `posts` overwrite:
 *
 *   - save carries the FULL authoring snapshot + expectedVersion + a stable
 *     operationId through `/api/article-commands` (action 'save'),
 *   - response-lost retries reuse the SAME operationId so the kernel replays
 *     instead of writing a new version (版本不会膨胀),
 *   - a conflict pauses the coordinator, preserves the local input in the
 *     unconfirmed draft, and is NEVER auto-merged (clear action, not
 *     last-write-wins),
 *   - the transport rejects non-OK responses as a save error.
 *
 * Unit-level: mocked `fetch`, no browser, no wrangler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorSaveCoordinator } from '@/lib/editor-save-coordinator'
import type { CoordinatorState, EditorSnapshotContent } from '@/lib/editor-save-coordinator'
import { createCommandTransport } from '@/lib/editor-command-transport'

const tick = () => new Promise<void>((res) => res())

interface FetchRecord {
  url: string
  body: Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function baseSnapshot(): EditorSnapshotContent {
  return {
    slug: 'inline-slug',
    title: '标题',
    html: '<p>正文</p>',
    content: '正文',
    description: '摘要',
    category: 'AI',
    tags: ['甲', '乙'],
    coverImage: '/cover.webp',
  }
}

interface Harness {
  coordinator: EditorSaveCoordinator
  key: string
  states: CoordinatorState[]
  fetches: FetchRecord[]
  edit: (patch: Partial<EditorSnapshotContent>) => void
}

interface DraftRecord {
  snapshot: { title: string }
  basedVersion: number | null
}

function makeHarness(push: (call: number) => unknown): Harness {
  let current: EditorSnapshotContent = baseSnapshot()

  const map = new Map<string, DraftRecord>()
  const states: CoordinatorState[] = []
  const fetches: FetchRecord[] = []
  let calls = 0

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      fetches.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      return push(calls)
    }),
  )

  const coordinator = new EditorSaveCoordinator({
    articleId: 5,
    version: 1,
    creationId: '',
    getContent: () => ({ ...current }),
    transport: createCommandTransport(),
    draftStore: {
      load: (k) => map.get(k) ?? null,
      save: (k, r) => void map.set(k, r as unknown as DraftRecord),
      remove: (k) => void map.delete(k),
    },
    onStateChange: (s) =>
      states.push({
        ...s,
        applied: { ...s.applied },
        conflict: s.conflict ? { ...s.conflict } : null,
      }),
    debounceMs: 1_500_000, // manual flush — no debounce interference
    maxRetryDelayMs: 10_000,
    newOperationId: () => `op-inline-${calls + 1}`,
    now: () => 1_700_000_000,
  })
  return {
    coordinator,
    key: 'editor-draft:article:5',
    states,
    fetches,
    edit: (patch) => {
      current = { ...current, ...patch }
      coordinator.schedule()
    },
  }
}

describe('EditorSaveCoordinator + createCommandTransport (inline save path)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('inline save goes through /api/article-commands with full snapshot + expected version + operation id', async () => {
    const h = makeHarness(() =>
      jsonResponse({
        outcome: 'applied',
        articleId: 5,
        postRef: 9,
        version: 2,
        operationId: 'op-inline-1',
        existing: false,
        slug: 'inline-slug',
        publishedAt: null,
      }),
    )
    h.coordinator.setInitialConfirmed()
    h.edit({ title: '新标题' })

    const ok = await h.coordinator.flush()
    expect(ok).toBe(true)

    expect(h.fetches).toHaveLength(1)
    const { url, body } = h.fetches[0]
    expect(url).toBe('/api/article-commands')
    expect(body.action).toBe('save')
    expect(body.articleId).toBe(5)
    expect(body.expectedVersion).toBe(1)
    expect(typeof body.operationId).toBe('string')
    const snapshot = body.snapshot as Record<string, unknown>
    expect(snapshot.slug).toBe('inline-slug')
    expect(snapshot.title).toBe('新标题')
    // description/tags preserved from the loaded snapshot — never blanked.
    expect(snapshot.description).toBe('摘要')
    expect(snapshot.tags).toEqual(['甲', '乙'])
  })

  it('response-lost retry reuses the same operation id — never writes an extra version', async () => {
    let attempt = 0
    const h = makeHarness(() => {
      attempt += 1
      if (attempt === 1) throw new Error('network drop')
      return jsonResponse({
        outcome: 'applied',
        articleId: 5,
        postRef: 9,
        version: 2,
        operationId: 'op-inline-2',
        existing: false,
        slug: 'inline-slug',
        publishedAt: null,
      })
    })
    h.coordinator.setInitialConfirmed()
    h.edit({ title: '新标题' })

    const ok = await h.coordinator.flush()
    // First attempt dropped: flush reports a transient error and schedules retry.
    expect(ok).toBe(false)
    expect(h.fetches).toHaveLength(1)
    const firstOp = h.fetches[0].body.operationId

    // Backoff retry fires — it MUST reuse the same operation id (server replays).
    await vi.advanceTimersByTimeAsync(2000)
    await tick()

    expect(h.fetches).toHaveLength(2)
    expect(h.fetches[1].body.operationId).toBe(firstOp)
    expect(h.states.at(-1)?.status).toBe('saved')
  })

  it('a conflict pauses the save, preserves the local input, and is never auto-merged', async () => {
    const h = makeHarness(() =>
      jsonResponse({
        outcome: 'conflict',
        articleId: 5,
        postRef: 9,
        expectedVersion: 1,
        serverVersion: 3,
        facts: { title: '主编辑器新版本', updated_at: 1700000100 },
      }),
    )
    h.coordinator.setInitialConfirmed()
    h.edit({ title: '新标题' })

    const ok = await h.coordinator.flush()
    expect(ok).toBe(false)

    const last = h.states.at(-1)
    expect(last?.status).toBe('conflict')
    expect(last?.conflict?.serverVersion).toBe(3)
    // The inline editor's full snapshot is preserved in the local draft store.
    const draft = (h.coordinator as unknown as { opts: { draftStore: { load: (k: string) => DraftRecord | null } } }).opts.draftStore.load(h.key)
    expect(draft).not.toBeNull()
    expect(draft?.snapshot.title).toBe('新标题')

    // No auto-merge: a further flush must not re-submit on its own.
    h.fetches.length = 0
    const again = await h.coordinator.flush()
    expect(again).toBe(false)
    expect(h.fetches).toHaveLength(0)
  })

  it('a non-OK transport response surfaces as a hard save error (not a false saved)', async () => {
    const h = makeHarness(() => jsonResponse({ error: 'server exploded' }, 500))
    h.coordinator.setInitialConfirmed()
    h.edit({ title: '新标题' })

    const ok = await h.coordinator.flush().catch(() => false)
    expect(ok).toBe(false)
    const last = h.states.at(-1)
    expect(last?.status).toBe('error')
    expect(last?.errorMessage).toBe('server exploded')
  })
})
