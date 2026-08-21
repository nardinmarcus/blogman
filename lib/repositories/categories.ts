import type { Database } from '@/lib/repositories/schema'
import type { CategoryRow } from '@/lib/repositories/types'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'

// 获取所有分类
export async function getCategories(db: Database): Promise<CategoryRow[]> {
  const { results } = await db
    .prepare('SELECT name, slug, post_count FROM categories ORDER BY name')
    .all<CategoryRow>()

  return results
}

export async function getPublicCategories(db: Database): Promise<CategoryRow[]> {
  // Degraded: posts is retired from the public runtime. When the canonical
  // fact tables are absent the header / sitemap get an empty category list
  // rather than a legacy `posts` read.
  try {
    const has = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='formal_publications'`)
      .first<{ name: string }>()
    if (!has) return []
  } catch (error) {
    // A migration-required DB must still surface DATABASE_MIGRATION_REQUIRED
    // (the site header / request-db-readonly path relies on it).
    rethrowIfDatabaseMigrationRequired(error)
    return []
  }

  // L2: the public category reader list derives from the CANONICAL formal
  // surface (lifecycle published + frozen-snapshot password/hidden/deleted),
  // grouped by the version snapshot's category — not the posts projection.
  const { results } = await db
    .prepare(
      `SELECT cat.name, cat.slug, COUNT(*) AS post_count
       FROM formal_publications f
       JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
       JOIN categories cat ON cat.name = json_extract(v.snapshot_json, '$.fields.category')
       WHERE f.lifecycle = 'published'
         AND COALESCE(json_extract(v.snapshot_json, '$.fields.password'), '') = ''
         AND COALESCE(json_extract(v.snapshot_json, '$.fields.is_hidden'), 0) = 0
         AND COALESCE(json_extract(v.snapshot_json, '$.fields.deleted_at'), 0) = 0
         AND COALESCE(json_extract(v.snapshot_json, '$.fields.category'), '') <> ''
       GROUP BY cat.name, cat.slug
       ORDER BY cat.name`,
    )
    .all<CategoryRow>()

  return results ?? []
}

// 创建分类
export async function createCategory(db: Database, name: string, slug: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)').bind(name, slug).run()
}

// 更新分类
export async function updateCategory(db: Database, oldSlug: string, name: string, newSlug: string): Promise<void> {
  const cat = await db
    .prepare('SELECT name FROM categories WHERE slug = ?')
    .bind(oldSlug)
    .first<Pick<CategoryRow, 'name'>>()

  if (cat) {
    await db.prepare('UPDATE posts SET category = ? WHERE category = ?').bind(name, cat.name).run()
  }

  await db.prepare('UPDATE categories SET name = ?, slug = ? WHERE slug = ?').bind(name, newSlug, oldSlug).run()
}

// 删除分类
export async function deleteCategory(db: Database, slug: string): Promise<void> {
  await db.prepare('DELETE FROM categories WHERE slug = ?').bind(slug).run()
}
