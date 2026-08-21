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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapSlugAddressState, createDatabase, query } from '@/tests/lib/slug-address/helpers'
import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import { resolvePublicArticle } from '@/lib/public-read'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import { searchPosts } from '@/lib/db'
import { getRelatedPosts, searchPostsWithStrategy } from '@/lib/related-content'

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
  })
  if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${s}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'l2s-fixture',
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