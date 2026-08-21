/**
 * B3-02 — /api/publish-revision + /api/article-commands route integration
 * fixture (issue #34).
 *
 * "浏览器证明自动保存不改线上": drives the write sequence the editor's browser
 * would perform through the real routes + real kernel + shared in-process D1 —
 * autosave (save), then promote. Proves the autosave NEVER changes the live
 * posts projection while an active revision exists, and that a promote commits
 * the restore point + event + formal move together.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapRevisionState,
  createDatabase,
  query,
  createFormalArticle,
} from '@/tests/lib/publish-revision/helpers'

const mocks = vi.hoisted(() => ({
  getRouteContextWithDb: vi.fn(),
  ensureAuthenticatedRequest: vi.fn(),
  parseJsonBody: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
}))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: mocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: mocks.parseJsonBody,
}))

vi.mock('@/lib/cache', () => ({ invalidatePublicContentCache: mocks.invalidatePublicContentCache }))
vi.mock('@/lib/background-jobs', () => ({
  enqueueBackgroundJob: mocks.enqueueBackgroundJob,
  aiProcessPostOperationId: (postRef: number, version: number) =>
    `ai:process-post:${postRef}:v${version}`,
}))

import { GET as ArticleGet, POST as ArticlePost } from '@/app/api/article-commands/route'
import { GET as RevisionGet, POST as RevisionPost } from '@/app/api/publish-revision/route'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b302-revision-route-'))
  cleanup.push(state)
  await bootstrapRevisionState(state)
}, 300_000)

afterAll(async () => {
  await teardown()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

import { teardownState as teardown } from '@/tests/lib/article-commands/helpers'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRouteContextWithDb.mockResolvedValue({
    ok: true,
    env: { NEXT_PUBLIC_SITE_URL: 'https://blog.example.test' },
    db: createDatabase(),
    ctx: { waitUntil: vi.fn() },
  })
  mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
  mocks.invalidatePublicContentCache.mockResolvedValue(undefined)
  mocks.enqueueBackgroundJob.mockResolvedValue(undefined)
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

async function post(route: typeof ArticlePost | typeof RevisionPost, payload: unknown) {
  mocks.parseJsonBody.mockResolvedValue(payload)
  const res = await route({} as never)
  return res.json()
}

async function articleGet(payload: string) {
  const res = (await ArticleGet(new Request(`http://localhost/api/article-commands?${payload}`) as never)) as Response
  return res.json()
}

async function revisionGet(payload: string) {
  const res = (await RevisionGet(new Request(`http://localhost/api/publish-revision?${payload}`) as never)) as Response
  return res.json()
}

/** The live formal content — materialized from the frozen formal version (canonical). */
async function livePostRow(postRef: number) {
  const rows = await query<Record<string, unknown>>(
    `SELECT v.snapshot_json FROM articles a
     JOIN formal_publications f ON f.article_id = a.id
     JOIN article_versions v ON v.article_id = a.id AND v.version = f.version
     WHERE a.post_ref = ${postRef} LIMIT 1`,
  )
  const raw = rows[0]
  if (!raw) return null
  const record = JSON.parse(raw.snapshot_json as string) as {
    fields: Record<string, unknown>
    original_content: string | null
  }
  return { ...record.fields, content: record.original_content }
}

