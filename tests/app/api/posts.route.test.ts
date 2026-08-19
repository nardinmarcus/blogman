/**
 * B2-08 — /api/posts external write route tests (issue #31).
 *
 * Thin-adapter wiring for the external Bearer/Agent/Obsidian/Chrome entry:
 * protocol negotiation (v1 vs legacy), authority gate, legacy draft-only
 * create/update with upgrade signal + telemetry, and versioned dispatch to
 * the kernel. The real protocol/kernel mapping is covered by the lib suite
 * and the in-process-D1 integration test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureAuthenticatedRequest: vi.fn(),
  getRouteContextWithDb: vi.fn(),
  parseJsonBody: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
  isVersionedProtocol: vi.fn(),
  isExternalWriteAuthoritySwitched: vi.fn(),
  createLegacyDraft: vi.fn(),
  updateLegacyDraft: vi.fn(),
  dispatchExternalWrite: vi.fn(),
  recordLegacyWrite: vi.fn(),
  resolveArticleBySlug: vi.fn(),
  createPost: vi.fn(),
  updatePostBySlug: vi.fn(),
  missingContentEnvelopeColumns: vi.fn(),
  buildContentEnvelopeFields: vi.fn(),
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

vi.mock('@/lib/db', () => ({
  createPost: mocks.createPost,
  updatePostBySlug: mocks.updatePostBySlug,
}))

vi.mock('@/lib/content-envelope-columns', () => ({
  missingContentEnvelopeColumns: mocks.missingContentEnvelopeColumns,
  buildContentEnvelopeFields: mocks.buildContentEnvelopeFields,
}))

vi.mock('nanoid', () => ({ nanoid: () => 'abc123' }))

vi.mock('@/lib/external-write-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/external-write-api')>()
  return {
    ...actual,
    isVersionedProtocol: mocks.isVersionedProtocol,
    isExternalWriteAuthoritySwitched: mocks.isExternalWriteAuthoritySwitched,
    createLegacyDraft: mocks.createLegacyDraft,
    updateLegacyDraft: mocks.updateLegacyDraft,
    dispatchExternalWrite: mocks.dispatchExternalWrite,
    recordLegacyWrite: mocks.recordLegacyWrite,
    resolveArticleBySlug: mocks.resolveArticleBySlug,
  }
})

import { PATCH, POST } from '@/app/api/posts/route'

/** Fake D1 that satisfies the route's schema probe + fact attachment + compat CRUD. */
function fakeDb(identity = true) {
  const stmt = {
    all: async () =>
      identity
        ? { results: [{ name: 'articles' }, { name: 'article_versions' }] }
        : { results: [] },
    first: async () => ({ slug: 'persisted-slug', published_at: 1700000000 }),
    run: async () => ({ meta: { last_row_id: 1 } }),
    bind: () => stmt,
  }
  return { prepare: () => stmt }
}

const CREATED = {
  outcome: 'created',
  articleId: 7,
  postRef: 10,
  version: 1,
  operationId: 'create:legacy:abc',
  existing: false,
  projectionFailures: [],
}

const APPLIED = {
  outcome: 'applied',
  articleId: 7,
  postRef: 10,
  version: 2,
  operationId: 'op-1',
  existing: false,
  projectionFailures: [],
}

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
  mocks.isVersionedProtocol.mockReturnValue(false)
  mocks.isExternalWriteAuthoritySwitched.mockResolvedValue(false)
  mocks.createLegacyDraft.mockResolvedValue({ result: CREATED, snapshot: { slug: 'legacy-slug' } })
  mocks.updateLegacyDraft.mockResolvedValue({ result: APPLIED, snapshot: { slug: 'persisted-slug' } })
  mocks.dispatchExternalWrite.mockResolvedValue(CREATED)
  mocks.recordLegacyWrite.mockResolvedValue(undefined)
  mocks.createPost.mockResolvedValue(42)
  mocks.updatePostBySlug.mockResolvedValue(undefined)
  mocks.missingContentEnvelopeColumns.mockResolvedValue([])
  mocks.buildContentEnvelopeFields.mockReturnValue({
    content_envelope: '{"format":"blogman-content-envelope/v1"}',
    content_snapshot_sha256: 'a'.repeat(64),
    source_sync_sha256: 'b'.repeat(64),
  })
})

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'user-agent': 'curl/8.0', ...extra })
}

