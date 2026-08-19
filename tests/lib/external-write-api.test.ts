/**
 * B2-08 — external write protocol module tests (issue #31).
 *
 * Unit surface of lib/external-write-api: protocol negotiation, client-type
 * classification, authority gate, privacy-safe legacy telemetry, legacy /
 * versioned snapshot coercion (draft-only + upgrade signal semantics) and
 * versioned action dispatch over a mocked kernel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  save: vi.fn(),
  publishTemp: vi.fn(),
}))

vi.mock('@/lib/article-commands', () => ({
  create: mocks.create,
  save: mocks.save,
  publishTemp: mocks.publishTemp,
}))

import {
  coerceLegacySnapshot,
  coerceVersionedSnapshot,
  dispatchExternalWrite,
  isExternalWriteAuthoritySwitched,
  isVersionedProtocol,
  readLegacyTelemetry,
  recordLegacyWrite,
  resolveArticleBySlug,
  resolveClientType,
} from '@/lib/external-write-api'

/* In-memory fake D1 for telemetry / authority-gate reads. */
function fakeDb(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial))
  return {
    rows,
    db: {
      prepare: () => {
        const stmt = {
          bind: (...values: unknown[]) => ({
            first: async () => {
              const hit = rows.get(String(values[0]))
              return hit === undefined ? null : { value: hit }
            },
            run: async () => {
              rows.set(String(values[0]), String(values[1] ?? ''))
              return { meta: { last_row_id: 1 } }
            },
          }),
          first: async () => null,
          run: async () => ({ meta: { last_row_id: 1 } }),
          all: async () => ({ results: [] }),
        }
        return stmt
      },
    } as never,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ outcome: 'created', articleId: 1, postRef: 10, version: 1, operationId: 'create:abc', existing: false, projectionFailures: [] })
  mocks.save.mockResolvedValue({ outcome: 'applied', articleId: 1, postRef: 10, version: 2, operationId: 'op', existing: false, projectionFailures: [] })
  mocks.publishTemp.mockResolvedValue({ outcome: 'applied', articleId: 1, postRef: 10, version: 2, operationId: 'op', existing: false, projectionFailures: [] })
})

describe('protocol negotiation', () => {
  it('recognizes the versioned protocol marker', () => {
    expect(isVersionedProtocol({ protocol: 'v1' })).toBe(true)
    expect(isVersionedProtocol({ protocol: 'v2' })).toBe(false)
    expect(isVersionedProtocol({})).toBe(false)
  })

  it('classifies client types from header, then user-agent', () => {
    expect(resolveClientType({ headers: { get: () => 'obsidian' } })).toBe('obsidian')
    expect(resolveClientType({ headers: { get: (n: string) => (n === 'user-agent' ? 'Obsidian/x.y' : null) } })).toBe('obsidian')
    expect(resolveClientType({ headers: { get: (n: string) => (n === 'user-agent' ? 'Mozilla/5.0 Chrome/120' : null) } })).toBe('chrome')
    expect(resolveClientType({ headers: { get: (n: string) => (n === 'user-agent' ? 'curl/8.0' : null) } })).toBe('cli')
    expect(resolveClientType({ headers: { get: (n: string) => (n === 'user-agent' ? 'node-fetch/2' : null) } })).toBe('agent')
    expect(resolveClientType({ headers: { get: () => null } })).toBe('unknown')
    expect(resolveClientType({})).toBe('unknown')
  })
})

describe('authority gate', () => {
  it('is off unless the versioned value is stored', async () => {
    expect(await isExternalWriteAuthoritySwitched(fakeDb({}).db)).toBe(false)
    expect(await isExternalWriteAuthoritySwitched(fakeDb({ external_write_authority: 'other' }).db)).toBe(false)
    expect(await isExternalWriteAuthoritySwitched(fakeDb({ external_write_authority: 'versioned' }).db)).toBe(true)
  })
})

