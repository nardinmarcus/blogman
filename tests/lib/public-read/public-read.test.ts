/**
 * L2 — canonical public read model (issue #67).
 *
 * Verifies the public reading surface now reads canonical D1 facts
 * (`formal_publications` + `article_versions` + `article_slug_addresses`)
 * for lifecycle, access-control, pinning, first-published time and
 * historical single-hop — instead of the legacy `posts` projection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapSlugAddressState, createDatabase, freshOp, query } from '@/tests/lib/slug-address/helpers'
import { backfillCurrentAddresses } from '@/lib/slug-address'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import { unpublish } from '@/lib/article-lifecycle'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import {
  countPublicArticles,
  listPublicArticles,
  resolvePublicArticle,
  searchPublicArticles,
} from '@/lib/public-read'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b67-public-read-'))
  cleanup.push(state)
  await bootstrapSlugAddressState(state)
  // The lifecycle ledger is a separate fact surface — ensure it too.
  const { ensureArticleLifecycleTables } = await import('@/lib/article-lifecycle')
  await ensureArticleLifecycleTables(createDatabase())
}, 300_000)

afterAll(async () => {
  await import('@/tests/lib/article-commands/helpers').then((m) => m.teardownState())
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function slug(): string {
  seq += 1
  return `pub-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}, s = slug()): ArticleCommandSnapshot {
  return {
    slug: s,
    title: '正式标题',
    content: '正式正文内容',
    html: '<p>正式正文内容</p>',
    description: '正式描述',
    category: '分类',
    tags: ['甲', '乙'],
    status: 'published',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: 1,
    updated_at: null,
    ...overrides,
  }
}

async function createFormal(s = slug(), overrides: Partial<ArticleCommandSnapshot> = {}): Promise<{
  articleId: number
  postRef: number
  slug: string
}> {
  const snap = snapshot(overrides, s)
  const created = await create(createDatabase(), { creationId: `formal-${s}`, snapshot: snap })
  if (created.outcome !== 'created') throw new Error(`create failed: ${JSON.stringify(created)}`)
  const articleId = created.articleId
  const hashRow = (await query<{ content_snapshot_sha256: string | null }>(
    `SELECT content_snapshot_sha256 FROM article_versions
     WHERE article_id = ${articleId} AND version = 1 ORDER BY id DESC LIMIT 1`,
  ))[0]
  const prepared = await preparePublish(createDatabase(), {
    prepareId: `prep-${s}`,
    articleId,
    confirmedVersion: 1,
    slug: s,
    title: snap.title,
    contentSha256: hashRow?.content_snapshot_sha256 ?? '',
    actor: 'b67-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${s}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b67-fixture',
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`)
  return { articleId, postRef: created.postRef, slug: s }
}

describe('lib/public-read — canonical public read model', { timeout: 600_000 }, () => {
  it('详情读取 canonical 事实：生命周期/首次发布时间/content 来自版本快照', async () => {
    const article = await createFormal()
    await backfillCurrentAddresses(createDatabase())

    const resolved = await resolvePublicArticle(createDatabase(), article.slug)
    expect(resolved.redirectSlug).toBeNull()
    expect(resolved.article).toBeTruthy()
    const a = resolved.article!
    expect(a.live).toBe(true)
    expect(a.lifecycle).toBe('published')
    expect(a.articleId).toBe(article.articleId)
    expect(a.version).toBe(1)
    expect(a.content).toContain('正式正文内容')
    expect(a.html).toContain('<p>正式正文内容</p>')
    expect(a.title).toBe('正式标题')
    expect(a.first_published_at).toBeGreaterThan(0)
    // 首次发布时间表达：正式事实时间
    const formal = (await query<{ first_published_at: number }>(
      `SELECT first_published_at FROM formal_publications WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(a.published_at).toBe(formal.first_published_at)
  })

  it('未注册地址解析为 404', async () => {
    const article = await createFormal()
    await backfillCurrentAddresses(createDatabase())

    // unknown → null (not a live single-hop target)
    expect((await resolvePublicArticle(createDatabase(), 'definitely-not-a-slug')).article).toBeNull()
    // candidate addresses are not publicly resolvable before go-live
    expect((await resolvePublicArticle(createDatabase(), article.slug + '-candidate')).article).toBeNull()
  })

  it('历史地址永久单跳：解析 old → current，redirect=老地址', async () => {
    const article = await createFormal()
    await backfillCurrentAddresses(createDatabase())
    const oldSlug = article.slug
    const newSlug = `${oldSlug}-renamed`

    // Simulate a real promoted rename: the registry rotation AND the formal
    // current slug are updated (promoteRevision does both atomically).
    await query(
      `UPDATE article_slug_addresses SET kind = 'historical' WHERE article_id = ${article.articleId} AND kind = 'current'`,
    )
    await query(
      `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
       VALUES ('${newSlug}', ${article.articleId}, 'current', 1, 1)`,
    )
    await query(
      `UPDATE formal_publications SET slug = '${newSlug}' WHERE article_id = ${article.articleId}`,
    )

    const resolved = await resolvePublicArticle(createDatabase(), oldSlug)
    expect(resolved.redirectSlug).toBe(newSlug)
    expect(resolved.article).toBeTruthy()
    expect(resolved.article!.slug).toBe(newSlug)

    // current address serves directly, no redirect
    const direct = await resolvePublicArticle(createDatabase(), newSlug)
    expect(direct.redirectSlug).toBeNull()
    expect(direct.article!.slug).toBe(newSlug)
  })

  it('公开列表读 canonical：仅线上、置顶靠前、首次时间排序', async () => {
    await createFormal(slug(), { title: '普通一', published_at: 100 })
    await createFormal(slug(), { title: '置顶文', is_pinned: 1, published_at: 90 })
    const c = await createFormal(slug(), { title: '隐藏文', is_hidden: 1 })
    await backfillCurrentAddresses(createDatabase())

    const list = await listPublicArticles(createDatabase())
    const titles = list.map((a) => a.title)
    // pinned first
    expect(titles[0]).toBe('置顶文')
    // hidden excluded by default
    expect(titles).not.toContain('隐藏文')
    expect(titles).toContain('普通一')
    expect(await countPublicArticles(createDatabase())).toBe(list.length)

    // includeHidden reveals the hidden one (still canonical, live)
    const withHidden = await listPublicArticles(createDatabase(), { includeHidden: true })
    expect(withHidden.map((a) => a.title)).toContain('隐藏文')
    void c
  })

  it('访问控制从版本快照表达：hidden 默认排除、详情可解析 live；密码为空', async () => {
    const hidden = await createFormal(slug(), { title: '隐藏文', is_hidden: 1 })
    const open = await createFormal(slug(), { title: '公开文' })
    await backfillCurrentAddresses(createDatabase())

    // default public list excludes hidden (unlisted)
    const titles = (await listPublicArticles(createDatabase())).map((a) => a.title)
    expect(titles).toContain('公开文')
    expect(titles).not.toContain('隐藏文')

    // detail still resolves it (a direct visitor with the URL), live + gated
    const resolved = await resolvePublicArticle(createDatabase(), hidden.slug)
    expect(resolved.article!.is_hidden).toBe(1)
    expect(resolved.article!.live).toBe(true)
    // canonically-published articles carry no password gate (first-publish blocks it)
    expect(resolved.article!.password).toBeNull()
    expect((await resolvePublicArticle(createDatabase(), open.slug)).article!.password).toBeNull()
  })

  it('生命周期表达：unpublish 后不再在公开列表、详情不可见', async () => {
    const article = await createFormal(slug(), { title: '下线文' })
    await backfillCurrentAddresses(createDatabase())

    const result = await unpublish(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('unpub'),
      actor: 'b67-fixture',
    })
    expect(result.outcome).toBe('applied')

    const titles = (await listPublicArticles(createDatabase())).map((a) => a.title)
    expect(titles).not.toContain('下线文')

    const resolved = await resolvePublicArticle(createDatabase(), article.slug)
    if (resolved.article) {
      expect(resolved.article.live).toBe(false)
      expect(resolved.article.lifecycle).toBe('unpublished')
    }
  })

  it('公开分类读数 canonical：仅统计线上可见文章', async () => {
    await createFormal(slug(), { title: '可见甲', category: '甲' })
    await createFormal(slug(), { title: '可见乙', category: '甲' })
    await createFormal(slug(), { title: '隐藏丙', category: '甲', is_hidden: 1 })
    await backfillCurrentAddresses(createDatabase())
    // Categories are header-registry rows; ensure the category exists.
    await query(`INSERT OR IGNORE INTO categories (name, slug) VALUES ('甲', 'jia')`)

    const { getPublicCategories } = await import('@/lib/db')
    const cats = (await getPublicCategories(createDatabase())).filter((c) => c.name === '甲')
    expect(cats.length).toBeGreaterThanOrEqual(1)
    // hidden article is NOT counted in the canonical public reader list
    expect(cats[0].post_count).toBe(2)
  })

  it('搜索投影可重建：命中后回锚 canonical 列表并按访问控制过滤', async () => {
    await createFormal(slug(), { title: '可搜索关键词', content: 'alpha beta gamma' })
    await createFormal(slug(), { title: '另一篇', content: 'unrelated content' })
    await backfillCurrentAddresses(createDatabase())

    const hits = await searchPublicArticles(createDatabase(), 'beta')
    expect(hits.length).toBe(1)
    expect(hits[0].title).toBe('可搜索关键词')
  })
})
