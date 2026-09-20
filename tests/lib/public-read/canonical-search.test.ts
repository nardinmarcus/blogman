/**
 * L2 — canonical public search + related-content (issue #19 follow-up).
 *
 * Guards that the public search (`lib/repositories/search.ts` via
 * `searchPosts`) and the related-articles path (`lib/related-content.ts`)
 * read the CANONICAL facts — `formal_publications` lifecycle +
 * `article_versions` frozen snapshot access-control — instead of the legacy
 * `posts` projection. Works when a real DB has posts data: results match the
 * old public semantics (published, non-deleted, non-hidden, non-passworded).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapSlugAddressState, createDatabase, query } from '@/tests/lib/slug-address/helpers'
import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'
import { create, setHidden, setPassword, setCategory, setPinned, softDelete, restore } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import { resolvePublicArticle, listPublicArticles, countPublicArticles, searchPublicArticles } from '@/lib/public-read'
import { unpublish } from '@/lib/article-lifecycle'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import { searchPosts, getPublicCategories, createCategory } from '@/lib/db'
import { getRelatedPosts, searchPostsWithStrategy, syncPostToRelatedIndex } from '@/lib/related-content'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-l2-search-canon-'))
  cleanup.push(state)
  await bootstrapSlugAddressState(state)
  const { ensureArticleLifecycleTables } = await import('@/lib/article-lifecycle')
  await ensureArticleLifecycleTables(createDatabase())
}, 300_000)

afterAll(async () => {
  await import('@/tests/lib/article-commands/helpers').then((m) => m.teardownState())
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function uniqueSlug(): string {
  seq += 1
  return `l2s-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}, s = uniqueSlug()): ArticleCommandSnapshot {
  return {
    slug: s,
    title: '正式标题',
    content: '正式正文内容',
    html: '<p>正式正文内容</p>',
    description: '正式描述',
    category: 'AI',
    tags: ['甲'],
    status: 'published',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: Date.now(),
    updated_at: null,
    ...overrides,
  }
}

async function createFormal(s = uniqueSlug(), overrides: Partial<ArticleCommandSnapshot> = {}): Promise<{
  articleId: number
  postRef: number
  slug: string
}> {
  const snap = snapshot(overrides, s)
  if (snap.category) await createCategory(createDatabase(), snap.category, `${s}-category`)
  const created = await create(createDatabase(), { creationId: `l2s-${s}`, snapshot: snap })
  if (created.outcome !== 'created') throw new Error(`create failed: ${JSON.stringify(created)}`)
  const articleId = created.articleId
  const hashRow = (await query<{ content_snapshot_sha256: string | null }>(
    `SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ${articleId} ORDER BY id DESC LIMIT 1`,
  ))[0]
  const prepared = await preparePublish(createDatabase(), {
    prepareId: `prep-${s}`,
    articleId,
    confirmedVersion: 1,
    slug: s,
    title: snap.title,
    contentSha256: hashRow?.content_snapshot_sha256 ?? '',
    actor: 'l2s-fixture',
    now: snap.published_at ?? Date.now(),
  })
  if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${s}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'l2s-fixture',
    now: snap.published_at ?? Date.now(),
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`)
  return { articleId: created.articleId, postRef: created.postRef, slug: s }
}

async function resolveAsPost(db: Database, slug: string): Promise<PostWithTags> {
  const resolved = await resolvePublicArticle(db, slug)
  if (!resolved.article || !resolved.article.live) throw new Error(`not live: ${slug}`)
  return resolved.article as unknown as PostWithTags
}

describe('L2 search + related-content — canonical facts', { timeout: 600_000 }, () => {
  it('searchPosts reads canonical facts and filters access-control from the snapshot', async () => {
    const open = await createFormal(uniqueSlug(), { title: '可检索词A', content: 'alpha beta gamma', published_at: 200 })
    const hidden = await createFormal(uniqueSlug(), { title: '隐藏文', content: 'alpha hiddenmarker', is_hidden: 1 })
    // password is blocked at formal publish, so inject it into the frozen snapshot
    const pw = await createFormal(uniqueSlug(), { title: '密码文', content: 'alpha passlocked' })
    // un-publish one via the lifecycle fact
    const off = await createFormal(uniqueSlug(), { title: '下线文', content: 'alpha unpublished' })

    await query(`UPDATE article_versions SET snapshot_json = json_set(snapshot_json, '$.fields.password', 'secret') WHERE article_id = ${pw.articleId}`)
    await query(`UPDATE formal_publications SET lifecycle = 'unpublished' WHERE article_id = ${off.articleId}`)

    // snapshot_json changed → content_snapshot_sha256 staleness doesn't matter for search
    const hits = await searchPosts(createDatabase(), 'alpha', 20)
    const titles = hits.map((p) => p.title)

    // only the openly published article matches canonical access-control
    expect(titles).toContain('可检索词A')
    expect(titles).not.toContain('隐藏文')
    expect(titles).not.toContain('密码文')
    expect(titles).not.toContain('下线文')
    for (const hit of hits) {
      expect(hit.status).toBe('published')
      expect(hit.is_hidden).toBe(0)
      expect(hit.password).toBeNull()
    }
    void open
    void hidden
  })

  it('searchPostsWithStrategy FTS sources from the same canonical surface', async () => {
    await createFormal(uniqueSlug(), { title: '向量靶文', content: 'gamma delta epsilon' })

    const result = await searchPostsWithStrategy(createDatabase(), undefined, 'gamma', { limit: 10 })
    // no VECTOR_INDEX binding in tests → vectorise disabled, falls to FTS
    expect(result.strategy).toBe('fts')
    expect(result.source).toBe('fts')
    expect(result.results.map((p) => p.title)).toContain('向量靶文')
  })

  it('getRelatedPosts returns same-category candidates read canonically', async () => {
    const current = await createFormal(uniqueSlug(), { title: '当前文章', category: 'AI', tags: ['甲'], published_at: 100 })
    await createFormal(uniqueSlug(), { title: '相关文章', category: 'AI', tags: ['甲'], published_at: 90 })
    await createFormal(uniqueSlug(), { title: '无关文章', category: 'OTHER', tags: [], published_at: 80 })

    const db = createDatabase()
    const post = await resolveAsPost(db, current.slug)
    const related = await getRelatedPosts(db, undefined, post, 3)

    const titles = related.results.map((p) => p.title)
    expect(titles).toContain('相关文章')
    expect(titles).not.toContain('当前文章')
    // the verbose fields used for scoring come from the canonical snapshot
    expect(titles.length).toBeGreaterThan(0)
  })
})

describe('Article-Level Commands across public readers', { timeout: 600_000 }, () => {
  it('hide immediately removes an article from discovery while preserving direct access', async () => {
    const target = await createFormal(uniqueSlug(), { title: 'commandmarker', category: 'command-category' })
    const db = createDatabase()
    expect(await setHidden(db, { articleId: target.articleId, expectedVersion: 1, operationId: `hide-${target.slug}`, is_hidden: 1 })).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject({ live: true, is_hidden: 1 })
    expect(await listPublicArticles(db, { category: 'command-category' })).toEqual([])
    expect(await countPublicArticles(db, { category: 'command-category' })).toBe(0)
    expect(await searchPosts(db, 'commandmarker')).toEqual([])
    expect((await getPublicCategories(db)).map((c) => c.name)).not.toContain('command-category')
    const vector = { describe: async () => ({ dimensions: 8 }), query: async () => ({ matches: [{ metadata: { slug: target.slug } }] }) }
    const result = await searchPostsWithStrategy(db, { ENABLE_VECTOR_SEARCH: 'true', VECTOR_INDEX: vector as unknown as VectorizeIndex }, 'commandmarker')
    expect(result.results).toEqual([])
  })
})


describe('formal content and latest management', { timeout: 600_000 }, () => {
  it('materializes deliberately divergent snapshots without trusting a snapshot address', async () => {
    const target = await createFormal(uniqueSlug(), { title: 'formalmarker', description: 'formal description', tags: ['formal tag'], cover_image: '/formal.jpg', category: 'formal category', published_at: 500 })
    const db = createDatabase()
    await setHidden(db, { articleId: target.articleId, expectedVersion: 1, operationId: `diverge-${target.slug}`, is_hidden: 1 })
    // Deliberate corrupt/divergent fixture, NOT an ordinary save: saves use separate revisions.
    await db.prepare(`UPDATE article_versions SET snapshot_json = json_set(snapshot_json,
      '$.fields.title', 'unpromoted title', '$.fields.description', 'unpromoted description',
      '$.fields.tags', json('["unpromoted tag"]'), '$.fields.cover_image', '/unpromoted.jpg',
      '$.fields.slug', 'snapshot-address', '$.fields.category', 'latest category',
      '$.fields.is_hidden', 0, '$.fields.is_pinned', 1, '$.fields.updated_at', 12345,
      '$.original_content', 'unpromoted body', '$.original_html', '<p>unpromoted</p>')
      WHERE article_id = ? AND version = 2`).bind(target.articleId).run()
    const expected = { slug: target.slug, title: 'formalmarker', description: 'formal description',
      content: '正式正文内容', html: '<p>正式正文内容</p>', tags: ['formal tag'], cover_image: '/formal.jpg',
      category: 'latest category', is_hidden: 0, is_pinned: 1, updated_at: 12345 }
    // BASE admin output deliberately differs from the public content policy.
    // Exercise every individual flag as well as the admin page's all-true call.
    const adminFlags: Array<[boolean, boolean, boolean, boolean]> = [
      [true, false, false, false], [false, true, false, false],
      [false, false, true, false], [false, false, false, true],
      [true, true, true, true],
    ]
    for (const flags of adminFlags) {
      expect((await searchPosts(db, 'formalmarker', 20, ...flags))[0]).toEqual({
        id: target.postRef, slug: 'snapshot-address', title: 'unpromoted title',
        content: '正式正文内容', html: '<p>正式正文内容</p>',
        description: 'unpromoted description', category: 'latest category',
        tags: ['unpromoted tag'], cover_image: '/unpromoted.jpg',
        status: 'published', password: null, is_hidden: 0, is_pinned: 1,
        deleted_at: null, published_at: 500, updated_at: 12345, view_count: 0,
      })
    }
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject(expected)
    expect((await listPublicArticles(db, { category: 'latest category' }))[0]).toMatchObject(expected)
    expect((await searchPosts(db, 'formalmarker'))[0]).toMatchObject(expected)
    expect((await searchPublicArticles(db, 'formalmarker'))[0]).toMatchObject(expected)
    const source = await createFormal(uniqueSlug(), { title: 'formal related source', tags: ['formal tag'] })
    expect((await getRelatedPosts(db, undefined, await resolveAsPost(db, source.slug), 50)).results.find((p) => p.id === target.postRef)).toMatchObject(expected)
    const vector = { describe: async () => ({ dimensions: 8 }), query: async () => ({ matches: [{ metadata: { slug: target.slug } }] }) }
    expect((await searchPostsWithStrategy(db, { ENABLE_VECTOR_SEARCH: 'true', VECTOR_INDEX: vector as unknown as VectorizeIndex }, 'formalmarker')).results[0]).toMatchObject(expected)
  })
})


function vectorEnv(slugs: string[]): Partial<CloudflareEnv> {
  return {
    ENABLE_VECTOR_SEARCH: 'true',
    VECTOR_INDEX: {
      describe: async () => ({ dimensions: 8 }),
      query: async () => ({ matches: slugs.map((slug) => ({ metadata: { slug } })) }),
    } as unknown as VectorizeIndex,
  }
}

describe('public discovery command round trips', { timeout: 600_000 }, () => {
  it('agrees across list, count, both searches, related and categories after every command', async () => {
    const db = createDatabase()
    const target = await createFormal(uniqueSlug(), { title: 'roundtripmarker', category: 'roundtrip-before', tags: ['roundtrip-shared'] })
    const source = await createFormal(uniqueSlug(), { title: 'recommendation source', category: 'source-category', tags: ['roundtrip-shared'] })
    const sourcePost = await resolveAsPost(db, source.slug)
    const checkDiscovery = async (visible: boolean, category: string) => {
      const expectedIds = visible ? [target.postRef] : []
      expect((await listPublicArticles(db, { category })).map((p) => p.id)).toEqual(expectedIds)
      expect(await countPublicArticles(db, { category })).toBe(visible ? 1 : 0)
      expect((await searchPosts(db, 'roundtripmarker')).map((p) => p.id)).toEqual(expectedIds)
      expect((await searchPublicArticles(db, 'roundtripmarker')).map((p) => p.id)).toEqual(expectedIds)
      expect((await searchPostsWithStrategy(db, vectorEnv([target.slug]), 'roundtripmarker')).results.map((p) => p.id)).toEqual(expectedIds)
      expect((await getRelatedPosts(db, undefined, sourcePost, 50)).results.some((p) => p.id === target.postRef)).toBe(visible)
      expect((await getPublicCategories(db)).find((c) => c.name === category)?.post_count ?? 0).toBe(visible ? 1 : 0)
    }
    const input = (expectedVersion: number) => ({ articleId: target.articleId, expectedVersion, operationId: `roundtrip-${target.slug}-${expectedVersion}` })
    await checkDiscovery(true, 'roundtrip-before')
    expect(await setHidden(db, { ...input(1), is_hidden: 1 })).toMatchObject({ outcome: 'applied', version: 2 })
    await checkDiscovery(false, 'roundtrip-before')
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject({ live: true, is_hidden: 1 })
    expect(await setHidden(db, { ...input(2), is_hidden: 0 })).toMatchObject({ outcome: 'applied', version: 3 })
    await checkDiscovery(true, 'roundtrip-before')
    expect(await setPassword(db, { ...input(3), password: 'secret' })).toMatchObject({ outcome: 'applied', version: 4 })
    await checkDiscovery(false, 'roundtrip-before')
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject({ live: true, password: 'secret' })
    expect(await setPassword(db, { ...input(4), password: '' })).toMatchObject({ outcome: 'applied', version: 5 })
    await checkDiscovery(true, 'roundtrip-before')
    await createCategory(db, 'roundtrip-after', 'roundtrip-after')
    expect(await setCategory(db, { ...input(5), category: 'roundtrip-after' })).toMatchObject({ outcome: 'applied', version: 6 })
    await checkDiscovery(true, 'roundtrip-after')
    expect(await listPublicArticles(db, { category: 'roundtrip-before' })).toEqual([])
    expect(await countPublicArticles(db, { category: 'roundtrip-before' })).toBe(0)
    expect((await getPublicCategories(db)).map((c) => c.name)).not.toContain('roundtrip-before')
    expect(await setPinned(db, { ...input(6), is_pinned: 1 })).toMatchObject({ outcome: 'applied', version: 7 })
    await checkDiscovery(true, 'roundtrip-after')
    expect((await listPublicArticles(db, { category: 'roundtrip-after' }))[0]).toMatchObject({ is_pinned: 1 })
    expect((await searchPosts(db, 'roundtripmarker'))[0]).toMatchObject({ is_pinned: 1 })
    expect(await softDelete(db, input(7))).toMatchObject({ outcome: 'applied', version: 8 })
    await checkDiscovery(false, 'roundtrip-after')
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject({ live: false, status: 'deleted' })
    expect(await restore(db, input(8))).toMatchObject({ outcome: 'applied', version: 9 })
    // Restore clears deletion but does not change the formal lifecycle.
    await checkDiscovery(true, 'roundtrip-after')
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject({ live: true, lifecycle: 'published' })

  })

  it('restore never brings an unpublished formal lifecycle back online', async () => {
    const db = createDatabase()
    const target = await createFormal(uniqueSlug(), { title: 'offrestoremarker', category: 'offrestore-category' })
    expect(await unpublish(db, { articleId: target.articleId, expectedVersion: 1, operationId: `unpublish-${target.slug}` })).toMatchObject({ outcome: 'applied' })
    expect(await softDelete(db, { articleId: target.articleId, expectedVersion: 1, operationId: `delete-${target.slug}` })).toMatchObject({ outcome: 'applied', version: 2 })
    expect(await restore(db, { articleId: target.articleId, expectedVersion: 2, operationId: `restore-${target.slug}` })).toMatchObject({ outcome: 'applied', version: 3 })
    expect((await resolvePublicArticle(db, target.slug)).article).toMatchObject({ live: false, lifecycle: 'unpublished', deleted_at: null })
    expect(await listPublicArticles(db, { category: 'offrestore-category' })).toEqual([])
    expect(await countPublicArticles(db, { category: 'offrestore-category' })).toBe(0)
    expect(await searchPosts(db, 'offrestoremarker')).toEqual([])
    expect(await searchPublicArticles(db, 'offrestoremarker')).toEqual([])
    expect((await searchPostsWithStrategy(db, vectorEnv([target.slug]), 'offrestoremarker')).results).toEqual([])
    expect((await getPublicCategories(db)).map((c) => c.name)).not.toContain('offrestore-category')
  })

  it('pinning preserves list pagination and never changes FTS rank ordering', async () => {
    const db = createDatabase()
    const older = await createFormal(uniqueSlug(), { title: 'pinrankmarker', category: 'pinrank-category', published_at: 100 })
    const newer = await createFormal(uniqueSlug(), { title: 'pinrankmarker', category: 'pinrank-category', published_at: 200 })
    const before = (await searchPosts(db, 'pinrankmarker')).map((p) => p.id)
    expect((await listPublicArticles(db, { category: 'pinrank-category', limit: 1 }))[0]?.id).toBe(newer.postRef)
    await setPinned(db, { articleId: older.articleId, expectedVersion: 1, operationId: `pin-${older.slug}`, is_pinned: 1 })
    expect((await listPublicArticles(db, { category: 'pinrank-category', limit: 1 }))[0]?.id).toBe(older.postRef)
    expect((await listPublicArticles(db, { category: 'pinrank-category', limit: 1, offset: 1 }))[0]?.id).toBe(newer.postRef)
    expect((await searchPosts(db, 'pinrankmarker')).map((p) => p.id)).toEqual(before)
    expect((await searchPosts(db, 'pinrankmarker', 1)).map((p) => p.id)).toEqual(before.slice(0, 1))
  })

  it('treats vector metadata as untrusted recall, filtering before limit without re-ranking', async () => {
    const db = createDatabase()
    const hidden = await createFormal(uniqueSlug(), { title: 'vector order hidden' })
    const first = await createFormal(uniqueSlug(), { title: 'vector first' })
    const second = await createFormal(uniqueSlug(), { title: 'vector second' })
    await setHidden(db, { articleId: hidden.articleId, expectedVersion: 1, operationId: `vector-hide-${hidden.slug}`, is_hidden: 1 })
    const env = vectorEnv([hidden.slug, 'unknown-address', second.slug, second.slug, first.slug])
    const result = await searchPostsWithStrategy(db, env, 'irrelevant retrieval text', { limit: 2 })
    expect(result.source).toBe('vectorize')
    expect(result.results.map((p) => p.id)).toEqual([second.postRef, first.postRef])
    const related = await getRelatedPosts(db, env, await resolveAsPost(db, first.slug), 1)
    expect(related.results.map((p) => p.id)).toEqual([second.postRef])
  })

  it('preserves empty/error vector fallback and canonical indexing eligibility', async () => {
    const db = createDatabase()
    const target = await createFormal(uniqueSlug(), { title: 'fallbackmarker' })
    expect((await searchPostsWithStrategy(db, vectorEnv([]), 'fallbackmarker')).source).toBe('fts')
    const broken = vectorEnv([])
    broken.VECTOR_INDEX!.query = async () => { throw new Error('vector unavailable') }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await searchPostsWithStrategy(db, broken, 'fallbackmarker')).results.map((p) => p.id)).toEqual([target.postRef])
    } finally {
      warning.mockRestore()
    }
    const upsert = vi.fn(async () => ({}))
    const deleteByIds = vi.fn(async () => ({}))
    const env = { ...vectorEnv([]), DB: db, VECTOR_INDEX: { describe: async () => ({ dimensions: 8 }), upsert, deleteByIds } as unknown as VectorizeIndex }
    expect(await syncPostToRelatedIndex(env, target.postRef)).toBe('synced')
    expect(upsert.mock.calls[0]).toBeDefined()
    await setPassword(db, { articleId: target.articleId, expectedVersion: 1, operationId: `index-password-${target.slug}`, password: 'secret' })
    expect(await syncPostToRelatedIndex(env, target.postRef)).toBe('deleted')
    expect(deleteByIds).toHaveBeenCalledWith([`post:${target.postRef}`])
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})


describe('admin search compatibility', { timeout: 600_000 }, () => {
  it('widens each visibility flag independently and still excludes never-formally-published drafts', async () => {
    const db = createDatabase()
    const open = await createFormal(uniqueSlug(), { title: 'adminflagmarker open' })
    const hidden = await createFormal(uniqueSlug(), { title: 'adminflagmarker hidden', is_hidden: 1 })
    const password = await createFormal(uniqueSlug(), { title: 'adminflagmarker password' })
    const deleted = await createFormal(uniqueSlug(), { title: 'adminflagmarker deleted' })
    const unpublished = await createFormal(uniqueSlug(), { title: 'adminflagmarker unpublished' })
    // Publication preconditions prohibit these states; seed historical formal
    // snapshots to exercise the existing admin adapter's individual flags.
    await db.prepare("UPDATE article_versions SET snapshot_json = json_set(snapshot_json, '$.fields.password', 'secret') WHERE article_id = ?").bind(password.articleId).run()
    await db.prepare("UPDATE article_versions SET snapshot_json = json_set(snapshot_json, '$.fields.deleted_at', 99) WHERE article_id = ?").bind(deleted.articleId).run()
    expect(await unpublish(db, { articleId: unpublished.articleId, expectedVersion: 1, operationId: `admin-off-${unpublished.slug}` })).toMatchObject({ outcome: 'applied' })
    const draft = await create(db, { creationId: `admin-never-${uniqueSlug()}`, snapshot: snapshot({ title: 'adminflagmarker never', status: 'draft' }) })
    expect(draft.outcome).toBe('created')
    const cases: Array<{ flags: [boolean, boolean, boolean, boolean]; ids: number[] }> = [
      { flags: [false, false, false, false], ids: [open.postRef] },
      { flags: [true, false, false, false], ids: [open.postRef, unpublished.postRef] },
      { flags: [false, true, false, false], ids: [open.postRef, password.postRef] },
      { flags: [false, false, true, false], ids: [open.postRef, hidden.postRef] },
      { flags: [false, false, false, true], ids: [open.postRef, deleted.postRef] },
      { flags: [true, true, true, true], ids: [open.postRef, unpublished.postRef, password.postRef, hidden.postRef, deleted.postRef] },
    ]
    for (const { flags, ids } of cases) {
      const hits = await searchPosts(db, 'adminflagmarker', 20, ...flags)
      expect(hits.map((p) => p.id).sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b))
    }
    const all = await searchPosts(db, 'adminflagmarker', 20, true, true, true, true)
    expect(all.find((p) => p.id === deleted.postRef)).toMatchObject({ status: 'deleted', deleted_at: 99 })
    expect(all.find((p) => p.id === unpublished.postRef)).toMatchObject({ status: 'draft' })
    expect(all.find((p) => p.id === password.postRef)).toMatchObject({ password: 'secret', tags: ['甲'], view_count: 0 })
    expect((await searchPosts(db, 'adminflagmarker', 1, true, true, true, true)).map((p) => p.id)).toEqual(all.slice(0, 1).map((p) => p.id))
  })

  it('retains the admin formal-slug fallback when latest snapshot metadata is absent', async () => {
    const db = createDatabase()
    const target = await createFormal(uniqueSlug(), { title: 'adminfallbackmarker' })
    expect(await setPinned(db, { articleId: target.articleId, expectedVersion: 1, operationId: `admin-pin-${target.slug}`, is_pinned: 1 })).toMatchObject({ outcome: 'applied', version: 2 })
    // Deliberate divergence distinguishes BASE admin fallback from public address policy.
    await db.prepare("UPDATE article_versions SET snapshot_json = json_remove(snapshot_json, '$.fields.slug', '$.fields.title') WHERE article_id = ? AND version = 2").bind(target.articleId).run()
    const current = `${target.slug}-current`
    await db.prepare("UPDATE article_slug_addresses SET slug = ? WHERE article_id = ? AND kind = 'current'").bind(current, target.articleId).run()
    expect((await searchPosts(db, 'adminfallbackmarker', 20, true, true, true, true))[0]).toMatchObject({
      slug: target.slug, title: target.slug, is_pinned: 1,
    })
    expect((await searchPosts(db, 'adminfallbackmarker'))[0]).toMatchObject({
      slug: current, title: 'adminfallbackmarker', is_pinned: 1,
    })
  })

  it('escapes colon and quote searches while standalone public search keeps its parse-error fallback', async () => {
    const db = createDatabase()
    const target = await createFormal(uniqueSlug(), { title: 'escapequery 2026: "twelve steps"' })
    expect((await searchPosts(db, 'escapequery 2026: "twelve steps"')).map((p) => p.id)).toEqual([target.postRef])
    expect(await searchPublicArticles(db, 'unknown_column:broken')).toEqual([])
  })
})


describe('canonical address and error contracts', { timeout: 600_000 }, () => {
  it('uses the registry live address even when the formal slug mirror lags', async () => {
    const db = createDatabase()
    const target = await createFormal(uniqueSlug(), { title: 'registrymarker' })
    const current = `${target.slug}-current`
    // Deliberate address-fact divergence: the registry remains authoritative.
    await db.prepare("UPDATE article_slug_addresses SET slug = ? WHERE article_id = ? AND kind = 'current'").bind(current, target.articleId).run()
    expect((await resolvePublicArticle(db, current)).article).toMatchObject({ slug: current, title: 'registrymarker' })
    expect((await listPublicArticles(db)).find((p) => p.id === target.postRef)?.slug).toBe(current)
    expect((await searchPosts(db, 'registrymarker'))[0]?.slug).toBe(current)
    expect((await searchPublicArticles(db, 'registrymarker'))[0]?.slug).toBe(current)
    expect((await searchPostsWithStrategy(db, vectorEnv([current]), 'noftsmarker')).results[0]?.slug).toBe(current)
    expect((await searchPostsWithStrategy(db, vectorEnv([target.slug]), 'noftsmarker')).results).toEqual([])
  })

  it('keeps repository search schema errors strict and standalone FTS errors lenient', async () => {
    const db = createDatabase()
    // Last case in this isolated database: real missing FTS table, no SQL mock.
    await db.prepare('DROP TABLE article_fts').run()
    await expect(searchPosts(db, 'missingftsmarker')).rejects.toMatchObject({ code: 'DATABASE_MIGRATION_REQUIRED' })
    await expect(searchPosts(db, 'missingftsmarker', 20, true, true, true, true)).rejects.toMatchObject({ code: 'DATABASE_MIGRATION_REQUIRED' })
    expect(await searchPublicArticles(db, 'missingftsmarker')).toEqual([])
  })
})
