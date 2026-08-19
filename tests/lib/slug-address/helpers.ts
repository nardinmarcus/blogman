/**
 * B3-04 — slug-address test helpers (issue #36).
 *
 * Reuses the shared in-process Miniflare bootstrap plus the first-publish and
 * revision fact tables, and layers the permanent slug-address registry on top
 * via its own idempotent DDL — exactly what the backfill / route path does.
 * Formal articles are produced through the REAL first-publish loop.
 */

import { bootstrapRevisionState, createDatabase, createFormalArticle, query, freshOp } from '@/tests/lib/publish-revision/helpers'
import { ensureSlugAddressTables } from '@/lib/slug-address'

export { bootstrapRevisionState, createDatabase, createFormalArticle, query, freshOp }

/** Boot the identity + first-publish + revision + slug-address schema. */
export async function bootstrapSlugAddressState(stateDir: string): Promise<void> {
  await bootstrapRevisionState(stateDir)
  await ensureSlugAddressTables(createDatabase())
}
