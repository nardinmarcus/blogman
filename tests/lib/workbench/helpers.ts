/**
 * B4-04 — isolated-D1 fixtures (issue #43).
 *
 * One shared in-process Miniflare instance layering the article-commands base,
 * the first-publish fact tables, scheduled-publish, and the new workbench +
 * notification tables through each module's idempotent DDL — exactly what the
 * DDL channel does. Drafts / formal articles are produced through the REAL
 * write + first-publish loops; schedules through the real schedule kernel.
 */

import { bootstrapState, createDatabase, query, teardownState } from '@/tests/lib/article-commands/helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'
import { ensureScheduledPublishTables } from '@/lib/scheduled-publish/ddl'
import { ensureWorkbenchTables } from '@/lib/workbench/ddl'
import { ensureNotificationTables } from '@/lib/notifications/ddl'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

export { bootstrapState, createDatabase, query, teardownState }

export interface CreatedArticle {
  articleId: number
  postRef: number
  slug: string
}

function snapshotFor(slug: string, title: string, content: string): ArticleCommandSnapshot {
  return {
    slug,
    title,
    content,
    html: `<p>${content}</p>`,
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
  }
}

/** Boot identity + first-publish + scheduled + workbench + notification schema (DDL runs twice: idempotency). */
export async function bootstrapB404State(stateDir: string): Promise<void> {
  await bootstrapState(stateDir)
  await ensureFirstPublishTables(createDatabase())
  await ensureScheduledPublishTables(createDatabase())
  await ensureWorkbenchTables(createDatabase())
  await ensureNotificationTables(createDatabase())
  // idempotency re-run
  await ensureScheduledPublishTables(createDatabase())
  await ensureWorkbenchTables(createDatabase())
  await ensureNotificationTables(createDatabase())
}

/** Create a draft article through the write kernel (stays a draft; v1 fact). */
export async function createDraftArticle(
  slug: string,
  title = '草稿标题',
  content = '# 草稿正文\n\n一段草稿。',
): Promise<CreatedArticle> {
  const snapshot = snapshotFor(slug, title, content)
  const created = await create(createDatabase(), { creationId: `draft-${slug}`, snapshot })
  if (created.outcome !== 'created') throw new Error(`createDraftArticle failed: ${JSON.stringify(created)}`)
  return { articleId: created.articleId, postRef: created.postRef, slug }
}

/** Create a draft then formally FIRST-publish it (B3-01 loop). */
export async function createFormalArticle(
  slug: string,
  title = '正式文章标题',
  content = '# 正式正文\n\n一段正式正文。',
): Promise<{ articleId: number; postRef: number; slug: string }> {
  const snapshot = snapshotFor(slug, title, content)
  const created = await create(createDatabase(), { creationId: `formal-${slug}`, snapshot })
  if (created.outcome !== 'created') throw new Error(`createFormalArticle create failed: ${JSON.stringify(created)}`)

  const articleId = created.articleId
  const hashRow = (await query<{ content_snapshot_sha256: string | null }>(
    `SELECT content_snapshot_sha256 FROM article_versions
     WHERE article_id = ${articleId} AND version = 1 ORDER BY id DESC LIMIT 1`,
  ))[0]
  const prepared = await preparePublish(createDatabase(), {
    prepareId: `prep-${slug}`,
    articleId,
    confirmedVersion: 1,
    slug,
    title,
    contentSha256: hashRow?.content_snapshot_sha256 ?? '',
    actor: 'b404-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`createFormalArticle prepare failed: ${JSON.stringify(prepared)}`)

  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${slug}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b404-fixture',
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`createFormalArticle confirm failed: ${JSON.stringify(confirmed)}`)

  return { articleId, postRef: created.postRef, slug }
}
