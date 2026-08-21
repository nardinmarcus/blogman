import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPostBySlug: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
  isAdminAuthenticated: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
  getRouteContextWithDb: vi.fn(),
  parseJsonBody: vi.fn(),
  getByPostRef: vi.fn(),
  listVersions: vi.fn(),
  setPinned: vi.fn(),
  setHidden: vi.fn(),
  setPassword: vi.fn(),
  setCategory: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getPostBySlug: mocks.getPostBySlug,
}))

vi.mock('@/lib/repositories/articles', () => ({
  getByPostRef: mocks.getByPostRef,
  listVersions: mocks.listVersions,
}))

vi.mock('@/lib/article-commands', () => ({
  setPinned: mocks.setPinned,
  setHidden: mocks.setHidden,
  setPassword: mocks.setPassword,
  setCategory: mocks.setCategory,
  softDelete: mocks.softDelete,
  restore: mocks.restore,
}))

/** SQL-aware db stub: registry slug → article id, article id → MAX(version). */
function fakeDb(
  registry: Record<string, number> = { 'old-slug': 5 },
  versions: Record<number, number> = { 5: 2 },
) {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM article_slug_addresses')) {
            const slug = String(binds[0] ?? '')
            return slug in registry ? { article_id: registry[slug] } : null
          }
          if (sql.includes('MAX(version)')) {
            return { version: versions[Number(binds[0])] ?? 0 }
          }
          return null
        },
      }),
    }),
  }
}

vi.mock('@/lib/admin-auth', () => ({
  COOKIE_NAME: 'blogman_admin',
  isAdminAuthenticated: mocks.isAdminAuthenticated,
}))

vi.mock('@/lib/cache', () => ({
  invalidatePublicContentCache: mocks.invalidatePublicContentCache,
}))

vi.mock('@/lib/background-jobs', () => ({
  enqueueBackgroundJob: mocks.enqueueBackgroundJob,
}))

vi.mock('@/lib/server/route-helpers', () => ({
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: mocks.parseJsonBody,
}))

import { PUT } from '@/app/api/admin/posts/[slug]/route'

describe('/api/admin/posts/[slug] route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isAdminAuthenticated.mockResolvedValue(true)
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: { CACHE: {} },
      db: fakeDb(),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.getPostBySlug.mockResolvedValue({ id: 7, slug: 'old-slug' })
    mocks.invalidatePublicContentCache.mockRejectedValue(new Error('cache down'))
  })

  const request = {
    cookies: {
      get: vi.fn(() => ({ value: 'token' })),
    },
  } as never

  it('rejects content-field updates with 409 — they belong to the versioned save entry', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      slug: 'next_slug',
      title: '文章标题',
      content: '更新后的正文',
      html: '<p>更新后的正文</p>',
      description: '   ',
      tags: ['AI', '写作'],
      cover_image: '/covers/admin.webp',
    })

    const response = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toMatch(/版本化保存入口/)
    expect(mocks.setPinned).not.toHaveBeenCalled()
    expect(mocks.softDelete).not.toHaveBeenCalled()
  })

  it('maps an is_pinned toggle onto the explicit command with server-side version facts', async () => {
    mocks.parseJsonBody.mockResolvedValue({ is_pinned: 1 })
    mocks.setPinned.mockResolvedValue({ outcome: 'applied' })

    const response = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    const input = mocks.setPinned.mock.calls[0][1] as Record<string, unknown>
    expect(input.articleId).toBe(5)
    expect(input.expectedVersion).toBe(2)
    expect(String(input.operationId)).toContain('admin-put:5')
    // Cache invalidation failures are tolerated (best-effort projection).
    expect(mocks.invalidatePublicContentCache).toHaveBeenCalled()
  })

  it('maps status=deleted onto softDelete and status=draft onto restore', async () => {
    mocks.parseJsonBody.mockResolvedValue({ status: 'deleted' })
    mocks.softDelete.mockResolvedValue({ outcome: 'applied' })

    const res1 = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    expect(res1.status).toBe(200)
    expect(mocks.softDelete.mock.calls[0][1]).toMatchObject({ articleId: 5, expectedVersion: 2 })

    mocks.parseJsonBody.mockResolvedValue({ status: 'draft' })
    mocks.restore.mockResolvedValue({ outcome: 'applied' })

    const res2 = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    expect(res2.status).toBe(200)
    expect(mocks.restore.mock.calls[0][1]).toMatchObject({ articleId: 5, expectedVersion: 2 })
  })

  it('refuses a lifecycle publish request through the generic PUT', async () => {
    mocks.parseJsonBody.mockResolvedValue({ status: 'published' })

    const response = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    expect(response.status).toBe(409)
  })

  it('refuses a versionless article with 409 — no legacy fallback', async () => {
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: { CACHE: {} },
      db: fakeDb({ 'old-slug': 5 }, { 5: 0 }),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.parseJsonBody.mockResolvedValue({ is_pinned: 1 })

    const response = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    expect(response.status).toBe(409)
    expect(mocks.setPinned).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated writes before any authority check', async () => {
    mocks.isAdminAuthenticated.mockResolvedValueOnce(false)
    const response = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    expect(response.status).toBe(401)
    expect(mocks.setPinned).not.toHaveBeenCalled()
  })

  it('returns 400 when no recognizable field is present', async () => {
    mocks.parseJsonBody.mockResolvedValue({ unrelated: true })
    const response = await PUT(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    expect(response.status).toBe(400)
  })

  it('DELETE routes through the explicit softDelete command', async () => {
    const { DELETE } = await import('@/app/api/admin/posts/[slug]/route')
    mocks.softDelete.mockResolvedValue({ outcome: 'applied' })

    const response = await DELETE(request, { params: Promise.resolve({ slug: 'old-slug' }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(mocks.softDelete.mock.calls[0][1]).toMatchObject({ articleId: 5, expectedVersion: 2 })
  })
})
