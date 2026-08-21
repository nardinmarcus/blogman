import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import {
  CANONICAL_ROW_COLUMNS,
  canonicalFactsAvailable,
  type CanonicalPublicRow,
  postFromCanonicalRow,
} from '@/lib/public-read/canon'

/** JSON1 accessors over the frozen version snapshot (mirrors kernel.ts). */
const SNAP = {
  deleted_at: "COALESCE(json_extract(v.snapshot_json, '$.fields.deleted_at'), 0)",
  password: "COALESCE(json_extract(v.snapshot_json, '$.fields.password'), '')",
  is_hidden: "COALESCE(json_extract(v.snapshot_json, '$.fields.is_hidden'), 0)",
}

/**
 * 全文搜索（FTS5，回退 LIKE）。
 *
 * On a canonical DB the search is re-anchored to canonical facts: `posts_fts`
 * is a REBUILDABLE projection used only to LOCATE candidates (its rowid is the
 * `posts.id` = `articles.post_ref`); every hit is then joined through
 * `articles` → `formal_publications` (lifecycle) → `article_versions`
 * (frozen access-control + content) so visibility/encryption/hidden semantics
 * are decided from canonical facts, in SQL, preserving FTS `rank` ordering.
 *
 * On a pre-migration / ledger-only DB (canonical tables absent) search is
 * DEGRADED: no legacy `posts` fallback is run (posts is retired from the public
 * runtime), so it returns an empty result set rather than reading `posts`.
 */
export async function searchPosts(
  db: Database,
  query: string,
  limit = 20,
  includeDrafts = false,
  includeEncrypted = false,
  includeHidden = false,
  includeDeleted = false,
): Promise<PostWithTags[]> {
  if (!query.trim()) return []

  if (!(await canonicalFactsAvailable(db))) {
    // posts is retired from the public runtime — degraded empty is the intent.
    return []
  }
  return searchCanonical(db, query, limit, includeDrafts, includeEncrypted, includeHidden, includeDeleted)
}

/** Canonical FTS: posts_fts → articles → formal_publications → article_versions. */
async function searchCanonical(
  db: Database,
  query: string,
  limit: number,
  includeDrafts: boolean,
  includeEncrypted: boolean,
  includeHidden: boolean,
  includeDeleted: boolean,
): Promise<PostWithTags[]> {
  const conditions: string[] = []
  const params: unknown[] = [query]
  if (!includeDrafts) conditions.push(`f.lifecycle = 'published'`)
  if (!includeDeleted) conditions.push(`${SNAP.deleted_at} = 0`)
  if (!includeEncrypted) conditions.push(`${SNAP.password} = ''`)
  if (!includeHidden) conditions.push(`${SNAP.is_hidden} = 0`)
  const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

  try {
    const { results } = await db
      .prepare(
        `SELECT ${CANONICAL_ROW_COLUMNS}
         FROM posts_fts
         JOIN articles a ON a.post_ref = posts_fts.rowid
         JOIN formal_publications f ON f.article_id = a.id
         JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
         WHERE posts_fts MATCH ?${whereClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .bind(...params, limit)
      .all<CanonicalPublicRow>()
    return (results ?? []).map(postFromCanonicalRow)
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    // FTS projection missing / parse error → a LIKE scan is not canonical-safe
    // here; keep search a rebuildable, best-effort surface.
    return []
  }
}


