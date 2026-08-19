/**
 * B3-01 — first formal publish shared types (issue #33).
 *
 * The fact surfaces are strictly separated: prepare, intent, event, outbox,
 * current formal version, public address, and receipt. A draft NEVER fabricates
 * formal facts — the only way to create a formal publication is the prepared +
 * confirmed command in `kernel.ts`.
 */

/** Formal lifecycle of an article (separate from the legacy `posts.status`). */
export type PublishLifecycle = 'draft' | 'prepared' | 'published' | 'unpublished' | 'deleted'

export type PrepareStatus = 'prepared' | 'committed' | 'aborted' | 'superseded'
export type IntentStatus = 'pending' | 'delivered' | 'failed'
export type OutboxStatus = 'pending' | 'delivered' | 'failed'
export type OutboxKind = 'public-receipt' | 'index-invalidate' | 'notify'

/**
 * The four blockers for a first formal publish. AI-derived or optional fields
 * (cover / summary / tags / metadata) never block — the acceptance criteria
 * require "AI 失败或未处理不阻塞发布".
 */
export interface PublishBlockers {
  /**
   * B1 版本已保存确认 — the exact confirmed server version is still the latest
   * version fact for the article (later edits fail this blocker).
   */
  saved: boolean
  /**
   * B2 生命周期允许首发 — the article has no formal publication yet and is not
   * deleted (first publish only).
   */
  lifecycle: boolean
  /**
   * B3 slug 无冲突 — the prepared slug is not used by another article's formal
   * publication and not used by another published post.
   */
  slug: boolean
  /**
   * B4 内容完整可公开 — title + body are non-blank and the post is not
   * password-protected (so the independent receipt can verify the public page).
   */
  content: boolean
}

export interface BlockerRow {
  blocker_saved: number
  blocker_lifecycle: number
  blocker_slug: number
  blocker_content: number
}

export function blockersAllPass(blockers: PublishBlockers): boolean {
  return blockers.saved && blockers.lifecycle && blockers.slug && blockers.content
}

export function failingBlockers(blockers: PublishBlockers): Array<keyof PublishBlockers> {
  const failed: Array<keyof PublishBlockers> = []
  if (!blockers.saved) failed.push('saved')
  if (!blockers.lifecycle) failed.push('lifecycle')
  if (!blockers.slug) failed.push('slug')
  if (!blockers.content) failed.push('content')
  return failed
}

/* ------------------------------------------------------------------ */
/* prepare                                                             */
/* ------------------------------------------------------------------ */

export interface PrepareInput {
  /** Client-generated deterministic prepare id (idempotency key). */
  prepareId: string
  articleId: number
  /** The exact server-saved version the author confirmed from the workbench. */
  confirmedVersion: number
  /** The slug the author prepared (must match the article's current slug). */
  slug: string
  /** Title at the prepared version (from the server confirmation snapshot). */
  title: string
  /** sha256 of the confirmed body (the version fact's content snapshot hash). */
  contentSha256: string
  actor: string
  now?: number
}

export type PrepareResult =
  | {
      outcome: 'prepared'
      prepareId: string
      articleId: number
      confirmedVersion: number
      slug: string
      blockers: PublishBlockers
      preparedAt: number
    }
  | {
      outcome: 'aborted'
      prepareId: string
      articleId: number
      confirmedVersion: number
      slug: string
      blockers: PublishBlockers
      failures: Array<keyof PublishBlockers>
      abortedAt: number
    }
  | { outcome: 'not-found'; articleId: number }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* confirm (the single-transaction publish)                            */
/* ------------------------------------------------------------------ */

export interface ConfirmInput {
  /** Client-generated intent id — at most one event per intent. */
  intentId: string
  /** The prepared plan this confirm commits. */
  prepareId: string
  articleId: number
  /** The confirmed version (must equal the prepare's + the server's latest). */
  expectedVersion: number
  actor: string
  /** Site origin used to compute the public address. */
  siteUrl?: string
  now?: number
  /**
   * Out-of-transaction external I/O hook bound to the outbox row written by the
   * transaction. Runs only after the transaction committed.
   */
  afterCommit?: (outbox: OutboxRow) => Promise<void> | void
}

