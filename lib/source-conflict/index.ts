/**
 * B6-04 — 明确选边解决主要源稿内容冲突 public entry (issue #53).
 *
 * When BOTH sides deviate from the confirmed baseline the sync is paused and
 * the author explicitly picks a side — source or Blogman — from a derived
 * title/body/media diff projection. There is no auto-merge. Choosing the
 * source saves a restore point first and commits the chosen source content
 * through the versioned write kernel (draft → new version; formal article →
 * its unique active revision); choosing Blogman routes through the B6-03
 * write-back lifecycle where the external confirmation is the only thing that
 * advances the baseline. A change on either side after the choice expires it.
 *
 * Zero production (零生产): the provider/media-store/write-back adapters are
 * mocks; the whole failure/expiry surface is provable in tests.
 */

export {
  CONFLICT_SAVE_OP_PREFIX,
  CONFLICT_WRITE_BACK_OP_PREFIX,
  ensureConflictTables,
  SOURCE_CONFLICT_DDL_STATEMENTS,
} from './ddl'
export {
  advanceConflictBaseline,
  confirmConflictWriteBack,
  conflictResolutionByOperation,
  currentConflictState,
  deriveDiffProjection,
  deriveSideDiff,
  deriveState,
  diffMedia,
  executeConflictWriteBack,
  mediaUrlsFromBody,
  probeConflict,
  readBlogmanView,
  readSourceView,
  resolveConflictSide,
  tokenDiff,
} from './kernel'
export { MockWritableSource } from './provider'
export type {
  BlogmanView,
  BodyDiffToken,
  ConfirmConflictWriteBackInput,
  ConfirmConflictWriteBackResult,
  ConflictBaseline,
  ConflictChosenSide,
  ConflictProbe,
  ConflictResolution,
  ConflictResolutionStatus,
  DerivedSyncState,
  DiffProjection,
  ExecuteConflictWriteBackInput,
  ExecuteConflictWriteBackResult,
  MediaItemDiff,
  ProbeConflictResult,
  ResolveConflictInput,
  ResolveConflictResult,
  SideProjectionDiff,
  SourceView,
} from './types'
export type { MediaStore, MediaSyncFact, SourceProvider, SourceWriteProvider, WriteBackIntent } from './types'