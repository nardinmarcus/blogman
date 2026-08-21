/**
 * B2-07 / B3-06 — background AI result → version-bound suggestions (issues #30
 * + #38).
 *
 * B3-06 (issue #38) changes the `process-post-ai` background job: the old
 * direct metadata write is removed. The job now records VERSION-BOUND
 * SUGGESTIONS (a preparation + ≤ 3 pending per-item suggestions) and writes NO
 * live post fact — the author previews/applies/revokes/ignores them through
 * the write kernel, and a late result never overwrites a newer version.
 *
 * Proven here:
 *   - the AI never writes directly (no version, no `posts` mutation, no
 *     projections run), it only records suggestions bound to the anchored
 *     version + content basis,
 *   - replaying the SAME operation id (queue retry / duplicate dispatch)
 *     replays the preparation instead of double-recording,
 *   - AI returning no result / a legacy post with no identity / a malformed
 *     identity-post pairing are all skipped with zero facts written.
 *
 * Runs against the same shared in-process Miniflare D1 as the kernel suites —
 * zero wrangler CLI spawns during execution.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create } from '@/lib/article-commands'
import { aiProcessPostOperationId, runBackgroundJob } from '@/lib/background-jobs'
import { ensurePublishSuggestionsTables } from '@/lib/publish-suggestions/ddl'
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
  await ensurePublishSuggestionsTables(createDatabase())
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
    `SELECT v.snapshot_json FROM articles a
     JOIN article_versions v ON v.article_id = a.id
      AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
     WHERE a.post_ref = ${postRef} LIMIT 1`,
  )
  const raw = rows[0]
  if (!raw) return null
  const record = JSON.parse(raw.snapshot_json as string) as { fields: Record<string, unknown> }
  return record.fields
}

async function versionRows(articleId: number): Promise<Array<{ version: number; operation_id: string }>> {
  return query<{ version: number; operation_id: string }>(
    `SELECT version, operation_id FROM article_versions
     WHERE article_id = ${articleId} ORDER BY version`,
  )
}

async function pendingSuggestions(articleId: number): Promise<number> {
  const [row] = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM publish_suggestions
     WHERE article_id = ${articleId} AND status = 'pending'`,
  )
  return row?.n ?? 0
}

describe('lib/background-jobs — process-post-ai records suggestions, never writes', { timeout: 600_000 }, () => {
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

  it('records version-bound suggestions without writing a single live fact', async () => {
    const { articleId, postRef } = await createdArticle()
    const db = createDatabase()

    mocks.processPost.mockResolvedValue({
      category: '技术',
      description: 'AI 补齐的描述',
      tags: ['AI标签', '迟到'],
    })

    const op = aiProcessPostOperationId(postRef, 1)
    await runBackgroundJob({ DB: db }, {
      type: 'process-post-ai',
      postId: postRef,
      articleId,
      expectedVersion: 1,
      operationId: op,
    })

    // Nothing was written to the live body/version…
    expect(await versionRows(articleId)).toHaveLength(1)
    const post = await postRow(postRef)
    expect(post!.category).toBe('未分类')
    expect(post!.description).toBeNull()
    expect(post!.tags).toBe('[]') // unchanged from creation — never touched

    // …but the suggestions were recorded, bound to version 1.
    expect(await pendingSuggestions(articleId)).toBe(3)
    const [prep] = await query<{ bound_version: number; source: string; status: string }>(
      `SELECT bound_version, source, status FROM publish_preparations WHERE article_id = ${articleId}`,
    )
    expect(prep.bound_version).toBe(1)
    expect(prep.source).toBe(op)

    // Projections never run for the suggestion path (no live commit).
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
    expect(mocks.invalidatePublicContentCache).not.toHaveBeenCalled()
  })

  it('replays the same source without re-recording (idempotent queue retry)', async () => {
    const { articleId, postRef } = await createdArticle({ category: '技术', tags: ['已有标签'] })
    mocks.processPost.mockResolvedValue({
      category: '技术',
      description: 'AI 补齐描述',
      tags: ['AI标签'],
    })

    const job = {
      type: 'process-post-ai' as const,
      postId: postRef,
      articleId,
      expectedVersion: 1,
      operationId: aiProcessPostOperationId(postRef, 1),
    }

    await runBackgroundJob({ DB: createDatabase() }, job)
    await runBackgroundJob({ DB: createDatabase() }, job)

    // Only one preparation, and the field the author owns was never suggested.
    const preps = await query<{ source: string }>(
      `SELECT source FROM publish_preparations WHERE article_id = ${articleId}`,
    )
    expect(preps).toHaveLength(1)
    // Author-owned category/tags stay untouched — only description is a gap.
    const fields = await query<{ field: string }>(
      `SELECT field FROM publish_suggestions WHERE article_id = ${articleId} AND status = 'pending'`,
    )
    expect(fields.map((f) => f.field)).toEqual(['description'])
    expect(await versionRows(articleId)).toHaveLength(1)
  })

  it('skips entirely when AI returns no result (zero writes, zero suggestions)', async () => {
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
    expect(await pendingSuggestions(articleId)).toBe(0)
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
  })

  it('skips a legacy post with no article identity (never migrates queue objects into facts)', async () => {
    const slug = fresh('legacy-no-id')
    // Explicit high id: keeps the legacy seed clear of synthesized post_refs
    // in the mixed fixture DB (production drops posts entirely).
    await query(
      `INSERT INTO posts (id, slug, title, content, html, description, category, tags, status)
       VALUES (987001, '${slug}', '旧稿', '旧正文', '<p>旧正文</p>', NULL, '未分类', NULL, 'draft')`,
    )
    const postId = (await query<{ id: number }>(`SELECT id FROM posts WHERE slug = '${slug}'`))[0].id

    await runBackgroundJob({ DB: createDatabase() }, {
      type: 'process-post-ai',
      postId,
    })

    expect(mocks.processPost).not.toHaveBeenCalled()
    expect(await query(`SELECT id FROM articles WHERE post_ref = ${postId}`)).toEqual([])
    // No suggestions were recorded for a non-identity post either.
    expect(await query(`SELECT * FROM publish_suggestions WHERE article_id = 0`)).toEqual([])
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
  })

  it('resolves identity + version at job start for legacy-shaped messages', async () => {
    const { articleId, postRef } = await createdArticle({ title: '旧型消息' })
    mocks.processPost.mockResolvedValue({
      category: '技术',
      description: '旧型消息补齐描述',
      tags: ['补标签'],
    })

    // Legacy-shaped message: postId only — the handler must anchor to v1.
    await runBackgroundJob({ DB: createDatabase() }, {
      type: 'process-post-ai',
      postId: postRef,
    })

    const [prep] = await query<{ bound_version: number }>(
      `SELECT bound_version FROM publish_preparations WHERE article_id = ${articleId}`,
    )
    expect(prep.bound_version).toBe(1)
    expect(await pendingSuggestions(articleId)).toBe(3)
    // Still no live write.
    expect(await versionRows(articleId)).toHaveLength(1)
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
  })

  it('skips a malformed message whose identity and post ref disagree', async () => {
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
    expect(await pendingSuggestions(b.articleId)).toBe(0)
    expect(await versionRows(b.articleId)).toHaveLength(1)
    expect(mocks.syncPostToRelatedIndex).not.toHaveBeenCalled()
  })
})
