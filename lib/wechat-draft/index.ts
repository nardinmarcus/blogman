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
 */

export {
  buildSubmitPayload,
  deriveWechatDraft,
  listWechatDraftTasks,
  normalizeWechatAccountId,
  projectionDigest,
  projectionFromRow,
  readWechatDraftTask,
  wechatDraftTaskIdFor,
} from './kernel'
export { ensureWechatDraftTables, WECHAT_DRAFT_DDL_STATEMENTS, WECHAT_DRAFT_TASK_STATUSES } from './ddl'
export {
  MockWechatDraftProvider,
  sanitizeWechatProviderError,
  WECHAT_PROVIDER_ERROR_LIMIT,
} from './provider'
export { projectWechatDraft, wrapWechatExportFragment } from './projection'
export type {
  DeriveWechatDraftInput,
  DeriveWechatDraftResult,
  ReadWechatDraftTaskResult,
  WechatDraftProjection,
  WechatDraftProvider,
  WechatDraftProviderResult,
  WechatDraftSubmitPayload,
  WechatDraftTaskRow,
} from './types'