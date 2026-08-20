/**
 * B8-05 — mobile full-page publish confirmation D1 integration tests (issue #64).
 *
 * Isolated Miniflare D1 (one shared instance, zero wrangler CLI spawns). Proves
 * the mobile publish path over the SHARED #33 first-publish / #34 revision
 * kernels through `confirmMobilePublish` (the same dispatcher the API route
 * calls):
 *
 *   - 首次发布: a draft confirms → single event + formal publication + blog
 *     receipt with the public address,
 *   - 重复提交: re-confirming the SAME exact publish replays (one event, never
 *     a double publish),
 *   - 版本变化: a version bump during confirmation aborts and returns conflict
 *     (no partial publish),
 *   - 修订上线: a formal article's active revision promotes through #34,
 *   - 回执事实: the combined receipt distinguishes 博客 / 排期 / 渠道 progress.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapRevisionState,
  createDatabase,
  query,
  createFormalArticle,
  freshOp,
} from '@/tests/lib/publish-revision/helpers'
import { createDraftArticle } from '@/tests/lib/first-publish/helpers'
import { ensureScheduledPublishTables } from '@/lib/scheduled-publish'
import { ensureWechatDraftTables } from '@/lib/wechat-draft'
import { save } from '@/lib/article-commands'
import { confirmMobilePublish, getMobilePublishConfirmation, readReceiptSurfaces } from '@/lib/mobile-publish'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
const cleanup: string[] = []
const T0 = 1_700_000_000
const SITE = 'https://blog.example.test'

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b805-mobile-publish-'))
  cleanup.push(state)
  await bootstrapRevisionState(state)
  await ensureScheduledPublishTables(createDatabase())
  await ensureWechatDraftTables(createDatabase())
}, 300_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await createDatabase().prepare('DELETE FROM formal_publications').run()
  await createDatabase().prepare('DELETE FROM publish_events').run()
  await createDatabase().prepare('DELETE FROM publish_prepares').run()
  await createDatabase().prepare('DELETE FROM publish_intents').run()
  await createDatabase().prepare('DELETE FROM publish_outbox').run()
  await createDatabase().prepare('DELETE FROM publish_promotions').run()
  await createDatabase().prepare('DELETE FROM publish_revisions').run()
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

async function countEvents(articleId: number): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
  return rows[0]?.c ?? 0
}

async function editedSnapshot(slug: string): Promise<ArticleCommandSnapshot> {
  return {
    slug,
    title: '修订后的标题',
    content: '# 修订正文\n\n已修订。',
    html: '<p>修订正文已修订。</p>',
    description: '修订描述',
    category: '分类',
    tags: ['乙'],
    status: 'published',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: 1,
    updated_at: null,
  }
}

const confirm = (articleId: number, expectedVersion: number, path: 'first' | 'revision') =>
  confirmMobilePublish(createDatabase(), {
    articleId,
    path,
    expectedVersion,
    actor: 'mobile-publish',
    siteUrl: SITE,
    now: T0,
  })

describe('mobile-publish — first publish confirm (#33 kernel)', { timeout: 600_000 }, () => {
  it('confirms a draft to a single event + formal publication + blog receipt', async () => {
    const { articleId, slug } = await createDraftArticle(fresh('m-a1'), '首篇标题', '# 首篇正文')

    const confirmation = await getMobilePublishConfirmation(createDatabase(), articleId)
    expect(confirmation).not.toBeNull()
    if (!confirmation) return
    expect(confirmation.path).toBe('first')
    expect(confirmation.canConfirm).toBe(true)
    expect(confirmation.exactVersion).toBe(1)

    const result = await confirm(articleId, 1, 'first')
    expect(result.outcome).toBe('delivered')
    if (result.outcome !== 'delivered') return
    expect(result.version).toBe(1)
    expect(result.publicUrl).toBe(`${SITE}/${slug}`)
    expect(result.eventId.length).toBeGreaterThan(0)

    // receipt blog surface is authoritative and carries the address.
    const blog = result.receipt.find((s) => s.key === 'blog')
    expect(blog?.present).toBe(true)
    expect(blog?.url).toContain(slug)

    // exactly one event + one formal publication.
    expect(await countEvents(articleId)).toBe(1)
    const formal = (await query<{ version: number }>(
      `SELECT version FROM formal_publications WHERE article_id = ${articleId}`,
    ))[0]
    expect(formal?.version).toBe(1)
  })

  it('re-submitting the SAME exact publish replays — never a double publish', async () => {
    const { articleId } = await createDraftArticle(fresh('m-a2'))

    const first = await confirm(articleId, 1, 'first')
    expect(first.outcome).toBe('delivered')

    const second = await confirm(articleId, 1, 'first')
    expect(second.outcome === 'replayed' || second.outcome === 'already-published').toBe(true)
    expect(await countEvents(articleId)).toBe(1)
  })

  it('a version bump during confirmation aborts and returns conflict (返回准备)', async () => {
    const { articleId, slug } = await createDraftArticle(fresh('m-a3'))

    // Load the confirmation, then the article version moves before the author confirms.
    await getMobilePublishConfirmation(createDatabase(), articleId)
    const bumped = await save(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: freshOp('m-drift'),
      snapshot: await editedSnapshot(slug),
    })
    expect(bumped.outcome).toBe('applied')

    const result = await confirm(articleId, 1, 'first') // page still held v1
    expect(result.outcome).toBe('conflict')
    if (result.outcome !== 'conflict') return
    expect(result.reason).toContain('版本已变化')
    expect(result.serverVersion).toBe(2)
    // no partial publish — zero events.
    expect(await countEvents(articleId)).toBe(0)
  })

  it('an already-published article with no revision yields already-published, not a duplicate', async () => {
    const { articleId } = await createFormalArticle(fresh('m-a4'))
    const confirmation = await getMobilePublishConfirmation(createDatabase(), articleId)
    expect(confirmation?.path).toBe('already')

    const result = await confirm(articleId, 1, 'revision')
    expect(result.outcome).toBe('already-published')
  })
})

describe('mobile-publish — revision promote (#34 kernel)', { timeout: 600_000 }, () => {
  it('promotes the active revision and returns a revision receipt', async () => {
    const article = await createFormalArticle(fresh('m-r1'))
    const saveResult = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('m-revision'),
      snapshot: await editedSnapshot(article.slug),
    })
    expect(saveResult.outcome).toBe('applied')
    if (saveResult.outcome !== 'applied') return

    const confirmation = await getMobilePublishConfirmation(createDatabase(), article.articleId)
    expect(confirmation?.path).toBe('revision')
    expect(confirmation?.revisionId).toBeTruthy()
    expect(confirmation?.canConfirm).toBe(true)
    expect(confirmation?.publicUrl).toBeTruthy()
    expect(confirmation?.exactVersion).toBe(1) // the revision number

    const result = await confirm(article.articleId, 1, 'revision')
    expect(result.outcome).toBe('delivered')
    if (result.outcome !== 'delivered') return
    // formal version advances 1 → 2.
    expect(result.version).toBe(2)
    expect(result.eventId.length).toBeGreaterThan(0)
    const blog = result.receipt.find((s) => s.key === 'blog')
    expect(blog?.url).toContain(article.slug)

    const formal = (await query<{ version: number }>(
      `SELECT version FROM formal_publications WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(formal?.version).toBe(2)
  })

  it('re-promoting the same revision replays (single promotion event)', async () => {
    const article = await createFormalArticle(fresh('m-r2'))
    await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('m-r2-save'),
      snapshot: await editedSnapshot(article.slug),
    })

    const first = await confirm(article.articleId, 1, 'revision')
    expect(first.outcome).toBe('delivered')

    const second = await confirm(article.articleId, 1, 'revision')
    expect(second.outcome === 'replayed' || second.outcome === 'already-published').toBe(true)
    const promos = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM publish_promotions WHERE article_id = ${article.articleId}`,
    )
    expect(promos[0]?.c ?? 0).toBe(1)
  })
})

describe('mobile-publish — receipt fact surfaces (博客 / 排期 / 渠道)', { timeout: 600_000 }, () => {
  it('distinguishes schedule and WeChat channel progress after a publish', async () => {
    const { articleId, slug, postRef } = await createDraftArticle(fresh('m-s1'), '排期渠道回执', '# 正文')
    await confirm(articleId, 1, 'first')

    // Independent schedule + WeChat channel facts for the published version.
    await createDatabase()
      .prepare(
        `INSERT INTO publish_schedules
           (schedule_id, article_id, version, scheduled_at, timezone, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'Asia/Shanghai', 'pending', ?, ?)`,
      )
      .bind(`sched-${slug}`, articleId, T0 + 100, T0, T0)
      .run()
    await createDatabase()
      .prepare(
        `INSERT INTO wechat_draft_tasks
           (task_id, article_id, post_ref, version, account_id, status, title, html_projection,
            plaintext_projection, content_sha256, projection_sha256, source_url, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'acct-a', 'submitted', 't', 'h', 'p', '', ?, 'https://blog.example.test/x', ?, ?)`,
      )
      .bind(`task-${slug}`, articleId, postRef, '0'.repeat(64), T0, T0)
      .run()

    const surfaces = await readReceiptSurfaces(createDatabase(), articleId, 1)
    expect(surfaces.map((s) => s.key)).toEqual(['blog', 'schedule', 'channel'])
    const blog = surfaces.find((s) => s.key === 'blog')!
    const schedule = surfaces.find((s) => s.key === 'schedule')!
    const channel = surfaces.find((s) => s.key === 'channel')!
    expect(blog.present).toBe(true)
    expect(blog.state).toBe('已上线')
    expect(schedule.present).toBe(true)
    expect(schedule.state).toBe('已排期')
    expect(channel.present).toBe(true)
    expect(channel.state).toBe('已递交')
  })

  it('reports absent schedule / channel as not present (never fabricated)', async () => {
    const { articleId } = await createDraftArticle(fresh('m-s2'))
    await confirm(articleId, 1, 'first')
    const surfaces = await readReceiptSurfaces(createDatabase(), articleId, 1)
    expect(surfaces[0].present).toBe(true) // blog always present after success
    expect(surfaces[1].present).toBe(false) // schedule absent
    expect(surfaces[1].state).toBe('未排期')
    expect(surfaces[2].present).toBe(false) // channel absent
    expect(surfaces[2].state).toBe('未生成')
  })
})
