/**
 * B6-04 — 明确选边解决主要源稿内容冲突 kernel tests (issue #53).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns) + the unified in-memory writable-source mock (both the read and the
 * write provider faces over ONE source state). Proves the ticket's acceptance
 * surface:
 *
 *   - 双方偏离检测:  synced / source-ahead / blogman-ahead / conflict, all
 *     DERIVED from both projections vs the baseline (no helper status label),
 *   - diff 完整性:   标题/正文/媒体 diff (added/removed/changed/same) with
 *     baseline + current hashes and asset URLs,
 *   - 选边各路径:    选源稿 (先建恢复点再走版本内核 — draft 写新版本 / formal 只
 *     更新待发布修订) and 选 Blogman (B6-03 风格 intent → written → confirmed,
 *     确认前不推进基线),
 *   - 无自动合并:    probe 只读不写; 任一方变化使旧选择过期; 迟到确认被拒绝;
 *     重复操作幂等回放; 媒体差异/失败路径.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, save } from '@/lib/article-commands'
import { confirmSourceLink, linkSourceToArticle, resolveSourceUrl } from '@/lib/source-identity'
import { SOURCE_IDENTITY_DDL_STATEMENTS, type SourceLink } from '@/lib/source-identity'
import { MockMediaStore, normalizeTitle, type SourceContent } from '@/lib/source-sync'
import { SOURCE_CONFLICT_DDL_STATEMENTS } from '@/lib/source-conflict'
import {
  confirmConflictWriteBack,
  conflictResolutionByOperation,
  executeConflictWriteBack,
  probeConflict,
  resolveConflictSide,
} from '@/lib/source-conflict'
import { MockWritableSource } from '@/lib/source-conflict'
import {
  bootstrapRevisionState,
  createDatabase,
  createFormalArticle,
  query,
} from '@/tests/lib/publish-revision/helpers'
import { teardownState } from '@/tests/lib/article-commands/helpers'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b604-conflict-'))
  cleanup.push(state)
  await bootstrapRevisionState(state)
  // Miniflare-only accommodation: the ledger's FTS external-content triggers
  // corrupt the DB on content containing markdown-image parens (`](`) — a
  // workerd/Miniflare bug, absent in real Cloudflare D1. FTS is a search
  // projection irrelevant to the conflict surface, so it is dropped here.
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

function baseSource(): SourceContent {
  return {
    title: '源稿标题',
    markdown: `![主图](${HERO_REF})\n\n原正文段落`,
    media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }],
  }
}

function snap(content: string, title: string, overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title,
    content,
    html: `<div>${content}</div>`,
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

function makeSource(content: SourceContent = baseSource(), salt = fresh('s')): MockWritableSource {
  const mock = new MockWritableSource(content)
  for (const m of content.media) {
    mock.setMediaBytes(m.ref, Buffer.from(`bytes:${m.ref}:${salt}`, 'utf8'))
  }
  return mock
}

interface Seeded {
  db: ReturnType<typeof createDatabase>
  articleId: number
  postRef: number
  sourceIdentityId: number
  url: string
  provider: MockWritableSource
  mediaStore: MockMediaStore
  token: { version: number; revisionId: string | null }
}

/**
 * Create a draft whose v1 content equals the source's current projection and
 * seed the confirmed baseline at (article_version=1, source fingerprint).
 */
async function seedBaseline(opts: { source?: SourceContent } = {}): Promise<Seeded> {
  const db = createDatabase()
  const content = opts.source ?? baseSource()
  const provider = makeSource(content)
  const mediaStore = new MockMediaStore()
  const url = `https://src.example.test/conflict/${fresh('u')}`
  const rewritten = provider.currentRewrittenMarkdown()
  const created = await create(db, {
    creationId: fresh('c'),
    snapshot: snap(rewritten, content.title),
    source: { url },
  })
  expect(created.outcome).toBe('created')
  if (created.outcome !== 'created') throw new Error('seed: create failed')
  const link = created.source?.link as SourceLink
  expect(link?.status).toBe('pending')
  const confirmed = await confirmSourceLink(db, {
    sourceIdentityId: link.sourceIdentityId,
    articleId: created.articleId,
    operationId: fresh('conf'),
    expectedStatus: 'pending',
  })
  expect(confirmed.outcome).toBe('confirmed')
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
  return {
    db,
    articleId: created.articleId,
    postRef: created.postRef,
    sourceIdentityId: link.sourceIdentityId,
    url,
    provider,
    mediaStore,
    token: { version: 1, revisionId: null },
  }
}

