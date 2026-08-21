/**
 * Canonical admin/public article read model (#234 Phase A).
 *
 * The legacy direct-write helpers (createPost / updatePost / deletePost /
 * incrementViewCount / …) are retired with the posts projection (ADR 0008):
 * every write goes through the versioned command kernels
 * (`lib/article-commands`, `lib/publish-revision`, `lib/article-lifecycle`).
 * What remains here is the read model that materialises the legacy-compatible
 * `PostWithTags` shape from canonical facts:
 *
 *   articles → latest article_versions snapshot (live state)
 *            → formal_publications  (observable lifecycle)
 *            → article_slug_addresses (address resolution)
 */

import { throwDatabaseMigrationRequired } from '@/lib/database-errors'
import type { Database } from '@/lib/repositories/schema'
import type { CountRow, PostWithTags } from '@/lib/repositories/types'

interface CanonicalListRow {
  post_ref: number
  slug: string
  lifecycle: string | null
  title: string | null
  description: string | null
  category: string | null
  tags: string | null
  authoring_status: string | null
  password: string | null
  is_pinned: number | null
  is_hidden: number | null
  cover_image: string | null
  deleted_at: number | null
  published_at: number | null
  updated_at: number | null
  original_content: string | null
  original_html: string | null
}

const LIST_SOURCE = `
  FROM articles a
  JOIN article_versions v ON v.article_id = a.id
   AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
  LEFT JOIN formal_publications f ON f.article_id = a.id`

const LIST_SOURCE_NO_FORMAL = `
  FROM articles a
  JOIN article_versions v ON v.article_id = a.id
   AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)`

const listFields = (withFormal: boolean) => `
  a.post_ref,
  COALESCE(json_extract(v.snapshot_json, '$.fields.slug'), a.slug) AS slug,
  ${withFormal ? 'f.lifecycle' : 'NULL'} AS lifecycle,
  json_extract(v.snapshot_json, '$.fields.title') AS title,
  json_extract(v.snapshot_json, '$.fields.description') AS description,
  json_extract(v.snapshot_json, '$.fields.category') AS category,
  json_extract(v.snapshot_json, '$.fields.tags') AS tags,
  json_extract(v.snapshot_json, '$.fields.status') AS authoring_status,
  json_extract(v.snapshot_json, '$.fields.password') AS password,
  json_extract(v.snapshot_json, '$.fields.is_pinned') AS is_pinned,
  json_extract(v.snapshot_json, '$.fields.is_hidden') AS is_hidden,
  json_extract(v.snapshot_json, '$.fields.cover_image') AS cover_image,
  json_extract(v.snapshot_json, '$.fields.deleted_at') AS deleted_at,
  json_extract(v.snapshot_json, '$.fields.published_at') AS published_at,
  json_extract(v.snapshot_json, '$.fields.updated_at') AS updated_at,
  json_extract(v.snapshot_json, '$.original_content') AS original_content,
  json_extract(v.snapshot_json, '$.original_html') AS original_html`

function parseTags(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.map(String)
  const s = String(raw).trim()
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed.map(String) : [s]
  } catch {
    return [s]
  }
}

/** Observable status: soft-delete wins; restore ≠ re-publish; lifecycle decides. */
function deriveStatus(
  lifecycle: string | null,
  deletedAt: number | null,
  authoringStatus: string | null,
): 'draft' | 'published' | 'deleted' {
  if (deletedAt != null) return 'deleted'
  if (lifecycle === 'published' && authoringStatus !== 'draft') return 'published'
  return 'draft'
}

/** Re-throw D1 schema failures as the classified migration-required error. */
async function classified<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    throwDatabaseMigrationRequired(error)
  }
}

/** True when the formal_publications surface exists on this DB. */
async function formalAvailable(db: Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='formal_publications'")
      .first<{ name: string }>()
    return Boolean(row)
  } catch {
    return false
  }
}

