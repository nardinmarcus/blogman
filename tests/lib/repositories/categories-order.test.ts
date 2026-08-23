import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLedger,
  cleanupStates,
  createState,
  query,
  runD1,
} from '@/tests/helpers/article-identity-state'
import { literal } from '@/tests/helpers/article-identity-state'
import type { Database } from '@/lib/repositories/schema'
import {
  createCategory,
  deleteCategory,
  getCategories,
  reorderCategories,
  updateCategory,
} from '@/lib/repositories/categories'

// Same lightweight D1-through-wrangler Database adapter pattern as
// tests/lib/repositories/articles.test.ts.
function createDatabase(state: string): Database {
  class Statement {
    constructor(private readonly sql: string, private readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values) }
    render() {
      let index = 0
      return this.sql.replace(/\?/g, () => literal(this.values[index++]))
    }
    async all<T>() {
      const result = runD1(state, this.render()).at(-1)
      return { results: (result?.results || []) as T[], success: result?.success ?? true, meta: {} }
    }
    async first<T>() { return (await this.all<T>()).results[0] ?? null }
    async run() { await this.all() ; return { success: true, meta: {} } }
  }
  return {
    prepare(sql: string) { return new Statement(sql) },
  } as unknown as Database
}

describe('category ordering via site_settings', () => {
  afterEach(() => cleanupStates())

  it('orders by stored slug order and keeps it in sync on rename/delete', { timeout: 300_000 }, async () => {
    const state = createState()
    applyLedger(state)
    const db = createDatabase(state)

    // Ledger seeds arrive in name order with no order setting stored.
    const initial = await getCategories(db)
    expect(initial.map((c) => c.slug)).toEqual(['ai', 'ai-tools', 'uncategorized'])
    expect(query(state, "SELECT value FROM site_settings WHERE key = 'category_order'")).toEqual([])

    await reorderCategories(db, ['uncategorized', 'ai', 'ai-tools'])
    expect((await getCategories(db)).map((c) => c.slug)).toEqual(['uncategorized', 'ai', 'ai-tools'])

    // New categories are not in the stored order: appended at the end.
    await createCategory(db, '新产品', 'new-products')
    expect((await getCategories(db)).map((c) => c.slug))
      .toEqual(['uncategorized', 'ai', 'ai-tools', 'new-products'])

    // Slug rename keeps the category's position in the stored order.
    await updateCategory(db, 'ai', 'AI', 'ai-renamed')
    expect((await getCategories(db)).map((c) => c.slug))
      .toEqual(['uncategorized', 'ai-renamed', 'ai-tools', 'new-products'])

    // Delete removes the slug from the stored order.
    await deleteCategory(db, 'uncategorized')
    expect((await getCategories(db)).map((c) => c.slug))
      .toEqual(['ai-renamed', 'ai-tools', 'new-products'])

    // Deleting the remaining ordered slugs empties the order; the empty
    // order is equivalent to unset, so the setting row is removed.
    await deleteCategory(db, 'ai-renamed')
    await deleteCategory(db, 'ai-tools')
    expect(query(state, "SELECT value FROM site_settings WHERE key = 'category_order'")).toEqual([])
    expect((await getCategories(db)).map((c) => c.slug)).toEqual(['new-products'])
  })
})
