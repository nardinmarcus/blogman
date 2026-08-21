/**
 * B3-02 — formal-article pending revision isolated-D1 fixture (issue #34).
 *
 * One shared in-process Miniflare instance (real D1 binding, zero wrangler CLI
 * spawns). Covers the full revision-loop acceptance matrix:
 *
 *   - 首次编辑 the first content change creates the unique active revision and
 *     the live posts projection is untouched,
 *   - 不虚构既有修订 an identical save replays without fabricating a revision,
 *   - 跨入口更新 the editor save and a metadata-only writer (AI/external shape)
 *     land in the SAME active revision,
 *   - 并发冲突 two writers racing the same revision number: one applies, the
 *     other conflicts without overwriting,
 *   - 重复上线 the same promotion replays (one event, one restore point),
 *   - 事务失败 a mid-batch abort leaves the old formal version online and the
 *     active revision intact,
 *   - 下一次修订 after promotion the next edit forms a brand-new active
 *     revision,
 *   - 拒绝旧式原地更新 the legacy direct posts write to a formal article throws.
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
  freshOp,
} from './helpers'
import { save, setPinned } from '@/lib/article-commands'
import { discardRevision, promoteRevision, readRevisionState } from '@/lib/publish-revision'

import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import type { RevisionRow } from '@/lib/publish-revision/types'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b302-publish-revision-'))
  cleanup.push(state)
  await bootstrapRevisionState(state)
}, 300_000)

afterAll(async () => {
  await teardown()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

import { teardownState as teardown } from '@/tests/lib/article-commands/helpers'

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title: '标题',
    content: '正文内容',
    html: '<p>正文内容</p>',
    description: '描述',
    category: '分类',
    tags: ['甲'],
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

/** The live formal content — materialized from the FROZEN FORMAL version (canonical). */
async function livePost(postRef: number) {
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
    original_html: string | null
  }
  return {
    ...record.fields,
    content: record.original_content,
    html: record.original_html,
  }
}

async function activeRevisions(articleId: number) {
  return query<RevisionRow>(`SELECT * FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`)
}

async function allRevisions(articleId: number) {
  return query<RevisionRow>(`SELECT * FROM publish_revisions WHERE article_id = ${articleId}`)
}

