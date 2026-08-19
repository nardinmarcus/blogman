/**
 * B3-02 — formal-article pending revision shared types (issue #34).
 *
 * The formal-article revision loop: editing a formally published article
 * NEVER changes the live version. The first content change creates the unique
 * active revision; every writer (in-site editor, AI background enrichment,
 * external versioned writers) writes into the SAME active revision; promotion
 * first saves a restore point, then promotes the revision and generates the
 * promotion event atomically. Public reads keep reading the formal projection
 * (`posts` / `formal_publications`) until promotion.
 *
 * Three new fact surfaces (STRICTLY separated from the first-publish six):
 *
 *   1. `publish_revisions`     — the pending revision row. At most ONE active
 *      revision per article (partial unique index on status='active'); a
 *      promoted/discarded revision row stays as immutable history and the next
 *      edit forms a brand-new active revision.
 *   2. `publish_restore_points` — the pre-promotion formal snapshot saved in
 *      the SAME transaction as the promotion (rollback material; never
 *      fabricates a revision that did not exist).
 *   3. `publish_promotions`    — one immutable event per promotion, with a
 *      canonical evidence payload bound to the promoted version + public URL.
 */

/** Lifecycle of one pending revision row. */
export type RevisionStatus = 'active' | 'promoted' | 'discarded'

/** The pending revision row (the full authoring snapshot, not a reference). */
export interface RevisionRow {
  id: number
  revision_id: string
  article_id: number
  /** The formal version this revision was forked from (never advances during editing). */
  base_version: number
  /** Monotonic edit counter shared by ALL writers; the client version token. */
  revision_number: number
  status: RevisionStatus
  slug: string
  title: string
  content: string
  html: string
  description: string | null
  category: string | null
  /** JSON array string (same shape as `posts.tags`). */
  tags: string | null
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null
  /** Canonical content hash of this revision's body (evidence + staleness). */
  content_sha256: string
  created_at: number
  updated_at: number
}

/** Pre-promotion formal snapshot saved inside the promotion transaction. */
export interface RestorePointRow {
  id: number
  restore_point_id: string
  article_id: number
  /** The formal version that was live BEFORE promotion. */
  formal_version: number
  /** The formal version the promotion produced (formal_version + 1). */
  promoted_version: number
  /** Canonical snapshot JSON of the live formal state being replaced. */
  snapshot_json: string
  /** Canonical content hash of the pre-promotion formal body. */
  content_sha256: string
  reason: string
  created_at: number
}

/** One immutable promotion event per raise of a revision. */
export interface PromotionRow {
  id: number
  promotion_id: string
  article_id: number
  revision_id: string
  base_version: number
  promoted_version: number
  slug: string
  public_url: string
  content_sha256: string
  evidence_sha256: string
  payload: string
  actor: string
  created_at: number
}

/** The fields a writer may store into a revision (mirrors the save snapshot). */
export interface RevisionSnapshotInput {
  slug: string
  title: string
  content: string
  html: string
  description: string | null
  category: string | null
  tags: string[] | null
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null
}

/** The formal state a revision is anchored to (read by the save router). */
export interface FormalAnchor {
  version: number
  slug: string
  /** Canonical content hash of the live formal body (the base content). */
  contentHash: string | null
}

/* ------------------------------------------------------------------ */
/* save-revision routing (called by the shared article-commands save)  */
/* ------------------------------------------------------------------ */

export interface SaveRevisionInput {
  articleId: number
  postRef: number
  expectedVersion: number
  operationId: string
  snapshot: RevisionSnapshotInput
  formal: FormalAnchor
}

/** Result of a routed revision save — shape-compatible with the kernel save. */
export type SaveRevisionResult =
  | {
      outcome: 'applied'
      articleId: number
      postRef: number
      version: number
      operationId: string
      existing: false
      projectionFailures: []
      /** True because this write landed on the revision surface, not the live row. */
      revision: true
      revisionId: string
      baseVersion: number
    }
  | {
      outcome: 'replayed'
      articleId: number
      postRef: number
      version: number
      operationId: string
      existing: true
      projectionFailures: []
      revision: true
      revisionId: string
      baseVersion: number
    }
  | {
      outcome: 'conflict'
      articleId: number
      postRef: number
      expectedVersion: number
      serverVersion: number
      revision: true
      revisionId: string | null
      reason: string
    }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* promote (the single-transaction go-live)                            */
/* ------------------------------------------------------------------ */

export interface PromoteInput {
  /** The active revision to raise (either id or article id resolves it). */
  revisionId?: string
  articleId?: number
  actor: string
  /** Site origin used to compute the public address after promotion. */
  siteUrl?: string
  now?: number
  /** Out-of-transaction external I/O hook; runs only after the transaction. */
  afterCommit?: (promotion: PromotionRow) => Promise<void> | void
}

export interface PromotionFacts {
  articleId: number
  revisionId: string
  baseVersion: number
  promotedVersion: number
  slug: string
  publicUrl: string
  contentSha256: string
  evidenceSha256: string
  actor: string
}