describe('legacy telemetry (client type / operation / time only)', () => {
  it('records and accumulates daily per-client operation counters; never content', async () => {
    const { db, rows } = fakeDb({})
    await recordLegacyWrite(db, { clientType: 'obsidian', operation: 'create', at: 1700000000 })
    await recordLegacyWrite(db, { clientType: 'obsidian', operation: 'create', at: 1700000000 })
    await recordLegacyWrite(db, { clientType: 'chrome', operation: 'create', at: 1700000060 })
    await recordLegacyWrite(db, { clientType: 'obsidian', operation: 'update', at: 1700000120 })

    const telemetry = await readLegacyTelemetry(db)
    const day = '2023-11-14' // 2023-11-14T21:34:00Z / 1700000000
    expect(telemetry.total).toBe(4)
    expect(telemetry.daily[day].obsidian.create).toBe(2)
    expect(telemetry.daily[day].obsidian.update).toBe(1)
    expect(telemetry.daily[day].chrome.create).toBe(1)

    // The stored blob is strictly structured fields — no freeform content.
    const raw = rows.get('legacy_external_write_telemetry') as string
    expect(raw).toContain('"obsidian"')
    expect(raw).not.toContain('标题')
    expect(raw).not.toContain('正文')
  })

  it('recovers from a corrupted blob without losing the ability to record', async () => {
    const { db } = fakeDb({ legacy_external_write_telemetry: '{not-json' })
    await recordLegacyWrite(db, { clientType: 'agent', operation: 'create', at: 1700000000 })
    const telemetry = await readLegacyTelemetry(db)
    expect(telemetry.total).toBe(1)
  })
})

describe('snapshot coercion', () => {
  it('legacy payload is always coerced to a draft snapshot (published requested ignored)', async () => {
    const { snapshot, autoSlug } = await coerceLegacySnapshot({
      title: '  标题  ',
      content: '---\nexcerpt: 摘要\n---\n\n# 正文',
      status: 'published',
      category: '  AI  ',
    })
    expect(autoSlug).toBe(true)
    expect(snapshot.slug).toBe('')
    expect(snapshot.title).toBe('标题')
    expect(snapshot.content).toBe('# 正文')
    expect(snapshot.status).toBe('draft')
    expect(snapshot.description).toBe('摘要')
    expect(snapshot.category).toBe('AI')
    expect(snapshot.html).toContain('<h1>正文</h1>')
  })

  it('versioned snapshot is coerced to draft and renders html from markdown when absent', async () => {
    const { snapshot, autoSlug } = await coerceVersionedSnapshot({
      slug: 'My Slug!',
      title: '版本化标题',
      content: '## 小节',
      status: 'published',
      tags: ['甲', '', '乙'],
    })
    expect(autoSlug).toBe(false)
    expect(snapshot.slug).toBe('myslug')
    expect(snapshot.status).toBe('draft')
    expect(snapshot.tags).toEqual(['甲', '乙'])
    expect(snapshot.html).toContain('<h2>小节</h2>')
  })
})

describe('versioned dispatch over the kernel (mock)', () => {
  it('create passes the creationId + draft snapshot to the kernel', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'create', {
      creationId: 'obsidian:note-1',
      snapshot: { title: 'T', content: 'C', category: 'AI' },
    })
    expect(mocks.create).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ creationId: 'obsidian:note-1' }),
    )
    const input = mocks.create.mock.calls[0][1].snapshot as { status: string; title: string }
    expect(input.status).toBe('draft')
    expect(input.title).toBe('T')
    expect(result).toMatchObject({ outcome: 'created', articleId: 1 })
  })

  it('create requires a creationId (identity) and rejects blank ones', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'create', { creationId: '  ', snapshot: {} })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 400 })
  })

  it('save requires articleId / expectedVersion / operationId and dispatches the full snapshot', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'save', {
      articleId: '7',
      expectedVersion: '1',
      operationId: 'op-save-1',
      snapshot: { slug: 's', title: 'T', content: 'C' },
    })
    expect(mocks.save).toHaveBeenCalledWith(db, expect.objectContaining({
      articleId: 7,
      expectedVersion: 1,
      operationId: 'op-save-1',
    }))
    expect(result).toMatchObject({ outcome: 'applied', version: 2 })
  })

  it('publishTemp dispatches the version + status preconditions', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    await dispatchExternalWrite(db, 'publishTemp', {
      articleId: '7',
      expectedVersion: '1',
      currentStatus: 'draft',
      operationId: 'op-pub-1',
      status: 'published',
    })
    expect(mocks.publishTemp).toHaveBeenCalledWith(db, expect.objectContaining({
      articleId: 7,
      expectedVersion: 1,
      currentStatus: 'draft',
      operationId: 'op-pub-1',
      status: 'published',
    }))
  })

  it('unknown action is a 400 without touching the kernel', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'explode', {})
    expect(result).toMatchObject({ status: 400 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('article resolution', () => {
  it('returns null when the slug has no identity/version', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.includes('FROM posts')) return null
            return null
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as never
    expect(await resolveArticleBySlug(db, 'missing')).toBeNull()
  })
})