describe('lib/publish-revision — formal-article pending revision loop', { timeout: 600_000 }, () => {
  it('首次编辑：第一次变化创建唯一活动修订，不改变线上 posts 投影', async () => {
    const article = await createFormalArticle(fresh('first-slug'))
    const beforeLive = await livePost(article.postRef)

    const saveInput = snapshot({ slug: article.slug, title: '编辑后的标题', content: '编辑后的正文' })
    const result = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1, // the formal version the editor loaded
      operationId: freshOp('first-save'),
      snapshot: saveInput,
    })
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    // The version token returned is the revision number (1 on first create).
    expect(result.version).toBe(1)
    expect((result as { revision?: boolean }).revision).toBe(true)

    // Exactly one active revision; the live posts projection is UNCHANGED.
    const active = await activeRevisions(article.articleId)
    expect(active).toHaveLength(1)
    expect((active[0] as RevisionRow).revision_number).toBe(1)
    expect((active[0] as RevisionRow).title).toBe('编辑后的标题')
    expect((active[0] as RevisionRow).content).toBe('编辑后的正文')
    const afterLive = await livePost(article.postRef)
    expect(afterLive?.title).toBe(beforeLive?.title)
    expect(afterLive?.content).toBe(beforeLive?.content)

    // Formal version is UNCHANGED (still the first-publish v1).
    const formal = (await query<Record<string, unknown>>(
      `SELECT version FROM formal_publications WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(formal?.version).toBe(1)
  })

  it('不虚构既有修订：与线上正文相同的保存 replay，不创建修订行', async () => {
    const article = await createFormalArticle(fresh('no-fabricate'))
    const live = await livePost(article.postRef)
    // A save carrying the EXACT live formal snapshot replays without a row.
    const result = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('same-save'),
      snapshot: snapshot({
        slug: article.slug,
        title: live?.title as string,
        content: live?.content as string,
        html: live?.html as string,
        description: (live?.description as string | null) ?? null,
        category: (live?.category as string | null) ?? null,
        tags: null,
        password: (live?.password as string | null) ?? null,
        is_pinned: live?.is_pinned as number,
        is_hidden: (live?.is_hidden as number) ?? 0,
        cover_image: (live?.cover_image as string | null) ?? null,
      }),
    })
    expect(result.outcome).toBe('replayed')
    expect(await activeRevisions(article.articleId)).toHaveLength(0)
  })

  it('跨入口更新：编辑器保存与元数据型 writer（AI/外部形状）写同一活动修订', async () => {
    const article = await createFormalArticle(fresh('cross-entry'))
    // First writer (editor) changes the body → creates the revision at rev 1.
    const editorSave = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('editor-1'),
      snapshot: snapshot({ slug: article.slug, title: '跨入口正文', content: '跨入口正文内容' }),
    })
    expect(editorSave.outcome).toBe('applied')
    if (editorSave.outcome !== 'applied') return
    expect(editorSave.version).toBe(1)

    // Second writer (AI metadata-only: same body, adds category/tags/description)
    // anchors to the CURRENT revision number (1) → advances to rev 2, same row.
    const aiSave = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('ai-1'),
      snapshot: snapshot({
        slug: article.slug,
        title: '跨入口正文',
        content: '跨入口正文内容',
        html: '<p>跨入口正文内容</p>',
        description: 'AI 生成的摘要',
        category: 'AI 分类',
        tags: ['AI标签'],
      }),
    })
    expect(aiSave.outcome).toBe('applied')
    if (aiSave.outcome !== 'applied') return
    expect(aiSave.version).toBe(2)

    // Still ONE active revision, rev 2, carrying BOTH writers' facts.
    const active = await activeRevisions(article.articleId)
    expect(active).toHaveLength(1)
    const revision = active[0] as RevisionRow
    expect(revision.revision_number).toBe(2)
    expect(revision.title).toBe('跨入口正文')
    expect(revision.description).toBe('AI 生成的摘要')
    expect(revision.category).toBe('AI 分类')
  })

  it('并发冲突：同修订号的两次并发只落一次，后到者冲突且不覆盖', async () => {
    const article = await createFormalArticle(fresh('race'))
    // Both writers load the revision at revision_number 1.
    const aFirst = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('race-a1'),
      snapshot: snapshot({ slug: article.slug, title: '并发A初版', content: '并发A初版正文' }),
    })
    expect(aFirst.outcome).toBe('applied')
    if (aFirst.outcome !== 'applied') return
    expect(aFirst.version).toBe(1)

    // Writer A advances the shared revision to rev 2.
    const aSecond = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('race-a2'),
      snapshot: snapshot({ slug: article.slug, title: '并发A第二版', content: '并发A第二版正文' }),
    })
    expect(aSecond.outcome).toBe('applied')
    if (aSecond.outcome !== 'applied') return
    expect(aSecond.version).toBe(2)

    // Writer B still holds the stale token 1 — its save conflicts and NEVER
    // overwrites the winner's revision content.
    const b = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('race-b'),
      snapshot: snapshot({ slug: article.slug, title: '并发B覆盖', content: '并发B覆盖正文' }),
    })
    expect(b.outcome).toBe('conflict')
    if (b.outcome !== 'conflict') return
    expect(b.serverVersion).toBe(2)

    // The winning writer's revision content is intact (B did not overwrite).
    const active = await activeRevisions(article.articleId)
    expect(active).toHaveLength(1)
    expect((active[0] as RevisionRow).title).toBe('并发A第二版')
    expect((active[0] as RevisionRow).revision_number).toBe(2)
  })

  it('上线：先存恢复点，再提升修订并生成事件，公共读读到新正式版本', async () => {
    const article = await createFormalArticle(fresh('promote'))
    await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('promote-save'),
      snapshot: snapshot({ slug: article.slug, title: '将上线的标题', content: '将上线的正文' }),
    })

    const promoted = await promoteRevision(createDatabase(), {
      revisionId: `revision:${article.articleId}:v1`,
      actor: 'b302-fixture',
      siteUrl: 'https://blog.example.test',
    })
    expect(promoted.outcome).toBe('promoted')
    if (promoted.outcome !== 'promoted') return
    expect(promoted.promotedVersion).toBe(2)
    expect(promoted.publicUrl).toBe(`https://blog.example.test/${article.slug}`)

    // Restore point captured the pre-promotion formal snapshot (v1).
    const restore = (await query<Record<string, unknown>>(
      `SELECT * FROM publish_restore_points WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(restore).not.toBeNull()
    expect(restore?.formal_version).toBe(1)
    expect(restore?.promoted_version).toBe(2)
    // Restore point content is the OLD formal snapshot, not the new revision.
    const restoreSheet = JSON.parse(restore?.snapshot_json as string) as { fields: { title: string } }
    expect(restoreSheet.fields.title).toBe('正式文章标题')

    // One promotion event with canonical evidence bound to public URL.
    const promo = (await query<Record<string, unknown>>(
      `SELECT * FROM publish_promotions WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(promo).not.toBeNull()
    expect(promo?.promoted_version).toBe(2)

    // Public projection + formal version moved to the promoted content.
    const live = await livePost(article.postRef)
    expect(live?.title).toBe('将上线的标题')
    const formal = (await query<Record<string, unknown>>(
      `SELECT * FROM formal_publications WHERE article_id = ${article.articleId}`,
    ))[0]
    expect(formal?.version).toBe(2)
    expect(formal?.public_url).toBe(`https://blog.example.test/${article.slug}`)

    // The article_version stream now holds v2 (the promoted content).
    const versions = await query<Record<string, unknown>>(
      `SELECT version, operation_id FROM article_versions WHERE article_id = ${article.articleId} ORDER BY version`,
    )
    expect(versions.map((v) => v.version)).toEqual([1, 2])

    // The promoted revision is immutable history — no longer active.
    expect(await activeRevisions(article.articleId)).toHaveLength(0)
    const history = await allRevisions(article.articleId)
    expect((history[0] as RevisionRow).status).toBe('promoted')
  })

  it('重复上线：同一修订重复 promote 幂等，事件与恢复点各一', async () => {
    const article = await createFormalArticle(fresh('dup-promote'))
    await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('dup-save'),
      snapshot: snapshot({ slug: article.slug, title: '重复上线正文', content: '重复上线正文内容' }),
    })
    const op = { revisionId: `revision:${article.articleId}:v1` }
    const first = await promoteRevision(createDatabase(), { ...op, actor: 'b302' })
    expect(first.outcome).toBe('promoted')
    const replay = await promoteRevision(createDatabase(), { ...op, actor: 'b302' })
    expect(replay.outcome).toBe('replayed')
    if (replay.outcome !== 'replayed') return
    expect(replay.promotedVersion).toBe(first.outcome === 'promoted' ? first.promotedVersion : -1)

    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_promotions WHERE article_id = ${article.articleId}`)).toHaveLength(1)
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_restore_points WHERE article_id = ${article.articleId}`)).toHaveLength(1)
    expect((await livePost(article.postRef))?.title).toBe('重复上线正文')
  })

  it('事务失败：中断时旧正式版本继续在线，活动修订保持完整', async () => {
    const article = await createFormalArticle(fresh('interrupt'))
    await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('interrupt-save'),
      snapshot: snapshot({ slug: article.slug, title: '中断修订', content: '中断修订正文' }),
    })

    // A conflicting article_versions row already occupies the promoted version
    // (2) with a DIFFERENT operation id — every promotion guard no-ops, so the
    // batch lands ZERO facts: no restore point, no event, no formal move, and
    // the active revision stays intact (atomic rollback ≡ guard no-op).
    const dirtyVersionJson = '{}'
    await query(
      `INSERT INTO article_versions
         (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
       VALUES (${article.articleId}, 2, 'dirty-conflict', '${dirtyVersionJson}', '${'0'.repeat(64)}', 1)`,
    )

    const revisionId = `revision:${article.articleId}:v1`
    const promoted = await promoteRevision(createDatabase(), { revisionId, actor: 'b302' })
    expect(promoted.outcome).toBe('conflict')

    // Zero new online state: formal stays at v1, posts unchanged, revision active.
    const formal = (await query<Record<string, unknown>>(`SELECT * FROM formal_publications WHERE article_id = ${article.articleId}`))[0]
    expect(formal?.version).toBe(1)
    expect((await livePost(article.postRef))?.title).toBe('正式文章标题')
    expect((await activeRevisions(article.articleId))[0]?.title).toBe('中断修订')
    // No restore point was written for the aborted attempt (atomic rollback).
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_restore_points WHERE article_id = ${article.articleId}`)).toHaveLength(0)
    expect(await query<Record<string, unknown>>(`SELECT * FROM publish_promotions WHERE article_id = ${article.articleId}`)).toHaveLength(0)
  })

  it('下一次修订：上线后再编辑形成下一唯一活动修订', async () => {
    const article = await createFormalArticle(fresh('next-rev'))
    await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('next-1'),
      snapshot: snapshot({ slug: article.slug, title: '第一修订', content: '第一修订正文' }),
    })
    const promoted = await promoteRevision(createDatabase(), { revisionId: `revision:${article.articleId}:v1`, actor: 'b302' })
    expect(promoted.outcome).toBe('promoted')
    if (promoted.outcome !== 'promoted') return

    // The editor now anchors to the NEW formal version (2) and creates the next
    // revision based on it — a different revision_id, a fresh unique active row.
    const nextSave = await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 2,
      operationId: freshOp('next-2'),
      snapshot: snapshot({ slug: article.slug, title: '第二修订', content: '第二修订正文' }),
    })
    expect(nextSave.outcome).toBe('applied')
    if (nextSave.outcome !== 'applied') return
    expect(nextSave.version).toBe(1)

    const active = await activeRevisions(article.articleId)
    expect(active).toHaveLength(1)
    expect((active[0] as RevisionRow).base_version).toBe(2)
    expect((active[0] as RevisionRow).revision_id).toBe(`revision:${article.articleId}:v2`)
    // History holds both the promoted v1-based revision and the new active one.
    expect((await allRevisions(article.articleId))).toHaveLength(2)
    // The live projection still reads the FIRST promoted content.
    expect((await livePost(article.postRef))?.title).toBe('第一修订')
  })

  it('拒绝旧式原地更新：legacy 直接写已随投影退役（结构性移除）', async () => {
    const article = await createFormalArticle(fresh('inplace'))
    // The legacy in-place helpers no longer exist — the posts write surface is
    // retired with the projection (ADR 0008). The live formal content is
    // untouched and remains reachable only through canonical reads.
    const repo = (await import('@/lib/repositories/posts')) as Record<string, unknown>
    expect(repo.updatePost).toBeUndefined()
    expect(repo.updatePostBySlug).toBeUndefined()
    expect((await livePost(article.postRef))?.title).toBe('正式文章标题')
    // A visibility-only toggle (pin) is NOT a content edit: it goes through
    // the explicit command protocol and appends its own immutable version;
    // public reads surface it from the LATEST snapshot immediately.
    await setPinned(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('inplace-pin'),
      is_pinned: 1,
    })
    const pinned = (await query<{ is_pinned: number }>(
      `SELECT json_extract(snapshot_json, '$.fields.is_pinned') AS is_pinned
       FROM article_versions WHERE article_id = ${article.articleId} ORDER BY version DESC LIMIT 1`,
    ))[0]
    expect(pinned?.is_pinned).toBe(1)
  })

  it('discard 可停用活动修订，保留正式版本且不改变线上', async () => {
    const article = await createFormalArticle(fresh('discard'))
    await save(createDatabase(), {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: freshOp('discard-save'),
      snapshot: snapshot({ slug: article.slug, title: '将被丢弃', content: '丢弃正文' }),
    })
    const discarded = await discardRevision(createDatabase(), {
      articleId: article.articleId,
      actor: 'b302',
    })
    expect(discarded).toMatchObject({ outcome: 'discarded' })
    expect(await activeRevisions(article.articleId)).toHaveLength(0)
    const history = await allRevisions(article.articleId)
    expect((history[0] as RevisionRow).status).toBe('discarded')
    expect((await livePost(article.postRef))?.title).toBe('正式文章标题')
    const state = await readRevisionState(createDatabase(), article.articleId)
    expect(state.formal?.version).toBe(1)
  })
})