export type PromoteResult =
  | ({ outcome: 'promoted' } & PromotionFacts & { promotionId: string; existing: false })
  | ({ outcome: 'replayed' } & PromotionFacts & { promotionId: string; existing: true })
  | {
      outcome: 'conflict'
      articleId: number
      reason: string
      revision: { revisionId: string; revisionNumber: number; status: RevisionStatus } | null
    }
  | { outcome: 'blocked'; articleId: number; reason: string; failures: string[] }
  | { outcome: 'not-found'; articleId?: number; reason: string }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* discard / read                                                      */
/* ------------------------------------------------------------------ */

export type DiscardResult =
  | { outcome: 'discarded'; articleId: number; revisionId: string }
  | { outcome: 'replayed'; articleId: number; revisionId: string }
  | { outcome: 'not-found'; reason: string }
  | { outcome: 'invalid'; reason: string }

/** The full revision-loop read surface for the editor / workbench. */
export interface RevisionState {
  articleId: number
  formal: FormalAnchor & { slug: string } | null
  active: RevisionRow | null
  promotions: PromotionRow[]
  latestRestorePoint: RestorePointRow | null
  /** B3-03 — the most recent restore points for this article (recent 10). */
  restorePoints: RestorePointRow[]
}

/* ------------------------------------------------------------------ */
/* B3-03 — revision comparison / restore (issue #35)                   */
/* ------------------------------------------------------------------ */

/** A single field-level comparison between the live formal snapshot and a target snapshot. */
export interface FieldComparison {
  field: string
  live: string | number | null
  target: string | number | null
  changed: boolean
}

/** A content-diff token pair for the editor workbench (rough word-line diff). */
export interface ContentDiffToken {
  type: 'same' | 'removed' | 'added'
  value: string
}

/** Result of comparing the live formal body against a target snapshot. */
export interface RevisionComparison {
  articleId: number
  /** The formal version the comparison was anchored to (re-verified at execution). */
  verifiedVersion: number
  targetLabel: string
  /** True when every compared field matches the live snapshot. */
  identical: boolean
  fields: FieldComparison[]
  contentDiff: ContentDiffToken[]
  liveContentSha256: string
  targetContentSha256: string
}

export type CompareRevisionResult =
  | ({ outcome: 'compared' } & RevisionComparison)
  | {
      outcome: 'conflict'
      articleId: number
      expectedVersion: number
      serverVersion: number
      reason: string
    }
  | { outcome: 'not-found'; articleId?: number; reason: string }
  | { outcome: 'invalid'; reason: string }

/** Where a restore should materialise its snapshot. */
export type RestoreTarget = 'revision' | 'draft'

/** The undo-able restore operation record (one row per restore). */
export interface RestoreOperationRow {
  id: number
  restore_operation_id: string
  article_id: number
  source_restore_point_id: string
  target: RestoreTarget
  expected_version: number
  /** Full editable snapshot of the live state immediately before this restore. */
  pre_restore_snapshot_json: string
  pre_restore_content_sha256: string
  /** The active revision formed for a `revision`-target restore (null for draft). */
  revision_id: string | null
  /** The draft copy article id for a `draft`-target restore (null for revision). */
  draft_article_id: number | null
  post_ref: number | null
  actor: string
  status: 'active' | 'undone'
  created_at: number
  undone_at: number | null
}

export type SaveRestorePointResult =
  | {
      outcome: 'saved'
      articleId: number
      restorePointId: string
      formalVersion: number
      reason: string
      /** Number of restore points pruned to keep the recent-10 retention. */
      pruned: number
    }
  | { outcome: 'not-found'; articleId: number; reason: string }
  | { outcome: 'invalid'; reason: string }

export type RestoreResult =
  | {
      outcome: 'restored'
      articleId: number
      restoreOperationId: string
      target: RestoreTarget
      formalVersion: number
      restorePointId: string
      /** For a `revision`-target restore: the active revision formed. */
      revisionId: string | null
      revisionNumber: number | null
      /** For a `draft`-target restore: the draft copy article + post ref. */
      draftArticleId: number | null
      draftPostRef: number | null
      /** Pruned restore points after this high-risk op. */
      pruned: number
    }
  | {
      outcome: 'conflict'
      articleId: number
      expectedVersion: number
      serverVersion: number
      reason: string
    }
  | { outcome: 'blocked'; articleId: number; reason: string; failures: string[] }
  | { outcome: 'not-found'; articleId?: number; reason: string }
  | { outcome: 'invalid'; reason: string }

export type UndoRestoreResult =
  | { outcome: 'undone'; articleId: number; restoreOperationId: string; target: RestoreTarget }
  | { outcome: 'replayed'; articleId: number; restoreOperationId: string }
  | { outcome: 'not-found'; articleId?: number; reason: string }
  | { outcome: 'invalid'; reason: string }

/** #35 inputs. */
export interface CompareRevisionInput {
  articleId: number
  /** The formal version the client previewed; re-verified before diffing. */
  expectedVersion: number
  /** Defaults to the active revision; an explicit promoted revision may be named. */
  revisionId?: string
}

export interface SaveRestorePointInput {
  articleId: number
  actor: string
  /** Short reason label recorded on the restore point (e.g. `restore-preflight`). */
  reason: string
}

export interface RestoreInput {
  /** The restore point to materialise. */
  restorePointId: string
  articleId?: number
  /** The formal version the client previewed; re-verified at execution. */
  expectedVersion?: number
  target: RestoreTarget
  actor: string
}

export interface UndoRestoreInput {
  restoreOperationId: string
  actor: string
}