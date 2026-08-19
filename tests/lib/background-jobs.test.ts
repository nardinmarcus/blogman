/**
 * B2-07 — background AI result staleness guard (issue #30).
 *
 * The `process-post-ai` background job must commit its AI metadata through the
 * versioned write kernel with the article identity + expected version + a
 * stable operation id recorded on the job. Two properties are proven here:
 *
 *   - a LATE result (the author advanced the version while AI was running) is a
 *     kernel conflict and is discarded — the author's newest version is never
 *     overwritten and no extra version fact appears,
 *   - replaying the SAME operation id (queue retry / duplicate dispatch)
 *     replays the original version instead of writing a new one.
 *
 * Runs against the same shared in-process Miniflare D1 as the kernel suite —
 * zero wrangler CLI spawns during execution.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, save } from '@/lib/article-commands'
import { aiProcessPostOperationId, runBackgroundJob } from '@/lib/background-jobs'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'

const mocks = vi.hoisted(() => ({
  processPost: vi.fn(),
  getAiRuntimeEnv: vi.fn(() => ({})),
  invalidatePublicContentCache: vi.fn(async () => false),
  syncPostToRelatedIndex: vi.fn(async () => 'skipped' as const),
  deletePostFromRelatedIndex: vi.fn(async () => undefined),
  isAutoDescription: vi.fn(() => false),
}))

vi.mock('@/lib/ai', () => ({
  processPost: mocks.processPost,
  getAiRuntimeEnv: mocks.getAiRuntimeEnv,
}))

vi.mock('@/lib/cache', () => ({
  invalidatePublicContentCache: mocks.invalidatePublicContentCache,
}))

vi.mock('@/lib/related-content', () => ({
  syncPostToRelatedIndex: mocks.syncPostToRelatedIndex,
  deletePostFromRelatedIndex: mocks.deletePostFromRelatedIndex,
}))

vi.mock('@/lib/post-utils', () => ({
  isAutoDescription: mocks.isAutoDescription,
}))

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b207-bg-'))
  cleanup.push(state)
  await bootstrapState(state)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isAutoDescription.mockReturnValue(false)
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title: 'AI 基稿',
    content: '# 标题\n\nAI 正文段落。',
    html: '<h1>标题</h1><p>AI 正文段落。</p>',
    description: null,
    category: '未分类',
    tags: [],
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

async function postRow(postRef: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT slug, title, content, html, description, category, tags, status,
            password, is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
     FROM posts WHERE id = ${postRef}`,
  )
  return rows[0] ?? null
}

async function versionRows(articleId: number): Promise<Array<{ version: number; operation_id: string }>> {
  return query<{ version: number; operation_id: string }>(
    `SELECT version, operation_id FROM article_versions
     WHERE article_id = ${articleId} ORDER BY version`,
  )
}

describe('lib/background-jobs — process-post-ai staleness guard', { timeout: 600_000 }, () => {
  async function createdArticle(overrides: Partial<ArticleCommandSnapshot> = {}): Promise<{
    articleId: number
    postRef: number
    slug: string
  }> {
    const creationId = fresh('bg-base')
    const snap = snapshot(overrides)
    const result = await create(createDatabase(), { creationId, snapshot: snap })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('create failed')
    return { articleId: result.articleId, postRef: result.postRef, slug: snap.slug }
  }

  it('discards a late AI result when the author advanced the version (no overwrite, no extra version)', async () => {
    const { articleId, postRef } = await createdArticle()
    const db = createDatabase()

    // Author keeps writing: v2 lands before the AI run finishes.
    const authorSave = await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('author-op'),
      snapshot: snapshot({
        slug: (await postRow(postRef))!.slug as string,
        title: '作者第二版',
        content: '# 作者改写\n\n正文被作者大幅修改。',
        html: '<h1>作者改写</h1><p>正文被作者大幅修改。</p>',
        status: 'published',
        category: '阅读', // author set their own category
        tags: ['作者标签'],
        description: '作者手写描述',
      }),
    })
    expect(authorSave.outcome).toBe('applied')

    // The late AI result is anchored to v1 and tries to fill 未分类/空 tags/空描述.
    mocks.processPost.mockResolvedValue({
      category: '技术',
      description: 'AI 生成的迟到描述',
      tags: ['AI标签', '迟到'],
    })
    mocks.isAutoDescription.mockReturnValue(true)

    await runBackgroundJob({ DB: db }, {
      type: 'process-post-ai',
      postId: postRef,
      articleId,
      expectedVersion: 1,
      operationId: aiProcessPostOperationId(postRef, 1),
    })

    // No version was written on top of the author's v2.
    const versions = await versionRows(articleId)
    expect(versions).toHaveLength(2)
    expect(versions[1].version).toBe(2)
    expect(versions[1].operation_id).toBe((authorSave as { operationId: string }).operationId)

    // The author's newest version is untouched — the stale AI metadata is gone.
    const post = await postRow(postRef)
    expect(post!.title).toBe('作者第二版')
    expect(post!.content).toContain('作者改写')
    expect(post!.category).toBe('阅读')
    expect(post!.description).toBe('作者手写描述')
    expect(post!.tags).toBe(JSON.stringify(['作者标签']))
    expect(post!.published_at).not.toBeNull()

    // Projections only run on an applied version — nothing ran for the conflict.
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
    expect(mocks.invalidatePublicContentCache).not.toHaveBeenCalled()
  })

  it('replays the same operation id without writing a new version (idempotent retry)', async () => {
    const { articleId, postRef } = await createdArticle({ category: '技术', tags: ['已有标签'] })
    const db = createDatabase()

    mocks.processPost.mockResolvedValue({
      category: '技术', // would be a no-op anyway (author-owned)
      description: 'AI 补齐的描述',
      tags: ['AI标签'],
    })
    mocks.isAutoDescription.mockReturnValue(true)

    const job = {
      type: 'process-post-ai' as const,
      postId: postRef,
      articleId,
      expectedVersion: 1,
      operationId: aiProcessPostOperationId(postRef, 1),
    }

    // First run applies: only the description was a gap (category/tags are the
    // author's and must not be overwritten).
    await runBackgroundJob({ DB: db }, job)
    let versions = await versionRows(articleId)
    expect(versions).toHaveLength(2)
    expect(versions[1].operation_id).toBe(job.operationId)

    const afterFirst = await postRow(postRef)
    expect(afterFirst!.category).toBe('技术')
    expect(afterFirst!.tags).toBe(JSON.stringify(['已有标签']))
    expect(afterFirst!.description).toBe('AI 补齐的描述')
    expect(mocks.syncPostToRelatedIndex).toHaveBeenCalledTimes(1)

    // Same job re-dispatched (queue retry): the kernel replays the original
    // version — no new version, posts untouched.
    await runBackgroundJob({ DB: db }, job)
    versions = await versionRows(articleId)
    expect(versions).toHaveLength(2)
    expect(versions.map((v) => v.version)).toEqual([1, 2])

    const afterReplay = await postRow(postRef)
    expect(afterReplay!.description).toBe('AI 补齐的描述')
    // Still only one projection round — nothing new was committed.
    expect(mocks.syncPostToRelatedIndex).toHaveBeenCalledTimes(1)
  })

  it('skips entirely when AI returns no result (zero writes, zero projections)', async () => {
    const { articleId, postRef } = await createdArticle()
    mocks.processPost.mockResolvedValue(null)

    await runBackgroundJob({ DB: createDatabase() }, {
      type: 'process-post-ai',
      postId: postRef,
      articleId,
      expectedVersion: 1,
      operationId: aiProcessPostOperationId(postRef, 1),
    })

    expect(await versionRows(articleId)).toHaveLength(1)
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
    expect(mocks.invalidatePublicContentCache).not.toHaveBeenCalled()
  })

  it('skips a legacy post with no article identity (never migrates queue objects into facts)', async () => {
    // A bare legacy posts row — no articles / article_versions identity.
    const slug = fresh('legacy-no-id')
    await query(
      `INSERT INTO posts (slug, title, content, html, description, category, tags, status)
       VALUES ('${slug}', '旧稿', '旧正文', '<p>旧正文</p>', NULL, '未分类', NULL, 'draft')`,
    )
    const postId = (await query<{ id: number }>(`SELECT id FROM posts WHERE slug = '${slug}'`))[0].id

    await runBackgroundJob({ DB: createDatabase() }, {
      type: 'process-post-ai',
      postId,
    })

    // No version facts were fabricated, no AI ran, nothing was written.
    expect(mocks.processPost).not.toHaveBeenCalled()
    expect(await query(`SELECT id FROM articles WHERE post_ref = ${postId}`)).toEqual([])
    expect(await query(`SELECT id FROM article_versions WHERE article_id = 0`)).toEqual([])
    expect((await postRow(postId))!.category).toBe('未分类')
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
  })

  it('resolves identity + version at job start for legacy-shaped messages', async () => {
    const { articleId, postRef } = await createdArticle({ title: '旧型消息' })
    mocks.processPost.mockResolvedValue({
      category: '技术',
      description: '旧型消息补齐描述',
      tags: ['补标签'],
    })
    mocks.isAutoDescription.mockReturnValue(true)

    // Legacy-shaped message: postId only — the handler must resolve the
    // identity + latest version and anchor the AI run to it.
    await runBackgroundJob({ DB: createDatabase() }, {
      type: 'process-post-ai',
      postId: postRef,
    })

    const versions = await versionRows(articleId)
    expect(versions).toHaveLength(2)
    expect(versions[1].operation_id).toBe(aiProcessPostOperationId(postRef, 1))
    const post = await postRow(postRef)
    expect(post!.category).toBe('技术')
    expect(post!.description).toBe('旧型消息补齐描述')
    expect(mocks.syncPostToRelatedIndex).toHaveBeenCalledTimes(1)
  })

  it('skips a malformed message whose identity and post ref disagree (never writes for an unvouched pairing)', async () => {
    // Two distinct articles; the message pairs article A's identity with
    // post B's post ref — the handler must refuse to write.
    const a = await createdArticle({ title: '甲稿' })
    const b = await createdArticle({ title: '乙稿' })
    mocks.processPost.mockResolvedValue({
      category: '技术',
      description: '绝不写入的描述',
      tags: ['绝'],
    })

    await runBackgroundJob({ DB: createDatabase() }, {
      type: 'process-post-ai',
      postId: b.postRef,
      articleId: a.articleId,
      expectedVersion: 1,
      operationId: aiProcessPostOperationId(b.postRef, 1),
    })

    expect(mocks.processPost).not.toHaveBeenCalled()
    expect(await versionRows(b.articleId)).toHaveLength(1)
    expect((await postRow(b.postRef))!.category).toBe('未分类')
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
  })
})