/**
 * L2 — canonical public read soft-switch fallback (issue #67).
 *
 * Guards the invariant that public read paths never 500 when the canonical
 * fact tables (formal_publications, article_lifecycles, article_slug_addresses)
 * are absent — e.g. a pre-migration / ledger-only DB. In that state the read
 * model must SOFT-SWITCH to the legacy `posts` projection instead of throwing.
 *
 * This is the regression guard for request-db-readonly: the site header reads
 * canonical public categories, and getSiteHeaderData must keep working on a
 * ledger-only DB.
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
  state = mkdtempSync(join(tmpdir(), 'blogman-b67-public-read-fallback-'))
  cleanup.push(state)
  await bootstrapState(state)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('lib/public-read — soft-switch fallback on a ledger-only DB', { timeout: 600_000 }, () => {
  it('canonical tables absent → detail/list/search/public-categories fall back to legacy posts', async () => {
    // ledger-only DB: no formal_publications / slug-address / lifecycle tables
    await query(
      `INSERT INTO posts (slug, title, content, html, description, category, tags, status, is_pinned, is_hidden, published_at)
       VALUES ('legacy_ro', 'Legacy Readonly', 'legacy body', '<p>legacy body</p>', 'desc', 'AI', '["x"]', 'published', 0, 0, 1700000000)`,
    )
    await query(`INSERT OR IGNORE INTO categories (name, slug) VALUES ('AI', 'ai')`)

    // detail soft-switch: resolves via legacy read, no throw
    const resolved = await resolvePublicArticle(createDatabase(), 'legacy_ro')
    expect(resolved.redirectSlug).toBeNull()
    expect(resolved.article).toBeTruthy()
    expect(resolved.article!.live).toBe(true)
    expect(resolved.article!.title).toBe('Legacy Readonly')

    // list soft-switch
    const list = await listPublicArticles(createDatabase())
    expect(list.map((a) => a.slug)).toContain('legacy_ro')
    expect(await countPublicArticles(createDatabase())).toBe(1)

    // search soft-switch (FTS projection)
    const hits = await searchPublicArticles(createDatabase(), 'legacy')
    expect(hits.map((a) => a.slug)).toContain('legacy_ro')

    // public categories soft-switch (the request-db-readonly regression)
    const cats = await getPublicCategories(createDatabase())
    expect(cats.some((c) => c.name === 'AI' && c.post_count === 1)).toBe(true)
  })

  it('searchPosts soft-switch: falls back to the legacy posts FTS on a ledger-only DB', async () => {
    const hits = await searchPosts(createDatabase(), 'legacy', 20)
    expect(hits.map((p) => p.slug)).toContain('legacy_ro')
    expect(hits.every((p) => p.is_hidden === 0 && p.password == null)).toBe(true)
  })
})
