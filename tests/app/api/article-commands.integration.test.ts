/**
 * B2-04 — /api/article-commands against the real kernel + shared in-process D1
 * (issue #27).
 *
 * Proves the D1 verification the ticket asks for: repeated save / conflict
 * never inflate the version count, and the conflict "server version" read
 * (GET) returns the current identity + snapshot. Uses the same shared Miniflare
 * adapter as the B2-03 kernel tests — zero wrangler CLI spawns during execution.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'

const mocks = vi.hoisted(() => ({
  getRouteContextWithDb: vi.fn(),
  ensureAuthenticatedRequest: vi.fn(),
  parseJsonBody: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
}))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: mocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: mocks.parseJsonBody,
}))

vi.mock('@/lib/cache', () => ({ invalidatePublicContentCache: mocks.invalidatePublicContentCache }))
vi.mock('@/lib/background-jobs', () => ({ enqueueBackgroundJob: mocks.enqueueBackgroundJob }))

import { GET, POST } from '@/app/api/article-commands/route'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b204-route-'))
  cleanup.push(state)
  await bootstrapState(state)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRouteContextWithDb.mockResolvedValue({
    ok: true,
    env: {},
    db: createDatabase(),
    ctx: { waitUntil: vi.fn() },
  })
  mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
  mocks.invalidatePublicContentCache.mockResolvedValue(undefined)
  mocks.enqueueBackgroundJob.mockResolvedValue(undefined)
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(slug: string, title: string) {
  return { slug, title, content: '正文', html: '<p>正文</p>', status: 'draft' }
}

async function versions(articleId: number): Promise<Array<{ version: number; operation_id: string }>> {
  return query<{ version: number; operation_id: string }>(
    `SELECT version, operation_id FROM article_versions WHERE article_id = ${articleId} ORDER BY version`,
  )
}

describe('app/api/article-commands — real kernel + D1', { timeout: 600_000 }, () => {
  it('create → save → replay → conflict; replay/conflict never inflate versions', async () => {
    const slug = fresh('slug')
    const creationId = fresh('create-id')

    // create (version 1)
    mocks.parseJsonBody.mockResolvedValue({
      action: 'create',
      creationId,
      snapshot: snapshot(slug, '第一版'),
    })
    const created = (await (await POST({} as never)).json()) as {
      outcome: string
      articleId: number
      version: number
      slug?: string
    }
    expect(created.outcome).toBe('created')
    expect(created.version).toBe(1)
    const articleId = created.articleId

    // save to version 2
    mocks.parseJsonBody.mockResolvedValue({
      action: 'save',
      articleId,
      expectedVersion: 1,
      operationId: 'op-1',
      snapshot: snapshot(slug, '第二版'),
    })
    const applied = (await (await POST({} as never)).json()) as { outcome: string; version: number }
    expect(applied.outcome).toBe('applied')
    expect(applied.version).toBe(2)

    // replay the SAME operation id → replayed, no new version
    mocks.parseJsonBody.mockResolvedValue({
      action: 'save',
      articleId,
      expectedVersion: 2,
      operationId: 'op-1',
      snapshot: snapshot(slug, '第二版'),
    })
    const replayed = (await (await POST({} as never)).json()) as { outcome: string; version: number }
    expect(replayed.outcome).toBe('replayed')
    expect(replayed.version).toBe(2)

    // stale expected version → conflict, zero writes
    mocks.parseJsonBody.mockResolvedValue({
      action: 'save',
      articleId,
      expectedVersion: 1,
      operationId: 'op-2',
      snapshot: snapshot(slug, '第三版'),
    })
    const conflict = (await (await POST({} as never)).json()) as {
      outcome: string
      expectedVersion: number
      serverVersion: number
    }
    expect(conflict.outcome).toBe('conflict')
    expect(conflict.expectedVersion).toBe(1)
    expect(conflict.serverVersion).toBe(2)

    // D1: exactly [1, 2] — replay + conflict added nothing
    expect((await versions(articleId)).map((r) => r.version)).toEqual([1, 2])
    const count = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`)).at(-1)?.n
    expect(count).toBe(2)

    // GET returns the current identity + latest server snapshot (冲突“服务器版”)
    const got = (await (await GET(new Request(`http://localhost/api/article-commands?articleId=${articleId}`))).json()) as {
      articleId: number
      version: number
      snapshot: { title: string; status: string }
    }
    expect(got.articleId).toBe(articleId)
    expect(got.version).toBe(2)
    expect(got.snapshot.title).toBe('第二版')
  })

  it('publishTemp transitions draft<->published and GET resolves by slug', async () => {
    const slug = fresh('pslug')
    const creationId = fresh('pcreate')
    mocks.parseJsonBody.mockResolvedValue({
      action: 'create',
      creationId,
      snapshot: snapshot(slug, '草稿'),
    })
    const created = (await (await POST({} as never)).json()) as { articleId: number; version: number }
    const articleId = created.articleId

    mocks.parseJsonBody.mockResolvedValue({
      action: 'publishTemp',
      articleId,
      expectedVersion: 1,
      currentStatus: 'draft',
      operationId: 'op-pub-1',
      status: 'published',
    })
    const pub = (await (await POST({} as never)).json()) as { outcome: string; version: number; publishedAt: number | null }
    expect(pub.outcome).toBe('applied')
    expect(pub.version).toBe(2)
    expect(pub.publishedAt).toBeTypeOf('number') // first publish -> now

    const got = (await (await GET(new Request(`http://localhost/api/article-commands?slug=${encodeURIComponent(slug)}`))).json()) as {
      articleId: number
      version: number
      snapshot: { status: string }
    }
    expect(got.articleId).toBe(articleId)
    expect(got.version).toBe(2)
    expect(got.snapshot.status).toBe('published')
  })
})
