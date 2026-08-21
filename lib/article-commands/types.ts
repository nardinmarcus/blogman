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
import type { SourceFacts, SourceLinkRole } from '@/lib/source-identity'

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
  /**
   * B6-01 — optional writable-primary-source URL (issue #50). When present the
   * kernel also records the 源稿 identity + a PENDING association (待确认关联,
   * not auto-effective). A URL already live-linked to an article converges on
   * that existing article instead of creating a duplicate.
   *
   * B7-01 (issue #57): `role` defaults to `primary` (writable source). The
   * Chrome 剪藏 entry passes `role: 'clip'` so a clipped reference page never
   * becomes the primary source (来源网页不成为主要源稿).
   */
  source?: { url: string; role?: SourceLinkRole }
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
  /** B6-01 — source identity + pending-link facts when the create carried a `source.url`. */
  source?: SourceFacts | null
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
  | { outcome: 'invalid-source'; url: string }
  /**
   * B6-01 — the source URL is already live-linked to an EXISTING article
   * (pending or confirmed). A repeated clip / duplicated source converges on
   * that article's identity + version instead of creating a duplicate.
   */
  | {
      outcome: 'source-linked'
      articleId: number
      postRef: number
      version: number
      operationId: string
      existing: true
      source: SourceFacts
    }

export type SaveResult =
  | AppliedVersionResult
  | VersionConflictResult
  | { outcome: 'slug-conflict'; slug: string }

export type PublishTempResult =
  | AppliedVersionResult
  | VersionConflictResult
  | { outcome: 'status-conflict'; articleId: number; postRef: number; expectedVersion: number; serverVersion: number; currentStatus: string | null }

/* ------------------------------------------------------------------ */
/* B2-06 — article-level (non-body) commands (issue #29).              */
/*                                                                    */
/* Status toggles (publish/unpublish) already run through the         */
/* versioned `publishTemp` command. The remaining admin-list actions   */
/* (pin / hide / password / category / soft-delete / restore) each      */
/* append ONE immutable version snapshot (#234 Phase A, ADR 0007): the */
/* body version ADVANCES on every applied action so the canonical       */
/* public read reflects the new state immediately; a long-open editor   */
/* gets an expectedVersion conflict on its next save (expected —        */
/* refresh + replay). Repeated operation ids replay without writing.    */
/* ------------------------------------------------------------------ */

/** Applied / replayed / conflict — the evidence surface of one article-level command. */
export interface ArticleLevelAppliedResult {
  outcome: 'applied'
  articleId: number
  postRef: number
  /** The version the action was anchored to (unchanged by the action). */
  version: number
  operationId: string
  existing: false
  projectionFailures: string[]
}

export interface ArticleLevelReplayedResult {
  outcome: 'replayed'
  articleId: number
  postRef: number
  version: number
  operationId: string
  existing: true
  projectionFailures: string[]
}

export type ArticleLevelResult =
  | ArticleLevelAppliedResult
  | ArticleLevelReplayedResult
  | VersionConflictResult

/** Shared precondition envelope for every independent article-level command. */
export interface ArticleLevelInput {
  articleId: number
  /** Body version the client last saw; the action is refused on mismatch. */
  expectedVersion: number
  /** Idempotency key — replays return `existing: true` and never re-write. */
  operationId: string
}

export interface SetPinnedInput extends ArticleLevelInput {
  is_pinned: 0 | 1
}

export interface SetHiddenInput extends ArticleLevelInput {
  is_hidden: 0 | 1
}

export interface SetPasswordInput extends ArticleLevelInput {
  password: string | null
}

export interface SetCategoryInput extends ArticleLevelInput {
  category: string | null
}

/** Soft delete keeps the first deletion timestamp and the posts status. */
export type SoftDeleteInput = ArticleLevelInput
/** Restore returns a deleted post to draft with NO deletion timestamp. */
export type RestoreInput = ArticleLevelInput

/** One article of a batch category write; each item keeps its own version precondition + operation id. */
export interface BatchSetCategoryItem extends ArticleLevelInput {
  category: string | null
}

export interface BatchSetCategoryInput {
  items: BatchSetCategoryItem[]
}

export type BatchSetCategoryItemResult =
  | ArticleLevelAppliedResult
  | ArticleLevelReplayedResult
  | { outcome: 'not-found'; articleId: number; expectedVersion: number }
  | VersionConflictResult

/** Batch classification never silently overwrites a conflicting article — every item reports its own outcome. */
export interface BatchSetCategoryResult {
  items: BatchSetCategoryItemResult[]
}
