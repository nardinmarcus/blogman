/**
 * B2-03 — versioned article write command kernel (issue #26).
 *
 * Shared command types: the full authoring snapshot a client submits, the
 * three command inputs, and the discriminated result unions that form the
 * kernel's evidence surface. The kernel itself lives in `kernel.ts`; it writes
 * version facts (articles + article_versions) and the legacy `posts` compat
 * projection in one D1 transaction and never builds batch-3 facts
 * (publish intent / events / Outbox).
 */

import type { FidelityClass } from '@/lib/article-identity'

/** Status vocabulary carried by the legacy posts projection. */
export type ArticleCommandStatus = 'draft' | 'published'

/**
 * Full authoring state of one article version, as submitted by a client.
 * The kernel derives the canonical version record (envelope, hashes, digest,
 * fidelity) from this via the B2-01/B2-02 kernels; nothing here is stored
 * verbatim except through the derived snapshot record.
 */
export interface ArticleCommandSnapshot {
  slug: string
  title: string
  /** Canonical markdown body — the body-of-truth source. */
  content: string
  /** Rendered HTML for the legacy posts projection (editor-authoritative when provided). */
  html: string
  description: string | null
  category: string | null
  tags: string[] | null
  status: ArticleCommandStatus
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null
  deleted_at: number | null
  published_at: number | null
  updated_at: number | null
}

/**
 * Out-of-transaction projection hooks. KV cache, FTS triggers, related-content
 * and vector indexes are all rebuildable projections: a failure here never
 * rolls back core facts, and is recorded on the result instead.
 */
export interface ArticleCommandProjections {
  /** Best-effort, runs only after core facts committed. */
  afterCommit?: (result: AppliedVersionResult) => Promise<void> | void
}

export interface CreateArticleInput {
  /** Client-generated idempotency key — at most one article per creation id. */
  creationId: string
  snapshot: ArticleCommandSnapshot
  projections?: ArticleCommandProjections
}

export interface SaveArticleInput {
  articleId: number
  /** The version the client last saw; the next monotonic version is written only when it matches. */
  expectedVersion: number
  /** Idempotency key — the same operation id returns the original result. */
  operationId: string
  snapshot: ArticleCommandSnapshot
  projections?: ArticleCommandProjections
}

export interface PublishTempInput {
  articleId: number
  expectedVersion: number
  /** Status precondition — the posts projection must currently be in this status. */
  currentStatus: ArticleCommandStatus | string
  operationId: string
  /** Target temporary status. */
  status: ArticleCommandStatus | string
  projections?: ArticleCommandProjections
}

/** Facts recorded when a version is applied (created / replayed). */
export interface AppliedVersionResult {
  outcome: 'created' | 'applied' | 'replayed' | 'existing'
  articleId: number
  postRef: number
  version: number
  operationId: string
  /** True when the result is a replay of an earlier successful run. */
  existing: boolean
  /** Errors from out-of-transaction projections (never fatal). */
  projectionFailures: string[]
}

/** Server-side facts for conflict comparison (never a partial write). */
export interface VersionComparisonFacts {
  version: number
  title: string | null
  slug: string | null
  status: string | null
  published_at: number | null
  updated_at: number | null
  content_snapshot_sha256: string | null
  source_sync_sha256: string | null
  post_field_sha256: string | null
  fidelity: FidelityClass | null
}

export interface VersionConflictResult {
  outcome: 'conflict'
  articleId: number
  postRef: number
  expectedVersion: number
  serverVersion: number
  facts: VersionComparisonFacts
}

export type CreateResult =
  | AppliedVersionResult
  | { outcome: 'skipped'; reason: 'blank-session' }
  | { outcome: 'slug-conflict'; slug: string }

export type SaveResult =
  | AppliedVersionResult
  | VersionConflictResult
  | { outcome: 'slug-conflict'; slug: string }

export type PublishTempResult =
  | AppliedVersionResult
  | VersionConflictResult
  | { outcome: 'status-conflict'; articleId: number; postRef: number; expectedVersion: number; serverVersion: number; currentStatus: string | null }
