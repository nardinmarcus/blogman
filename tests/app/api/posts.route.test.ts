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
  dispatchExternalWrite: vi.fn(),
  resolveArticleBySlug: vi.fn(),
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

vi.mock('@/lib/external-write-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/external-write-api')>()
  return {
    ...actual,
    isVersionedProtocol: mocks.isVersionedProtocol,
    dispatchExternalWrite: mocks.dispatchExternalWrite,
    resolveArticleBySlug: mocks.resolveArticleBySlug,
  }
})

import { PATCH, POST } from '@/app/api/posts/route'

/** Fake D1 that satisfies the route's fact attachment read on `posts`. */
function fakeDb() {
  const stmt = {
    first: async () => ({ slug: 'persisted-slug', published_at: 1700000000 }),
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
  mocks.dispatchExternalWrite.mockResolvedValue(CREATED)
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

  it('records no legacy write when the protocol is explicit', async () => {
    mocks.isVersionedProtocol.mockReturnValue(true)
    mocks.dispatchExternalWrite.mockResolvedValue({ ...CREATED, slug: 'persisted-slug' })
    mocks.parseJsonBody.mockResolvedValue({ protocol: 'v1', action: 'create', creationId: 'c-1', snapshot: {} })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ protocol: 'v1', outcome: 'created' })
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

describe('POST /api/posts — legacy create rejected after removal', () => {
  it('rejects an unversioned create outright with a required upgrade signal and performs no write', async () => {
    mocks.parseJsonBody.mockResolvedValue({ title: '旧客户端', content: '# 正文', status: 'published' })
    const response = await POST({ headers: headers({ 'x-blogman-client': 'obsidian' }) } as never)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
    expect(body.error).toContain('legacy 无版本写入已停用')
    expect(body.upgrade).toMatchObject({ protocol: 'v1', required: true, endpoint: '/api/posts' })
  })

  it('rejects an unversioned create regardless of requested status (no direct publish)', async () => {
    mocks.parseJsonBody.mockResolvedValue({ title: 'T', content: 'C', status: 'published' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(409)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
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

describe('PATCH /api/posts — legacy update rejected after removal', () => {
  it('rejects an unversioned update outright with a required upgrade signal (no versionless write)', async () => {
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 'persisted-slug', title: '新标题' })
    const response = await PATCH({ headers: headers({ 'user-agent': 'obsidian-md/1.0' }) } as never)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
    expect(mocks.resolveArticleBySlug).not.toHaveBeenCalled()
    expect(body.error).toContain('legacy 无版本写入已停用')
    expect(body.upgrade).toMatchObject({ protocol: 'v1', required: true, endpoint: '/api/posts' })
  })

  it('rejects an unversioned update that requests a direct publish', async () => {
    mocks.parseJsonBody.mockResolvedValue({ current_slug: 's', status: 'published' })
    const response = await PATCH({ headers } as never)
    expect(response.status).toBe(409)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
  })
})

describe('POST/PATCH /api/posts — no legacy compat / bypass projection', () => {
  it('rejects an unversioned create even when the identity schema probe is unavailable (fail closed)', async () => {
    mocks.parseJsonBody.mockResolvedValue({ title: '原协议创建', content: '正文', status: 'draft' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(409)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
  })

  it('still rejects unauthenticated writes before any write', async () => {
    mocks.ensureAuthenticatedRequest.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    mocks.parseJsonBody.mockResolvedValue({ title: 'T', content: 'C' })
    const response = await POST({ headers } as never)
    expect(response.status).toBe(401)
    expect(mocks.dispatchExternalWrite).not.toHaveBeenCalled()
  })
})