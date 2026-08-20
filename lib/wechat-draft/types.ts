/**
 * B5-01 — WeChat draft-task types (issue #46).
 *
 * The derivation surface is deliberately small: an article identity + EXACT
 * version (never "latest"), one account target, a frozen-projection body, and
 * the deterministic operation id that makes the whole derivation idempotent.
 * Channel groups / generations / account-setting revisions / remote identity
 * facts belong to the later batch-5 surfaces and are intentionally NOT part of
 * this row — the draft task only binds what it must.
 */

import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import type { WechatDraftTaskStatus } from './ddl'
import type { WechatDraftAttemptClassification, WechatDraftAttemptOutcome } from './ddl'

export type { WechatDraftTaskStatus }
export type { WechatDraftAttemptClassification, WechatDraftAttemptOutcome }

/** A single derived WeChat draft task row (`wechat_draft_tasks`). */
export interface WechatDraftTaskRow {
  id: number
  task_id: string
  article_id: number
  post_ref: number
  version: number
  account_id: string
  status: WechatDraftTaskStatus
  title: string
  html_projection: string
  plaintext_projection: string
  cover_image_url: string | null
  digest: string | null
  content_sha256: string
  projection_sha256: string
  source_url: string
  remote_draft_id: string | null
  provider_error: string | null
  created_at: number
  updated_at: number
  /** B5-02 — bumped on every state transition (optimistic guard). */
  revision: number
  /** B5-02 — number of submission executions so far (retry policy counter). */
  attempt_count: number
  /**
   * B5-02 — classification of the last execution: 'ok' | 'retryable' |
   * 'needs-author' | 'unknown'. NULL means no provider execution happened yet
   * (a freshly derived zero-production task).
   */
  classification: WechatDraftAttemptClassification | null
  /** B5-02 — 1 when the task is an author todo (unknown / needs-author). */
  needs_author: number
  /** B5-02 — earliest instant a retryable task may be claimed again (backoff). */
  next_attempt_at: number | null
  /** B5-02 — sanitized error of the last execution. */
  last_error: string | null
  /** B5-02 — instant an in-flight execution claimed the row. */
  claimed_at: number | null
  /** B5-02 — per-claim lease ownership token. */
  lease_token: string | null
  /** B5-02 — instant the in-flight lease expires (crash reclaim). */
  lease_expires_at: number | null
}

/** The WeChat-adapted projection body built from one frozen version snapshot. */
export interface WechatDraftProjection {
  title: string
  html: string
  plaintext: string
  coverImageUrl: string
  digest: string
  sourceUrl: string
}

/** Payload handed to a provider adapter when the executor submits the draft. */
export interface WechatDraftSubmitPayload extends WechatDraftProjection {
  taskId: string
  articleId: number
  version: number
  accountId: string
  contentSha256: string
}

/**
 * Result of a provider `createDraft` call. `accepted: true` means the remote
 * draft box recorded the draft and returned its identity (the WeChat
 * `media_id`) — stored as `remote_draft_id` and permanently kept
 * (media_id 不丢失覆盖). When NOT accepted, `classification` decides the
 * retry state machine:
 *
 *   - 'retryable'    → transient (rate limit / temporary unavailability),
 *                      re-armed under cap + backoff,
 *   - 'needs-author' → permanent / configuration error, author todo,
 *   - 'unknown'      → the request MAY have landed but the response was lost;
 *                      blind retry forbidden — query/reconcile first.
 *
 * An absent `classification` on a rejection defaults to 'needs-author': an
 * untyped rejection is treated as author-actionable, never blindly retried.
 */
export interface WechatDraftProviderResult {
  accepted: boolean
  remoteDraftId?: string
  error?: string
  classification?: Exclude<WechatDraftAttemptClassification, 'ok'>
}

/** Payload handed to a provider `queryDraft` (reconcile) call. */
export interface WechatDraftQueryPayload {
  taskId: string
  articleId: number
  version: number
  accountId: string
  sourceUrl: string
}

/**
 * Result of a provider `queryDraft` call for a result-unknown task:
 *
 *   - found:true    → the earlier submission DID land (remote draft exists);
 *                     `remoteDraftId` is the media_id to persist,
 *   - found:false   → confirmed the draft was never created — safe to
 *                     re-submit exactly once under the retry policy,
 *   - unknown:true  → the query itself lost its response — the task stays
 *                     frozen as an author todo (no blind conclusion).
 */
export interface WechatDraftQueryResult {
  found: boolean
  remoteDraftId?: string
  error?: string
  unknown?: boolean
}

/**
 * The WeChat API layer interface. This batch ships the MOCK only — real API
 * calls are deferred to a later batch. Providers are injected via `deps`;
 * production is `null` ⇒ 只建草稿 (in-DB task), 不发布, 不真调微信 API.
 * B5-02 adds `queryDraft` so a result-unknown task can be reconciled by
 * querying the remote before ANY further submission.
 */