async function baselineRow(db: ReturnType<typeof createDatabase>, articleId: number) {
  return (
    await query<{
      article_version: number | null
      source_sync_sha256: string | null
      baseline_sha256: string | null
      synced_version: number | null
      synced_title: string | null
      synced_media_json: string | null
    }>(`SELECT article_version, source_sync_sha256, baseline_sha256, synced_version, synced_title, synced_media_json
        FROM source_sync_baselines WHERE article_id = ${articleId}`)
  )[0] ?? null
}

async function versionCount(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

async function resolutionRows(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_conflict_resolutions WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

async function intentRows(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_write_back_intents WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

/** Draft conflict fixture: baseline v1 = C0; blogman at v2 (C1); source = C2. */
async function seedConflict(): Promise<Seeded & { opId: string }> {
  const s = await seedBaseline()
  const saved = await save(s.db, {
    articleId: s.articleId,
    expectedVersion: 1,
    operationId: fresh('save'),
    snapshot: snap('![主图](/api/images/old-sha)\n\nBlogman 领先正文', 'Blogman 标题'),
  })
  expect(saved.outcome).toBe('applied')
  if (saved.outcome !== 'applied') throw new Error('seedConflict: blogman save failed')
  // Source moves past the baseline too — BOTH sides must deviate for a conflict.
  s.provider.setContent({
    title: '源稿改标题',
    markdown: `![主图](${HERO_REF})\n\n源稿新段落`,
    media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }],
  })
  return { ...s, token: { version: 2, revisionId: null }, opId: fresh('res') }
}

/* ------------------------------------------------------------------ */
/* 双方偏离检测                                                         */
/* ------------------------------------------------------------------ */


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

describe('probeConflict — 双方偏离检测 (derive, never store a status label)', { timeout: 120_000 }, () => {
  it('synced: neither side moved past the baseline', async () => {
    const s = await seedBaseline()
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('synced')
    expect(probe.conflict).toBe(false)
    expect(probe.sourceChanged).toBe(false)
    expect(probe.blogmanChanged).toBe(false)
  }, 60_000)

  it('source-ahead: only the source moved past the baseline', async () => {
    const s = await seedBaseline()
    s.provider.setContent({ ...baseSource(), markdown: '![主图](assets/hero.png)\n\n源稿侧新段落' })
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('source-ahead')
    expect(probe.conflict).toBe(false)
    expect(probe.sourceChanged).toBe(true)
    expect(probe.blogmanChanged).toBe(false)
  }, 60_000)

  it('blogman-ahead: only Blogman moved past the baseline', async () => {
    const s = await seedBaseline()
    await save(s.db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snap('Blogman 新正文', 'Blogman 标题'),
    })
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('blogman-ahead')
    expect(probe.conflict).toBe(false)
    expect(probe.sourceChanged).toBe(false)
    expect(probe.blogmanChanged).toBe(true)
  }, 60_000)

  it('conflict: BOTH sides moved past the baseline (paused)', async () => {
    const c = await seedConflict()
    const probe = await probeConflict(c.db, c.provider, { sourceUrl: c.url, articleId: c.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('conflict')
    expect(probe.conflict).toBe(true)
    expect(probe.sourceChanged).toBe(true)
    expect(probe.blogmanChanged).toBe(true)
  }, 60_000)

  it('unreadable: no conclusion is derived when the source cannot be read', async () => {
    const s = await seedBaseline()
    s.provider.failNextRead()
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('unreadable')
  }, 60_000)

  it('no-baseline: conflict cannot be derived without a confirmed baseline', async () => {
    const db = createDatabase()
    const provider = makeSource()
    const url = `https://src.example.test/conflict/${fresh('nb')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snap('正文', '标题'),
      source: { url },
    })
    if (created.outcome !== 'created') return
    const probe = await probeConflict(db, provider, { sourceUrl: url, articleId: created.articleId })
    expect(probe.outcome).toBe('no-baseline')
  }, 60_000)

  it('probe writes NOTHING — 无自动合并 (read-only derivation)', async () => {
    const s = await seedConflict()
    const counts = {
      versions: await versionCount(s.articleId),
      resolutions: await resolutionRows(s.articleId),
      intents: await intentRows(s.articleId),
      baselines: (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_sync_baselines WHERE article_id = ${s.articleId}`))[0].n,
      media: (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_assets`))[0].n,
      mappings: (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_media_mappings`))[0].n,
    }
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('conflict')
    expect(await versionCount(s.articleId)).toBe(counts.versions)
    expect(await resolutionRows(s.articleId)).toBe(counts.resolutions)
    expect(await intentRows(s.articleId)).toBe(counts.intents)
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_sync_baselines WHERE article_id = ${s.articleId}`))[0].n).toBe(counts.baselines)
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_assets`))[0].n).toBe(counts.media)
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_media_mappings`))[0].n).toBe(counts.mappings)
  }, 60_000)
})

/* ------------------------------------------------------------------ */
/* diff 完整性                                                          */
/* ------------------------------------------------------------------ */

describe('probeConflict — diff 投影完整性 (标题/正文/媒体)', { timeout: 120_000 }, () => {
  it('title + body diffs carry baseline vs current values for both sides', async () => {
    const s = await seedBaseline()
    await save(s.db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snap('![主图](/api/images/old-sha)\n\nBlogman 领先正文', 'Blogman 标题'),
    })
    s.provider.setContent({
      title: '源稿改标题',
      markdown: `![主图](${HERO_REF})\n\n源稿新段落`,
      media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }],
    })
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('conflict')
    expect(probe.diff.source.title.changed).toBe(true)
    expect(probe.diff.source.title.baseline).toBe('源稿标题')
    expect(probe.diff.source.title.current).toBe('源稿改标题')
    expect(probe.diff.source.bodyChanged).toBe(true)
    expect(probe.diff.source.body.some((t) => t.type === 'added')).toBe(true)
    expect(probe.diff.source.body.some((t) => t.type === 'removed')).toBe(true)
    // Blogman side: title changed, body changed vs baseline.
    expect(probe.diff.blogman.title.changed).toBe(true)
    expect(probe.diff.blogman.title.current).toBe('Blogman 标题')
    expect(probe.diff.blogman.bodyChanged).toBe(true)
  }, 60_000)

  it('media added/removed/changed/same with hashes + asset URLs', async () => {
    // Baseline holds hero@v1 + keep@v1.
    const source = {
      title: '源稿标题',
      markdown: `![主图](${HERO_REF})\n\n![保留](assets/keep.png)\n\n正文`,
      media: [
        { ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' },
        { ref: 'assets/keep.png', contentType: 'image/png', filename: 'keep.png' },
      ],
    }
    const s = await seedBaseline({ source })
    // Blogman moves to v2 (content differs).
    await save(s.db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snap('![主图](/api/images/old-sha)\n\nBlogman 新正文', 'Blogman 标题'),
    })
    // Source: hero bytes CHANGE, keep stays, a new ref is ADDED.
    s.provider.setMediaBytes(HERO_REF, Buffer.from('bytes-hero-v2', 'utf8'))
    s.provider.setMediaBytes('assets/new.png', Buffer.from('bytes-new', 'utf8'))
    s.provider.setContent({
      title: '源稿标题',
      markdown: `![主图](${HERO_REF})\n\n![保留](assets/keep.png)\n\n![新图](assets/new.png)\n\n新正文`,
      media: [
        { ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' },
        { ref: 'assets/keep.png', contentType: 'image/png', filename: 'keep.png' },
        { ref: 'assets/new.png', contentType: 'image/png', filename: 'new.png' },
      ],
    })

    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('conflict')
    const byRef = new Map(probe.diff.source.media.map((m) => [m.ref, m]))
    expect(byRef.get(HERO_REF)?.change).toBe('changed')
    expect(byRef.get(HERO_REF)?.baselineSha256).toBeTruthy()
    expect(byRef.get(HERO_REF)?.currentSha256).not.toBe(byRef.get(HERO_REF)?.baselineSha256)
    expect(byRef.get('assets/keep.png')?.change).toBe('same')
    expect(byRef.get('assets/keep.png')?.baselineSha256).toBe(byRef.get('assets/keep.png')?.currentSha256)
    expect(byRef.get('assets/new.png')?.change).toBe('added')
    expect(byRef.get('assets/new.png')?.assetUrl).toMatch(/^\/api\/images\/source-media\/[0-9a-f]{64}$/)
    expect(probe.diff.source.mediaChanged).toBe(true)
  }, 60_000)

  it('media-only source change (bytes change, same refs) still flips the fingerprint', async () => {
    const s = await seedBaseline()
    await save(s.db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snap('Blogman 领先', 'Blogman 标题'),
    })
    // Only the hero bytes change — same ref names, different content identity.
    s.provider.setMediaBytes(HERO_REF, Buffer.from('bytes-hero-v2', 'utf8'))
    const probe = await probeConflict(s.db, s.provider, { sourceUrl: s.url, articleId: s.articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('conflict')
    const hero = probe.diff.source.media.find((m) => m.ref === HERO_REF)
    expect(hero?.change).toBe('changed')
  }, 60_000)
})

/* ------------------------------------------------------------------ */
/* 选源稿 — 先建恢复点, 再走版本内核                                      */
/* ------------------------------------------------------------------ */

describe('resolveConflictSide — 选源稿 (draft 写新版本)', { timeout: 120_000 }, () => {
  it('saves a restore point, writes the chosen source via the version kernel, advances the baseline', async () => {
    const c = await seedConflict()
    const res = await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'source',
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    expect(res.outcome).toBe('resolved-source')
    if (res.outcome !== 'resolved-source') return
    expect(res.version).toBe(3)
    expect(res.baselineSha256).toBe(c.provider.currentFingerprint())
    // Media materialised: one asset + mapping + R2 object.
    expect(res.media).toHaveLength(1)
    expect(res.media[0].reused).toBe(false)
    expect(c.mediaStore.objectCount).toBe(1)
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_assets`))[0].n).toBe(1)
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_media_mappings`))[0].n).toBe(1)

    // 恢复点 captured (draft: pre-resolution snapshot + versioned history).
    const rp = (await conflictResolutionByOperation(c.db, c.opId))!
    expect(rp.status).toBe('applied')
    const pre = JSON.parse(rp.preResolutionSnapshotJson) as { title: string; content: string }
    expect(pre.title).toBe('Blogman 标题')
    expect(pre.content).toContain('Blogman 领先正文')
    // The pre-resolution v2 is still recoverable in article_versions history.
    expect(await versionCount(c.articleId)).toBe(3)

    // 版本内核 wrote the chosen source content (refs rewritten to asset URLs).
    const post = await canonFields(c.postRef)
    expect(post.title).toBe('源稿改标题')
    expect(post.content).toContain('/api/images/source-media/')
    expect(post.content).not.toContain(HERO_REF)

    // Baseline advanced → recompute → synced (both sides back on the baseline).
    const base = await baselineRow(c.db, c.articleId)
    expect(base?.article_version).toBe(3)
    expect(base?.baseline_sha256).toBe(c.provider.currentFingerprint())
    const after = await probeConflict(c.db, c.provider, { sourceUrl: c.url, articleId: c.articleId })
    expect(after.outcome).toBe('probed')
    if (after.outcome === 'probed') expect(after.state).toBe('synced')
  }, 60_000)

  it('duplicate operation id replays with zero new writes (重复操作幂等)', async () => {
    const c = await seedConflict()
    const input = {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'source' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    }
    const first = await resolveConflictSide(c.db, input)
    expect(first.outcome).toBe('resolved-source')
    if (first.outcome !== 'resolved-source') return
    const versionsAfterFirst = await versionCount(c.articleId)
    const mediaAfterFirst = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_assets`))[0].n
    const replay = await resolveConflictSide(c.db, input)
    expect(replay.outcome).toBe('replayed')
    expect(await versionCount(c.articleId)).toBe(versionsAfterFirst)
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_assets`))[0].n).toBe(mediaAfterFirst)
    expect(await resolutionRows(c.articleId)).toBe(1)
  }, 60_000)

  it('a source change between attempts expires the retry of an open resolution (任一方变化使旧选择过期)', async () => {
    const s = await seedBaseline()
    await save(s.db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snap('Blogman 领先', 'Blogman 标题'),
    })
    // Source diverges → conflict.
    s.provider.setContent({ title: '源稿改标题', markdown: `![主图](${HERO_REF})\n\n源稿新段落`, media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }] })
    const opId = fresh('res')
    const input = {
      sourceUrl: s.url,
      articleId: s.articleId,
      chosenSide: 'source' as const,
      expectedVersion: 2,
      operationId: opId,
      actor: 'test-author',
      provider: s.provider,
      mediaStore: s.mediaStore,
      writeProvider: s.provider,
    }
    // First attempt: the R2 put fails during materialisation → open resolution,
    // nothing written (partial-media failure, 不产生半同步).
    const heroSha = s.provider.baselineMediaFacts().find((m) => m.ref === HERO_REF)!.contentSha256
    s.mediaStore.putFail(`source-media/${heroSha}`)
    const first = await resolveConflictSide(s.db, input)
    expect(first.outcome).toBe('media-failed')
    expect((await conflictResolutionByOperation(s.db, opId))?.status).toBe('open')
    expect(await versionCount(s.articleId)).toBe(2)
    // The source changes again before the retry — the old choice is now expired.
    s.provider.setContent({ title: '源稿再改', markdown: `![主图](${HERO_REF})\n\n再改内容`, media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }] })
    const retry = await resolveConflictSide(s.db, input)
    expect(retry.outcome).toBe('stale-choice')
    if (retry.outcome === 'stale-choice') expect(retry.reason).toBe('source-changed')
    expect((await conflictResolutionByOperation(s.db, opId))?.status).toBe('expired')
    expect(await versionCount(s.articleId)).toBe(2) // nothing overwritten
  }, 60_000)

  it('a stale expectedVersion refuses before any write (旧写入不能覆盖新内容)', async () => {
    const c = await seedConflict()
    const res = await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'source' as const,
      expectedVersion: 1, // stale — blogman is already at 2
      operationId: fresh('res'),
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    expect(res.outcome).toBe('version-moved')
    if (res.outcome === 'version-moved') expect(res.serverVersion).toBe(2)
    expect(await versionCount(c.articleId)).toBe(2) // nothing written
    expect((await baselineRow(c.db, c.articleId))?.article_version ?? 1).toBe(1) // baseline unchanged
  }, 60_000)

  it('a source that is not in conflict refuses the resolution (no false pick)', async () => {
    const s = await seedBaseline() // synced
    const res = await resolveConflictSide(s.db, {
      sourceUrl: s.url,
      articleId: s.articleId,
      chosenSide: 'source' as const,
      expectedVersion: 1,
      operationId: fresh('res'),
      actor: 'test-author',
      provider: s.provider,
      mediaStore: s.mediaStore,
      writeProvider: s.provider,
    })
    expect(res.outcome).toBe('not-conflict')
    expect(await resolutionRows(s.articleId)).toBe(0)
  }, 60_000)
})

/* ------------------------------------------------------------------ */
/* 选 Blogman — 走 B6-03 显式写回确认                                    */
/* ------------------------------------------------------------------ */

describe('resolveConflictSide — 选 Blogman (确认前不推进基线, 迟到确认拒绝)', { timeout: 120_000 }, () => {
  it('intent → written → confirmed: only the external confirmation advances the baseline', async () => {
    const c = await seedConflict()
    const res = await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    expect(res.outcome).toBe('intent')
    if (res.outcome !== 'intent') return
    expect(res.intent.status).toBe('intent')
    expect(res.intent.articleVersion).toBe(2)
    expect(res.intent.baselineVersion).toBe(1)

    // 确认前不推进基线: execute alone must NOT move it.
    const executed = await executeConflictWriteBack(
      c.db,
      { read: c.provider, write: c.provider },
      { operationId: c.opId },
    )
    expect(executed.outcome).toBe('written')
    expect(c.provider.pushCount).toBe(1)
    let base = await baselineRow(c.db, c.articleId)
    expect(base?.article_version).toBe(1)

    // External confirmation — the ONLY baseline-advancing step.
    const confirmed = await confirmConflictWriteBack(
      c.db,
      { read: c.provider, write: c.provider },
      { operationId: c.opId },
    )
    expect(confirmed.outcome).toBe('confirmed')
    base = await baselineRow(c.db, c.articleId)
    expect(base?.article_version).toBe(2)
    expect(base?.source_sync_sha256).toBe(c.provider.currentFingerprint())
    expect(base?.synced_title).toBe('Blogman 标题')

    // Both sides now on the baseline → synced.
    const after = await probeConflict(c.db, c.provider, { sourceUrl: c.url, articleId: c.articleId })
    expect(after.outcome).toBe('probed')
    if (after.outcome === 'probed') expect(after.state).toBe('synced')
  }, 60_000)

  it('a lost response re-queries the same operation id without re-pushing (重复操作幂等)', async () => {
    const c = await seedConflict()
    await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    const first = await executeConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    expect(first.outcome).toBe('written')
    const pushes = c.provider.pushCount
    const again = await executeConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    expect(again.outcome).toBe('replayed')
    expect(c.provider.pushCount).toBe(pushes) // no second push
    // Re-resolve with the same operation id replays the original intent.
    const replay = await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    expect(replay.outcome).toBe('replayed')
  }, 60_000)

  it('a version change before execution expires the choice and never pushes (任一方变化使旧选择过期)', async () => {
    const c = await seedConflict()
    await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    // The author edits again BEFORE the write-back is executed.
    await save(c.db, {
      articleId: c.articleId,
      expectedVersion: 2,
      operationId: fresh('save2'),
      snapshot: snap('v3 内容', '新标题'),
    })
    const ex = await executeConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    expect(ex.outcome).toBe('stale')
    if (ex.outcome === 'stale') expect(ex.reason).toBe('version-changed')
    expect(c.provider.pushCount).toBe(0)
    expect((await conflictResolutionByOperation(c.db, c.opId))?.status).toBe('expired')
    expect((await baselineRow(c.db, c.articleId))?.article_version).toBe(1)
  }, 60_000)

  it('a source change before execution expires the choice (no blind overwrite of unseen source content)', async () => {
    const c = await seedConflict()
    await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    // The source changes AGAIN after the choice was recorded.
    c.provider.setContent({
      title: '第三次源稿',
      markdown: `![主图](${HERO_REF})\n\n第三次内容`,
      media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }],
    })
    const ex = await executeConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    expect(ex.outcome).toBe('stale')
    if (ex.outcome === 'stale') expect(ex.reason).toBe('source-changed')
    expect(c.provider.pushCount).toBe(0)
  }, 60_000)

  it('a late confirmation after the author edits is refused — 迟到确认 (baseline stays)', async () => {
    const c = await seedConflict()
    await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    await executeConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    // The external confirmation arrives LATE — after the author saved a new version.
    await save(c.db, {
      articleId: c.articleId,
      expectedVersion: 2,
      operationId: fresh('save2'),
      snapshot: snap('v3 内容', '新标题'),
    })
    const cf = await confirmConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    expect(cf.outcome).toBe('stale')
    if (cf.outcome === 'stale') expect(cf.reason).toBe('version-changed')
    // 确认前不推进基线 — and a stale confirm never moves it either.
    expect((await baselineRow(c.db, c.articleId))?.article_version).toBe(1)
    expect((await conflictResolutionByOperation(c.db, c.opId))?.status).toBe('expired')
  }, 60_000)

  it('confirms before a written push are refused (transition gate)', async () => {
    const c = await seedConflict()
    await resolveConflictSide(c.db, {
      sourceUrl: c.url,
      articleId: c.articleId,
      chosenSide: 'blogman' as const,
      expectedVersion: 2,
      operationId: c.opId,
      actor: 'test-author',
      provider: c.provider,
      mediaStore: c.mediaStore,
      writeProvider: c.provider,
    })
    const cf = await confirmConflictWriteBack(c.db, { read: c.provider, write: c.provider }, { operationId: c.opId })
    expect(cf.outcome).toBe('refused')
    expect((await baselineRow(c.db, c.articleId))?.article_version).toBe(1)
  }, 60_000)
})

/* ------------------------------------------------------------------ */
/* 恢复点 + 正式文章: 选择源稿只更新待发布修订                            */
/* ------------------------------------------------------------------ */

describe('选源稿 — 正式文章只更新待发布修订 (恢复点 + 线上版本保持)', { timeout: 120_000 }, () => {
  it('formal article: active revision carries the chosen source; live projection and version stay', async () => {
    const db = createDatabase()
    const { articleId, postRef } = await createFormalArticle(fresh('formal-slug'))
    const provider = makeSource()
    const mediaStore = new MockMediaStore()
    const url = `https://src.example.test/formal/${fresh('u')}`
    await linkSource(db, articleId, url)

    // Seed the baseline from the source's current content at article_version=1.
    const sha = provider.currentFingerprint()
    const rewritten = provider.currentRewrittenMarkdown()
    const identity = await sourceIdentityIdFor(db, url)
    await db
      .prepare(
        `INSERT INTO source_sync_baselines
           (source_identity_id, article_id, article_version, source_sync_sha256, baseline_sha256,
            synced_version, synced_revision_id, synced_title, synced_markdown, synced_html,
            synced_media_json, updated_at)
         VALUES (?, ?, 1, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        identity,
        articleId,
        sha,
        sha,
        normalizeTitle(baseSource().title),
        rewritten,
        rewritten,
        JSON.stringify(provider.baselineMediaFacts()),
        Math.floor(Date.now() / 1000),
      )
      .run()

    // Blogman's live editable content diverges via the ACTIVE REVISION (v1→2).
    const rev1 = await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snap('![主图](/api/images/x)\n\n修订侧正文', '修订标题'),
    })
    expect(rev1.outcome).toBe('applied')
    if (rev1.outcome !== 'applied') return

    // Source diverges too → conflict.
    provider.setContent({
      title: '源稿标题',
      markdown: `![主图](${HERO_REF})\n\n源稿新段落`,
      media: [{ ref: HERO_REF, contentType: 'image/png', filename: 'hero.png' }],
    })
    const probe = await probeConflict(db, provider, { sourceUrl: url, articleId })
    expect(probe.outcome).toBe('probed')
    if (probe.outcome !== 'probed') return
    expect(probe.state).toBe('conflict')

    // 选源稿: expectedVersion = the revision token the author saw (1).
    const res = await resolveConflictSide(db, {
      sourceUrl: url,
      articleId,
      chosenSide: 'source' as const,
      expectedVersion: 1,
      operationId: fresh('res'),
      actor: 'test-author',
      provider,
      mediaStore,
      writeProvider: provider,
    })
    expect(res.outcome).toBe('resolved-source')
    if (res.outcome !== 'resolved-source') return

    // 正式文章选择源稿只更新待发布修订 — the version kernel wrote the ACTIVE
    // revision, never a new article_versions row and never the live projection.
    expect(await versionCount(articleId)).toBe(1)
    const active = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`))[0].n
    expect(active).toBe(1)
    const lastRevision = (await query<{ revision_number: number; title: string }>(`SELECT revision_number, title FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active' ORDER BY revision_number DESC LIMIT 1`))[0]
    expect(lastRevision.revision_number).toBe(2)
    expect(lastRevision.title).toBe('源稿标题')

    // 恢复点: 先建恢复点 — a canonical pre-promotion snapshot was saved.
    const rp = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM publish_restore_points WHERE article_id = ${articleId} AND reason LIKE 'conflict-pick-source:%'`))[0].n
    expect(rp).toBe(1)

    // Live posts projection untouched (线上版本保持).
    const live = await canonFields(postRef)
    expect(live.title).toBe('正式文章标题')

    // Baseline advanced → re-derive → synced.
    const base = await baselineRow(db, articleId)
    expect(base?.article_version).toBe(2)
    const after = await probeConflict(db, provider, { sourceUrl: url, articleId })
    expect(after.outcome).toBe('probed')
    if (after.outcome === 'probed') expect(after.state).toBe('synced')
  }, 60_000)
})

/* ------------------------------------------------------------------ */
/* local helpers shared by the formal fixture above                    */
/* ------------------------------------------------------------------ */

async function linkSource(db: ReturnType<typeof createDatabase>, articleId: number, url: string): Promise<void> {
  const linked = await linkSourceToArticle(db, {
    operationId: fresh('link'),
    url,
    articleId,
  })
  expect(linked.outcome === 'applied' || linked.outcome === 'replayed').toBe(true)
  if (linked.outcome === 'applied') {
    const confirmed = await confirmSourceLink(db, {
      sourceIdentityId: linked.link.sourceIdentityId,
      articleId,
      operationId: fresh('conf'),
      expectedStatus: 'pending',
    })
    expect(confirmed.outcome).toBe('confirmed')
  }
}

async function sourceIdentityIdFor(db: ReturnType<typeof createDatabase>, url: string): Promise<number> {
  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') throw new Error('sourceIdentityIdFor: unresolved')
  return resolved.identity.id
}