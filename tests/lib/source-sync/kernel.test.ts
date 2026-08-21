/**
 * B6-02 — 源稿领先内容安全写入 Blogman kernel tests (issue #51).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns). Proves the ticket's acceptance surface:
 *
 *   - 单边变化:源稿领先 → 规范化标题 + Markdown 正文 + 引用媒体安全写入; 草稿
 *     写新版本, 正式文章只写唯一修订 (线上版本保持),
 *   - 任一媒体/保存失败不产生半同步:失败时版本不写、基线不推进,
 *   - 同内容媒体跨路径文章复用:内容身份去重, 不凭文件名推断, 不重复存储,
 *   - 全部成功才推进基线; 并发冲突 / 重复操作幂等回放.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create } from '@/lib/article-commands'
import { createDatabase, query, teardownState } from '@/tests/lib/article-commands/helpers'
import {
  bootstrapRevisionState,
  createFormalArticle,
} from '@/tests/lib/publish-revision/helpers'
import { SOURCE_IDENTITY_DDL_STATEMENTS, linkSourceToArticle } from '@/lib/source-identity'
import {
  MockMediaStore,
  MockSourceProvider,
  SOURCE_SYNC_DDL_STATEMENTS,
  syncSourceAhead,
  type SourceContent,
} from '@/lib/source-sync'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b602-source-sync-'))
  cleanup.push(state)
  // Boot the full stack (ledger + identity + first-publish + revision + slug-
  // address) plus B6-01 source-identity and B6-02 source-sync fact surfaces so
  // both draft and formal-article scenarios share one schema.
  await bootstrapRevisionState(state)
  // Miniflare-only accommodation: the ledger's FTS5 external-content `posts_fts`
  // trigger corrupts the DB on content containing markdown-image parens (`](`)
  // — a workerd/Miniflare bug, absent in real Cloudflare D1. FTS is a search
  // projection irrelevant to the sync, so it is dropped for the isolated tests.
  await query('DROP TRIGGER IF EXISTS posts_ai')
  await query('DROP TRIGGER IF EXISTS posts_au')
  await query('DROP TRIGGER IF EXISTS posts_ad')
  await query('DROP TABLE IF EXISTS posts_fts')
  for (const stmt of SOURCE_IDENTITY_DDL_STATEMENTS) await query(stmt)
  for (const stmt of SOURCE_SYNC_DDL_STATEMENTS) await query(stmt)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title: '原标题',
    content: '# 原标题\n\n正文。',
    html: '<h1>原标题</h1><p>正文。</p>',
    description: null,
    category: '未分类',
    tags: ['旧标签'],
    status: 'draft',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: null,
    updated_at: null,
    ...overrides,
  }
}

interface CreatedArticle {
  articleId: number
  postRef: number
  version: number
}

async function createSourceArticle(sourceUrl: string): Promise<CreatedArticle> {
  const created = await create(createDatabase(), {
    creationId: fresh('creation'),
    snapshot: snapshot(),
    source: { url: sourceUrl },
  })
  expect(created.outcome).toBe('created')
  if (created.outcome !== 'created') throw new Error('create failed')
  return { articleId: created.articleId, postRef: created.postRef, version: created.version }
}

function providerFor(content: SourceContent): MockSourceProvider {
  const provider = new MockSourceProvider(content)
  for (const m of content.media) {
    provider.setMediaBytes(m.ref, Buffer.from(`bytes-${m.ref}`, 'utf8'))
  }
  return provider
}

function baseContent(): SourceContent {
  return {
    title: '  新款手机 评测  ',
    markdown: '![主图](assets/hero.png)\n\n全新段落正文',
    media: [{ ref: 'assets/hero.png', contentType: 'image/png', filename: 'hero.png' }],
  }
}

async function versionCount(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

async function baselineCount(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_sync_baselines WHERE article_id = ${articleId}`))[0]?.n ?? 0
}


/** Latest frozen snapshot fields for an article (canonical, projection-free). */
async function canonFields(postRef: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT v.snapshot_json FROM articles a
     JOIN article_versions v ON v.article_id = a.id
      AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
     WHERE a.post_ref = ${postRef} LIMIT 1`,
  )
  const raw = rows[0]
  if (!raw) return null
  const record = JSON.parse(raw.snapshot_json as string) as {
    fields: Record<string, unknown>
    original_content: string | null
    original_html: string | null
  }
  return { ...record.fields, content: record.original_content ?? '', html: record.original_html ?? '' }
}

describe('syncSourceAhead — 草稿写新版本', () => {
  it('同步规范化标题、正文与引用媒体, 草稿写新版本, 全部成功推进基线', async () => {
    const url = 'https://src.example.test/guide/a'
    const { articleId, postRef } = await createSourceArticle(url)

    const provider = providerFor(baseContent())
    const mediaStore = new MockMediaStore()
    const result = await syncSourceAhead(createDatabase(), {
      sourceUrl: url,
      articleId,
      expectedVersion: 1,
      operationId: fresh('sync'),
      provider,
      mediaStore,
    })

    expect(result.outcome).toBe('synced')
    if (result.outcome !== 'synced') return
    expect(result.version).toBe(2)
    expect(result.revisionId).toBeNull()
    expect(result.projection.title).toBe('新款手机 评测')
    expect(result.projection.markdown).toContain('/api/images/source-media/')
    expect(result.media).toHaveLength(1)
    expect(result.media[0].reused).toBe(false)
    expect(mediaStore.objectCount).toBe(1)
    expect(await versionCount(articleId)).toBe(2)
    expect(await baselineCount(articleId)).toBe(1)

    // 正文确实写入了文章版本(不产生半同步, 全量成功)。
    const post = await canonFields(postRef)
    expect(post?.title).toBe('新款手机 评测')
    expect(String(post?.content)).toContain('![')
    expect(String(post?.content)).not.toContain('assets/hero.png')
  })

  it('同内容媒体跨路径文章复用: 不凭文件名推断、不重复存储', async () => {
    const a = await createSourceArticle('https://src.example.test/guide/b')
    const b = await createSourceArticle('https://src.example.test/other/c')

    const storeA = new MockMediaStore()
    await syncSourceAhead(createDatabase(), {
      sourceUrl: 'https://src.example.test/guide/b',
      articleId: a.articleId,
      expectedVersion: 1,
      operationId: fresh('sync'),
      provider: providerFor(baseContent()),
      mediaStore: storeA,
    })

    // Article B references the SAME bytes under a DIFFERENT path/ref.
    const contentB: SourceContent = {
      title: 'B 标题',
      markdown: '![复](assets/other-hero.png)\n\nb 正文',
      media: [{ ref: 'assets/other-hero.png', contentType: 'image/png', filename: 'hero.png' }],
    }
    const providerB = new MockSourceProvider(contentB)
    // Identical content bytes, different ref/path — reuse must NOT guess from the filename.
    providerB.setMediaBytes('assets/other-hero.png', Buffer.from('bytes-assets/hero.png'))
    const storeB = new MockMediaStore()
    const resultB = await syncSourceAhead(createDatabase(), {
      sourceUrl: 'https://src.example.test/other/c',
      articleId: b.articleId,
      expectedVersion: 1,
      operationId: fresh('sync'),
      provider: providerB,
      mediaStore: storeB,
    })
    expect(resultB.outcome).toBe('synced')
    if (resultB.outcome !== 'synced') return
    expect(resultB.media[0].reused).toBe(true)
    // 同一内容身份 → 单一 asset + 单一 R2 对象(跨路径复用, 不重复存储)。
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_assets`))[0].n).toBe(1)
    expect(storeB.objectCount).toBe(0)
    expect(resultB.media[0].r2Key).toBe(`source-media/${resultB.media[0].contentSha256}`)
  })

  it('媒体读取失败 → 不写版本、不推进基线', async () => {
    const url = 'https://src.example.test/guide/d'
    const { articleId } = await createSourceArticle(url)
    const provider = providerFor(baseContent())
    provider.failMedia('assets/hero.png')

    const result = await syncSourceAhead(createDatabase(), {
      sourceUrl: url,
      articleId,
      expectedVersion: 1,
      operationId: fresh('sync'),
      provider,
      mediaStore: new MockMediaStore(),
    })

    expect(result.outcome).toBe('media-failed')
    expect(await versionCount(articleId)).toBe(1)
    expect(await baselineCount(articleId)).toBe(0)
  })

  it('保存冲突(版本前置不符) → 不推进基线、不写版本', async () => {
    const url = 'https://src.example.test/guide/e'
    const { articleId } = await createSourceArticle(url)

    const result = await syncSourceAhead(createDatabase(), {
      sourceUrl: url,
      articleId,
      expectedVersion: 99, // stale
      operationId: fresh('sync'),
      provider: providerFor(baseContent()),
      mediaStore: new MockMediaStore(),
    })

    expect(result.outcome).toBe('save-conflict')
    if (result.outcome === 'save-conflict') expect(result.serverVersion).toBe(1)
    expect(await versionCount(articleId)).toBe(1)
    expect(await baselineCount(articleId)).toBe(0)
  })

  it('重复操作幂等回放: 同一 operation 返回原事实, 不再读源稿、不重复写版本', async () => {
    const url = 'https://src.example.test/guide/f'
    const { articleId } = await createSourceArticle(url)
    const provider = providerFor(baseContent())
    const mediaStore = new MockMediaStore()
    const operationId = fresh('sync')

    const first = await syncSourceAhead(createDatabase(), {
      sourceUrl: url, articleId, expectedVersion: 1, operationId, provider, mediaStore,
    })
    expect(first.outcome).toBe('synced')
    const second = await syncSourceAhead(createDatabase(), {
      sourceUrl: url, articleId, expectedVersion: 1, operationId, provider, mediaStore,
    })

    expect(second.outcome).toBe('replayed')
    if (second.outcome === 'replayed') {
      expect(second.baselineSha256).toBe(first.outcome === 'synced' ? first.baselineSha256 : '')
      expect(second.media).toHaveLength(first.outcome === 'synced' ? first.media.length : 0)
    }
    // 回放不重读源稿、不写新版本。
    expect(provider.totalCalls).toBe(1)
    expect(await versionCount(articleId)).toBe(2)
    expect(await baselineCount(articleId)).toBe(1)
  })
})

describe('syncSourceAhead — 正式文章只更新唯一修订', () => {
  it('线上版本保持, 变化只进修订, 全部成功推进基线', async () => {
    const url = 'https://src.example.test/formal/a'
    const { articleId, postRef } = await createFormalArticle(fresh('formal-slug'))
    await linkSourceToArticle(createDatabase(), {
      operationId: fresh('link'),
      url,
      articleId,
    })

    const result = await syncSourceAhead(createDatabase(), {
      sourceUrl: url,
      articleId,
      expectedVersion: 1,
      operationId: fresh('sync'),
      provider: providerFor(baseContent()),
      mediaStore: new MockMediaStore(),
    })

    expect(result.outcome).toBe('synced')
    if (result.outcome !== 'synced') return
    expect(result.revisionId).toBeTruthy()
    // 正式文章不写新 article_versions(线上版本保持), 只建一条 active 修订。
    expect(await versionCount(articleId)).toBe(1)
    const active = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`))[0].n
    expect(active).toBe(1)
    // 线上 posts 投影不被改写。
    const post = await canonFields(postRef)
    expect(post.title).toBe('正式文章标题')
    expect(await baselineCount(articleId)).toBe(1)
  })
})
