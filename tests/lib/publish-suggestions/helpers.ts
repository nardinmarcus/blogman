/**
 * B3-06 — publish-suggestion test helpers (issue #38).
 *
 * Reuses the shared in-process Miniflare bootstrap (one workerd instance per
 * suite, zero wrangler CLI spawns) and layers the suggestion fact tables on top
 * via the module's own idempotent DDL — exactly what the DDL channel does.
 * A formally published article fixture is produced through the REAL first-publish
 * loop, and drafts through the write kernel, so suggestions can be anchored to
 * real formal facts + revisions.
 */

import { createHash } from 'node:crypto'
import { bootstrapState, createDatabase, query } from '@/tests/lib/article-commands/helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'
import { ensurePublishRevisionTables } from '@/lib/publish-revision/ddl'
import { ensureSlugAddressTables } from '@/lib/slug-address'
import { ensurePublishSuggestionsTables } from '@/lib/publish-suggestions/ddl'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

export { bootstrapState, createDatabase, query }

/** Boot the identity + first-publish + revision + slug-address + suggestions schema. */
export async function bootstrapSuggestionState(stateDir: string): Promise<void> {
  await bootstrapState(stateDir)
  await ensureFirstPublishTables(createDatabase())
  await ensurePublishRevisionTables(createDatabase())
  await ensureSlugAddressTables(createDatabase())
  await ensurePublishSuggestionsTables(createDatabase())
}

/** Canonical sha256 of a body string. */
export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function freshSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
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

/** Create a draft article through the write kernel (stays a draft; v1 fact). */
export async function createDraftArticle(
  slug = freshSlug('suggest-draft'),
  title = '草稿标题',
  content = '# 草稿正文\n\n一段草稿。',
): Promise<{ articleId: number; postRef: number; slug: string }> {
  const snapshot = snapshotFor(slug, title, content)
  const created = await create(createDatabase(), { creationId: `draft-${slug}`, snapshot })
  if (created.outcome !== 'created') throw new Error(`createDraftArticle failed: ${JSON.stringify(created)}`)
  return { articleId: created.articleId, postRef: created.postRef, slug }
}

/** Create a draft then formally FIRST-publish it (the B3-01 loop). */
export async function createFormalArticle(
  slug = freshSlug('suggest-formal'),
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
    actor: 'b306-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`createFormalArticle prepare failed: ${JSON.stringify(prepared)}`)

  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${slug}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b306-fixture',
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`createFormalArticle confirm failed: ${JSON.stringify(confirmed)}`)

  return { articleId, postRef: created.postRef, slug }
}
