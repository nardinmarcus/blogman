/**
 * B6-06 — 安全解除并显式重新关联主要源稿 kernel tests (issue #55).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns). Proves the ticket's acceptance surface for the unbind / relink
 * lifecycle, as the brief requires:
 *
 *   - 解除幂等:  unlink once then replay the same operation id → `replayed`,
 *     zero new rows; a different operation over the already-cancelled pair is
 *     a no-op `not-linked` refusal.
 *   - 重链幂等:  relink once (new pending link via the #50 identity chain)
 *     then replay the same operation id → `replayed`, zero new rows; a
 *     different operation while a live link exists → `already-linked` (必须先
 *     解除, never silently duplicated).
 *   - 解除后 sync 结论为空: probeConflict derives no conclusion after unlink
 *     (`not-linked`); the B6-06 `sourceRelationState` reports syncConclusion
 *     null with write access refused and the identity still resolving.
 *   - 历史保留:  unlink+relink deletes NOTHING — the identity, the durable
 *     baseline row, the article versions and the media all stay; the lifecycle
 *     history shows the cancelled + relinked rows.
 *   - 重新关联不自动同步: relink only creates a PENDING link — no article
 *     version advances and no baseline is inherited (autoSynced=false).
 *   - 旧身份更新被拒绝且可度量: after unlink, an old-source write-back initiate
 *     is refused (`link-not-confirmed`) and `sourceRelationState` reports the
 *     refusal reason.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, save } from '@/lib/article-commands'
import { confirmSourceLink } from '@/lib/source-identity'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import { normalizeTitle } from '@/lib/source-sync'
import { SOURCE_CONFLICT_DDL_STATEMENTS } from '@/lib/source-conflict'
import { probeConflict } from '@/lib/source-conflict'
import { MockWritableSource } from '@/lib/source-conflict'
import { initiateWriteBack } from '@/lib/source-writeback'
import type { SourceWriteProvider } from '@/lib/source-writeback'
import {
  relinkSourceToArticle,
  sourceRelationState,
  unlinkSourceFromArticle,
} from '@/lib/source-relink'
import {
  bootstrapRevisionState,
  createDatabase,
  query,
} from '@/tests/lib/publish-revision/helpers'
import { teardownState } from '@/tests/lib/article-commands/helpers'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b606-relink-'))
  cleanup.push(state)
  await bootstrapRevisionState(state)
  // Miniflare-only accommodation: the ledger FTS triggers corrupt the DB on
  // markdown-image parens — a workerd/Miniflare bug absent in real D1 (see
  // the B6-04 tests). FTS is irrelevant to the relink surface.
  await query('DROP TRIGGER IF EXISTS posts_ai')
  await query('DROP TRIGGER IF EXISTS posts_au')
  await query('DROP TRIGGER IF EXISTS posts_ad')
  await query('DROP TABLE IF EXISTS posts_fts')
  for (const stmt of SOURCE_IDENTITY_DDL_STATEMENTS) await query(stmt)
  for (const stmt of SOURCE_CONFLICT_DDL_STATEMENTS) await query(stmt)
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

const HERO_REF = 'assets/hero.png'

function baseSource() {
  return {
    title: '源稿标题',
    markdown: `![主图](${HERO_REF})\n\n原正文段落`,
    media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }],
  }
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title: '标题',
    content: '# 标题\n\n正文。',
    html: '<h1>标题</h1><p>正文。</p>',
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

interface Seeded {
  db: ReturnType<typeof createDatabase>
  articleId: number
  postRef: number
  sourceIdentityId: number
  url: string
  provider: MockWritableSource
}

/** Create a published-link draft whose v1 matches the source, and seed the baseline. */
async function seed(options: { baseline?: boolean } = {}): Promise<Seeded> {
  const db = createDatabase()
  const content = baseSource()
  const provider = new MockWritableSource(content)
  provider.setMediaBytes(HERO_REF, Buffer.from(`bytes:${HERO_REF}:${fresh('s')}`, 'utf8'))
  const url = `https://src.example.test/relink/${fresh('u')}`
  const rewritten = provider.currentRewrittenMarkdown()
  const created = await create(db, {
    creationId: fresh('c'),
    snapshot: snapshot({ title: content.title, content: rewritten }),
    source: { url },
  })
  expect(created.outcome).toBe('created')
  if (created.outcome !== 'created') throw new Error('seed: create failed')
  const link = created.source!.link!
  expect(link.status).toBe('pending')
  const confirmed = await confirmSourceLink(db, {
    sourceIdentityId: link.sourceIdentityId,
    articleId: created.articleId,
    operationId: fresh('conf'),
    expectedStatus: 'pending',
  })
  expect(confirmed.outcome).toBe('confirmed')

  if (options.baseline ?? true) {
    const sha = provider.currentFingerprint()
    const now = Math.floor(Date.now() / 1000)
    await db
      .prepare(
        `INSERT INTO source_sync_baselines
           (source_identity_id, article_id, article_version, source_sync_sha256, baseline_sha256,
            synced_version, synced_revision_id, synced_title, synced_markdown, synced_html,
            synced_media_json, updated_at)
         VALUES (?, ?, 1, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        link.sourceIdentityId,
        created.articleId,
        sha,
        sha,
        normalizeTitle(content.title),
        rewritten,
        rewritten,
        JSON.stringify(provider.baselineMediaFacts()),
        now,
      )
      .run()
  }

  return {
    db,
    articleId: created.articleId,
    postRef: created.postRef,
    sourceIdentityId: link.sourceIdentityId,
    url,
    provider,
  }
}

async function linkRows(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_source_links WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

async function identityCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM source_identities'))[0]?.n ?? 0
}

async function baselineCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM source_sync_baselines'))[0]?.n ?? 0
}

async function versionCount(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

/* ------------------------------------------------------------------ */
/* 解除幂等                                                             */
/* ------------------------------------------------------------------ */

describe('unlinkSourceFromArticle — 解除幂等', { timeout: 120_000 }, () => {
  it('unlinks a confirmed link and replay of the same operation is a no-op', async () => {
    const s = await seed()
    const op = fresh('unlink');

    const first = await unlinkSourceFromArticle(s.db, { operationId: op, sourceUrl: s.url, articleId: s.articleId })
    expect(first.outcome).toBe('unlinked')
    if (first.outcome !== 'unlinked') return
    expect(first.link.status).toBe('cancelled')
    expect(first.link.operationId).toBe(op) // the unlink op is recorded on the row
    expect(first.conclusion).toBeNull() // 解除后同步结论为空
    expect(first.baselinePreserved).toBe(true)

    const rowsAfter = await linkRows(s.articleId)
    const identsAfter = await identityCount()
    const baseAfter = await baselineCount()

    // Same operation replayed → original cancellation, zero new rows.
    const again = await unlinkSourceFromArticle(s.db, { operationId: op, sourceUrl: s.url, articleId: s.articleId })
    expect(again.outcome).toBe('replayed')
    if (again.outcome !== 'replayed') return
    expect(again.link.status).toBe('cancelled')
    expect(again.link.id).toBe(first.link.id)

    expect(await linkRows(s.articleId)).toBe(rowsAfter)
    expect(await identityCount()).toBe(identsAfter)
    expect(await baselineCount()).toBe(baseAfter)

    // A DIFFERENT operation over the already-cancelled pair is a no-op refusal.
    const later = await unlinkSourceFromArticle(s.db, { operationId: fresh('unlink2'), sourceUrl: s.url, articleId: s.articleId })
    expect(later.outcome).toBe('not-linked')
    expect(await linkRows(s.articleId)).toBe(rowsAfter)
    expect(await identityCount()).toBe(identsAfter)
  }, 60_000)

  it('unlinks a PENDING (never-confirmed) link too', async () => {
    const db = createDatabase()
    const url = `https://src.example.test/relink/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '待确认' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    const op = fresh('unlink')
    const unlinked = await unlinkSourceFromArticle(db, {
      operationId: op,
      sourceUrl: url,
      articleId: created.articleId,
    })
    expect(unlinked.outcome).toBe('unlinked')
    if (unlinked.outcome !== 'unlinked') return
    expect(unlinked.link.status).toBe('cancelled')
    // never synced → no baseline row to preserve, so baselinePreserved is false
    expect(unlinked.baselinePreserved).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 重链幂等                                                             */
/* ------------------------------------------------------------------ */

describe('relinkSourceToArticle — 重链幂等 (走 #50 身份链)', { timeout: 120_000 }, () => {
  it('relink creates a new pending link; replay is a no-op; live link refuses', async () => {
    const s = await seed()
    const unlinkOp = fresh('unlink')
    const first = await unlinkSourceFromArticle(s.db, { operationId: unlinkOp, sourceUrl: s.url, articleId: s.articleId })
    expect(first.outcome).toBe('unlinked')
    if (first.outcome !== 'unlinked') return
    expect(await linkRows(s.articleId)).toBe(1) // only the cancelled row so far

    const op = fresh('relink')
    const relinked = await relinkSourceToArticle(s.db, { operationId: op, sourceUrl: s.url, articleId: s.articleId })
    expect(relinked.outcome).toBe('relinked')
    if (relinked.outcome !== 'relinked') return
    expect(relinked.link.status).toBe('pending')
    expect(relinked.link.operationId).toBe(op)
    expect(relinked.link.sourceIdentityId).toBe(s.sourceIdentityId) // SAME identity (same URL)
    expect(relinked.autoSynced).toBe(false) // 重新关联不自动同步
    expect(relinked.baselineInherited).toBe(false) // 新关系不沿用旧基线
    expect(relinked.priorLink?.status).toBe('cancelled') // termination history retained
    expect(await linkRows(s.articleId)).toBe(2) // cancelled + new pending

    const before = await linkRows(s.articleId)

    // Same operation replayed → original pending link, zero new rows.
    const replay = await relinkSourceToArticle(s.db, { operationId: op, sourceUrl: s.url, articleId: s.articleId })
    expect(replay.outcome).toBe('replayed')
    if (replay.outcome !== 'replayed') return
    expect(replay.link.id).toBe(relinked.link.id)
    expect(await linkRows(s.articleId)).toBe(before)

    // A DIFFERENT operation while a live link exists → already-linked (必须先解除).
    const whileLive = await relinkSourceToArticle(s.db, { operationId: fresh('relink2'), sourceUrl: s.url, articleId: s.articleId })
    expect(whileLive.outcome).toBe('already-linked')
    if (whileLive.outcome !== 'already-linked') return
    expect(whileLive.link.status).toBe('pending')
    expect(await linkRows(s.articleId)).toBe(before)
  }, 60_000)

  it('relink maintains full termination + re-link history (历史保留)', async () => {
    const s = await seed()
    await unlinkSourceFromArticle(s.db, { operationId: fresh('unlink'), sourceUrl: s.url, articleId: s.articleId })
    await relinkSourceToArticle(s.db, { operationId: fresh('relink'), sourceUrl: s.url, articleId: s.articleId })

    const history = await sourceRelationState(s.db, { sourceUrl: s.url, articleId: s.articleId })
    // The B6-01 lifecycle transitions in-place on one row, so the retained
    // termination history is the cancelled row + the new pending row.
    expect(history.history.map((h) => h.status)).toEqual(['cancelled', 'pending'])
    expect(history.sourceIdentity?.id).toBe(s.sourceIdentityId) // identity preserved
    expect(history.baseline?.exists).toBe(true) // baseline row preserved
  })
})

/* ------------------------------------------------------------------ */
/* 解除后 sync 结论为空 + 旧身份更新被拒绝且可度量                        */
/* ------------------------------------------------------------------ */

describe('解除后 sync 结论为空 · 旧身份更新被拒绝', { timeout: 120_000 }, () => {
  it('probeConflict derives NO conclusion after unlink (not-linked)', async () => {
    const s = await seed({ baseline: true })
    // Before unlink the pair is probe-able and synced.
    const before = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(before.outcome).toBe('probed')
    if (before.outcome !== 'probed') return
    expect(before.state).toBe('synced')

    await unlinkSourceFromArticle(s.db, { operationId: fresh('unlink'), sourceUrl: s.url, articleId: s.articleId })

    // After unlink there is no live link → no sync conclusion is derivable.
    const after = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(after.outcome).toBe('not-linked')

    // The B6-06 relationship-level surface reports an EMPTY sync conclusion.
    const state = await sourceRelationState(s.db, { sourceUrl: s.url, articleId: s.articleId })
    expect(state.liveStatus).toBe('none')
    expect(state.syncConclusion).toBeNull()
    expect(state.conclusionReason).toBe('unlinked')
    expect(state.writeAccess).toEqual({ allowed: false, reason: 'unlinked' })
    expect(state.sourceIdentity?.id).toBe(s.sourceIdentityId) // identity still resolves
  }, 60_000)

  it('an old-source write-back is refused after unlink (旧身份更新被拒绝且可度量)', async () => {
    const s = await seed({ baseline: true })
    // Bump the article past the baseline so the write-back WOULD be a write.
    const saved = await save(s.db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: 'Blogman 领先' }),
    })
    expect(saved.outcome).toBe('applied')
    const provider: SourceWriteProvider = {
      pushWriteBack: async () => ({ externalRef: 'x', sourceSyncSha256: 'b'.repeat(64) }),
      readSourceHash: async () => 'c'.repeat(64),
    }
    await unlinkSourceFromArticle(s.db, { operationId: fresh('unlink'), sourceUrl: s.url, articleId: s.articleId })

    const initiated = await initiateWriteBack(s.db, provider, {
      sourceIdentityId: s.sourceIdentityId,
      articleId: s.articleId,
      operationId: fresh('wb'),
    })
    // A cancelled link is not a confirmed link → the write-back is refused.
    expect(initiated.outcome).toBe('link-not-confirmed')
  })
})

