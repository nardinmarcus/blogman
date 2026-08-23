import type { Database } from '@/lib/repositories/schema'
import type { CategoryRow } from '@/lib/repositories/types'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { getSetting, setSetting } from '@/lib/repositories/settings'
import { setCategory } from '@/lib/article-commands'

// 分类展示顺序存于 site_settings（与 nav_links 同一模式），避免 schema 变更
const CATEGORY_ORDER_KEY = 'category_order'

async function getCategoryOrder(db: Database): Promise<string[]> {
  const raw = await getSetting(db, CATEGORY_ORDER_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

// rows 已按 name 排序；排序数组中未知的 slug 保持名称序排到末尾（sort 是稳定排序）
function applyCategoryOrder(rows: CategoryRow[], order: string[]): CategoryRow[] {
  if (order.length === 0) return rows
  const position = new Map(order.map((slug, index) => [slug, index]))
  return [...rows].sort(
    (a, b) => (position.get(a.slug) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.slug) ?? Number.MAX_SAFE_INTEGER),
  )
}

// 获取所有分类
export async function getCategories(db: Database): Promise<CategoryRow[]> {
  const { results } = await db
    .prepare('SELECT name, slug, post_count FROM categories ORDER BY name')
    .all<CategoryRow>()

  return applyCategoryOrder(results, await getCategoryOrder(db))
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

  return applyCategoryOrder(results ?? [], await getCategoryOrder(db))
}

// 创建分类
export async function createCategory(db: Database, name: string, slug: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)').bind(name, slug).run()
}

// 保存分类排序（全量 slug 顺序，与 nav_links 同为设置项写入）
export async function reorderCategories(db: Database, slugs: string[]): Promise<void> {
  await setSetting(db, CATEGORY_ORDER_KEY, JSON.stringify(slugs))
}

// 更新分类
export async function updateCategory(db: Database, oldSlug: string, name: string, newSlug: string): Promise<void> {
  const cat = await db
    .prepare('SELECT name FROM categories WHERE slug = ?')
    .bind(oldSlug)
    .first<Pick<CategoryRow, 'name'>>()

  if (cat && cat.name !== name) {
    // #234 Phase A — the posts bulk UPDATE is retired. Every article whose
    // latest frozen snapshot carries the old category name gets its own
    // immutable version via the explicit command (ADR 0007 — no in-place
    // snapshot mutation), so canonical reads reflect the rename immediately.
    // On a ledger-only DB (canonical surfaces absent) there is nothing to
    // re-point: only the taxonomy row renames below.
    let members: Array<{ article_id: number; version: number }> = []
    try {
      members = await db
        .prepare(
          `SELECT a.id AS article_id, COALESCE(MAX(v.version), 0) AS version
           FROM articles a
           JOIN article_versions v ON v.article_id = a.id
           WHERE json_extract(v.snapshot_json, '$.fields.category') = ?
           GROUP BY a.id`,
        )
        .bind(cat.name)
        .all<{ article_id: number; version: number }>().then((r) => r.results)
    } catch {
      // Ledger-only DB: canonical surfaces absent — skip per-article versioning.
      members = []
    }
    for (const member of members) {
      if (member.version < 1) continue
      await setCategory(db, {
        articleId: member.article_id,
        expectedVersion: member.version,
        operationId: `category-rename:${cat.name}:${member.article_id}:${Date.now()}`,
        category: name,
      })
    }
  }

  await db.prepare('UPDATE categories SET name = ?, slug = ? WHERE slug = ?').bind(name, newSlug, oldSlug).run()

  // slug 变更后同步排序设置，避免顺序丢失
  if (oldSlug !== newSlug) {
    const order = await getCategoryOrder(db)
    if (order.includes(oldSlug)) {
      await setSetting(db, CATEGORY_ORDER_KEY, JSON.stringify(order.map((s) => (s === oldSlug ? newSlug : s))))
    }
  }
}

// 删除分类
export async function deleteCategory(db: Database, slug: string): Promise<void> {
  await db.prepare('DELETE FROM categories WHERE slug = ?').bind(slug).run()

  const order = await getCategoryOrder(db)
  if (order.includes(slug)) {
    const next = order.filter((s) => s !== slug)
    // 空顺序等同于未设置，删除该 key 避免留下空壳设置行
    if (next.length === 0) {
      await db.prepare('DELETE FROM site_settings WHERE key = ?').bind(CATEGORY_ORDER_KEY).run()
    } else {
      await setSetting(db, CATEGORY_ORDER_KEY, JSON.stringify(next))
    }
  }
}
