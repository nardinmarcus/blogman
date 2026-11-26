/**
 * B3-04 — slug-address test helpers (issue #36).
 *
 * Reuses the shared in-process Miniflare bootstrap; the first-publish, revision
 * and slug-address registry tables come from ledger migration 008.
 * Formal articles are produced through the REAL first-publish loop.
 */

import { bootstrapRevisionState, createDatabase, createFormalArticle, query, freshOp } from '@/tests/lib/publish-revision/helpers'

export { bootstrapRevisionState, createDatabase, createFormalArticle, query, freshOp }

/** Boot the identity + first-publish + revision + slug-address schema. */
export async function bootstrapSlugAddressState(stateDir: string): Promise<void> {
  await bootstrapRevisionState(stateDir)
}
