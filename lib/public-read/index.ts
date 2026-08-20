/**
 * L2 — canonical public read model (issue #67).
 *
 * All public reading paths (home / detail / category / search / feed / sitemap /
 * historical-address / access-control) read canonical D1 facts:
 * `formal_publications` (lifecycle + first-published + current address),
 * `article_versions` (frozen content + pinned + access-control) and
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