export interface FormalPublicationFacts {
  articleId: number
  version: number
  slug: string
  lifecycle: PublishLifecycle
  firstPublishedAt: number
  publishedAt: number
  publicUrl: string
  eventId: string
}

export type ConfirmResult =
  | ({ outcome: 'delivered' } & FormalPublicationFacts & { intentId: string; outboxId: string; existing: false })
  | ({ outcome: 'replayed' } & FormalPublicationFacts & { intentId: string; outboxId: string; existing: true })
  | { outcome: 'already-published'; articleId: number; formal: FormalPublicationFacts }
  | {
      outcome: 'conflict'
      articleId: number
      expectedVersion: number
      serverVersion: number
      reason: 'version-moved' | string
    }
  | { outcome: 'slug-conflict'; articleId: number; slug: string }
  | {
      outcome: 'blocked'
      articleId: number
      expectedVersion: number
      blockers: PublishBlockers
      failures: Array<keyof PublishBlockers>
    }
  | { outcome: 'aborted'; articleId: number; reason: string }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* read model / receipts                                               */
/* ------------------------------------------------------------------ */

export interface PrepareRow {
  id: number
  prepare_id: string
  article_id: number
  post_ref: number
  prepared_version: number
  prepared_slug: string
  prepared_title: string
  prepared_content_sha256: string
  blocker_saved: number
  blocker_lifecycle: number
  blocker_slug: number
  blocker_content: number
  status: PrepareStatus
  created_at: number
  updated_at: number
}

export interface IntentRow {
  id: number
  intent_id: string
  prepare_id: string
  article_id: number
  version: number
  slug: string
  lifecycle: PublishLifecycle
  status: IntentStatus
  created_at: number
}

export interface EventRow {
  id: number
  event_id: string
  intent_id: string
  article_id: number
  version: number
  slug: string
  lifecycle: PublishLifecycle
  first_published_at: number
  evidence_sha256: string
  payload: string
  created_at: number
}

export interface OutboxRow {
  id: number
  outbox_id: string
  event_id: string
  article_id: number
  version: number
  kind: OutboxKind
  payload: string
  status: OutboxStatus
  attempts: number
  created_at: number
  delivered_at: number | null
}

export interface FormalPublicationRow {
  article_id: number
  version: number
  slug: string
  lifecycle: PublishLifecycle
  first_published_at: number
  published_at: number
  public_url: string
  event_id: string
}

export interface ReceiptRow {
  id: number
  event_id: string
  article_id: number
  version: number
  slug: string
  public_url: string
  receipt_payload: string
  verified: number
  verified_at: number
  created_at: number
}

export type ReceiptResult =
  | { outcome: 'recorded'; row: ReceiptRow }
  | { outcome: 'replayed'; row: ReceiptRow }
  | { outcome: 'not-found'; reason?: string }
  | { outcome: 'invalid'; reason: string }

/** The full read-model surface for the workbench / editor confirmation UI. */
export interface PublicationState {
  articleId: number
  prepare: PrepareRow | null
  intent: IntentRow | null
  event: EventRow | null
  outbox: OutboxRow | null
  formal: FormalPublicationRow | null
  receipt: ReceiptRow | null
}

export interface DispatchOutboxInput {
  /** Acts on a single pending outbox row; throws to mark the row failed. */
  deliver: (row: OutboxRow) => Promise<void>
  limit?: number
}

/** Canonical evidence payload written with every publish event. */
export interface PublishEvidencePayload {
  format: 'blogman-first-publish-event/v1'
  eventId: string
  intentId: string
  articleId: number
  version: number
  slug: string
  lifecycle: PublishLifecycle
  firstPublishedAt: number
  publishedAt: number
  publicUrl: string
  contentSha256: string
  actor: string
  blockerFlags: { saved: number; lifecycle: number; slug: number; content: number }
}