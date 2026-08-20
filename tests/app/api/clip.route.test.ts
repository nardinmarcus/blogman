/**
 * B7-01 — Chrome 剪藏 /api/clip route contract tests (issue #57).
 *
 * Thin-adapter wiring for the Chrome clip entry: auth gate, payload coercion,
 * outcome mapping (created / existing / invalid-source / skipped). The real
 * idempotency + D1 concurrency is covered by the lib/kernel suite (in-process
 * D1); this file proves the ROUTE contract the Chrome extension drives:
 * first clip → `created` with a stable creationId + clip source facts; the same
 * URL again → `existing` with the SAME article identity (repeat-clip browser
 * flow); invalid URL → 400.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureAuthenticatedRequest: vi.fn(),
  getRouteContextWithDb: vi.fn(),
  parseJsonBody: vi.fn(),
  clipArticle: vi.fn(),
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

vi.mock('@/lib/clip', () => ({ clipArticle: mocks.clipArticle }))
vi.mock('@/lib/cache', () => ({ invalidatePublicContentCache: mocks.invalidatePublicContentCache }))
vi.mock('@/lib/background-jobs', () => ({ enqueueBackgroundJob: mocks.enqueueBackgroundJob }))

import { POST } from '@/app/api/clip/route'

function fakeDb() {
  const stmt = {
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({ meta: { last_row_id: 1 } }),
    bind: () => stmt,
  }
  return { prepare: () => stmt }
}

const CLIP_SOURCE = {
  sourceIdentity: { id: 3, canonicalUrl: 'https://example.com/p', identitySha256: 'a'.repeat(64), existing: true, createdAt: 1 },
  link: { id: 9, sourceIdentityId: 3, articleId: 7, status: 'pending', role: 'clip', operationId: 'source:clip:abc', createdAt: 1, resolvedAt: null },
}

const CREATED = {
  outcome: 'created',
  articleId: 7,
  postRef: 10,
  version: 1,
  creationId: 'clip:' + 'a'.repeat(64),
  existing: false,
  source: CLIP_SOURCE,
}

const EXISTING = {
  outcome: 'existing',
  articleId: 7,
  postRef: 10,
  version: 1,
  creationId: 'clip:' + 'a'.repeat(64),
  existing: true,
  source: CLIP_SOURCE,
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
  mocks.parseJsonBody.mockResolvedValue({ url: 'https://example.com/p', title: 't', content: 'c' })
})

describe('POST /api/clip — Chrome 剪藏 contract', () => {
  it('first clip → 200 created with a stable creationId + clip-role source facts', async () => {
    mocks.clipArticle.mockResolvedValue(CREATED)
    const res = await POST({ headers: new Headers() } as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome).toBe('created')
    expect(body.articleId).toBe(7)
    expect(body.creationId).toBe(CREATED.creationId)
    expect(body.existing).toBe(false)
    expect(body.source.link.role).toBe('clip')
    expect(body.source.link.status).toBe('pending')
  })

  it('repeat clip of the same URL → 200 existing with the SAME article identity (repeat-clip flow)', async () => {
    mocks.clipArticle.mockResolvedValue(EXISTING)
    const res = await POST({ headers: new Headers() } as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome).toBe('existing')
    expect(body.articleId).toBe(7)
    expect(body.creationId).toBe(EXISTING.creationId)
    expect(body.existing).toBe(true)
  })

  it('requires authentication — rejects when unauthenticated', async () => {
    mocks.ensureAuthenticatedRequest.mockResolvedValue(Response.json({ error: '未授权' }, { status: 401 }))
    const res = await POST({ headers: new Headers() } as never)
    expect(res.status).toBe(401)
  })

  it('rejects a missing url with 400', async () => {
    mocks.parseJsonBody.mockResolvedValue({ title: 't', content: 'c' })
    const res = await POST({ headers: new Headers() } as never)
    expect(res.status).toBe(400)
    expect(mocks.clipArticle).not.toHaveBeenCalled()
  })

  it('maps invalid-source and skipped to 400', async () => {
    mocks.clipArticle.mockResolvedValue({ outcome: 'invalid-source', url: 'bad' })
    expect((await POST({ headers: new Headers() } as never)).status).toBe(400)
    mocks.clipArticle.mockResolvedValue({ outcome: 'skipped', reason: 'blank-session' })
    expect((await POST({ headers: new Headers() } as never)).status).toBe(400)
  })

  it('maps a server failure to 500', async () => {
    mocks.clipArticle.mockRejectedValue(new Error('boom'))
    const res = await POST({ headers: new Headers() } as never)
    expect(res.status).toBe(500)
  })
})
