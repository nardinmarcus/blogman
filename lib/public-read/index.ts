/**
 * L2 — canonical public read model (issue #67).
 *
 * All public reading paths (home / detail / category / search / feed / sitemap /
 * historical-address / access-control) read canonical D1 facts:
 * `formal_publications` (lifecycle + first-published),
 * `article_versions` (formal content + latest management) and
 * `article_slug_addresses` (permanent single-hop registry). FTS / cache /
 * related-articles remain rebuildable projections layered on top.
 */

export { resolvePublicArticle, listPublicArticles, countPublicArticles, searchPublicArticles } from './kernel'
export type {
  PublicArticle,
  PublicArticleResolution,
  PublicListOptions,
  PublicLifecycle,
} from './types'

export { searchPublicPosts } from './search'
export { listPublicCategoryMembership } from './categories'
export { recallPublicPosts, recentPublicPosts, getIndexablePublicPost } from './related'
