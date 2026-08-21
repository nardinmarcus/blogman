import type { Database } from '@/lib/repositories/schema'
import type { Post, PostWithTags } from '@/lib/repositories/types'
import { mapPostWithTags } from '@/lib/repositories/post-mappers'
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
 * On a pre-migration / ledger-only DB (canonical tables absent) it SOFT-SWITCHES
 * to the legacy `posts` + `posts_fts` projection so search never 500s.
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

  if (await canonicalFactsAvailable(db)) {
    return searchCanonical(db, query, limit, includeDrafts, includeEncrypted, includeHidden, includeDeleted)
  }
  return searchLegacy(db, query, limit, includeDrafts, includeEncrypted, includeHidden, includeDeleted)
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

/** Legacy (pre-migration) FTS with LIKE fallback, unchanged semantics. */
async function searchLegacy(
  db: Database,
  query: string,
  limit: number,
  includeDrafts: boolean,
  includeEncrypted: boolean,
  includeHidden: boolean,
  includeDeleted: boolean,
): Promise<PostWithTags[]> {
  const conditions: string[] = []
  if (!includeDrafts) conditions.push("posts.status = 'published'")
  if (!includeEncrypted) conditions.push('posts.password IS NULL')
  if (!includeHidden) conditions.push('posts.is_hidden = 0')
  if (!includeDeleted) conditions.push('posts.deleted_at IS NULL')
  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''

  let results: Post[]
  try {
    const ftsResult = await db
      .prepare(
        `SELECT posts.* FROM posts_fts
         JOIN posts ON posts.id = posts_fts.rowid
         WHERE posts_fts MATCH ?
         ${whereClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .bind(query, limit)
      .all<Post>()
    results = ftsResult.results
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    const pattern = `%${query}%`
    const likeResult = await db
      .prepare(
        `SELECT * FROM posts
         WHERE (title LIKE ? OR content LIKE ?)
         ${whereClause}
         ORDER BY published_at DESC
         LIMIT ?`,
      )
      .bind(pattern, pattern, limit)
      .all<Post>()
    results = likeResult.results
  }

  return results.map(mapPostWithTags)
}
