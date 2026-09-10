/**
 * #244 — schema-matrix regression: ONLY `articles` missing + historical slug.
 *
 * Base semantics (per-read silent catches): the registry resolves the
 * historical address to the article's current one, the formal + version
 * reads succeed, and only the post_ref lookup fails silently (id → 0).
 * Result: article.live=true, slug=current, redirectSlug=current, id=0.
 *
 * This is the one field-level difference the #244 schema compatibility
 * matrix found (31/32 identical) — pinned here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapSlugAddressState, createDatabase, query } from '@/tests/lib/slug-address/helpers'
import { backfillCurrentAddresses } from '@/lib/slug-address'
import { createFormalArticle } from '@/tests/lib/publish-revision/helpers'
import { resolvePublicArticle } from '@/lib/public-read'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-244-articles-missing-'))
  cleanup.push(state)
  await bootstrapSlugAddressState(state)
}, 300_000)

afterAll(async () => {
  await import('@/tests/lib/article-commands/helpers').then((m) => m.teardownState())
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('lib/public-read — #244 articles-missing historical matrix case', { timeout: 600_000 }, () => {
  it('仅缺 articles + 历史 slug：live=true, slug=current, redirectSlug=current, id=0', async () => {
    const created = await createFormalArticle(`hist-${Date.now()}`, '历史标题', '历史正文')
    await backfillCurrentAddresses(createDatabase())
    const oldSlug = created.slug
    const newSlug = `${oldSlug}-renamed`

    // Simulate a real promoted rename: registry rotation AND formal slug.
    await query(
      `UPDATE article_slug_addresses SET kind = 'historical'
       WHERE article_id = ${created.articleId} AND kind = 'current'`,
    )
    await query(
      `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
       VALUES ('${newSlug}', ${created.articleId}, 'current', 1, 1)`,
    )
    await query(`UPDATE formal_publications SET slug = '${newSlug}' WHERE article_id = ${created.articleId}`)

    // Drop ONLY the articles table.
    await query('DROP TABLE articles')

    const resolved = await resolvePublicArticle(createDatabase(), oldSlug)
    expect(resolved.redirectSlug).toBe(newSlug)
    expect(resolved.article).toBeTruthy()
    expect(resolved.article!.live).toBe(true)
    expect(resolved.article!.slug).toBe(newSlug)
    expect(resolved.article!.id).toBe(0)
    expect(resolved.article!.title).toBe('历史标题')
  })
})
