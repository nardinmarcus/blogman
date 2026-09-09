/**
 * Article Command Client — public entry (CONTEXT.md).
 *
 * The single client-side seam for admin-surface commands on the
 * /api/article-commands wire: typed requests, operation-id generation,
 * the ledger-only legacy direct-write bypass, and normalized outcomes.
 * Server-only types never enter this barrel — everything here is
 * client-safe (the hook file carries 'use client').
 */

export { createArticleCommandClient } from './client'
export type { ArticleCommandClient } from './client'
export { useArticleCommand } from './hook'
export type { RunOptions, UseArticleCommandOptions } from './hook'
export type {
  ArticleCommandOutcome,
  ArticleCommandRequest,
  ArticleCommandTarget,
  BatchCategoryItem,
  BatchCategoryOutcome,
  FetchLike,
  RefreshStrategy,
} from './types'
