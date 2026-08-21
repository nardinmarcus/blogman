/**
 * B2-04 — /api/article-commands route dispatch tests (issue #27).
 *
 * Thin-adapter behavior: action dispatch to the B2-03 kernel, payload
 * coercion, auto-slug assignment for blank create slugs, auth gating and
 * result enrichment (applied slug / published_at). The kernel itself and the
 * D1 interaction are exercised by the shared-Miniflare integration test
 * (article-commands.integration.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  save: vi.fn(),
  publishTemp: vi.fn(),
  setPinned: vi.fn(),
  setHidden: vi.fn(),
  setPassword: vi.fn(),
  setCategory: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  batchSetCategory: vi.fn(),
  getRouteContextWithDb: vi.fn(),
  ensureAuthenticatedRequest: vi.fn(),
  parseJsonBody: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
  getPostBySlug: vi.fn(),
  updatePost: vi.fn(),
  getByPostRef: vi.fn(),
  listVersions: vi.fn(),
  nanoid: vi.fn(() => 'abc123'),
}))

vi.mock('@/lib/article-commands', () => ({
  create: mocks.create,
  save: mocks.save,
  publishTemp: mocks.publishTemp,
  setPinned: mocks.setPinned,
  setHidden: mocks.setHidden,
  setPassword: mocks.setPassword,
  setCategory: mocks.setCategory,
  softDelete: mocks.softDelete,
  restore: mocks.restore,
  batchSetCategory: mocks.batchSetCategory,
}))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: mocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: mocks.parseJsonBody,
}))

vi.mock('@/lib/cache', () => ({
  invalidatePublicContentCache: mocks.invalidatePublicContentCache,
}))

vi.mock('@/lib/background-jobs', () => ({
  enqueueBackgroundJob: mocks.enqueueBackgroundJob,
  aiProcessPostOperationId: (postRef: number, version: number) =>
    `ai:process-post:${postRef}:v${version}`,
}))

vi.mock('@/lib/db', () => ({
  getPostBySlug: mocks.getPostBySlug,
  updatePost: mocks.updatePost,
}))

vi.mock('@/lib/repositories/articles', () => ({
  getByPostRef: mocks.getByPostRef,
  listVersions: mocks.listVersions,
}))

vi.mock('nanoid', () => ({
  nanoid: mocks.nanoid,
}))

import { POST } from '@/app/api/article-commands/route'

function fakeDb(
  registry: Record<string, number> = { s: 5 },
  versions: Record<number, number> = { 5: 2 },
) {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          if (sql.includes("json_extract(v.snapshot_json, '$.fields.slug')")) {
            return { slug: 'persisted-slug', published_at: 1700000000 }
          }
          if (sql.includes('FROM article_slug_addresses')) {
            const slug = String(binds[0] ?? '')
            return slug in registry ? { article_id: registry[slug] } : null
          }
          if (sql.includes('MAX(version)')) {
            return { version: versions[Number(binds[0])] ?? 0 }
          }
          return { slug: 'persisted-slug', published_at: 1700000000 }
        },
      }),
    }),
  }
}

/** Versioned-authority defaults for B2-06 dispatch tests. */
function mockAuthority(articleId = 5, version = 2) {
  mocks.getByPostRef.mockResolvedValue({ id: articleId, post_ref: 1, slug: 's', draft_ref: null, source_page_identity: null, created_at: 1 })
  mocks.listVersions.mockResolvedValue([{ id: 10, article_id: articleId, version, operation_id: 'x', snapshot_json: '{}', content_snapshot_sha256: '', published_at: null, created_at: 1 } as never])
}


