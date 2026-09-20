import type { Database } from '@/lib/repositories/schema'
import type { CategoryRow } from '@/lib/repositories/types'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { canonicalFactsAvailableStrictForRequest, CANONICAL_LATEST_JOIN, MANAGEMENT, discoveryConditions } from './canon'

/** Null means facts are unavailable; callers must preserve early degradation. */
export async function listPublicCategoryMembership(db: Database): Promise<CategoryRow[] | null> {
  // Degraded: posts is retired from the public runtime. When the canonical
  // fact tables are absent the header / sitemap get an empty category list
  // rather than a legacy `posts` read.
  try {
    // #244 — request-scoped schema probe (single cached sqlite_master read,
    // shared with detail/related/search). STRICT variant: a migration-required
    // DB must still surface DATABASE_MIGRATION_REQUIRED (the site header /
    // request-db-readonly path relies on it).
    const has = await canonicalFactsAvailableStrictForRequest(db)
    if (!has) return null
  } catch (error) {
    // A migration-required DB must still surface DATABASE_MIGRATION_REQUIRED
    // (the site header / request-db-readonly path relies on it).
    rethrowIfDatabaseMigrationRequired(error)
    return null
  }

  // Taxonomy membership and visibility both follow latest management;
  // formal publication still controls lifecycle and content eligibility.
  const { results } = await db
    .prepare(
      `SELECT cat.name, cat.slug, COUNT(*) AS post_count
       FROM formal_publications f
       JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
       ${CANONICAL_LATEST_JOIN}
       JOIN categories cat ON cat.name = ${MANAGEMENT.category}
       WHERE ${discoveryConditions().join(' AND ')}
         AND COALESCE(${MANAGEMENT.category}, '') <> ''
       GROUP BY cat.name, cat.slug
       ORDER BY cat.name`,
    )
    .all<CategoryRow>()

  return results ?? []
}
