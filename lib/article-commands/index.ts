/**
 * B2-03 — versioned article write command kernel (issue #26).
 *
 * Public entry point: `create` / `save` / `publishTemp` over an isolated D1
 * application command layer. Version facts lead, the legacy `posts` compat
 * projection follows, both inside one transaction. No batch-3 facts
 * (publish intent / events / Outbox) are built here.
 */

export {
  create,
  save,
  publishTemp,
  createOperationId,
  setPinned,
  setHidden,
  setPassword,
  setCategory,
  softDelete,
  restore,
  batchSetCategory,
} from './kernel'
export type {
  ArticleCommandProjections,
  ArticleCommandSnapshot,
  ArticleCommandStatus,
  AppliedVersionResult,
  ArticleLevelInput,
  ArticleLevelResult,
  BatchSetCategoryInput,
  BatchSetCategoryItem,
  BatchSetCategoryItemResult,
  BatchSetCategoryResult,
  CreateArticleInput,
  CreateResult,
  PublishTempInput,
  PublishTempResult,
  SaveArticleInput,
  SaveResult,
  SetCategoryInput,
  SetHiddenInput,
  SetPasswordInput,
  SetPinnedInput,
  SoftDeleteInput,
  RestoreInput,
  VersionComparisonFacts,
  VersionConflictResult,
} from './types'
