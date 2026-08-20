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
  /** B5-03 — 交付代次 within the (article, account) channel delivery group. */
  generation: number
  /** B5-03 — 设置修订 used to build this task's projection (0 = no settings). */
  settings_revision: number
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
      outcome: 'created' | 'existing' | 'updated' | 'submitted' | 'failed' | 'unknown'
      articleId: number
      version: number
      accountId: string
      taskId: string
      task: WechatDraftTaskRow
      created: boolean
      projection: WechatDraftProjection
      /** B5-03 — 交付代次 (沿用代次 on pre-delivery settings updates). */
      generation?: number
      /** B5-03 — 设置修订 used (0 = no settings). */
      settingsRevision?: number
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
  | { outcome: 'not-unknown'; taskId: string; delivery: WechatLifecycleRowView; task?: WechatDraftTaskRow; replacement?: WechatDraftReplacementRow }
  /** Already delivered / already resolved — late or duplicate command replay. */
  | { outcome: 'replayed'; taskId: string; delivery: WechatLifecycleRowView; task?: WechatDraftTaskRow; replacement?: WechatDraftReplacementRow }
  /** No adapter — the task stays frozen as an author todo (never concluded). */
  | { outcome: 'no-provider'; taskId: string; delivery: WechatLifecycleRowView; task?: WechatDraftTaskRow; replacement?: WechatDraftReplacementRow }
  /** Query itself lost — the task stays frozen; no blind conclusion. */
  | {
      outcome: 'unknown-still'
      taskId: string
      reason: string
      delivery: WechatLifecycleRowView
      task?: WechatDraftTaskRow
      replacement?: WechatDraftReplacementRow
    }
  /** Resolved: the remote draft exists (submitted + media_id saved) or was
   *  provably never created (re-armed as a fresh draft for one safe resubmit). */
  | {
      outcome: 'reconciled'
      taskId: string
      found: boolean
      /** The media_id when the remote draft exists; null when provably not created. */
      remoteDraftId: string | null
      delivery: WechatLifecycleRowView
      task?: WechatDraftTaskRow
      replacement?: WechatDraftReplacementRow
    }

export type { ArticleIdentitySnapshot }

/* ------------------------------------------------------------------ */
/* B5-03 — 交付前设置、替代草稿与历史 (issue #48)                      */
/* ------------------------------------------------------------------ */

/** 账号/设置修订 — 每（正式文章, 账号）一份可调设置。 */
export interface WechatDraftSettingsRow {
  id: number
  article_id: number
  account_id: string
  /** 设置修订：首次保存映射为修订 1（初始配置映射初始修订，不猜历史）。 */
  settings_revision: number
  title_override: string | null
  digest_override: string | null
  cover_image_override: string | null
  created_at: number
  updated_at: number
}

/** 渠道交付组任务代次台账 — 每（文章, 账号）一串单调递增加法代次。 */
export interface WechatDraftGenerationRow {
  id: number
  article_id: number
  account_id: string
  generation: number
  version: number
  task_id: string
  /** 前代 task 键（wechat_draft_tasks.task_id 或 wechat_draft_replacements.replacement_key），
   *  NULL 表示首代。 */
  replaces_task_id: string | null
  status: WechatDraftTaskStatus
  settings_revision: number
  created_at: number
  updated_at: number
}

/** 交付后显式替代草稿 — 新代次行，完整生命周期列与 wechat_draft_tasks 一致。 */
export interface WechatDraftReplacementRow {
  id: number
  replacement_key: string
  article_id: number
  version: number
  account_id: string
  replaces_task_id: string
  generation: number
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
  settings_revision: number
  created_at: number
  updated_at: number
  revision: number
  attempt_count: number
  classification: WechatDraftAttemptClassification | null
  needs_author: number
  next_attempt_at: number | null
  last_error: string | null
  claimed_at: number | null
  lease_token: string | null
  lease_expires_at: number | null
}

/** 归一化的生命周期行 — 执行器/重试/对账统一处理任务与替代草稿。 */
export interface WechatLifecycleRowView {
  kind: 'task' | 'replacement'
  key: string
  articleId: number
  version: number
  accountId: string
  status: WechatDraftTaskStatus
  title: string
  htmlProjection: string
  plaintextProjection: string
  coverImageUrl: string | null
  digest: string | null
  contentSha256: string
  projectionSha256: string
  sourceUrl: string
  remoteDraftId: string | null
  providerError: string | null
  settingsRevision: number
  generation: number
  replacesTaskId: string | null
  revision: number
  attemptCount: number
  classification: WechatDraftAttemptClassification | null
  needsAuthor: number
  nextAttemptAt: number | null
  lastError: string | null
  claimedAt: number | null
  leaseToken: string | null
  leaseExpiresAt: number | null
}

export interface SaveWechatDraftSettingsInput {
  articleId: number
  accountId: string
  /** 留空/未传 = 保留该字段现有覆盖（或保持空白）。 */
  title?: string
  digest?: string
  coverImageUrl?: string
  now?: number
}

export type SaveWechatDraftSettingsResult =
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'disabled'; reason: string }
  | {
      outcome: 'saved'
      settings: WechatDraftSettingsRow
      /** true 时本次保存新建了设置（初始修订 = 1，不猜历史）。 */
      created: boolean
      /** 设置修订自增后仍是同一正文版本、同一交付代次。 */
      settingsRevision: number
    }

export interface ReplaceWechatDraftInput {
  /** 要替代的当前已交付行键（task_id 或 replacement_key）；缺省时按 articleId+accountId 解析当前代。 */
  taskId?: string
  articleId?: number
  accountId?: string
  /** 注入适配器（测试用 mock；生产 null → 只建替代草稿，不调外部）。 */
  provider?: WechatDraftProvider | null
  now?: number
  siteUrl?: string
  maxAttempts?: number
  retryBackoffSeconds?: number
  retryBackoffFactor?: number
  retryBackoffMaxSeconds?: number
}

export type ReplaceWechatDraftResult =
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'disabled'; reason: string }
  | { outcome: 'not-found'; reason: string; articleId?: number; accountId?: string }
  | {
      outcome: 'not-delivered'
      reason: string
      current: WechatLifecycleRowView
    }
  | {
      outcome: 'created' | 'existing' | 'submitted' | 'failed' | 'unknown'
      articleId: number
      version: number
      accountId: string
      generation: number
      replacesTaskId: string
      taskId: string
      replacement: WechatDraftReplacementRow
      projection: WechatDraftProjection
      /** true 时本次调用了 provider 并产生首个尝试（与派生路径一致）。 */
      handout: boolean
      classification?: WechatDraftAttemptClassification
    }

export interface WechatDeliveryHistoryRow {
  generation: WechatDraftGenerationRow
  /** 该代对应的任务/替代草稿归一化视图。 */
  delivery: WechatLifecycleRowView
  /** 前代键（首代为 null）。 */
  replacesTaskId: string | null
}

/** 人类可读的交付视图 — 待微信确认, 永不声称已发布。 */
export interface WechatDeliveryView {
  kind: 'task' | 'replacement'
  key: string
  articleId: number
  version: number
  accountId: string
  generation: number
  replacesTaskId: string | null
  status: WechatDraftTaskStatus
  /** true 仅当草稿已交付到微信草稿箱（submitted）— 待作者在微信确认，绝不等于已发布。 */
  awaitingWechatConfirmation: boolean
  humanLabel: string
  remoteDraftId: string | null
  settingsRevision: number
  title: string
}
