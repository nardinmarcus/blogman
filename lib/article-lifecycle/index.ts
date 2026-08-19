/**
 * B3-05 — article lifecycle command kernel (issue #37) public entry.
 *
 * Independent lifecycle commands over a formally published article:
 *
 *   - `unpublish` — take a live article OFF the public surface (取消发布);
 *     preserves every version, revision, restore point and the history.
 *   - `relive`    — bring it back online (重新上线): either the last official
 *     version (`content: 'formal'`) or the current pending revision
 *     (`content: 'revision'`).
 *
 * Soft-delete restore ("软删后恢复为未发布") is owned by the B2-06 `restore`
 * command in lib/article-commands — it returns a deleted post to the draft/
 * unpublished state without ever re-publishing it.
 *
 * Every transition is recorded immutably in `article_lifecycles` (operation id
 * idempotence + status precondition). Slug history (#36) and the revision
 * comparison UI (#35) are out of scope.
 */

export { unpublish, relive, listLifecycleHistory, evidenceDigest } from './kernel'
export type {
  LifecycleRow,
  UnpublishInput,
  UnpublishResult,
  ReliveInput,
  ReliveResult,
  LifecycleAppliedResult,
  LifecycleReplayedResult,
  LifecycleVersionConflict,
  LifecycleStatusConflict,
  LifecycleBlocked,
  LifecycleNotFound,
  LifecycleDirection,
  AllowedLifecycle,
} from './types'
export { ARTICLE_LIFECYCLE_DDL_STATEMENTS, ensureArticleLifecycleTables } from './ddl'
