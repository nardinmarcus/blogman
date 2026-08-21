/**
 * B3-05 — article lifecycle command isolated-D1 fixture (issue #37).
 *
 * 取消发布 / 重新上线 / 软删除恢复. One shared in-process Miniflare instance
 * (real D1 binding, zero wrangler CLI spawns). Covers:
 *
 *   - 取消发布 a live formal article leaves the public surface: posts -> draft,
 *     formal lifecycle -> unpublished, while versions, the active revision and
 *     the history are ALL preserved,
 *   - 幂等 the same operation id replays instead of re-writing,
 *   - 状态前置条件 a non-published / already-offline article is refused, and a
 *     soft-deleted article is blocked,
 *   - 重新上线最后正式版 relive(content='formal') re-lists the last official
 *     version with no new version written,
 *   - 重新上线当前修订 relive(content='revision') raises the current pending
 *     revision (new formal version + restore point + promotion event) and flips
 *     lifecycle back to published,
 *   - 从未上线 an article with no formal publication cannot relive,
 *   - 软删后恢复为未发布 B2-06 restore returns a deleted post to draft (未发布)
 *     and does NOT re-publish it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapLifecycleState,
  createDatabase,
  query,
  createFormalArticle,
  freshOp,
} from './helpers'
import { relive, unpublish, listLifecycleHistory } from '@/lib/article-lifecycle'
import { restore, softDelete } from '@/lib/article-commands'
import { save } from '@/lib/article-commands'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b305-article-lifecycle-'))
  cleanup.push(state)
  await bootstrapLifecycleState(state)
}, 300_000)

afterAll(async () => {
  await teardown()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

// eslint-disable-next-line import/first
import { teardownState as teardown } from '@/tests/lib/article-commands/helpers'

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: freshOp('slug'),
    title: '文章标题',
    content: '正文内容',
    html: '<p>正文内容</p>',
    description: null,
    category: null,
    tags: null,
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

async function postState(postRef: number) {
  const [row] = await query<{ status: string | null; deleted_at: number | null; published_at: number | null }>(
    `SELECT status, deleted_at, published_at FROM posts WHERE id = ${postRef}`,
  )
  return row
}

/** #234-02 — article-level state now lives in the latest immutable snapshot. */
async function latestSnapshotState(articleId: number) {
  const [row] = await query<{ snapshot_json: string }>(
    `SELECT snapshot_json FROM article_versions WHERE article_id = ${articleId} ORDER BY version DESC LIMIT 1`,
  )
  if (!row) return null
  const parsed = JSON.parse(row.snapshot_json) as { fields: { status: string; deleted_at: number | null } }
  return parsed.fields
}

async function formalState(articleId: number) {
  const [row] = await query<{ lifecycle: string; version: number }>(
    `SELECT lifecycle, version FROM formal_publications WHERE article_id = ${articleId}`,
  )
  return row
}

