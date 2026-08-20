/**
 * B5-01 — WeChat draft isolated-D1 fixtures (issue #46).
 *
 * One shared in-process Miniflare instance (real D1 binding, zero wrangler CLI
 * spawns) bootstrapped over the revision-loop base (identity + first-publish
 * + revision + slug-address) and layered with the new `wechat_draft_tasks`
 * table through the module's idempotent DDL — exactly what the DDL channel
 * does. A formally published article is produced through the REAL first-publish
 * loop, and a version switch through the REAL revision-save + promotion loop,
 * so derivations are anchored to genuine frozen version facts.
 */

import { bootstrapRevisionState, createDatabase, query, sha256 } from '@/tests/lib/publish-revision/helpers'
import { ensureWechatDraftTables } from '@/lib/wechat-draft/ddl'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import { save } from '@/lib/article-commands'
import { promoteRevision } from '@/lib/publish-revision'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

export { bootstrapRevisionState, createDatabase, query, sha256 }

export const TEST_SITE_URL = 'https://blog.example.test'

export function expectSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`expected a 64-hex sha256, got: ${value}`)
  }
}

/** Boot the revision base then the WeChat draft tables (DDL runs twice: idempotency). */
export async function bootstrapWechatDraftState(stateDir: string): Promise<void> {
  await bootstrapRevisionState(stateDir)
  await ensureWechatDraftTables(createDatabase())
  await ensureWechatDraftTables(createDatabase())
}

export interface CreatedFormalArticle {
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

function formalSnapshot(slug: string, title: string, content: string): ArticleCommandSnapshot {
  return {
    ...snapshotFor(slug, title, content),
    status: 'published',
    published_at: 1_700_000_000,
  }
}

/** Create a draft then formally FIRST-publish it (the B3-01 loop) at version 1. */
export async function createFormalArticle(
  slug = `wx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title = '正式文章标题',
  content = '# 正式正文\n\n一段正式正文。',
): Promise<CreatedFormalArticle> {
  const snapshot = formalSnapshot(slug, title, content)
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
    actor: 'b501-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`createFormalArticle prepare failed: ${JSON.stringify(prepared)}`)

  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${slug}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b501-fixture',
    siteUrl: TEST_SITE_URL,
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`createFormalArticle confirm failed: ${JSON.stringify(confirmed)}`)

  return { articleId, postRef: created.postRef, slug }
}

let opSeq = 0
function freshOp(prefix: string): string {
  opSeq += 1
  return `${prefix}-${Date.now()}-${opSeq}`
}

export interface PromotedArticle {
  articleId: number
  postRef: number
  slug: string
  version: 2
}

/** Edit the formal article and promote the revision — the formal version moves 1 → 2. */
export async function promoteToVersion2(
  article: CreatedFormalArticle,
  title = '升级后的标题',
  content = '# 升级正文\n\n升级后的正式正文。',
): Promise<PromotedArticle> {
  const saved = await save(createDatabase(), {
    articleId: article.articleId,
    expectedVersion: 1,
    operationId: freshOp('b501-save'),
    snapshot: formalSnapshot(article.slug, title, content),
  })
  if (saved.outcome !== 'applied') throw new Error(`promoteToVersion2 save failed: ${JSON.stringify(saved)}`)

  const promoted = await promoteRevision(createDatabase(), {
    revisionId: `revision:${article.articleId}:v1`,
    actor: 'b501-fixture',
    siteUrl: TEST_SITE_URL,
  })
  if (promoted.outcome !== 'promoted') throw new Error(`promoteToVersion2 failed: ${JSON.stringify(promoted)}`)

  return { articleId: article.articleId, postRef: article.postRef, slug: article.slug, version: 2 }
}