/* ------------------------------------------------------------------ */
/* 重新关联不自动同步 · 历史保留                                        */
/* ------------------------------------------------------------------ */

describe('重新关联不自动同步 · 不删身份/基线', { timeout: 120_000 }, () => {
  it('relink does not advance the article version or inherit the baseline', async () => {
    const s = await seed({ baseline: true })
    const versionsBefore = await versionCount(s.articleId)
    const baseBefore = await baselineCount()
    const identitiesBefore = await identityCount()

    await unlinkSourceFromArticle(s.db, { operationId: fresh('unlink'), sourceUrl: s.url, articleId: s.articleId })
    const relinked = await relinkSourceToArticle(s.db, { operationId: fresh('relink'), sourceUrl: s.url, articleId: s.articleId })
    expect(relinked.outcome).toBe('relinked')
    if (relinked.outcome !== 'relinked') return
    expect(relinked.autoSynced).toBe(false)

    // No article version written, no new baseline row, identity/baseline intact.
    expect(await versionCount(s.articleId)).toBe(versionsBefore)
    expect(await baselineCount()).toBe(baseBefore)
    expect(await identityCount()).toBe(identitiesBefore)

    // The relinked state has a live pending link + retained baseline, but the
    // relationship-level conclusion stays empty until an explicit sync.
    const state = await sourceRelationState(s.db, { sourceUrl: s.url, articleId: s.articleId })
    expect(state.liveStatus).toBe('pending')
    expect(state.baseline?.exists).toBe(true)
    expect(state.syncConclusion).toBeNull()
    expect(state.writeAccess).toEqual({ allowed: false, reason: 'pending-link' })
  }, 60_000)
})