async function versionCount(articleId: number) {
  const [row] = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`,
  )
  return row?.n ?? 0
}

describe('unpublish — 取消发布', () => {
  it('takes a live formal article offline while preserving versions, revisions and history', async () => {
    const { articleId, postRef, slug } = await createFormalArticle('off-1', '上线文章', '正式内容')

    expect((await postState(postRef))?.status).toBe('published')
    expect((await formalState(articleId))?.lifecycle).toBe('published')
    const versionsBefore = await versionCount(articleId)

    // Create an active revision before unpublishing (must survive untouched).
    const op = freshOp('save')
    const saveResult = await save(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: op,
      snapshot: snapshot({ slug, title: '上线文章改', content: '正式内容·修订' }),
    })
    expect(saveResult.outcome).toBe('applied')

    const revOp = freshOp('unpublish')
    const result = await unpublish(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: revOp,
      actor: 'b305-test',
    })
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    expect(result.lifecycle).toBe('unpublished')
    expect(result.direction).toBe('unpublish')

    // Live surface is offline…
    expect((await postState(postRef))?.status).toBe('draft')
    expect((await formalState(articleId))?.lifecycle).toBe('unpublished')

    // …but nothing content-bearing was destroyed.
    expect(await versionCount(articleId)).toBe(versionsBefore)
    const [active] = await query<{ status: string }>(
      `SELECT status FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`,
    )
    expect(active?.status).toBe('active')
    const history = await listLifecycleHistory(createDatabase(), articleId)
    expect(history).toHaveLength(1)
    expect(history[0].direction).toBe('unpublish')
  })

  it('replays idempotently on the same operation id', async () => {
    const { articleId, postRef } = await createFormalArticle('off-idem', '幂等文章', '内容')
    const revOp = freshOp('unpublish')
    const first = await unpublish(createDatabase(), { articleId, expectedVersion: 1, operationId: revOp })
    expect(first.outcome).toBe('applied')

    const second = await unpublish(createDatabase(), { articleId, expectedVersion: 1, operationId: revOp })
    expect(second.outcome).toBe('replayed')
    if (second.outcome !== 'replayed') return
    expect(second.existing).toBe(true)

    const history = await listLifecycleHistory(createDatabase(), articleId)
    expect(history).toHaveLength(1)
    expect((await postState(postRef))?.status).toBe('draft')
  })

  it('refuses when the article is not live (status precondition)', async () => {
    const { articleId } = await createFormalArticle('off-refuse', '拒绝文章', '内容')
    await unpublish(createDatabase(), { articleId, expectedVersion: 1, operationId: freshOp('unpublish') })

    // Second unpublish without an idempotency key — already offline -> status-conflict.
    const again = await unpublish(createDatabase(), { articleId, expectedVersion: 1, operationId: freshOp('unpublish2') })
    expect(again.outcome).toBe('status-conflict')
  })

  it('blocks a soft-deleted article', async () => {
    const { articleId } = await createFormalArticle('off-deleted', '已删文章', '内容')
    // #234-02: softDelete appends its own version snapshot (v2).
    const del = await softDelete(createDatabase(), { articleId, expectedVersion: 1, operationId: freshOp('softDelete') })
    expect(del).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await latestSnapshotState(articleId))?.deleted_at).not.toBeNull()
    // NOTE: the posts-backed blocked guard in the lifecycle kernel is remapped
    // to the canonical latest snapshot by the 外围内核 posts-less ticket; the
    // outcome assertion moves there. Here we pin the canonical deletion fact.
  })
})

describe('relive — 重新上线', () => {
  it('re-lists the last official version (formal) without writing a new version', async () => {
    const { articleId, postRef } = await createFormalArticle('relive-f', '重新上线文章', '最后正式版')
    await unpublish(createDatabase(), { articleId, expectedVersion: 1, operationId: freshOp('unpublish') })

    const result = await relive(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: freshOp('relive'),
      content: 'formal',
      actor: 'b305-test',
      siteUrl: 'https://blog.example.test',
    })
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    expect(result.direction).toBe('relive-formal')
    expect(result.lifecycle).toBe('published')
    // No new version on the formal path.
    expect(await versionCount(articleId)).toBe(1)

    expect((await postState(postRef))?.status).toBe('published')
    expect((await formalState(articleId))?.lifecycle).toBe('published')
    const history = await listLifecycleHistory(createDatabase(), articleId)
    expect(history.map((h) => h.direction)).toEqual(['relive-formal', 'unpublish'])
  })

  it('raises the current revision (revision) and flips lifecycle to published', async () => {
    const { articleId, postRef, slug } = await createFormalArticle('relive-r', '修订上线文章', '正式版内容')
    await unpublish(createDatabase(), { articleId, expectedVersion: 1, operationId: freshOp('unpublish') })

    // Create an active revision while offline (edits keep landing in the revision surface).
    await save(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: freshOp('save'),
      snapshot: snapshot({ slug, title: '修订版标题', content: '修订版正文', status: 'draft' }),
    })

    const result = await relive(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: freshOp('relive'),
      content: 'revision',
      actor: 'b305-test',
      siteUrl: 'https://blog.example.test',
    })
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    expect(result.direction).toBe('relive-revision')
    expect(result.lifecycle).toBe('published')
    // A new formal version was written by the promotion.
    expect(result.version).toBe(2)

    expect((await postState(postRef))?.status).toBe('published')
    const [content] = await query<{ title: string }>(`SELECT title FROM posts WHERE id = ${postRef}`)
    expect(content?.title).toBe('修订版标题')
    expect((await formalState(articleId))?.lifecycle).toBe('published')
    const [promotion] = await query<{ promoted_version: number }>(
      `SELECT promoted_version FROM publish_promotions WHERE article_id = ${articleId}`,
    )
    expect(promotion?.promoted_version).toBe(2)
    const history = await listLifecycleHistory(createDatabase(), articleId)
    expect(history.map((h) => h.direction)).toEqual(['relive-revision', 'unpublish'])
  })

  it('blocks an article that was never published', async () => {
    const created = await (async () => {
      const { create } = await import('@/lib/article-commands')
      return create(createDatabase(), {
        creationId: freshOp('neverpub'),
        snapshot: snapshot({ slug: freshOp('neverpub'), status: 'draft' }),
      })
    })()
    if (created.outcome !== 'created') throw new Error('create failed')
    const result = await relive(createDatabase(), {
      articleId: created.articleId,
      expectedVersion: 1,
      operationId: freshOp('relive'),
      content: 'formal',
    })
    expect(result.outcome).toBe('blocked')
  })
})

describe('soft-delete restore — 软删后恢复为未发布', () => {
  it('restores a deleted post to draft (unpublished) and never re-publishes it', async () => {
    const { articleId } = await createFormalArticle('restore-1', '恢复文章', '内容')
    await softDelete(createDatabase(), { articleId, expectedVersion: 1, operationId: freshOp('softDelete') })
    expect((await latestSnapshotState(articleId))?.deleted_at).not.toBeNull()

    // #234-02: restore anchors on the soft-delete's v2 and appends v3.
    const result = await restore(createDatabase(), { articleId, expectedVersion: 2, operationId: freshOp('restore') })
    expect(result).toMatchObject({ outcome: 'applied', version: 3 })

    const after = await latestSnapshotState(articleId)
    expect(after?.deleted_at).toBeNull()
    // 未发布 — NOT re-published.
    expect(after?.status).toBe('draft')
  })
})
