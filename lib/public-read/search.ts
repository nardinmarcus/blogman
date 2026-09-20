import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import {
  CANONICAL_ROW_COLUMNS,
  CANONICAL_LATEST_JOIN,
  canonicalFactsAvailable,
  postFromCanonicalRow,
  postFromAdminRow,
  LIVE_SLUG,
  discoveryConditions,
  readCanonicalRows,
} from '@/lib/public-read/canon'

/**
 * Existing admin compatibility: each flag independently widens the formal
 * search surface. Never-formally-published drafts remain outside this join.
 * Public discovery uses latest management facts through a separate entry.
 */
export function searchAdminPosts(
  db: Database,
  query: string,
  limit: number,
  includeDrafts: boolean,
  includeEncrypted: boolean,
  includeHidden: boolean,
  includeDeleted: boolean,
): Promise<PostWithTags[]> {
  const conditions: string[] = []
  if (!includeDrafts) conditions.push("f.lifecycle = 'published'")
  if (!includeDeleted) conditions.push("COALESCE(json_extract(v.snapshot_json, '$.fields.deleted_at'), 0) = 0")
  if (!includeEncrypted) conditions.push("COALESCE(json_extract(v.snapshot_json, '$.fields.password'), '') = ''")
  if (!includeHidden) conditions.push("COALESCE(json_extract(v.snapshot_json, '$.fields.is_hidden'), 0) = 0")
  return searchCanonical(db, query, limit, conditions, 'admin')
}

/** Public discovery has no admin visibility switches. */
export function searchPublicPosts(db: Database, query: string, limit = 20): Promise<PostWithTags[]> {
  return searchCanonical(db, query, limit, discoveryConditions(), 'public')
}

/** Canonical FTS: article_fts → articles → formal_publications → article_versions. */
async function searchCanonical(
  db: Database,
  query: string,
  limit: number,
  conditions: string[],
  audience: 'public' | 'admin',
): Promise<PostWithTags[]> {
  if (!query.trim() || !(await canonicalFactsAvailable(db))) return []
  // FTS5 safety: a raw user query containing ':' (e.g. a title "in 2026: 12
  // steps") makes FTS5 parse "2026:" as a column filter → "no such column".
  // Quote the whole query as one phrase and escape embedded quotes, so the
  // MATCH argument is always a syntactically-safe string literal.
  const ftsSafeQuery = `"${query.replace(/"/g, '""')}"`
  const params: unknown[] = [ftsSafeQuery]
  const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''
  // BASE admin reads did not consult the registry; retain its formal fallback.
  const columns = audience === 'admin'
    ? CANONICAL_ROW_COLUMNS.replace(LIVE_SLUG, 'f.slug')
    : CANONICAL_ROW_COLUMNS

  try {
    const results = await readCanonicalRows(
      db,
      `SELECT ${columns}
       FROM article_fts
       JOIN articles a ON a.id = article_fts.rowid
       JOIN formal_publications f ON f.article_id = a.id
       JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
       ${CANONICAL_LATEST_JOIN}
       WHERE article_fts MATCH ?${whereClause}
       ORDER BY rank
       LIMIT ?`,
      [...params, limit],
    )
    return results.map(audience === 'admin' ? postFromAdminRow : postFromCanonicalRow)
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    // Schema faults above remain strict; other FTS faults degrade to empty.
    return []
  }
}