describe('/api/article-commands — dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: {},
      db: fakeDb(),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
    mocks.invalidatePublicContentCache.mockResolvedValue(undefined)
    mocks.enqueueBackgroundJob.mockResolvedValue(undefined)
  })

  it('rejects unauthenticated writes', async () => {
    mocks.ensureAuthenticatedRequest.mockResolvedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    )
    const res = await POST({} as never)
    expect(res.status).toBe(401)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('dispatches create with a coerced snapshot and attaches facts', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      action: 'create',
      creationId: 'c1',
      snapshot: {
        slug: 'my-slug',
        title: ' 新标题 ',
        content: '# 正文',
        html: '<h1>正文</h1>',
        category: '  AI  ',
        tags: ['甲', ' ', '乙'],
        status: 'published',
        description: ' 摘要 ',
      },
    })
    mocks.create.mockResolvedValue({
      outcome: 'created',
      articleId: 1,
      postRef: 2,
      version: 1,
      operationId: 'create:c1',
      existing: false,
    })

    const res = await POST({} as never)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(mocks.create).toHaveBeenCalledOnce()
    const input = mocks.create.mock.calls[0][1]
    expect(input.creationId).toBe('c1')
    expect(input.snapshot.slug).toBe('my-slug')
    expect(input.snapshot.title).toBe('新标题')
    expect(input.snapshot.category).toBe('AI')
    expect(input.snapshot.tags).toEqual(['甲', '乙'])
    expect(input.snapshot.status).toBe('published')
    expect(input.snapshot.is_pinned).toBe(0)
    // enrich: applied slug + published_at from the posts projection
    expect(body.slug).toBe('persisted-slug')
    expect(body.publishedAt).toBe(1700000000)
  })

  it('auto-assigns a slug for a brand-new post with no slug', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      action: 'create',
      creationId: 'c2',
      snapshot: { title: '新文章', content: '正文' },
    })
    mocks.create.mockResolvedValue({
      outcome: 'created',
      articleId: 3,
      postRef: 4,
      version: 1,
      operationId: 'create:c2',
      existing: false,
    })

    await POST({} as never)
    const input = mocks.create.mock.calls[0][1]
    expect(input.snapshot.slug).toMatch(/^2026-\d{2}-\d{2}-abc123$/)
  })

  it('dispatches save with expected version + operation id and validates integers', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      action: 'save',
      articleId: 5,
      expectedVersion: 2,
      operationId: 'op-1',
      snapshot: { slug: 's', title: 't', content: 'c' },
    })
    mocks.save.mockResolvedValue({
      outcome: 'applied',
      articleId: 5,
      postRef: 9,
      version: 3,
      operationId: 'op-1',
      existing: false,
    })

    const res = await POST({} as never)
    expect(res.status).toBe(200)
    const input = mocks.save.mock.calls[0][1]
    expect(input.articleId).toBe(5)
    expect(input.expectedVersion).toBe(2)
    expect(input.operationId).toBe('op-1')

    // validation: non-integer articleId rejected before kernel call
    mocks.parseJsonBody.mockResolvedValueOnce({
      action: 'save',
      articleId: 'bad',
      expectedVersion: 1,
      operationId: 'x',
      snapshot: { slug: 's', title: 't', content: 'c' },
    })
    mocks.save.mockClear()
    const bad = await POST({} as never)
    expect(bad.status).toBe(400)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('dispatches publishTemp with status + status-precondition', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      action: 'publishTemp',
      articleId: 5,
      expectedVersion: 3,
      currentStatus: 'draft',
      operationId: 'op-pub',
      status: 'published',
    })
    mocks.publishTemp.mockResolvedValue({
      outcome: 'applied',
      articleId: 5,
      postRef: 9,
      version: 4,
      operationId: 'op-pub',
      existing: false,
    })

    const res = await POST({} as never)
    expect(res.status).toBe(200)
    const input = mocks.publishTemp.mock.calls[0][1]
    expect(input.status).toBe('published')
    expect(input.currentStatus).toBe('draft')
    expect(input.expectedVersion).toBe(3)
  })

  it('dispatches setPinned with expectedVersion + operationId; enriches via projections', async () => {
    mockAuthority(5, 2)
    mocks.getPostBySlug.mockResolvedValue({ id: 1, slug: 's', title: 't', description: null, category: null, tags: null, status: 'draft', password: null, is_pinned: 0, is_hidden: 0, deleted_at: null, published_at: 1, updated_at: 1, view_count: 0 })
    mocks.parseJsonBody.mockResolvedValue({
      action: 'setPinned',
      slug: 's',
      articleId: 5,
      expectedVersion: 2,
      operationId: 'op-pin-1',
      is_pinned: 1,
    })
    mocks.setPinned.mockResolvedValue({
      outcome: 'applied',
      articleId: 5,
      postRef: 1,
      version: 2,
      operationId: 'op-pin-1',
      existing: false,
      projectionFailures: [],
    })

    const res = await POST({} as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome).toBe('applied')
    const input = mocks.setPinned.mock.calls[0][1] as Record<string, unknown>
    expect(input.articleId).toBe(5)
    expect(input.expectedVersion).toBe(2)
    expect(input.operationId).toBe('op-pin-1')
    expect(input.is_pinned).toBe(1)
    // content-visible change -> public cache invalidated best-effort
    expect(mocks.invalidatePublicContentCache).toHaveBeenCalled()
  })

  it('rejects an articleId/slug mismatch with 409 before touching the kernel', async () => {
    // The registry binds slug 's' to article 99; the request claims article 5.
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: {},
      db: fakeDb({ s: 99 }, { 99: 3 }),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.parseJsonBody.mockResolvedValue({
      action: 'setHidden',
      slug: 's',
      articleId: 5,
      expectedVersion: 2,
      operationId: 'op-h-1',
      is_hidden: 1,
    })
    const res = await POST({} as never)
    expect(res.status).toBe(409)
    expect(mocks.setHidden).not.toHaveBeenCalled()
  })

  it('refuses a versionless article (no version facts) with 409 — no legacy fallback', async () => {
    // Registry resolves the slug but the article carries zero version facts.
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: {},
      db: fakeDb({ s: 5 }, { 5: 0 }),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.parseJsonBody.mockResolvedValue({
      action: 'setPinned',
      slug: 's',
      articleId: 5,
      expectedVersion: 1,
      operationId: 'op-legacy-pin',
      is_pinned: 1,
    })

    const res = await POST({} as never)
    expect(res.status).toBe(409)
    expect(mocks.updatePost).not.toHaveBeenCalled()
    expect(mocks.setPinned).not.toHaveBeenCalled()
  })

  it('batchSetCategory returns per-article applied + conflict, never blocking each other', async () => {
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: {},
      db: fakeDb({ a: 5, b: 6 }, { 5: 2, 6: 5 }),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.setCategory.mockResolvedValueOnce({
      outcome: 'applied', articleId: 5, postRef: 1, version: 2, operationId: 'op-a', existing: false, projectionFailures: [],
    })
    mocks.setCategory.mockResolvedValueOnce({
      outcome: 'conflict', articleId: 6, postRef: 2, expectedVersion: 3, serverVersion: 5, facts: null,
    })
    mocks.parseJsonBody.mockResolvedValue({
      action: 'batchSetCategory',
      items: [
        { slug: 'a', articleId: 5, expectedVersion: 2, operationId: 'op-a', category: 'AI' },
        { slug: 'b', articleId: 6, expectedVersion: 3, operationId: 'op-b', category: 'AI' },
      ],
    })

    const res = await POST({} as never)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items[0].outcome).toBe('applied')
    expect(body.items[1].outcome).toBe('conflict')
    expect(body.items[1].serverVersion).toBe(5)
  })

  it('rejects an unknown action', async () => {
    mocks.parseJsonBody.mockResolvedValue({ action: 'explode', payload: {} })
    const res = await POST({} as never)
    expect(res.status).toBe(400)
  })
})
