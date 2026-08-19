/**
 * B3-01 — /api/first-publish route integration fixture (issue #33).
 *
 * Thin route + real kernel + shared in-process D1: drives the full desktop
 * first-publish flow the way the workbench's browser would — create the draft,
 * prepare the confirmed version, confirm the exact version, receive the
 * independent blog receipt — and proves the route never lets a later edit ride
 * along on a stale prepared plan.
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
  createDraftArticle,
} from '@/tests/lib/first-publish/helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'

const mocks = vi.hoisted(() => ({
  getRouteContextWithDb: vi.fn(),
  ensureAuthenticatedRequest: vi.fn(),
  parseJsonBody: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
}))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: mocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: mocks.parseJsonBody,
}))

vi.mock('@/lib/cache', () => ({ invalidatePublicContentCache: mocks.invalidatePublicContentCache }))

import { GET, POST } from '@/app/api/first-publish/route'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b301-route-'))
  cleanup.push(state)
  await bootstrapState(state)
  await ensureFirstPublishTables(createDatabase())
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRouteContextWithDb.mockResolvedValue({
    ok: true,
    env: { NEXT_PUBLIC_SITE_URL: 'https://blog.example.test', RECEIPT_TOKEN: 'secret' },
    db: createDatabase(),
    ctx: { waitUntil: vi.fn() },
  })
  mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
  mocks.invalidatePublicContentCache.mockResolvedValue(undefined)
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

async function post(payload: unknown, headers: Record<string, string> = {}) {
  mocks.parseJsonBody.mockResolvedValue(payload)
  const req = { json: async () => payload, headers: new Headers(headers) } as never
  const res = await POST(req)
  return res.json()
}

describe('app/api/first-publish — thin route + real kernel + D1', { timeout: 600_000 }, () => {
  it('浏览器首次发布流程：建稿→准备→确认→回执，确认失败时无部分上线', async () => {
    const article = await createDraftArticle(fresh('route-slug'), '路由标题', '路由正文')
    // The browser sends the exact server-saved content hash (from the
    // GET /api/article-commands server snapshot) — here read from the version fact.
    const hashRow = (await query<{ content_snapshot_sha256: string }>(
      `SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ${article.articleId} AND version = 1`,
    ))[0]
    const contentSha256 = hashRow.content_snapshot_sha256

    // 1) prepare — the workbench confirms the exact saved version (v1).
    const prepareId = fresh('prepare')
    const prepared = await post({
      action: 'prepare',
      prepareId,
      articleId: article.articleId,
      confirmedVersion: 1,
      slug: article.slug,
      title: '路由标题',
      contentSha256,
    })
    expect(prepared).toMatchObject({ outcome: 'prepared', articleId: article.articleId, confirmedVersion: 1 })

    // 2) confirm — single transaction, then out-of-transaction cache invalidation.
    const intentId = fresh('intent')
    const confirmed = await post({
      action: 'confirm',
      intentId,
      prepareId,
      articleId: article.articleId,
      expectedVersion: 1,
    })
    expect(confirmed).toMatchObject({
      outcome: 'delivered',
      articleId: article.articleId,
      version: 1,
      publicUrl: `https://blog.example.test/${article.slug}`,
    })
    expect(mocks.invalidatePublicContentCache).toHaveBeenCalledTimes(1)

    // 3) GET state shows the separated surfaces: prepare committed, event,
    //    outbox pending, formal publication + public address.
    const stateRes = (await GET(new Request(`https://blog.example.test/api/first-publish?articleId=${article.articleId}`) as never)) as Response
    const state = await stateRes.json()
    expect(state.state.prepare.status).toBe('committed')
    expect(state.state.event.intent_id).toBe(intentId)
    expect(state.state.outbox.status).toBe('pending')
    expect(state.state.formal.version).toBe(1)
    expect(state.state.formal.public_url).toBe(`https://blog.example.test/${article.slug}`)
    expect(state.state.receipt).toBeNull()

    // 4) The independent blog verifier posts the receipt back.
    const receipt = await post(
      {
        action: 'receipt',
        eventId: state.state.event.event_id,
        verified: true,
        receipt: { http: 200, contentSha256 },
      },
      { 'x-receipt-token': 'secret' },
    )
    expect(receipt).toMatchObject({ outcome: 'recorded' })

    const afterReceipt = (await (await GET(new Request(`https://blog.example.test/api/first-publish?articleId=${article.articleId}`) as never)).json())
    expect(afterReceipt.state.receipt.verified).toBe(1)
    expect(afterReceipt.state.receipt.event_id).toBe(state.state.event.event_id)
  })

  it('确认的门在 route 层同样有效：后续编辑的版本不被顺带发布，且零部分事实', async () => {
    const article = await createDraftArticle(fresh('route-guard'), '守卫', '守卫正文')
    const hashRow = (await query<{ content_snapshot_sha256: string }>(
      `SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ${article.articleId} AND version = 1`,
    ))[0]
    const prepareId = fresh('prepare')
    const prep = await post({
      action: 'prepare',
      prepareId,
      articleId: article.articleId,
      confirmedVersion: 1,
      slug: article.slug,
      title: '守卫',
      contentSha256: hashRow.content_snapshot_sha256,
    })
    expect(prep.outcome).toBe('prepared')

    // A later edit lands (v2) before the editor confirms v1.
    const { save } = await import('@/lib/article-commands')
    const saved = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: {
        slug: article.slug,
        title: '后续编辑',
        content: '后续正文',
        html: '<p>后续正文</p>',
        description: null,
        category: null,
        tags: null,
        status: 'draft',
        password: null,
        is_pinned: 0,
        is_hidden: 0,
        cover_image: null,
        deleted_at: null,
        published_at: null,
        updated_at: null,
      },
    })
    expect(saved.outcome).toBe('applied')

    const confirm = await post({
      action: 'confirm',
      intentId: fresh('intent'),
      prepareId,
      articleId: article.articleId,
      expectedVersion: 1,
    })
    expect(confirm).toMatchObject({ outcome: 'conflict', reason: 'version-moved' })

    const facts = await query<Record<string, unknown>>(
      `SELECT * FROM formal_publications WHERE article_id = ${article.articleId}`,
    )
    expect(facts).toEqual([])
    const events = await query<Record<string, unknown>>(
      `SELECT * FROM publish_events WHERE article_id = ${article.articleId}`,
    )
    expect(events).toEqual([])
  })

  it('未认证请求被拒；receipt 需要共享令牌', async () => {
    mocks.ensureAuthenticatedRequest.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    const res = await post({ action: 'prepare', prepareId: 'p', articleId: 1, confirmedVersion: 1, slug: 's', title: 't', contentSha256: 'a'.repeat(64) })
    expect(res).toEqual({ error: 'Unauthorized' })

    mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
    const denied = await post(
      { action: 'receipt', eventId: 'event:x', verified: true },
      { 'x-receipt-token': 'wrong' },
    )
    expect(denied).toEqual({ error: 'receipt: unauthorized' })
    const allowed = await post(
      { action: 'receipt', eventId: 'event:x', verified: true },
      { 'x-receipt-token': 'secret' },
    )
    expect(allowed).toEqual({ outcome: 'not-found' })
  })
})