function toPost(row: CanonicalListRow): PostWithTags {
  const deletedAt = (row.deleted_at as number | null) ?? null
  return {
    id: row.post_ref,
    slug: row.slug,
    title: (row.title as string) ?? row.slug,
    content: row.original_content ?? '',
    html: row.original_html ?? '',
    description: (row.description as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    tags: parseTags(row.tags),
    status: deriveStatus(row.lifecycle, deletedAt, (row.authoring_status as string | null) ?? null),
    password: (row.password as string | null) ?? null,
    is_pinned: (row.is_pinned as number | null) ?? 0,
    is_hidden: (row.is_hidden as number | null) ?? 0,
    cover_image: (row.cover_image as string | null) ?? null,
    deleted_at: deletedAt,
    published_at: (row.published_at as number | null) ?? 0,
    updated_at: (row.updated_at as number | null) ?? 0,
    view_count: 0,
  }
}

// 获取文章列表（默认只返回已发布文章）
export async function getPosts(
  db: Database,
  limit = 50,
  offset = 0,
  includeDrafts = false,
  includeEncrypted = false,
  includeHidden = false,
  includeDeleted = false,
): Promise<PostWithTags[]> {
  const conditions: string[] = []
  if (!includeDeleted) conditions.push('deleted_at IS NULL')
  if (!includeEncrypted) conditions.push("COALESCE(password, '') = ''")
  if (!includeHidden) conditions.push('COALESCE(is_hidden, 0) = 0')
  if (!includeDrafts) {
    conditions.push("f.lifecycle = 'published'")
    conditions.push("authoring_status <> 'draft'")
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const source = (await formalAvailable(db)) ? LIST_SOURCE : LIST_SOURCE_NO_FORMAL

  const { results } = await classified(db
    .prepare(
      `SELECT * FROM (SELECT ${listFields(source === LIST_SOURCE)}
       ${source}
       ${where})
       ORDER BY is_pinned DESC, published_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<CanonicalListRow>())

  return results.map(toPost)
}

// 根据 slug 获取文章（调用方可选传入公共 KV 缓存）
export async function getPostBySlug(
  db: Database,
  slug: string,
  _kv?: KVNamespace,
): Promise<PostWithTags | null> {
  void _kv
  // Address resolution through the permanent registry (ADR 0009): any kind
  // matches (admin/editor need drafts and candidates too); fall back to the
  // identity slug for pre-registry rows.
  const source = (await formalAvailable(db)) ? LIST_SOURCE : LIST_SOURCE_NO_FORMAL
  const { results } = await classified(db
    .prepare(
      `SELECT ${listFields(source === LIST_SOURCE)}
       ${source}
       WHERE a.id = (
         SELECT article_id FROM article_slug_addresses WHERE slug = ?
           UNION ALL
         SELECT id FROM articles WHERE slug = ? LIMIT 1
       )
       LIMIT 1`,
    )
    .bind(slug, slug)
    .all<CanonicalListRow>())

  const row = results[0]
  return row ? toPost(row) : null
}

// 获取统计数据
export async function getStats(
  db: Database,
): Promise<{ total_posts: number; total_views: number }> {
  const source = (await formalAvailable(db)) ? LIST_SOURCE : LIST_SOURCE_NO_FORMAL
  const result = await classified(db
    .prepare(
      `SELECT COUNT(*) as total_posts FROM (SELECT 1 AS one ${source}
       WHERE json_extract(v.snapshot_json, '$.fields.deleted_at') IS NULL)`,
    )
    .first<{ total_posts: number }>())
  return {
    total_posts: (result?.total_posts as number) ?? 0,
    // The public view counter was retired with the projection (ADR 0010).
    total_views: 0,
  }
}

// 获取文章总数（默认只统计已发布）
export async function getPostsCount(
  db: Database,
  includeDrafts = false,
  includeEncrypted = false,
  includeHidden = false,
  includeDeleted = false,
): Promise<number> {
  const conditions: string[] = []
  if (!includeDeleted) conditions.push('deleted_at IS NULL')
  if (!includeEncrypted) conditions.push("COALESCE(password, '') = ''")
  if (!includeHidden) conditions.push('COALESCE(is_hidden, 0) = 0')
  if (!includeDrafts) {
    conditions.push("f.lifecycle = 'published'")
    conditions.push("authoring_status <> 'draft'")
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const source = (await formalAvailable(db)) ? LIST_SOURCE : LIST_SOURCE_NO_FORMAL
  const result = await classified(db
    .prepare(`SELECT COUNT(*) as count FROM (SELECT 1 AS one ${source} ${where})`)
    .first<CountRow>())
  return (result?.count as number) ?? 0
}

// 根据分类获取文章数
export async function getPostsCountByCategory(db: Database, category: string): Promise<number> {
  const source = (await formalAvailable(db)) ? LIST_SOURCE : LIST_SOURCE_NO_FORMAL
  const result = await classified(db
    .prepare(
      `SELECT COUNT(*) as count FROM (SELECT 1 AS one ${source}
       WHERE category = ?
         AND f.lifecycle = 'published'
         AND authoring_status <> 'draft'
         AND COALESCE(password, '') = ''
         AND COALESCE(is_hidden, 0) = 0
         AND deleted_at IS NULL)`,
    )
    .bind(category)
    .first<CountRow>())
  return (result?.count as number) ?? 0
}

// 根据分类获取文章
export async function getPostsByCategory(
  db: Database,
  category: string,
  limit = 50,
  offset = 0,
): Promise<PostWithTags[]> {
  const source = (await formalAvailable(db)) ? LIST_SOURCE : LIST_SOURCE_NO_FORMAL
  const { results } = await classified(db
    .prepare(
      `SELECT * FROM (SELECT ${listFields(source === LIST_SOURCE)}
       ${source}
       WHERE category = ?
         AND f.lifecycle = 'published'
         AND authoring_status <> 'draft'
         AND COALESCE(password, '') = ''
         AND COALESCE(is_hidden, 0) = 0
         AND deleted_at IS NULL)
       ORDER BY is_pinned DESC, published_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(category, limit, offset)
    .all<CanonicalListRow>())

  return results.map(toPost)
}
