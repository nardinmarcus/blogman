/**
 * B3-01 — first-publish test helpers (issue #33).
 *
 * Reuses the B2-03 shared in-process Miniflare bootstrap (one workerd instance
 * per suite, zero wrangler CLI spawns) and layers the six first-publish fact
 * tables on top via the module's own idempotent DDL — exactly what the route
 * path does in production.
 */

import { createHash } from 'node:crypto'
import { bootstrapState, createDatabase, query, teardownState } from '@/tests/lib/article-commands/helpers'
import { create } from '@/lib/article-commands'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

export { bootstrapState, createDatabase, query, teardownState }

export interface CreatedArticle {
  articleId: number
  postRef: number
  slug: string
}

/** Canonical sha256 of a body string (prepared evidence value). */
export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * Create a draft article through the real version kernel (v1) with a known
 * slug, so the publication fixture has real version facts to publish.
 */
export async function createDraftArticle(
  slug: string,
  title = '待发布标题',
  content = '# 正文\n\n一段正文。',
): Promise<CreatedArticle> {
  const snapshot: ArticleCommandSnapshot = {
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
  const result = await create(createDatabase(), { creationId: `fixture-${slug}`, snapshot })
  if (result.outcome !== 'created') throw new Error(`createDraftArticle failed: ${JSON.stringify(result)}`)
  return { articleId: result.articleId, postRef: result.postRef, slug }
}