describe('app/api revision loop — browser autosave never changes live', { timeout: 600_000 }, () => {
  it('自动保存不改变线上：编辑中正式版本保持不变，promote 才上线', async () => {
    const article = await createFormalArticle(fresh('route-slug'), '线上标题', '线上正文')
    const liveBefore = await livePostRow(article.postRef)

    // 1) The editor autosaves a changed body → active revision is formed, live
    //    posts row (public projection) is UNCHANGED.
    const autosave = await post(ArticlePost, {
      action: 'save',
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: fresh('autosave-1'),
      snapshot: {
        slug: article.slug,
        title: '自动保存的新标题',
        content: '自动保存的新正文',
        html: '<p>自动保存的新正文</p>',
        description: null,
        category: null,
        tags: [],
        status: 'published',
        password: null,
        is_pinned: 0,
        is_hidden: 0,
        cover_image: null,
        deleted_at: null,
        published_at: 1,
        updated_at: null,
      },
    })
    expect(autosave.outcome).toBe('applied')
    expect(autosave.version).toBe(1)

    // Public projection is untouched; the public page (getPostBySlug) reads the
    // ORIGINAL formal content.
    const liveAfterAutosave = await livePostRow(article.postRef)
    expect(liveAfterAutosave?.title).toBe(liveBefore?.title)
    expect(liveAfterAutosave?.content).toBe(liveBefore?.content)

    // The editor's GET surfaces the revision snapshot + its number as version.
    const editorState = await articleGet(`articleId=${article.articleId}`)
    expect(editorState.version).toBe(1)
    expect(editorState.snapshot.title).toBe('自动保存的新标题')
    expect(editorState.revision.revisionId).toBe(`revision:${article.articleId}:v1`)

    // 2) Promote through the revision route → restore point + event + formal
    //    move + posts projection all advance together.
    const promoted = await post(RevisionPost, {
      action: 'promote',
      revisionId: `revision:${article.articleId}:v1`,
    })
    expect(promoted.outcome).toBe('promoted')
    if (promoted.outcome !== 'promoted') return
    expect(promoted.promotedVersion).toBe(2)

    // Now the public projection reflects the promoted revision.
    const liveAfterPromote = await livePostRow(article.postRef)
    expect(liveAfterPromote?.title).toBe('自动保存的新标题')
    const formal = (await query<Record<string, unknown>>(
      `SELECT version FROM formal_publications WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(formal?.version).toBe(2)
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_restore_points WHERE article_id = ${article.articleId}`)).toHaveLength(1)
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_promotions WHERE article_id = ${article.articleId}`)).toHaveLength(1)
    expect(mocks.invalidatePublicContentCache).toHaveBeenCalled()

    // 3) A post-promotion autosave forms the NEXT unique revision; live untouched.
    const next = await post(ArticlePost, {
      action: 'save',
      articleId: article.articleId,
      expectedVersion: 2, // the NEW formal version
      operationId: fresh('autosave-2'),
      snapshot: {
        slug: article.slug,
        title: '第二次编辑',
        content: '第二次编辑正文',
        html: '<p>第二次编辑正文</p>',
        description: null,
        category: null,
        tags: [],
        status: 'published',
        password: null,
        is_pinned: 0,
        is_hidden: 0,
        cover_image: null,
        deleted_at: null,
        published_at: 2,
        updated_at: null,
      },
    })
    expect(next.outcome).toBe('applied')
    if (next.outcome !== 'applied') return
    expect(next.version).toBe(1)
    // The second revision is a DIFFERENT active row based on v2.
    const activeRows = await query<Record<string, unknown>>(
      `SELECT * FROM publish_revisions WHERE article_id = ${article.articleId} AND status = 'active'`,
    )
    expect(activeRows).toHaveLength(1)
    expect(activeRows[0]?.revision_id).toBe(`revision:${article.articleId}:v2`)
    expect((await livePostRow(article.postRef))?.title).toBe('自动保存的新标题')

    // GET resolves the revision read surface by slug for the workbench.
    const rev = await revisionGet(`slug=${encodeURIComponent(article.slug)}`)
    expect(rev.state.formal.version).toBe(2)
    expect(rev.state.active.revision_id).toBe(`revision:${article.articleId}:v2`)
    expect(rev.state.promotions).toHaveLength(1)
    expect(rev.state.latestRestorePoint).not.toBeNull()
  })

  it('discard 通过 route 可停用活动修订，线上不变', async () => {
    const article = await createFormalArticle(fresh('discard-slug'))
    await post(ArticlePost, {
      action: 'save',
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: fresh('discard-save'),
      snapshot: {
        slug: article.slug,
        title: '将被丢弃',
        content: '丢弃正文',
        html: '<p>丢弃正文</p>',
        description: null,
        category: null,
        tags: [],
        status: 'published',
        password: null,
        is_pinned: 0,
        is_hidden: 0,
        cover_image: null,
        deleted_at: null,
        published_at: 1,
        updated_at: null,
      },
    })
    const discarded = await post(RevisionPost, {
      action: 'discard',
      articleId: article.articleId,
    })
    expect(discarded.outcome).toBe('discarded')
    expect((await livePostRow(article.postRef))?.title).toBe('正式文章标题')
    expect(
      await query<Record<string, unknown>>(`SELECT * FROM publish_revisions WHERE article_id = ${article.articleId} AND status = 'active'`),
    ).toHaveLength(0)
  })

  // B3-03 (issue #35): compare / restore / undo through the route.
  it('compare 通过 route 重验预览版本并返回差异', async () => {
    const article = await createFormalArticle(fresh('route-cmp-slug'), '线上标题', '线上正文')
    const compared = await post(RevisionPost, {
      action: 'compare',
      articleId: article.articleId,
      expectedVersion: 1,
    })
    expect(compared.outcome).toBe('compared')
    if (compared.outcome !== 'compared') return
    expect(compared.verifiedVersion).toBe(1)
    expect(compared.identical).toBe(true)

    // Stale preview version → conflict, never silently compared.
    const stale = await post(RevisionPost, {
      action: 'compare',
      articleId: article.articleId,
      expectedVersion: 999,
    })
    expect(stale.outcome).toBe('conflict')
  })

  it('restore 通过 route 恢复为修订与草稿，undo 均不改变线上', async () => {
    const article = await createFormalArticle(fresh('route-restore-slug'), '第一版标题', '第一版正文')

    // Promote once so a pre-promotion restore point for v1 exists.
    await post(ArticlePost, {
      action: 'save',
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: fresh('route-restore-save'),
      snapshot: {
        slug: article.slug,
        title: '第二版标题',
        content: '第二版正文',
        html: '<p>第二版正文</p>',
        description: null,
        category: null,
        tags: [],
        status: 'published',
        password: null,
        is_pinned: 0,
        is_hidden: 0,
        cover_image: null,
        deleted_at: null,
        published_at: 2,
        updated_at: null,
      },
    })
    const promoted = await post(RevisionPost, { action: 'promote', revisionId: `revision:${article.articleId}:v1` })
    expect(promoted.outcome).toBe('promoted')

    const state = await revisionGet(`articleId=${article.articleId}`)
    const rp = state.state.restorePoints[0]
    expect(rp).toBeTruthy()

    // Restore as revision.
    const restored = await post(RevisionPost, {
      action: 'restore',
      restorePointId: rp.restore_point_id,
      articleId: article.articleId,
      expectedVersion: 2,
      target: 'revision',
    })
    expect(restored.outcome).toBe('restored')
    expect(restored.target).toBe('revision')
    // Live projection still reads v2 (the promoted body).
    expect((await livePostRow(article.postRef))?.title).toBe('第二版标题')

    // Undo restores the pending revision away; live untouched.
    const undone = await post(RevisionPost, {
      action: 'undo-restore',
      restoreOperationId: restored.restoreOperationId,
    })
    expect(undone.outcome).toBe('undone')
    expect((await livePostRow(article.postRef))?.title).toBe('第二版标题')

    // Restore as draft → standalone copy, original stays published.
    const draftRestored = await post(RevisionPost, {
      action: 'restore',
      restorePointId: rp.restore_point_id,
      articleId: article.articleId,
      expectedVersion: 2,
      target: 'draft',
    })
    expect(draftRestored.outcome).toBe('restored')
    expect(draftRestored.target).toBe('draft')
    expect(draftRestored.draftArticleId).toBeTruthy()
    expect((await livePostRow(article.postRef))?.status).toBe('published')
  })
})
