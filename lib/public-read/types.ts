/**
 * L2 — canonical public read model (issue #67).
 *
 * The public reading surface (home / detail / category / search / feed /
 * sitemap / historical-address / access-control) reads CANONICAL D1 facts
 * instead of the legacy `posts` compat projection:
 *
 *   - lifecycle  — `formal_publications.lifecycle` (published / unpublished),
 *   - current + historical address — `formal_publications.slug` +
 *     `article_slug_addresses` (permanent single-hop registry),
 *   - first-published time — `formal_publications.first_published_at`,
 *   - content — formal article version (body, HTML, title, description,
 *     tags, cover),
 *   - management — latest immutable version (password, hidden, pinned,
 *     deletion, category, updated_at).
 *
 * The Compat Projection is frozen and never read here. The retired view
 * counter is represented by a constant zero for legacy-shaped consumers.
 */

export type PublicLifecycle = 'published' | 'unpublished'

/**
 * The normalized public-reading article. Field names deliberately mirror the
 * legacy `PostWithTags` surface so route components (HomeClient, category,
 * search, feed, sitemap) keep working unchanged, while every *decision*
 * field is sourced from canonical facts.
 */
export interface PublicArticle {
  /** post_ref (legacy posts.id) — kept for downstream wiring. */
  id: number
  articleId: number
  /** Current live address (single-hop target). */
  slug: string
  version: number
  lifecycle: PublicLifecycle
  /** True when this article is on the public surface (published + not deleted). */
  live: boolean
  /** Legacy-compatible status (derived from canonical lifecycle + deleted). */
  status: 'draft' | 'published' | 'deleted'
  /** Legacy-compatible deletion timestamp (from the frozen snapshot). */
  deleted_at: number | null

  title: string
  content: string
  html: string
  description: string | null
  category: string | null
  tags: string[]
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null

  /** Canonical first-observable-published time (never fabricated). */
  first_published_at: number
  /** Display time — mirrors the legacy `published_at` field. */
  published_at: number
  updated_at: number
  /** Retired counter; always zero. */
  view_count: number
}

/** Result of a single-hop public address resolution + canonical load. */
export interface PublicArticleResolution {
  article: PublicArticle | null
  /** Non-null when the requested slug is a historical address → 301 here. */
  redirectSlug: string | null
}

export interface PublicListOptions {
  limit?: number
  offset?: number
  /** Include password-protected articles (admin/canonical listing). */
  includePassword?: boolean
  /** Include hidden (unlisted) articles. */
  includeHidden?: boolean
  /** Restrict to the latest category name. */
  category?: string | null
}
