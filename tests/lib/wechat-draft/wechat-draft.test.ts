/**
 * B5-01 — WeChat draft derivation test suite (issue #46), D1-backed.
 *
 * Proves the derivation contract from the EXACT frozen formal version:
 *
 *   - 同版本幂等   deriving the same version for the same account twice lands
 *                 in ONE row with the SAME deterministic task id; the replay
 *                 reports `existing` and never re-submits to the provider,
 *   - 版本切换后重新派生 after promoting the formal version 1 → 2, re-deriving
 *                 creates a NEW task for version 2 (different task id), the
 *                 older version's task is superseded, and history is retained,
 *   - 投影保真     the stored body is exactly the frozen version's WeChat
 *                 projection — title / html fragment / plaintext / cover /
 *                 digest / source URL / content sha / projection sha all
 *                 match an independently computed projection,
 *   - 账号隔离     同版本不同账号 → separate tasks (account is part of the
 *                 binding identity),
 *   - 零生产      no provider bound ⇒ the in-DB draft is created and NO
 *                 external call happens; with a mock provider the exact
 *                 payload is recorded and the draft is never published,
 *   - 只对正式版本  a non-formal article or a not-yet-published version is
 *                 rejected (not-found) without writing any fact.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse, plainText } from '@/lib/content-envelope'
import { resolvePostCoverImage } from '@/lib/default-cover-images'
import {
  bootstrapWechatDraftState,
  createDatabase,
  createFormalArticle,
  promoteToVersion2,
  query,
  TEST_SITE_URL,
  expectSha256,
} from './helpers'
import { MockWechatDraftProvider } from '@/lib/wechat-draft/provider'
import { deriveWechatDraft, projectWechatDraft, projectionDigest, wechatDraftTaskIdFor, listWechatDraftTasks } from '@/lib/wechat-draft'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b501-wechat-draft-'))
  cleanup.push(state)
  await bootstrapWechatDraftState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

const ACCOUNT = 'official-account-a'

async function frozenSnapshot(articleId: number, version: number): Promise<ArticleIdentitySnapshot> {
  const row = (await query<{ snapshot_json: string; content_snapshot_sha256: string }>(
    `SELECT snapshot_json, content_snapshot_sha256 FROM article_versions
     WHERE article_id = ${articleId} AND version = ${version} ORDER BY id DESC LIMIT 1`,
  ))[0]
  expect(row).toBeTruthy()
  const snapshot = JSON.parse(row!.snapshot_json) as ArticleIdentitySnapshot
  snapshot.content_snapshot_sha256 = snapshot.content_snapshot_sha256 ?? row!.content_snapshot_sha256
  return snapshot
}

describe('lib/wechat-draft — 从精确正式版本派生微信公众号草稿', { timeout: 600_000 }, () => {
  it('同版本幂等: 同一版本重复派生返回同一草稿（operation id）', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const first = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return
    expect(first.created).toBe(true)
    expect(first.taskId).toBe(wechatDraftTaskIdFor(article.articleId, 1, ACCOUNT))

    const replay = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(replay.outcome).toBe('existing')
    if (replay.outcome !== 'existing') return
    expect(replay.created).toBe(false)
    expect(replay.taskId).toBe(first.taskId)
    expect(replay.task.id).toBe(first.task.id)

    const rows = await query<{ task_id: string; status: string }>(
      `SELECT task_id, status FROM wechat_draft_tasks
       WHERE article_id = ${article.articleId} AND account_id = '${ACCOUNT}'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.task_id).toBe(first.taskId)
    expect(rows[0]?.status).toBe('draft')
  })

  it('版本切换后重新派生: 新版本生成新草稿，旧版本任务标记 superseded，历史保留', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const v1 = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(v1.outcome).toBe('created')
    if (v1.outcome !== 'created') return

    const promoted = await promoteToVersion2(article, '升级后的标题', '# 升级正文\n\n升级后的正式正文。')

    const v2 = await deriveWechatDraft(db, {
      articleId: promoted.articleId,
      version: 2,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(v2.outcome).toBe('created')
    if (v2.outcome !== 'created') return
    expect(v2.taskId).not.toBe(v1.taskId)
    expect(v2.task.title).toBe('升级后的标题')

    // The derived content follows the NEW frozen version, not the old one.
    expect(v2.task.plaintext_projection).toContain('升级后的正式正文')
    expect(v2.task.plaintext_projection).not.toContain('一段正式正文')

    // History retained: v1 task preserved but superseded; only v2 is live.
    const rows = await query<{ version: number; status: string }>(
      `SELECT version, status FROM wechat_draft_tasks
       WHERE article_id = ${article.articleId} AND account_id = '${ACCOUNT}' ORDER BY version`,
    )
    expect(rows.map((r) => r.version)).toEqual([1, 2])
    expect(rows[0]?.status).toBe('superseded')
    expect(rows[1]?.status).toBe('draft')

    // Re-deriving v1 after v2 is live is rejected — the live target is the
    // newer version; the historical v1 task stays superseded (never a second
    // live draft for the same account).
    const v1Again = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(v1Again.outcome).toBe('not-found')
    if (v1Again.outcome !== 'not-found') return
    expect(v1Again.reason).toContain('newer version is already derived')
    expect(await query<{ id: number }>(`SELECT id FROM wechat_draft_tasks WHERE article_id = ${article.articleId} AND version = 1`)).toHaveLength(1)
  })

  it('投影保真: 存储体精确等于冻结版本的微信适配投影', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const result = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return

    const snapshot = await frozenSnapshot(article.articleId, 1)
    const sourceUrl = (await query<{ public_url: string }>(
      `SELECT public_url FROM formal_publications WHERE article_id = ${article.articleId}`,
    ))[0].public_url
    const expected = projectWechatDraft(snapshot, { sourceUrl, siteUrl: TEST_SITE_URL })
    const expectedDigest = projectionDigest(expected, snapshot.content_snapshot_sha256 ?? '')

    const task = result.task
    expect(task.title).toBe(expected.title)
    expect(task.html_projection).toBe(expected.html)
    expect(task.plaintext_projection).toBe(expected.plaintext)
    expect(task.cover_image_url).toBe(expected.coverImageUrl)
    expect(task.digest).toBe(expected.digest)
    expect(task.source_url).toBe(expected.sourceUrl)
    expect(task.content_sha256).toBe(snapshot.content_snapshot_sha256)
    expect(task.projection_sha256).toBe(expectedDigest)
    expect(task.status).toBe('draft')
    expectSha256(task.content_sha256)
    expectSha256(task.projection_sha256)

    // Concrete body checks: the WeChat export fragment structure + escaped title.
    expect(task.html_projection).toContain('<section class="wechat-export-root">')
    expect(task.html_projection).toContain('<p class="wechat-export-title">')
    expect(task.html_projection).toContain(`<div class="wechat-export-content">`)
    expect(task.html_projection).toContain('一段正式正文')

    // Plaintext is the envelope's plain-text projection, digest capped to 120 chars.
    const envelope = parse({ markdown: '# 正式正文\n\n一段正式正文。' })
    expect(task.plaintext_projection).toBe(plainText(envelope))
    expect([...task.digest!].length).toBeLessThanOrEqual(120)

    // Cover falls back to the deterministic default cover on the site origin.
    const expectedCover = resolvePostCoverImage(
      { slug: article.slug, title: '正式文章标题', cover_image: null },
      { baseUrl: TEST_SITE_URL },
    )
    expect(task.cover_image_url).toBe(expectedCover)
    expect(task.cover_image_url).toMatch(/^https:\/\/blog\.example\.test\/default-covers\//)
  })

  it('账号隔离: 同版本不同账号派生为独立任务，互不覆盖', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const a = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: 'official-a',
      siteUrl: TEST_SITE_URL,
    })
    const b = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: 'official-b',
      siteUrl: TEST_SITE_URL,
    })
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('created')
    if (a.outcome !== 'created' || b.outcome !== 'created') return
    expect(a.taskId).not.toBe(b.taskId)
    expect(a.task.id).not.toBe(b.task.id)

    const rows = await listWechatDraftTasks(db, article.articleId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.account_id))).toEqual(new Set(['official-a', 'official-b']))
  })

  it('零生产: 无 provider 注入时只建草稿，不发生任何外部调用', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const result = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.task.remote_draft_id).toBeNull()
    expect(result.task.status).toBe('draft')
    expect(result.task.provider_error).toBeNull()
  })

  it('provider 接口: 新派生调用一次 mock，payload 精确；重复派生不再调 provider', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider()

    const first = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(first.outcome).toBe('submitted')
    if (first.outcome !== 'submitted') return
    expect(provider.totalCalls).toBe(1)
    expect(first.task.status).toBe('submitted')
    expect(first.task.remote_draft_id).toBe('mock-draft-1')

    // The payload handed to the WeChat draft box is the exact projection.
    const payload = provider.submitted[0]
    expect(payload.taskId).toBe(first.taskId)
    expect(payload.articleId).toBe(article.articleId)
    expect(payload.version).toBe(1)
    expect(payload.accountId).toBe(ACCOUNT)
    expect(payload.title).toBe('正式文章标题')
    expect(payload.html).toBe(first.task.html_projection)
    expect(payload.plaintext).toBe(first.task.plaintext_projection)
    expect(payload.contentSha256).toBe(first.task.content_sha256)
    expect(payload.sourceUrl).toBe(`https://blog.example.test/${article.slug}`)

    // Idempotent replay — the remote draft is NOT re-submitted.
    const replay = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(replay.outcome).toBe('existing')
    if (replay.outcome !== 'existing') return
    expect(provider.totalCalls).toBe(1)
    expect(replay.task.remote_draft_id).toBe('mock-draft-1')
  })

  it('provider 拒绝/抛错: 任务标记 failed 且错误被绑定、不发布', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([{ accepted: false, error: '接口暂时不可用' }])

    const result = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') return
    expect(result.task.status).toBe('failed')
    expect(result.task.provider_error).toContain('接口暂时不可用')
    expect(provider.submitted).toHaveLength(0)
  })

  it('不能回退: 新版本已派生后，再派生旧版本被拒绝且零写入', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    // Promote to v2 FIRST, then derive v2 — the live target for the account
    // is now the newer version.
    const promoted = await promoteToVersion2(article, '先升级', '# 升级正文\n\n先到新版本。')
    const newer = await deriveWechatDraft(db, {
      articleId: promoted.articleId,
      version: 2,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(newer.outcome).toBe('created')

    // Deriving the OLDER version afterwards must not create a second live
    // draft — it is rejected before any insert.
    const older = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(older.outcome).toBe('not-found')
    if (older.outcome !== 'not-found') return
    expect(older.reason).toContain('newer version is already derived')

    const rows = await query<{ id: number }>(`SELECT id FROM wechat_draft_tasks WHERE article_id = ${article.articleId}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(newer.outcome === 'created' ? newer.task.id : -1)
  })

  it('只对正式版本: 未发布版本与未正式发布的文章被拒且零写入', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    // A version beyond the current formal version is not frozen yet.
    const future = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 99,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(future.outcome).toBe('not-found')
    expect(future.outcome === 'not-found' && future.reason).toContain('not been formally published')

    // A pure draft article (never formally published) is not a target.
    const draft = await createDraftOnly(slugFor(article.slug))
    const notFormal = await deriveWechatDraft(db, {
      articleId: draft.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(notFormal.outcome).toBe('not-found')
    if (notFormal.outcome !== 'not-found') return
    expect(notFormal.reason).toContain('not a formally published')

    // Nothing was written for either rejected derivation.
    const rows = await query<{ id: number }>(`SELECT id FROM wechat_draft_tasks WHERE article_id = ${article.articleId}`)
    const draftRows = await query<{ id: number }>(`SELECT id FROM wechat_draft_tasks WHERE article_id = ${draft.articleId}`)
    expect(rows).toHaveLength(0)
    expect(draftRows).toHaveLength(0)
  })

  it('无效入参被拒绝: 空账号/空版本不写事实', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const badAccount = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: '  ',
    })
    expect(badAccount.outcome).toBe('invalid')

    const badVersion = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 0,
      accountId: ACCOUNT,
    })
    expect(badVersion.outcome).toBe('invalid')

    const rows = await query<{ id: number }>(`SELECT id FROM wechat_draft_tasks WHERE article_id = ${article.articleId}`)
    expect(rows).toHaveLength(0)
  })
})

/** Create a draft-only article through the write kernel (never formally published). */
async function createDraftOnly(slug: string) {
  const { create } = await import('@/lib/article-commands') as typeof import('@/lib/article-commands')
  const created = await create(createDatabase(), {
    creationId: `draft-only-${slug}`,
    snapshot: {
      slug,
      title: '纯草稿标题',
      content: '# 草稿正文',
      html: '<p>草稿正文</p>',
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
  if (created.outcome !== 'created') throw new Error(`createDraftOnly failed: ${JSON.stringify(created)}`)
  return { articleId: created.articleId, postRef: created.postRef }
}

function slugFor(prefix: string): string {
  return `${prefix}-draft-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}