export interface WechatDraftProvider {
  readonly kind: string
  /** Create a DRAFT in the WeChat draft box — never a live publication. */
  createDraft(payload: WechatDraftSubmitPayload): Promise<WechatDraftProviderResult>
  /** Query whether a previously-submitted draft exists remotely (reconcile). */
  queryDraft(payload: WechatDraftQueryPayload): Promise<WechatDraftQueryResult>
}

/** One IMMUTABLE execution record of a task (`wechat_draft_attempts`). */
export interface WechatDraftAttemptRow {
  id: number
  attempt_key: string
  task_id: string
  attempt_no: number
  classification: WechatDraftAttemptClassification
  outcome: WechatDraftAttemptOutcome
  started_at: number
  finished_at: number | null
  remote_draft_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface DeriveWechatDraftInput {
  articleId: number
  version: number
  accountId: string
  /** Optional injected adapter (mock in tests; null/absent in production). */
  provider?: WechatDraftProvider | null
  /** Frozen epoch clock for deterministic timestamps. */
  now?: number
  /** Site origin used to absolutize relative cover URLs. */
  siteUrl?: string
  /** Retry cap for the provider hand-off at derivation time. */
  maxAttempts?: number
  /** Base backoff (seconds) after the first failed hand-off attempt. */
  retryBackoffSeconds?: number
  /** Exponential growth factor per retry attempt. */
  retryBackoffFactor?: number
  /** Ceiling (seconds) for a single retry wait. */
  retryBackoffMaxSeconds?: number
}

export type DeriveWechatDraftResult =
  | { outcome: 'invalid'; reason: string }
  | {
      outcome: 'not-found'
      reason: string
      articleId: number
      version: number
      accountId: string
    }
  | {
      outcome: 'created' | 'existing' | 'submitted' | 'failed' | 'unknown'
      articleId: number
      version: number
      accountId: string
      taskId: string
      task: WechatDraftTaskRow
      created: boolean
      projection: WechatDraftProjection
      /** B5-02 — classification of the immediate provider hand-off (if any). */
      classification?: WechatDraftAttemptClassification
    }

export interface ReadWechatDraftTaskResult {
  task: WechatDraftTaskRow | null
  projection?: WechatDraftProjection
}

/* ------------------------------------------------------------------ */
/* B5-02 — channel executor (retry loop) + reconcile (query-first)     */
/* ------------------------------------------------------------------ */

export interface WechatDraftExecutorInput {
  /** Injected adapter (mock in tests; null/absent in production → inert). */
  provider?: WechatDraftProvider | null
  /** Controlled clock for deterministic tests; defaults to the wall clock. */
  now?: number
  /** Max tasks processed per executor run (bounded batch). */
  limit?: number
  /** Lease duration (seconds) before a crashed claim may be reclaimed. */
  leaseSeconds?: number
  /** Retry cap — a task stops auto-retrying after this many submission attempts. */
  maxAttempts?: number
  /** Base backoff (seconds) after the first failed attempt. */
  retryBackoffSeconds?: number
  /** Exponential growth factor per retry attempt. */
  retryBackoffFactor?: number
  /** Ceiling (seconds) for a single retry wait. */
  retryBackoffMaxSeconds?: number
}

export interface WechatDraftExecutorResult {
  /** true when the kill-switch is on or no provider is bound (inert run). */
  disabled: boolean
  scanned: number
  claimed: number
  submitted: number
  retried: number
  failed: number
  needsAuthor: number
  unknown: number
}

export interface WechatDraftReconcileInput {
  taskId: string
  /** Injected adapter (mock in tests; null/absent in production → frozen). */
  provider?: WechatDraftProvider | null
  /** Controlled clock for deterministic timestamps. */
  now?: number
}

export type WechatDraftReconcileResult =
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; taskId: string }
  /** The task is not result-unknown — nothing to reconcile (idempotent no-op). */
  | { outcome: 'not-unknown'; taskId: string; task: WechatDraftTaskRow }
  /** Already delivered / already resolved — late or duplicate command replay. */
  | { outcome: 'replayed'; taskId: string; task: WechatDraftTaskRow }
  /** No adapter — the task stays frozen as an author todo (never concluded). */
  | { outcome: 'no-provider'; taskId: string; task: WechatDraftTaskRow }
  /** Query itself lost — the task stays frozen; no blind conclusion. */
  | {
      outcome: 'unknown-still'
      taskId: string
      reason: string
      task: WechatDraftTaskRow
    }
  /** Resolved: the remote draft exists (submitted + media_id saved) or was
   *  provably never created (re-armed as a fresh draft for one safe resubmit). */
  | {
      outcome: 'reconciled'
      taskId: string
      found: boolean
      /** The media_id when the remote draft exists; null when provably not created. */
      remoteDraftId: string | null
      task: WechatDraftTaskRow
    }

export type { ArticleIdentitySnapshot }