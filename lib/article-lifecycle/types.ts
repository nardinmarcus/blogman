/**
 * B3-05 — article lifecycle command types (issue #37).
 *
 * The independent lifecycle vocabulary for a formally published article:
 *
 *   - `unpublish`  — takes a live article OFF the public surface (posts
 *     status -> draft, formal lifecycle -> unpublished). Everything else —
 *     versions, the active pending revision, restore points and the whole
 *     history — is PRESERVED untouched. Idempotent by operation id; requires
 *     a "currently published" status precondition.
 *   - `relive`     — brings an unpublished article back ONLINE. Two sources:
 *       * `formal`   — relist the LAST OFFICIAL version (the current formal
 *                      projection) without writing a new version;
 *       * `revision` — raise the CURRENT pending revision (a new formal
 *                      version + restore point + promotion event) then flip
 *                      the lifecycle back to published.
 *
 * Every command carries the same independent-command precondition envelope as
 * the B2-06 article-level commands (article id + expected body version +
 * operation id) and records its transition immutably in `article_lifecycles`.
 *
 * Slack-history (#36) and revision-compare UI (#35) are intentionally OUT of
 * scope for this module.
 */

export type LifecycleDirection = 'unpublish' | 'relive-formal' | 'relive-revision'
export type AllowedLifecycle = 'published' | 'unpublished'

/** One immutable ledger row for a lifecycle transition. */
export interface LifecycleRow {
  id: number
  operation_id: string
  article_id: number
  post_ref: number
  version: number
  direction: LifecycleDirection
  lifecycle_before: AllowedLifecycle
  lifecycle_after: AllowedLifecycle
  source_version: number | null
  public_url: string | null
  evidence_sha256: string
  payload: string
  actor: string
  created_at: number
}

/** Shared precondition envelope for every lifecycle command. */
export interface LifecycleInput {
  articleId: number
  /** Body version the client last saw; the action is refused on mismatch. */
  expectedVersion: number
  /** Idempotency key — replays return `existing: true` and never re-write. */
  operationId: string
  actor?: string
  now?: number
}

export interface UnpublishInput extends LifecycleInput {
  /** Best-effort external I/O that runs only after the transaction commits. */
  afterCommit?: () => void | Promise<void>
}

export interface ReliveInput extends LifecycleInput {
  /** Which content to bring online: last official form or the current revision. */
  content?: 'formal' | 'revision'
  /** Site origin used to compute the public address on a revision relive. */
  siteUrl?: string
  /** Best-effort external I/O that runs only after the transaction commits. */
  afterCommit?: () => void | Promise<void>
}

/* ------------------------------------------------------------------ */
/* result surface                                                      */
/* ------------------------------------------------------------------ */

interface LifecycleBaseResult {
  articleId: number
  postRef: number
  version: number
  operationId: string
  direction: LifecycleDirection
  lifecycle: AllowedLifecycle
  publicUrl: string | null
  projectionFailures: string[]
}

export interface LifecycleAppliedResult extends LifecycleBaseResult {
  outcome: 'applied'
  existing: false
}

export interface LifecycleReplayedResult extends LifecycleBaseResult {
  outcome: 'replayed'
  existing: true
}

export interface LifecycleVersionConflict {
  outcome: 'conflict'
  articleId: number
  postRef: number
  expectedVersion: number
  serverVersion: number
  reason: 'version-moved'
}

export interface LifecycleStatusConflict {
  outcome: 'status-conflict'
  articleId: number
  postRef: number
  expectedVersion: number
  serverVersion: number
  currentStatus: string | null
  lifecycle: string | null
}

export interface LifecycleBlocked {
  outcome: 'blocked'
  articleId: number
  reason: string
  failures: string[]
}

export interface LifecycleNotFound {
  outcome: 'not-found'
  articleId?: number
  reason: string
}

export type UnpublishResult =
  | LifecycleAppliedResult
  | LifecycleReplayedResult
  | LifecycleVersionConflict
  | LifecycleStatusConflict
  | LifecycleBlocked
  | LifecycleNotFound

export type ReliveResult =
  | LifecycleAppliedResult
  | LifecycleReplayedResult
  | LifecycleVersionConflict
  | LifecycleStatusConflict
  | LifecycleBlocked
  | LifecycleNotFound
