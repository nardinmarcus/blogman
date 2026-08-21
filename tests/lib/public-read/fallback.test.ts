/**
 * L4 — degraded public read when canonical tables are absent (issue #69).
 *
 * posts is RETIRED from the public runtime: when the canonical fact tables
 * (formal_publications / article_versions) are absent — e.g. a pre-migration /
 * ledger-only DB, or after the posts tables were dropped under gate+backup —
 * every public read path must DEGRADE (empty / unresolvable / zero) and must
 * NEVER fall back to the legacy `posts` projection.
 *
 * This is the regression guard for request-db-readonly: the site header reads
 * canonical public categories, and getSiteHeaderData must keep working (return
 * an empty category set) on a ledger-only DB.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapState, teardownState, createDatabase, query } from '@/tests/lib/article-commands/helpers'
import { getPublicCategories, searchPosts } from '@/lib/db'
import { listPublicArticles, resolvePublicArticle, searchPublicArticles, countPublicArticles } from '@/lib/public-read'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b69-public-read-degraded-'))
  cleanup.push(state)
  await bootstrapState(state)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('lib/public-read — degraded (no posts fallback) on a ledger-only DB', { timeout: 600_000 }, () => {
  it('canonical tables absent → detail/list/search/count degrade to empty, never read posts', async () => {
    // ledger-only DB: no formal_publications / slug-address / lifecycle tables,
    // but a legacy posts row exists — it must NOT surface through the readers.
    await query(
      `INSERT INTO posts (slug, title, content, html, description, category, tags, status, is_pinned, is_hidden, published_at)
       VALUES ('legacy_ro', 'Legacy Readonly', 'legacy body', '<p>legacy body</p>', 'desc', 'AI', '["x"]', 'published', 0, 0, 1700000000)`,
    )
    await query(`INSERT OR IGNORE INTO categories (name, slug) VALUES ('AI', 'ai')`)

    // detail degrades: unknown address, no legacy read
    const resolved = await resolvePublicArticle(createDatabase(), 'legacy_ro')
    expect(resolved.redirectSlug).toBeNull()
    expect(resolved.article).toBeNull()

    // list / count degrade to empty / zero
    expect(await listPublicArticles(createDatabase())).toEqual([])
    expect(await countPublicArticles(createDatabase())).toBe(0)

    // search degrades to empty (no `posts` / posts_fts fallback)
    expect(await searchPublicArticles(createDatabase(), 'legacy')).toEqual([])

    // public categories degrade to empty (the request-db-readonly regression)
    const cats = await getPublicCategories(createDatabase())
    expect(cats.some((c) => c.name === 'AI')).toBe(false)
  })

  it('searchPosts degrades: ledger-only DB returns zero results (posts retired)', async () => {
    const hits = await searchPosts(createDatabase(), 'legacy', 20)
    expect(hits).toEqual([])
  })
})