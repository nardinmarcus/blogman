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
 */

export {
  buildSubmitPayload,
  classifyWechatExecution,
  deriveWechatDraft,
  isWechatDraftExecutorDisabled,
  listWechatDraftAttempts,
  listWechatDraftTasks,
  normalizeWechatAccountId,
  projectionDigest,
  projectionFromRow,
  readWechatDraftTask,
  reconcileWechatDraft,
  runWechatDraftExecutor,
  wechatDraftAttemptKey,
  wechatDraftReconcileKey,
  wechatDraftTaskIdFor,
  wechatRetryBackoffSeconds,
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
export type {
  DeriveWechatDraftInput,
  DeriveWechatDraftResult,
  ReadWechatDraftTaskResult,
  WechatDraftAttemptClassification,
  WechatDraftAttemptOutcome,
  WechatDraftAttemptRow,
  WechatDraftExecutorInput,
  WechatDraftExecutorResult,
  WechatDraftProjection,
  WechatDraftProvider,
  WechatDraftProviderResult,
  WechatDraftQueryPayload,
  WechatDraftQueryResult,
  WechatDraftReconcileInput,
  WechatDraftReconcileResult,
  WechatDraftSubmitPayload,
  WechatDraftTaskRow,
  WechatDraftTaskStatus,
} from './types'
export type { WechatExecutionVerdict } from './kernel'