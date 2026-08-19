/**
 * B3-03 — revision compare / restore / undo (issue #35).
 *
 * Builds strictly on the #34 revision-loop facts. It proves:
 *
 *   - `compareRevision` re-verifies the preview version before diffing, and
 *     never compares a stale silent expected version,
 *   - a restore-as-revision forms a NEW pending active revision carrying the
 *     restore-point snapshot WITHOUT touching the live formal / slug history /
 *     public projection (promotion stays an explicit separate step),
 *   - a restore-as-draft creates a standalone draft copy and never unpublishes
 *     or rewrites the live article's slug,
 *   - `undoRestoreOperation` discards the pending revision / draft copy and
 *     leaves the live formal projection untouched,
 *   - `pruneRestorePoints` enforces the recent-10 per-article retention.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapRevisionState,
  createDatabase,
  query,
  createFormalArticle,
} from '@/tests/lib/publish-revision/helpers'
import {
  compareRevision,
  promoteRevision,
  readRevisionState,
  restoreRevisionSnapshot,
  saveRestorePoint,
  saveRevision,
  undoRestoreOperation,
} from '@/lib/publish-revision'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b303-restore-'))
  cleanup.push(state)
  await bootstrapRevisionState(state)
}, 300_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(slug: string, title: string, content: string) {
  return {
    slug,
    title,
    content,
    html: `<p>${content}</p>`,
    description: null,
    category: null,
    tags: [] as string[] | null,
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
  }
}

describe('lib/publish-revision compare/restore — issue #35', { timeout: 600_000 }, () => {
  it('compare 重验预览版本：expectedVersion 过期时 conflict，绝不静默比较', async () => {
    const article = await createFormalArticle(fresh('cmp-slug'), '线上标题', '线上正文 #1 内容')

    const stale = await compareRevision(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 999,
    })
    expect(stale.outcome).toBe('conflict')
    if (stale.outcome !== 'conflict') return
    expect(stale.serverVersion).toBe(1)
    expect(stale.reason).toBe('stale-formal-version')

    // Correct preview version → compared, identical with no active revision.
    const compared = await compareRevision(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
    })
    expect(compared.outcome).toBe('compared')
    if (compared.outcome !== 'compared') return
    expect(compared.identical).toBe(true)
  })

  it('compare 可对照活动修订展示字段与正文差异', async () => {
    const article = await createFormalArticle(fresh('cmp2-slug'), '线上标题', '原文 内容')
    await saveRevision(createDatabase(), {
      articleId: article.articleId,
      postRef: article.postRef,
      expectedVersion: 1,
      operationId: fresh('cmp2-save'),
      snapshot: snapshot(article.slug, '草稿新标题', '原文 内容 追加'),
      formal: { version: 1, slug: article.slug, contentHash: '' },
    })
    const compared = await compareRevision(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
    })
    expect(compared.outcome).toBe('compared')
    if (compared.outcome !== 'compared') return
    expect(compared.identical).toBe(false)
    expect(compared.targetLabel).toContain('active-revision')
    expect(compared.fields.find((f) => f.field === 'title')?.changed).toBe(true)
    expect(compared.contentDiff.some((t) => t.type === 'added')).toBe(true)
  })

  it('恢复为修订形成待定活动修订，不改变线上/不重写 slug 历史', async () => {
    const article = await createFormalArticle(fresh('restore-rev-slug'), '第一版标题', '第一版正文内容')

    // Promote once so a restore point for the (now older) first version exists.
    await saveRevision(createDatabase(), {
      articleId: article.articleId,
      postRef: article.postRef,
      expectedVersion: 1,
      operationId: fresh('promote-save'),
      snapshot: snapshot(article.slug, '第二版标题', '第二版正文内容'),
      formal: { version: 1, slug: article.slug, contentHash: '' },
    })
    const promoted = await promoteRevision(createDatabase(), {
      articleId: article.articleId,
      actor: 'b303',
    })
    expect(promoted.outcome).toBe('promoted')
    if (promoted.outcome !== 'promoted') return
    expect(promoted.promotedVersion).toBe(2)

    // Restore the (pre-promotion) first-version restore point as a revision.
    const state = await readRevisionState(createDatabase(), article.articleId)
    const restorePoint = state.restorePoints[0]
    expect(restorePoint).toBeTruthy()
    const restored = await restoreRevisionSnapshot(createDatabase(), {
      restorePointId: restorePoint.restore_point_id,
      articleId: article.articleId,
      expectedVersion: 2,
      target: 'revision',
      actor: 'b303',
    })
    expect(restored.outcome).toBe('restored')
    if (restored.outcome !== 'restored') return
    expect(restored.target).toBe('revision')
    expect(restored.revisionId).toBeTruthy()

    // Live formal is untouched — the public projection still reads v2.
    const live = (await query<Record<string, unknown>>(
      `SELECT title, slug FROM posts WHERE id = ${article.postRef}`,
    ))[0]
    expect(live?.title).toBe('第二版标题')
    const active = await readRevisionState(createDatabase(), article.articleId)
    expect(active.active).toBeTruthy()
    expect(active.active?.title).toBe('第一版标题')

    // Undo: discards the pending revision, live still untouched.
    const undone = await undoRestoreOperation(createDatabase(), {
      restoreOperationId: restored.restoreOperationId,
      actor: 'b303',
    })
    expect(undone.outcome).toBe('undone')
    const afterUndo = await readRevisionState(createDatabase(), article.articleId)
    expect(afterUndo.active).toBeNull()
    expect((await query<Record<string, unknown>>(`SELECT title FROM posts WHERE id = ${article.postRef}`))[0]?.title).toBe('第二版标题')
  })

  it('恢复为草稿创建独立草稿副本，绝不取消发布/不改线上 slug', async () => {
    const article = await createFormalArticle(fresh('restore-draft-slug'), '正式标题', '正式正文内容')
    // Save a manual preflight restore point of the CURRENT live state.
    const saved = await saveRestorePoint(createDatabase(), {
      articleId: article.articleId,
      actor: 'b303',
      reason: 'manual-preflight',
    })
    expect(saved.outcome).toBe('saved')
    if (saved.outcome !== 'saved') return

    const restored = await restoreRevisionSnapshot(createDatabase(), {
      restorePointId: saved.restorePointId,
      articleId: article.articleId,
      expectedVersion: 1,
      target: 'draft',
      actor: 'b303',
    })
    expect(restored.outcome).toBe('restored')
    if (restored.outcome !== 'restored') return
    expect(restored.target).toBe('draft')
    expect(restored.draftArticleId).toBeTruthy()

    // Original live article is fully untouched (still published, same slug).
    const live = (await query<Record<string, unknown>>(
      `SELECT title, status, slug FROM posts WHERE id = ${article.postRef}`,
    ))[0]
    expect(live?.status).toBe('published')
    expect(live?.slug).toBe(article.slug)

    // The draft copy exists as a separate routed draft.
    const draftPost = await query<Record<string, unknown>>(
      `SELECT p.title, p.status FROM posts p
       JOIN articles a ON a.post_ref = p.id WHERE a.id = ${restored.draftArticleId}`,
    )
    expect(draftPost).toHaveLength(1)
    expect(draftPost[0]?.status).toBe('draft')

    // Undo removes the draft copy; live untouched.
    const undone = await undoRestoreOperation(createDatabase(), {
      restoreOperationId: restored.restoreOperationId,
      actor: 'b303',
    })
    expect(undone.outcome).toBe('undone')
    expect(
      await query<Record<string, unknown>>(`SELECT id FROM articles WHERE id = ${restored.draftArticleId}`),
    ).toHaveLength(0)
    expect((await query<Record<string, unknown>>(`SELECT status FROM posts WHERE id = ${article.postRef}`))[0]?.status).toBe('published')
  })

  it('恢复点保留最近 10 条（retention），超出即修剪', async () => {
    const article = await createFormalArticle(fresh('retention-slug'), '标题', '正文')
    // Save 13 manual restore points.
    for (let i = 0; i < 13; i += 1) {
      await saveRestorePoint(createDatabase(), {
        articleId: article.articleId,
        actor: 'b303',
        reason: `retention-${i}`,
      })
    }
    const st = await readRevisionState(createDatabase(), article.articleId)
    expect(st.restorePoints.length).toBeLessThanOrEqual(10)
    expect(st.restorePoints.length).toBe(10)
  })
})
