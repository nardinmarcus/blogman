/**
 * B7-01 — Chrome 剪藏 command kernel (issue #57).
 *
 * The Chrome 剪藏 (clip) entry: normalize a source URL to an idempotent
 * identity, then either create the article + a pending `clip`-role source link
 * (首次剪藏) or return the existing article identity for比较 (重复剪藏, no
 * duplicate). A clip NEVER becomes the writable primary source — the link role
 * is `clip`, so the B6 primary-source chain (sync / write-back / conflict)
 * never treats a clipped page as the 主要源稿.
 *
 * Idempotency contract:
 *   - `creationId = clip:<identitySha256>` is DERIVED from the normalized URL,
 *     so repeated and CONCURRENT first clips of the same page share one key and
 *     the B2-03 create kernel's atomic `WHERE NOT EXISTS(draft_ref)` converges
 *     them onto exactly one article (并发首次只建一篇).
 *   - the source link uses the same derived `source:<creationId>` operation id
 *     → the D1 UNIQUE constraint converges onto one `clip`-role pending link.
 *   - a URL already live-linked to an EXISTING article returns `source-linked`
 *     (the owner's identity) instead of fabricating a second article.
 *
 * 无正文回填: an existing article is NEVER mutated — the `existing` /
 * `source-linked` paths return identity + version for comparison and do not
 * write the clip's title/body into the post.
 */

import { nanoid } from 'nanoid'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkHtml from 'remark-html'
import type { Database } from '@/lib/repositories/schema'
import { create, type ArticleCommandSnapshot } from '@/lib/article-commands'
import { normalizeSourceUrl } from '@/lib/source-identity'
import type { ClipArticleInput, ClipArticleResult } from './types'

/** Stable creation id for a clip = `clip:<sha256 of canonical URL>`. */
export function clipCreationId(url: string): string | null {
  const normalized = normalizeSourceUrl(url)
  if (!normalized) return null
  return `clip:${normalized.identitySha256}`
}

/** Stable, collision-resistant slug for a clip, derived from the canonical URL. */
export function clipSlug(url: string): string | null {
  const normalized = normalizeSourceUrl(url)
  if (!normalized) return null
  return `clip-${normalized.identitySha256.slice(0, 12)}`
}

/** Coerce a clip's raw page facts into a full authoring snapshot (draft-only). */
export async function createClippedSnapshot(
  input: ClipArticleInput,
): Promise<ArticleCommandSnapshot> {
  const title = (input.title ?? '').trim()
  const content = (input.content ?? '').trim()
  const providedHtml = (input.html ?? '').trim()
  const html = providedHtml || (content ? (await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content)).toString() : '')
  return {
    slug: clipSlug(input.url) ?? `clip-${nanoid(10)}`,
    title,
    content,
    html,
    description: title || content.split('\n')[0].slice(0, 200) || null,
    category: '未分类',
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

/**
 * The Chrome 剪藏 entry. Never builds a primary-source link; the clip link's
 * role is always `clip`. Repeats/concurrent first clips converge on one article.
 */
export async function clipArticle(
  db: Database,
  input: ClipArticleInput,
): Promise<ClipArticleResult> {
  const url = (input.url ?? '').trim()
  const creationId = clipCreationId(url)
  if (!creationId) return { outcome: 'invalid-source', url }

  const snapshot = await createClippedSnapshot(input)
  if (snapshot.title === '' && snapshot.content === '') {
    return { outcome: 'skipped', reason: 'blank-session' }
  }

  // Only the Chrome clip entry produces a `clip`-role source link — Agent/API
  // create-with-source stays `primary` in the B6 kernel. The clip is therefore
  // the sole producer of this 参考来源关系.
  const result = await create(db, {
    creationId,
    snapshot,
    source: { url, role: 'clip' },
    projections: input.projections,
  })

  if (result.outcome === 'created') {
    return {
      outcome: 'created',
      existing: false,
      articleId: result.articleId,
      postRef: result.postRef,
      version: result.version,
      creationId,
      source: result.source!,
    }
  }
  if (result.outcome === 'existing') {
    return {
      outcome: 'existing',
      existing: true,
      articleId: result.articleId,
      postRef: result.postRef,
      version: result.version,
      creationId,
      source: result.source!,
    }
  }
  if (result.outcome === 'source-linked') {
    return {
      outcome: 'source-linked',
      existing: true,
      articleId: result.articleId,
      postRef: result.postRef,
      version: result.version,
      creationId,
      source: result.source!,
    }
  }
  if (result.outcome === 'invalid-source') {
    return { outcome: 'invalid-source', url: result.url }
  }
  return { outcome: 'skipped', reason: 'blank-session' }
}
