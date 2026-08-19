/**
 * B3-05 — article lifecycle test helpers (issue #37).
 *
 * Layers the immutable `article_lifecycles` ledger on top of the shared
 * B3-02 bootstrap (identity + first-publish + revision schema) so lifecycle
 * commands are anchored to genuine formal facts. `createFormalArticle` runs
 * the REAL first-publish loop, giving a live formal publication to unpublish
 * and relive.
 */

import {
  bootstrapRevisionState,
  createDatabase,
  query,
  createFormalArticle,
  freshOp,
} from '@/tests/lib/publish-revision/helpers'
import { ensureArticleLifecycleTables } from '@/lib/article-lifecycle/ddl'

export { createDatabase, query, createFormalArticle, freshOp }

export async function bootstrapLifecycleState(stateDir: string): Promise<void> {
  await bootstrapRevisionState(stateDir)
  await ensureArticleLifecycleTables(createDatabase())
}
