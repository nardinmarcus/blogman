/**
 * B7-02 — 比较后显式刷新来源网页 public entry (issue #58).
 *
 * Compare-then-confirm refresh for a CLIP (reference) source page: `propose`
 * freezes the source snapshot + the 标题/正文/媒体 diff bound to the article's
 * current version WITHOUT writing; `confirm` applies only after the author
 * explicitly confirms, through the versioned write kernel (draft → new version;
 * formal → unique active revision). Media is reused by verifiable content
 * identity; a media failure never marks the refresh complete. The clip source
 * never gains the primary-source authority (role stays `clip`).
 */

export {
  proposeRefresh,
  confirmRefresh,
  snapshotFingerprint,
} from './kernel'
export { ensureSourceRefreshTables, SOURCE_REFRESH_DDL_STATEMENTS } from './ddl'
export type {
  ConfirmRefreshInput,
  ConfirmRefreshResult,
  ProposeRefreshInput,
  ProposeRefreshResult,
  ProposedRefreshFacts,
  RefreshDiff,
  RefreshFacts,
  RefreshMediaDiff,
  RefreshMediaStatus,
  SourceRefreshProjection,
} from './types'
