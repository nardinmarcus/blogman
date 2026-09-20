import type { PostWithTags } from '@/lib/repositories/types'
import {
  CANONICAL_ROW_COLUMNS,
  CANONICAL_LATEST_JOIN,
  canonicalFactsAvailable,
  postFromCanonicalRow,
  discoveryConditions,
  readCanonicalRows,
  LIVE_SLUG,
} from '@/lib/public-read/canon'

export async function recallPublicPosts(db: D1Database, slugs: string[]): Promise<PostWithTags[]> {
  if (slugs.length === 0) return []

  const placeholders = slugs.map(() => '?').join(', ')
  const order = new Map(slugs.map((slug, index) => [slug, index]))

  if (!(await canonicalFactsAvailable(db))) {
    // posts is retired from the public runtime — degraded empty.
    return []
  }

  const results = await readCanonicalRows(
    db,
    `SELECT ${CANONICAL_ROW_COLUMNS}
     FROM articles a
     JOIN formal_publications f ON f.article_id = a.id
     JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
     ${CANONICAL_LATEST_JOIN}
     WHERE ${LIVE_SLUG} IN (${placeholders})
       AND ${discoveryConditions().join(' AND ')}`,
    slugs,
  )

  return results
    .map(postFromCanonicalRow)
    .sort((left, right) => (order.get(left.slug) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.slug) ?? Number.MAX_SAFE_INTEGER))
}

/** Recent public articles (exclude one slug), read from canonical facts. */
export async function recentPublicPosts(db: D1Database, excludeSlug: string, limit: number): Promise<PostWithTags[]> {
  if (!(await canonicalFactsAvailable(db))) {
    // posts is retired from the public runtime — degraded empty.
    return []
  }

  const results = await readCanonicalRows(
    db,
    `SELECT ${CANONICAL_ROW_COLUMNS}
     FROM articles a
     JOIN formal_publications f ON f.article_id = a.id
     JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
     ${CANONICAL_LATEST_JOIN}
     WHERE ${LIVE_SLUG} != ?
       AND ${discoveryConditions().join(' AND ')}
     ORDER BY f.first_published_at DESC
     LIMIT ?`,
    [excludeSlug, limit],
  )

  return results.map(postFromCanonicalRow)
}

/** Indexing is public discovery too; callers need only handle absence. */
export async function getIndexablePublicPost(db: D1Database, postId: number): Promise<PostWithTags | null> {
  if (!(await canonicalFactsAvailable(db))) return null
  const rows = await readCanonicalRows(
    db,
    `SELECT ${CANONICAL_ROW_COLUMNS}
     FROM articles a
     JOIN formal_publications f ON f.article_id = a.id
     JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
     ${CANONICAL_LATEST_JOIN}
     WHERE a.post_ref = ?`,
    [postId],
  )
  if (!rows[0]) return null
  const post = postFromCanonicalRow(rows[0])
  // Retain indexing's materialized-value checks (including numeric coercion).
  return post.status === 'published' && !post.password && post.is_hidden === 0 && post.deleted_at == null
    ? post
    : null
}