describe('POST /api/posts — versioned protocol (upgraded client)', () => {
  it('dispatches create/save/publishTemp to the kernel and wraps with protocol v1', async () => {
    mocks.isVersionedProtocol.mockReturnValue(true)
    mocks.dispatchExternalWrite.mockResolvedValue({ ...CREATED, slug: 'persisted-slug' })
    mocks.parseJsonBody.mockResolvedValue({ protocol: 'v1', action: 'create', creationId: 'obsidian:note-1', snapshot: {} })

    const response = await POST({ headers } as never)
    const body = await response.json()

    expect(mocks.dispatchExternalWrite).toHaveBeenCalledWith(
      expect.anything(),
      'create',
      expect.objectContaining({ creationId: 'obsidian:note-1' }),
      expect.any(Object),
    )
    expect(body.protocol).toBe('v1')
    expect(body.outcome).toBe('created')
    expect(body.slug).toBe('persisted-slug')
  })

  it('does not touch the legacy path when the protocol is explicit', async () => {
    mocks.isVersionedProtocol.mockReturnValue(true)
    mocks.parseJsonBody.mockResolvedValue({ protocol: 'v1', action: 'create', creationId: 'c-1', snapshot: {} })
    await POST({ headers } as never)
    expect(mocks.createLegacyDraft).not.toHaveBeenCalled()
    expect(mocks.recordLegacyWrite).not.toHaveBeenCalled()
  })

  it('surfaces dispatch errors with their status', async () => {
    mocks.isVersionedProtocol.mockReturnValue(true)
    mocks.dispatchExternalWrite.mockResolvedValue({ error: 'create: creationId 不能为空', status: 400 })
    mocks.parseJsonBody.mockResolvedValue({ protocol: 'v1', action: 'create' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('create: creationId 不能为空')
  })
})

describe('POST /api/posts — legacy create (draft-only + upgrade signal)', () => {
  it('routes through the kernel and returns a draft with a machine-readable upgrade signal', async () => {
    mocks.parseJsonBody.mockResolvedValue({ title: '旧客户端', content: '# 正文', status: 'published' })
    const response = await POST({ headers: headers({ 'x-blogman-client': 'obsidian' }) } as never)
    const body = await response.json()

    expect(mocks.createLegacyDraft).toHaveBeenCalled()
    expect(mocks.recordLegacyWrite).toHaveBeenCalledWith(expect.anything(), {
      clientType: 'obsidian',
      operation: 'create',
    })
    expect(body.success).toBe(true)
    expect(body.status).toBe('draft')
    expect(body.legacy).toBe(true)
    expect(body.upgrade).toMatchObject({ protocol: 'v1', required: false, endpoint: '/api/posts' })
    expect(body.articleId).toBe(7)
    expect(body.slug).toBe('persisted-slug')
  })

  it('rejects legacy create outright once the external-write authority is switched', async () => {
    mocks.isExternalWriteAuthoritySwitched.mockResolvedValue(true)
    mocks.parseJsonBody.mockResolvedValue({ title: 'T', content: 'C' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(409)
    expect(mocks.createLegacyDraft).not.toHaveBeenCalled()
    expect(mocks.recordLegacyWrite).not.toHaveBeenCalled()
  })

  it('rejects a blank title/body before touching the kernel', async () => {
    mocks.parseJsonBody.mockResolvedValue({ title: '', content: ' ' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(400)
    expect(mocks.createLegacyDraft).not.toHaveBeenCalled()
  })

  it('maps a kernel slug-conflict to 409', async () => {
    mocks.createLegacyDraft.mockResolvedValue({
      result: { outcome: 'slug-conflict', slug: 'taken' },
      snapshot: { slug: 'taken' },
    })
    mocks.parseJsonBody.mockResolvedValue({ title: 'T', content: 'C' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('slug 已存在')
  })
})

describe('PATCH /api/posts — versioned save', () => {
  it('dispatches save with the resolved article id when only a slug is given', async () => {
    mocks.isVersionedProtocol.mockReturnValue(true)
    mocks.resolveArticleBySlug.mockResolvedValue({ articleId: 7, postRef: 10, version: 2, snapshot: { slug: 'persisted-slug' } })
    mocks.dispatchExternalWrite.mockResolvedValue({ ...APPLIED, slug: 'persisted-slug' })
    mocks.parseJsonBody.mockResolvedValue({
      protocol: 'v1',
      current_slug: 'persisted-slug',
      expectedVersion: 2,
      operationId: 'op-1',
      snapshot: { slug: 'persisted-slug', title: '新标题', content: '正文' },
    })

    const response = await PATCH({ headers } as never)
    const body = await response.json()

    expect(mocks.dispatchExternalWrite).toHaveBeenCalledWith(
      expect.anything(),
      'save',
      expect.objectContaining({ articleId: 7, expectedVersion: 2, operationId: 'op-1' }),
      expect.any(Object),
    )
    expect(body.protocol).toBe('v1')
    expect(body.outcome).toBe('applied')
  })

  it('requires expectedVersion + operationId (no versionless saves for v1)', async () => {
    mocks.isVersionedProtocol.mockReturnValue(true)
    mocks.parseJsonBody.mockResolvedValue({ protocol: 'v1', current_slug: 's', snapshot: {} })
    const response = await PATCH({ headers } as never)
    expect(response.status).toBe(400)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/posts — legacy update (draft-only through the kernel)', () => {
  it('routes the merge through kernel save and records update telemetry', async () => {
    mocks.updateLegacyDraft.mockResolvedValue({ result: APPLIED, snapshot: { slug: 'persisted-slug' } })
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 'persisted-slug', title: '新标题' })
    const response = await PATCH({ headers: headers({ 'user-agent': 'obsidian-md/1.0' }) } as never)
    const body = await response.json()

    expect(mocks.updateLegacyDraft).toHaveBeenCalledWith(expect.anything(), 'persisted-slug', expect.anything(), expect.any(Object))
    expect(mocks.recordLegacyWrite).toHaveBeenCalledWith(expect.anything(), { clientType: 'obsidian', operation: 'update' })
    expect(body.success).toBe(true)
    expect(body.status).toBe('draft')
    expect(body.legacy).toBe(true)
    expect(body.upgrade.required).toBe(false)
  })

  it('rejects legacy update outright once authority is switched (versionless update rejected)', async () => {
    mocks.isExternalWriteAuthoritySwitched.mockResolvedValue(true)
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 's', title: 'T' })
    const response = await PATCH({ headers } as never)
    expect(response.status).toBe(409)
    expect(mocks.updateLegacyDraft).not.toHaveBeenCalled()
  })

  it('rejects legacy update of a post not under versioned authority with an upgrade signal', async () => {
    mocks.updateLegacyDraft.mockResolvedValue(null)
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 'legacy-only', title: 'T' })
    const response = await PATCH({ headers } as never)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('protocol=v1')
  })

  it('surfaces a legacy version conflict as a 409 with a versioned retry hint', async () => {
    mocks.updateLegacyDraft.mockResolvedValue({
      result: { outcome: 'conflict', articleId: 7, postRef: 10, expectedVersion: 1, serverVersion: 3, facts: null },
      snapshot: { slug: 'persisted-slug' },
    })
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 'persisted-slug', title: 'T' })
    const response = await PATCH({ headers } as never)
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toContain('protocol=v1')
    expect(body.serverVersion).toBe(3)
  })
})

describe('POST/PATCH /api/posts — ledger-only D1 compat (no identity tables)', () => {
  it('falls back to the original direct create (no 503) and surfaces the upgrade signal', async () => {
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: {},
      db: fakeDb(false), // articles/article_versions absent
      ctx: { waitUntil: vi.fn() },
    })
    mocks.parseJsonBody.mockResolvedValue({ title: '原协议创建', content: '正文', status: 'draft' })

    const response = await POST({ headers } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.createPost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ slug: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-abc123$/) }))
    expect(body.success).toBe(true)
    expect(body.status).toBe('draft')
    expect(body.legacy).toBe(true)
    expect(body.upgrade).toMatchObject({ protocol: 'v1', required: false, endpoint: '/api/posts' })
    expect(mocks.recordLegacyWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'create' }))
  })

  it('falls back to the original direct update (no 503) with telemetry', async () => {
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: {},
      db: fakeDb(false),
      ctx: { waitUntil: vi.fn() },
    })
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 's', title: '原协议更新' })

    const response = await PATCH({ headers } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.updatePostBySlug).toHaveBeenCalled()
    expect(body.success).toBe(true)
    expect(body.legacy).toBe(true)
    expect(mocks.recordLegacyWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'update' }))
  })

  it('still rejects unauthenticated writes before any write', async () => {
    mocks.ensureAuthenticatedRequest.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    mocks.parseJsonBody.mockResolvedValue({ title: 'T', content: 'C' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(401)
    expect(mocks.createPost).not.toHaveBeenCalled()
  })
})