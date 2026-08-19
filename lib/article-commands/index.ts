/**
 * B2-03 — versioned article write command kernel (issue #26).
 *
 * Public entry point: `create` / `save` / `publishTemp` over an isolated D1
 * application command layer. Version facts lead, the legacy `posts` compat
 * projection follows, both inside one transaction. No batch-3 facts
 * (publish intent / events / Outbox) are built here.
 */

export { create, save, publishTemp, createOperationId } from './kernel'
export type {
  ArticleCommandProjections,
  ArticleCommandSnapshot,
  ArticleCommandStatus,
  AppliedVersionResult,
  CreateArticleInput,
  CreateResult,
  PublishTempInput,
  PublishTempResult,
  SaveArticleInput,
  SaveResult,
  VersionComparisonFacts,
  VersionConflictResult,
} from './types'
