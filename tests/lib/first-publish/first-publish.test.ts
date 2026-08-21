/**
 * B3-01 — first formal publish isolated-D1 fixture (issue #33).
 *
 * One shared in-process Miniflare instance (real D1 binding, zero wrangler CLI
 * spawns). Covers the full first-publish acceptance matrix:
 *
 *   - 四阻塞项 each of the four blockers blocks a prepare/confirm,
 *   - 确认期间版本变化 a later edit between prepare and confirm is never
 *     published (only the confirmed version is promoted),
 *   - 重复确认 the same intent produces exactly one event + one outbox,
 *   - 事务中断 a mid-batch abort leaves zero partial online facts,
 *   - slug 冲突 a rival slug taken before confirm blocks with zero writes,
 *   - 重复 Outbox at most one outbox row per event; dispatch + receipt bind,
 *   - 草稿不伪造正式版本 legacy publishTemp never fabricates formal facts.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
  createDraftArticle,
  sha256,
  type CreatedArticle,
} from './helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'
import {
  cancelPrepare,
  confirmPublish,
  dispatchOutbox,
  preparePublish,
  readPublicationState,
  recordReceipt,
} from '@/lib/first-publish'
import { publishTemp } from '@/lib/article-commands'
let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b301-first-publish-'))
  cleanup.push(state)
  await bootstrapState(state)
  await ensureFirstPublishTables(createDatabase())
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

const SITE_URL = 'https://blog.example.test'

async function prepareFor(article: CreatedArticle, overrides: { confirmedVersion?: number; slug?: string; contentSha256?: string; title?: string } = {}) {
  const confirmedVersion = overrides.confirmedVersion ?? 1
  const slug = overrides.slug ?? article.slug
  // The kernel's content hash is the envelope snapshot hash — read it from the
  // version fact so the prepare carries the EXACT server-saved evidence.
  const row = (await query<{ content_snapshot_sha256: string | null }>(
    `SELECT content_snapshot_sha256 FROM article_versions
     WHERE article_id = ${article.articleId} AND version = ${confirmedVersion} ORDER BY id DESC LIMIT 1`,
  ))[0]
  const contentSha256 = overrides.contentSha256 ?? row?.content_snapshot_sha256 ?? ''
  const title = overrides.title ?? '待发布标题'
  return preparePublish(createDatabase(), {
    prepareId: fresh('prepare'),
    articleId: article.articleId,
    confirmedVersion,
    slug,
    title,
    contentSha256,
    actor: 'b301-fixture',
  })
}

function confirmFor(article: CreatedArticle, opts: { intentId: string; prepareId: string; version: number }) {
  return confirmPublish(createDatabase(), {
    intentId: opts.intentId,
    prepareId: opts.prepareId,
    articleId: article.articleId,
    expectedVersion: opts.version,
    actor: 'b301-fixture',
    siteUrl: SITE_URL,
  })
}

async function formalFacts(articleId: number) {
  return (await query<Record<string, unknown>>(`SELECT * FROM formal_publications WHERE article_id = ${articleId}`))[0] ?? null
}

async function events(articleId: number) {
  return query<Record<string, unknown>>(`SELECT * FROM publish_events WHERE article_id = ${articleId}`)
}

async function outboxRows(articleId: number) {
  return query<Record<string, unknown>>(`SELECT * FROM publish_outbox WHERE article_id = ${articleId}`)
}

describe('lib/first-publish — first formal publish', { timeout: 600_000 }, () => {
  it('四阻塞项：任一阻塞项失败都阻止准备；全部通过才可确认', async () => {
    // B1 saved — confirmed version is not the latest server version.
    const a = await createDraftArticle(fresh('b1-slug'))
    const b1 = await prepareFor(a, { confirmedVersion: 2 })
    expect(b1.outcome).toBe('aborted')
    if (b1.outcome !== 'aborted') return
    expect(b1.failures).toContain('saved')
    expect(b1.blockers.saved).toBe(false)

    // B4 content — blank title (body exists) blocks. Mutate the frozen
    // snapshot (canonical), not the retired projection.
    await query(`UPDATE article_versions SET snapshot_json = json_set(snapshot_json, '$.fields.title', '') WHERE article_id = ${a.articleId} AND version = 1`)
    const b4 = await prepareFor(a, { title: '' })
    expect(b4.outcome).toBe('aborted')
    if (b4.outcome !== 'aborted') return
    expect(b4.failures).toContain('content')

    // Restore content; B3 slug — a rival article owns the address in the registry.
    await query(`UPDATE article_versions SET snapshot_json = json_set(snapshot_json, '$.fields.title', '待发布标题') WHERE article_id = ${a.articleId} AND version = 1`)
    const rivalSlug = fresh('rival')
    await query(`INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at) VALUES ('${rivalSlug}', 987654, 'candidate', strftime('%s','now'), strftime('%s','now'))`)
    const b3 = await prepareFor(a, { slug: rivalSlug })
    expect(b3.outcome).toBe('aborted')
    if (b3.outcome !== 'aborted') return
    expect(b3.failures).toContain('slug')

    // B2 lifecycle — a formally published article can never first-publish again.
    const c = await createDraftArticle(fresh('b2-slug'))
    const prep = await prepareFor(c)
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return
    const delivered = await confirmFor(c, { intentId: fresh('intent'), prepareId: prep.prepareId, version: 1 })
    expect(delivered.outcome).toBe('delivered')
    const b2 = await prepareFor(c)
    expect(b2.outcome).toBe('aborted')
    if (b2.outcome !== 'aborted') return
    expect(b2.failures).toContain('lifecycle')

    // All blockers pass → prepared and confirm delivers the exact version.
    const d = await createDraftArticle(fresh('allpass-slug'))
    const ok = await prepareFor(d)
    expect(ok.outcome).toBe('prepared')
    if (ok.outcome !== 'prepared') return
    expect(ok.blockers).toEqual({ saved: true, lifecycle: true, slug: true, content: true })
    const okConfirm = await confirmFor(d, { intentId: fresh('intent'), prepareId: ok.prepareId, version: 1 })
    expect(okConfirm.outcome).toBe('delivered')
    if (okConfirm.outcome !== 'delivered') return
    expect(okConfirm.version).toBe(1)
    expect(okConfirm.publicUrl).toBe(`${SITE_URL}/${d.slug}`)
    expect(okConfirm.firstPublishedAt).toBe(okConfirm.publishedAt)
  })

  it('确认期间版本变化：prepare 后落地的后续编辑不会被顺带发布', async () => {
    const article = await createDraftArticle(fresh('mv-slug'), '基底', '基底正文')
    // Prepare on v1, then a later save makes v2 the latest before confirm.
    const prep = await prepareFor(article)
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return

    const saved = await publishTemp(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      currentStatus: 'draft',
      operationId: fresh('mv-save'),
      status: 'published',
    })
    expect(saved.outcome).toBe('applied')

    // A later edit (v2) lands before confirm.
    const save = await import('@/lib/article-commands').then((m) => m.save)
    const saved2 = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 2,
      operationId: fresh('mv-save2'),
      snapshot: {
        slug: article.slug,
        title: '被编辑的后续版本',
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
    expect(saved2.outcome).toBe('applied')

    // Confirm of the OLD prepared plan (v1) must be refused — only the
    // confirmed version (v2 snapshot, not v1) may be promoted.
    const confirm = await confirmFor(article, { intentId: fresh('intent'), prepareId: prep.prepareId, version: 1 })
    expect(confirm.outcome).toBe('conflict')
    if (confirm.outcome !== 'conflict') return
    expect(confirm.serverVersion).toBe(3)
    expect(confirm.reason).toBe('version-moved')

    // Zero partial online facts: the confirmed v1 must NOT be public.
    expect(await formalFacts(article.articleId)).toBeNull()
    expect(await events(article.articleId)).toEqual([])
    expect(await outboxRows(article.articleId)).toEqual([])
  })

  it('重复确认：同一意图最多一个事件、一个 Outbox、一条正式版本行', async () => {
    const article = await createDraftArticle(fresh('dup-slug'))
    const prep = await prepareFor(article)
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return

    const intentId = fresh('intent')
    const first = await confirmFor(article, { intentId, prepareId: prep.prepareId, version: 1 })
    expect(first.outcome).toBe('delivered')

    const replay = await confirmFor(article, { intentId, prepareId: prep.prepareId, version: 1 })
    expect(replay.outcome).toBe('replayed')
    if (replay.outcome !== 'replayed') return
    expect(replay.eventId).toBe(first.outcome === 'delivered' ? first.eventId : '')

    expect((await events(article.articleId)).length).toBe(1)
    expect((await outboxRows(article.articleId)).length).toBe(1)
    expect((await formalFacts(article.articleId))?.version).toBe(1)
  })

  it('事务中断：批量中途失败回滚全部事实，零部分上线', async () => {
    const article = await createDraftArticle(fresh('interrupt-slug'))
    const prep = await prepareFor(article)
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return

    // Simulate a dirty partial state left by an earlier interrupted run: an
    // event row already exists for this intent (same deterministic event id).
    const intentId = fresh('intent')
    const dirtyEventId = `event:${intentId}`
    const zero = '0'.repeat(64)
    await query(
      `INSERT INTO publish_events
         (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at, evidence_sha256, payload, created_at)
       VALUES ('${dirtyEventId}', '${intentId}', ${article.articleId}, 1, '${article.slug}', 'published', 1, '${zero}', '{}', 1)`,
    )

    const confirm = await confirmFor(article, { intentId, prepareId: prep.prepareId, version: 1 })
    // The batch hits the UNIQUE(intent_id) on the dirty event and MUST abort.
    expect(confirm.outcome).toBe('aborted')

    // Zero new partial facts: no formal row, no intent, no outbox.
    expect(await formalFacts(article.articleId)).toBeNull()
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_intents WHERE intent_id = '${intentId}'`)).toEqual([])
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_outbox WHERE article_id = ${article.articleId}`)).toEqual([])
    // Only the pre-existing dirty event row remains; the prepare is untouched.
    expect(await events(article.articleId)).toHaveLength(1)
    const prepareAfter = await readPublicationState(createDatabase(), article.articleId)
    expect(prepareAfter.prepare?.status).toBe('prepared')

    // A fresh intent for the same article still works cleanly after the abort.
    const retryPrep = await prepareFor(article)
    expect(retryPrep.outcome).toBe('prepared')
    if (retryPrep.outcome !== 'prepared') return
    const retry = await confirmFor(article, { intentId: fresh('intent'), prepareId: retryPrep.prepareId, version: 1 })
    expect(retry.outcome).toBe('delivered')
  })

  it('slug 冲突：confirm 前他人抢占 slug 时拒绝并无部分写入', async () => {
    const article = await createDraftArticle(fresh('slug-conflict'))
    const prep = await prepareFor(article)
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return

    // The article's own registry address is handed to a rival article between
    // prepare and confirm (simulating a concurrent claim).
    await query(`UPDATE article_slug_addresses SET article_id = 987654, kind = 'candidate' WHERE slug = '${article.slug}'`)

    const confirm = await confirmFor(article, { intentId: fresh('intent'), prepareId: prep.prepareId, version: 1 })
    expect(confirm.outcome).toBe('slug-conflict')
    if (confirm.outcome !== 'slug-conflict') return
    expect(confirm.slug).toBe(article.slug)

    expect(await formalFacts(article.articleId)).toBeNull()
    expect(await events(article.articleId)).toEqual([])
    expect(await outboxRows(article.articleId)).toEqual([])
  })

  it('重复 Outbox：每个事件至多一个 Outbox；交付幂等且回执绑定事件', async () => {
    const article = await createDraftArticle(fresh('outbox-slug'), 'Outbox 标题', 'Outbox 正文')
    const prep = await prepareFor(article)
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return

    const confirm = await confirmFor(article, { intentId: fresh('intent'), prepareId: prep.prepareId, version: 1 })
    expect(confirm.outcome).toBe('delivered')
    if (confirm.outcome !== 'delivered') return

    // Exactly one outbox row for the event.
    const rows = await outboxRows(article.articleId)
    expect(rows).toHaveLength(1)
    const outbox = rows[0] as { event_id: string; status: string; attempts: number }
    expect(outbox.event_id).toBe(confirm.eventId)
    expect(outbox.status).toBe('pending')
    expect(outbox.attempts).toBe(0)

    // Dispatch delivers the queue; only THIS article's row is captured by the
    // scoped handler, and a second dispatch re-sends nothing.
    const deliveredIds: string[] = []
    const deliver = async (row: { event_id: string }) => {
      if (row.event_id === confirm.eventId) deliveredIds.push(row.event_id)
    }
    const firstDispatch = await dispatchOutbox(createDatabase(), { deliver })
    expect(firstDispatch.delivered).toBeGreaterThanOrEqual(1)
    expect(deliveredIds).toEqual([confirm.eventId])
    const secondDispatch = await dispatchOutbox(createDatabase(), { deliver })
    expect(secondDispatch.delivered).toBe(0)
    expect(deliveredIds).toEqual([confirm.eventId])
    const afterDispatch = (await query<Record<string, unknown>>(`SELECT * FROM publish_outbox WHERE article_id = ${article.articleId}`))[0] as { status: string; attempts: number }
    expect(afterDispatch.status).toBe('delivered')
    expect(afterDispatch.attempts).toBe(1)

    // The independent blog receipt binds to the event that produced the address.
    const receiptPayload = JSON.stringify({
      verified: true,
      url: confirm.publicUrl,
      fetchedVersion: confirm.version,
    })
    const receipt = await recordReceipt(createDatabase(), { eventId: confirm.eventId, verified: true, receiptPayload })
    expect(receipt.outcome).toBe('recorded')
    const replayReceipt = await recordReceipt(createDatabase(), { eventId: confirm.eventId, verified: true, receiptPayload })
    expect(replayReceipt.outcome).toBe('replayed')

    const state = await readPublicationState(createDatabase(), article.articleId)
    const receiptRow = state.receipt
    expect(receiptRow).not.toBeNull()
    expect(receiptRow?.event_id).toBe(confirm.eventId)
    expect(receiptRow?.public_url).toBe(confirm.publicUrl)
    expect(JSON.parse(receiptRow?.receipt_payload ?? '{}')).toEqual({ verified: true, url: confirm.publicUrl, fetchedVersion: 1 })
    expect(state.formal?.public_url).toBe(confirm.publicUrl)
  })

  it('草稿不伪造正式版本：legacy 状态切换不写正式事实，取消准备可回收', async () => {
    const article = await createDraftArticle(fresh('legacy-slug'))
    const pub = await publishTemp(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      currentStatus: 'draft',
      operationId: fresh('legacy-pub'),
      status: 'published',
    })
    expect(pub.outcome).toBe('applied')

    // The legacy switch touched posts status only — no formal facts.
    expect(await formalFacts(article.articleId)).toBeNull()
    expect(await events(article.articleId)).toEqual([])
    expect(await outboxRows(article.articleId)).toEqual([])

    // A prepare for the same draft still works after the legacy switch (the
    // legacy publishTemp advanced the version to 2 — prepare THAT version), and
    // the confirm writes the REAL first-publish facts (the draft never faked
    // them).
    const prep = await prepareFor(article, { confirmedVersion: 2 })
    expect(prep.outcome).toBe('prepared')
    if (prep.outcome !== 'prepared') return
    const confirm = await confirmFor(article, { intentId: fresh('intent'), prepareId: prep.prepareId, version: 2 })
    expect(confirm.outcome).toBe('delivered')
    if (confirm.outcome !== 'delivered') return
    expect(confirm.firstPublishedAt).toBeTruthy()
    expect(await formalFacts(article.articleId)).not.toBeNull()

    // Cancelling a fresh prepare frees the plan for the next author decision.
    const article2 = await createDraftArticle(fresh('cancel-slug'))
    const prep2 = await prepareFor(article2)
    expect(prep2.outcome).toBe('prepared')
    if (prep2.outcome !== 'prepared') return
    const cancelled = await cancelPrepare(createDatabase(), prep2.prepareId, 'b301-fixture')
    expect(cancelled).toEqual({ outcome: 'cancelled' })
    const afterCancel = await readPublicationState(createDatabase(), article2.articleId)
    expect(afterCancel.prepare?.status).toBe('aborted')
    expect(await formalFacts(article2.articleId)).toBeNull()
  })

  it('actor 缺席或参数非法时拒绝，不写任何事实', async () => {
    const article = await createDraftArticle(fresh('invalid-slug'))
    const invalid = await preparePublish(createDatabase(), {
      prepareId: 'p',
      articleId: article.articleId,
      confirmedVersion: -1,
      slug: article.slug,
      title: 'x',
      contentSha256: sha256('x'),
      actor: 'b301-fixture',
    })
    expect(invalid).toEqual({ outcome: 'invalid', reason: expect.stringContaining('confirmedVersion') })
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_prepares WHERE article_id = ${article.articleId}`)).toEqual([])
  })
})