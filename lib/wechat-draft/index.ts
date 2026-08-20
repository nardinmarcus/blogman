/**
 * B5-01 — WeChat draft derivation public entry (issue #46).
 *
 * Derives a WeChat public-account DRAFT from the EXACT frozen formal version
 * of a formally published article: the derivation binds article identity +
 * exact version + one account, projects that version's snapshot into the
 * WeChat body (HTML / plaintext / cover / digest), and writes ONE deterministic
 * task row idempotently. 不直接发布, 只建草稿 — production has no provider
 * bound (零生产, 不真调微信 API); the provider interface + mock ship here and
 * real API wiring is deferred to a later batch.
 *
 * B5-02 (issue #47) — provider failure / retry / result-unknown state machine.
 *
 * `runWechatDraftExecutor` is the channel executor (lease-claimed submission
 * of due drafts, IMMUTABLE classified attempt rows, cap + exponential backoff,
 * kill-switchable via WECHAT_DRAFT_EXECUTOR_DISABLED). `reconcileWechatDraft`
 * resolves a result-unknown task by QUERYING the remote before any further
 * submission — a non-idempotent uncertain call is never blindly retried; the
 * unknown freezes as an author todo until the query settles it. `listWechatDraftAttempts`
 * exposes the immutable execution evidence per task (脱敏分类).
 *
 * B5-03 (issue #48) — 交付前设置调整、替代草稿与历史.
 *
 * `saveWechatDraftSettings` / `readWechatDraftSettings` manage the per-(article,
 * account) deliverable settings (设置修订与正文版本/代次分离); pre-delivery
 * re-derivation applies them to the SAME task (沿用代次) and a delivered row is
 * never modified. `replaceWechatDraft` is the ONLY explicit post-delivery path
 * to a new draft: next generation, prior-generation reference, history and
 * media_id preserved, delivered to the draft box only (待微信确认, never 已发布).
 * `listWechatDeliveries` / `readWechatDeliveryView` expose the human-readable
 * 组 → 代次 → 行 history, and `WECHAT_DRAFT_ADMIN_WRITES_DISABLED` closes the
 * settings/replace WRITE commands while every read stays available.
 */

export {
  buildSubmitPayload,
  classifyWechatExecution,
  deriveWechatDraft,
  isWechatDraftAdminWritesDisabled,
  isWechatDraftExecutorDisabled,
  listWechatDeliveries,
  listWechatDraftAttempts,
  listWechatDraftTasks,
  normalizeWechatAccountId,
  projectionDigest,
  projectionFromRow,
  projectionFromView,
  readWechatDeliveryView,
  readWechatDraftSettings,
  readWechatDraftTask,
  reconcileWechatDraft,
  replaceWechatDraft,
  runWechatDraftExecutor,
  saveWechatDraftSettings,
  wechatDeliveryView,
  wechatDraftAttemptKey,
  wechatDraftReconcileKey,
  wechatDraftTaskIdFor,
  wechatRetryBackoffSeconds,
  WECHAT_DRAFT_ADMIN_WRITES_DISABLED_ENV,
  WECHAT_DRAFT_DEFAULT_LEASE_SECONDS,
  WECHAT_DRAFT_DEFAULT_MAX_ATTEMPTS,
  WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_FACTOR,
  WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_MAX_SECONDS,
  WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_SECONDS,
  WECHAT_DRAFT_EXECUTOR_DISABLED_ENV,
} from './kernel'
export {
  ensureWechatDraftTables,
  WECHAT_DRAFT_ADDITIVE_COLUMNS,
  WECHAT_DRAFT_ATTEMPT_CLASSIFICATIONS,
  WECHAT_DRAFT_ATTEMPT_OUTCOMES,
  WECHAT_DRAFT_DDL_STATEMENTS,
  WECHAT_DRAFT_TASK_STATUSES,
} from './ddl'
export {
  MockWechatDraftProvider,
  normalizeWechatClassification,
  sanitizeWechatProviderError,
  WechatProviderError,
  WECHAT_PROVIDER_ERROR_LIMIT,
} from './provider'
export { projectWechatDraft, wrapWechatExportFragment } from './projection'
export type { WechatProjectionSettings } from './projection'
export type {
  DeriveWechatDraftInput,
  DeriveWechatDraftResult,
  ReadWechatDraftTaskResult,
  ReplaceWechatDraftInput,
  ReplaceWechatDraftResult,
  SaveWechatDraftSettingsInput,
  SaveWechatDraftSettingsResult,
  WechatDeliveryHistoryRow,
  WechatDeliveryView,
  WechatDraftAttemptClassification,
  WechatDraftAttemptOutcome,
  WechatDraftAttemptRow,
  WechatDraftExecutorInput,
  WechatDraftExecutorResult,
  WechatDraftGenerationRow,
  WechatDraftProjection,
  WechatDraftProvider,
  WechatDraftProviderResult,
  WechatDraftQueryPayload,
  WechatDraftQueryResult,
  WechatDraftReconcileInput,
  WechatDraftReconcileResult,
  WechatDraftReplacementRow,
  WechatDraftSettingsRow,
  WechatDraftSubmitPayload,
  WechatDraftTaskRow,
  WechatDraftTaskStatus,
  WechatLifecycleRowView,
} from './types'
export type { WechatExecutionVerdict } from './kernel'