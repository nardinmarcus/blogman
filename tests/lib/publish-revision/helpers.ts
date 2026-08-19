/**
 * B3-02 — publish-revision test helpers (issue #34).
 *
 * Reuses the shared in-process Miniflare bootstrap (one workerd instance per
 * suite, zero wrangler CLI spawns) and layers the three revision fact tables on
 * top via the module's own idempotent DDL — exactly what the route path does.
 * A formally published article fixture is produced through the REAL first-publish
 * loop (prepare + confirm), so the revision writes are anchored to genuine
 * formal facts (formal_publications + article_versions + posts projection).
 */

import { createHash } from 'node:crypto'
import { bootstrapState, createDatabase, query } from '@/tests/lib/article-commands/helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'
import { ensurePublishRevisionTables } from '@/lib/publish-revision/ddl'
import { ensureSlugAddressTables } from '@/lib/slug-address'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

export { bootstrapState, createDatabase, query }

export interface CreatedFormalArticle {
  articleId: number
  postRef: number
  slug: string
}

/** Canonical sha256 of a body string. */
export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** Boot the identity + first-publish + revision + slug-address schema. */
export async function bootstrapRevisionState(stateDir: string): Promise<void> {
  await bootstrapState(stateDir)
  await ensureFirstPublishTables(createDatabase())
  await ensurePublishRevisionTables(createDatabase())
  await ensureSlugAddressTables(createDatabase())
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

/** Create a draft then formally FIRST-publish it (the B3-01 loop). */
export async function createFormalArticle(
  slug: string,
  title = '正式文章标题',
  content = '# 正式正文\n\n一段正式正文。',
): Promise<CreatedFormalArticle> {
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
    actor: 'b302-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`createFormalArticle prepare failed: ${JSON.stringify(prepared)}`)

  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${slug}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b302-fixture',
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`createFormalArticle confirm failed: ${JSON.stringify(confirmed)}`)

  return { articleId, postRef: created.postRef, slug }
}

let updateSeq = 0
export function freshOp(prefix: string): string {
  updateSeq += 1
  return `${prefix}-${Date.now()}-${updateSeq}`
}