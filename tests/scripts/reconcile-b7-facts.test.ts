/**
 * B7-G — batch-7 acceptance fixture tests (issue #59).
 *
 * Two layers:
 *
 *   A) SQL-seeded acceptance fixtures (wrangler-persisted states, the same
 *      channel the reconciler reads): a complete settled batch-7 fact state
 *      over the five clip-chain surfaces (身份 URL 规范化 / 关联 clip 链接 /
 *      比较确认刷新记录 / 来源快照 / 媒体身份复用) is ALIGNED when bound to the
 *      same immutable candidate, DRIFT on a candidate mismatch, and DRIFT with
 *      itemized messages when each surface is corrupted.
 *
 *   B) Real-kernel scenario coverage (in-process Miniflare persisting into the
 *      wrangler-addressable `v3/d1` layout): drive the REAL batch-7 kernels
 *      (clipArticle / proposeRefresh / confirmRefresh) through mock providers
 *      and then reconcile the resulting fact state ALIGNED:
 *      1. 全链闭环: 剪藏→提案→确认刷新→媒体内容复用, 对账 ALIGNED —
 *      2. 重复剪藏幂等: 同一 URL 剪藏两次收敛到同一文章 / 同一 clip 链接 —
 *      3. 比较/确认重放幂等: propose 与 confirm 各重放两次 只留一条事实, 对账
 *         连续两次 ALIGNED —
 *      4. 负向探针: 篡改真实内核的稳定提案 source snapshot → DRIFT。
 *
 * Zero production: every D1 access is local / tmpdir, the providers are
 * in-memory mocks, and the reconciler only issues read-only SELECT statements.
 * No full vitest run — this file is targeted independently.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CANDIDATE,
  applyB7Schema,
  cleanupB7State,
  clipDerivedIdentity,
  createKernelContext,
  createWranglerState,
  runReconcileB7,
  runD1,
  sha256,
} from '@/tests/scripts/reconcile-b7-helpers'
import { literal } from '@/tests/helpers/article-identity-state'
import { clipArticle } from '@/lib/clip'
import { proposeRefresh, confirmRefresh, snapshotFingerprint } from '@/lib/source-refresh'
import { MockMediaStore, MockSourceProvider, type SourceContent } from '@/lib/source-sync'

const T0 = 1_700_000_000
const URL = 'https://src.example.test/clip/a'
const HERO = 'assets/hero.png'

const reportDirs: string[] = []
const seedStates: string[] = []
let seedState: string | null = null

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b7-facts-report-'))
  reportDirs.push(dir)
  return dir + '/report.md'
}

function freshSeedState(): string {
  const state = createWranglerState()
  seedStates.push(state)
  return state
}

afterAll(async () => {
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const s of seedStates.splice(0)) rmSync(s, { recursive: true, force: true })
  await cleanupB7State()
})

/* ------------------------------------------------------------------ */
/* SQL-seeded complete fixture (five surfaces, settled)                */
/* ------------------------------------------------------------------ */

/** The frozen media fact and fingerprint of the settled fixture. */
function heroFact(assetUrl = ''): Record<string, unknown> {
  return {
    ref: HERO,
    contentType: 'image/png',
    filename: 'hero.png',
    contentSha256: sha256('hero-bytes'),
    assetUrl,
    reused: true,
    status: 'added',
  }
}

function fixtureFingerprint(): string {
  return snapshotFingerprint('新标题', '# 新正文', [heroFact()])
}

function fixtureDiff(fp: string): Record<string, unknown> {
  return {
    titleChanged: true,
    currentTitle: '旧标题',
    sourceTitle: '新标题',
    bodyChanged: true,
    currentContent: '# 旧正文',
    sourceMarkdown: '# 新正文',
    mediaChanged: true,
    media: [heroFact()],
    changed: true,
    sourceSnapshotSha256: fp,
  }
}

/**
 * The settled batch-7 fixture covering all five surfaces on ONE clip chain:
 *
 *   - 身份: one canonical identity (+ a merged URL variant) whose sha256 binds
 *     to the article's clip-derived draft_ref / slug.
 *   - 关联: one confirmed `clip`-role link (resolved_at set) — the ONLY live
 *     clip link for the identity.
 *   - 刷新记录: one confirmed proposal + one refreshed record bound to it.
 *   - 来源快照: the proposal / record snapshot fingerprint re-derives to the
 *     stored value.
 *   - 媒体身份复用: the frozen media fact maps to a content-identity asset.
 */
function seedB7Facts(state: string): void {
  const identitySha256 = sha256(URL)
  const derived = clipDerivedIdentity(URL)
  const fp = fixtureFingerprint()
  const mediaJson = JSON.stringify([heroFact()])
  const diffJson = JSON.stringify(fixtureDiff(fp))

  const rows = [
    // ---- article (draft) with clip-derived identity ----
    `INSERT INTO articles (id, post_ref, slug, draft_ref, created_at) VALUES
      (1, 1, ${literal(derived.slug)}, ${literal(derived.draftRef)}, ${T0})`,
    `INSERT INTO article_versions (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at) VALUES
      (1, 1, 'op:b7:v1', ${literal('{}')}, ${literal(sha256('b7-v1'))}, NULL),
      (1, 2, 'op:b7:v2', ${literal('{}')}, ${literal(sha256('b7-v2'))}, NULL)`,
    // ---- 身份 + URL 变体 ----
    `INSERT INTO source_identities (id, canonical_url, identity_sha256, created_at) VALUES
      (1, ${literal(URL)}, ${literal(identitySha256)}, ${T0})`,
    `INSERT INTO source_url_variants (id, source_identity_id, variant_canonical_url, merged_by_operation_id, created_at) VALUES
      (1, 1, ${literal('https://src.example.test/clip/a?ref=clip')}, ${literal('merge-b7')}, ${T0})`,
    // ---- 关联（clip 角色 confirmed，resolved_at 已设）----
    `INSERT INTO article_source_links
       (id, source_identity_id, article_id, status, role, operation_id, created_at, resolved_at) VALUES
      (1, 1, 1, 'confirmed', 'clip', ${literal('link-b7')}, ${T0}, ${T0})`,
    // ---- 比较/确认刷新记录（confirmed proposal + refreshed record）----
    `INSERT INTO source_refresh_proposals
       (operation_id, source_identity_id, article_id, post_ref, role, proposed_version,
        status, source_title, source_markdown, source_html, snapshot_sha256,
        diff_json, media_json, created_at)
     VALUES (${literal('propose-b7')}, 1, 1, 1, 'clip', 1, 'confirmed',
        '新标题', '# 新正文', '<h1>新正文</h1>', ${literal(fp)},
        ${literal(diffJson)}, ${literal(mediaJson)}, ${T0})`,
    `INSERT INTO source_refresh_records
       (operation_id, proposal_operation_id, source_identity_id, article_id, post_ref, role,
        outcome, reason, expected_version, applied_version, applied_revision_id,
        baseline_sha256, projection_json, media_json, diff_json, created_at)
     VALUES (${literal('confirm-b7')}, ${literal('propose-b7')}, 1, 1, 1, 'clip',
        'refreshed', NULL, 1, 2, NULL,
        ${literal(fp)}, ${literal('{"title":"新标题","markdown":"# 新正文","html":"<h1>新正文</h1>","snapshotSha256":"' + fp + '"}')},
        ${literal(mediaJson)}, ${literal(diffJson)}, ${T0})`,
    // ---- 媒体（内容身份寻址 + 复用）----
    `INSERT INTO media_assets
       (id, content_sha256, r2_key, media_type, filename, size, created_at) VALUES
      (1, ${literal(sha256('hero-bytes'))}, ${literal('source-media/' + sha256('hero-bytes'))}, 'image/png', 'hero.png', 10, ${T0})`,
    `INSERT INTO source_media_mappings (id, source_identity_id, source_ref, media_asset_id, created_at) VALUES
      (1, 1, ${literal(HERO)}, 1, ${T0})`,
  ]
  runD1(state, rows.join(';\n'))
}

function buildSeedState(): string {
  if (seedState) return seedState
  const state = freshSeedState()
  applyB7Schema(state)
  seedB7Facts(state)
  seedState = state
  return state
}

/* ------------------------------------------------------------------ */
/* Layer A — SQL-seeded acceptance fixtures                            */
/* ------------------------------------------------------------------ */

describe('reconcile-b7-facts (SQL-seeded acceptance fixture)', { timeout: 600_000 }, () => {
  it('reports ALIGNED on a complete batch-7 fact state bound to the same candidate', () => {
    const state = buildSeedState()
    const report = freshReport()
    const aligned = runReconcileB7(state, report, ['--candidate', CANDIDATE])
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('drift=0')
    expect(aligned.stdout).toContain('identities=1')
    expect(aligned.stdout).toContain('variants=1')
    expect(aligned.stdout).toContain('links=1')
    expect(aligned.stdout).toContain('proposals=1')
    expect(aligned.stdout).toContain('records=1')
    expect(aligned.stdout).toContain('mediaAssets=1')
    expect(aligned.stdout).toContain('mappings=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('ALIGNED')
    expect(text).toContain('五面剪藏链事实完整')
  })

  it('reports DRIFT with a single candidate item when the ledger candidate mismatches', () => {
    const state = buildSeedState()
    const report = freshReport()
    const drifted = runReconcileB7(state, report, ['--candidate', 'd'.repeat(40)])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    expect(drifted.stdout).toContain('drift=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('候选漂移')
  })

  it('is idempotent: running the reconciler twice over the same state stays ALIGNED', () => {
    const state = buildSeedState()
    const first = runReconcileB7(state, freshReport(), ['--candidate', CANDIDATE])
    expect(first.status, first.stdout || first.stderr).toBe(0)
    const second = runReconcileB7(state, freshReport(), ['--candidate', CANDIDATE])
    expect(second.status, second.stdout || second.stderr).toBe(0)
    expect(second.stdout).toContain('drift=0')
  })

  it('reports DRIFT with itemized items when each B7-G surface is corrupted', () => {
    const state = buildSeedState()

    // 1. 身份 — tamper identity_sha256 to break the canonical binding.
    runD1(state, `UPDATE source_identities SET identity_sha256 = '${'0'.repeat(64)}' WHERE id = 1`)
    // 2. 关联 — a clip article must carry the clip-derived draft identity.
    runD1(state, `UPDATE articles SET draft_ref = 'clip:not-derived' WHERE id = 1`)
    // 3. 刷新记录 — the record's baseline must equal its proposal's snapshot.
    runD1(state, `UPDATE source_refresh_records SET baseline_sha256 = '${'a'.repeat(64)}' WHERE operation_id = 'confirm-b7'`)
    // 4. 来源快照 — tamper the frozen proposal snapshot fingerprint.
    runD1(state, `UPDATE source_refresh_proposals SET snapshot_sha256 = '${'b'.repeat(64)}' WHERE operation_id = 'propose-b7'`)
    // 5. 媒体身份复用 — the frozen media fact maps to a missing asset.
    runD1(state, `UPDATE source_media_mappings SET media_asset_id = 999 WHERE id = 1`)

    const report = freshReport()
    const drifted = runReconcileB7(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('identity_sha256 与 canonical_url 不符')
    expect(text).toContain('draft_ref=')
    expect(text).toContain('baseline_sha256 != 提案')
    expect(text).toContain('来源快照指纹篡改')
    expect(text).toContain('映射指向不存在的资源')
  })
})

/* ------------------------------------------------------------------ */
/* Layer B — real-kernel scenario coverage                             */
/* ------------------------------------------------------------------ */

function baseContent(): SourceContent {
  return {
    title: '  刷新标题  ',
    markdown: `![主图](${HERO})\n\n刷新后的正文`,
    media: [{ ref: HERO, contentType: 'image/png', filename: 'hero.png' }],
  }
}

function providerFor(content: SourceContent): MockSourceProvider {
  const provider = new MockSourceProvider(content)
  for (const m of content.media) {
    provider.setMediaBytes(m.ref, Buffer.from(`bytes-${m.ref}`, 'utf8'))
  }
  return provider
}

describe('reconcile-b7-facts (real-kernel scenarios)', { timeout: 600_000 }, () => {
  it('全链闭环: 剪藏→提案(冻结)→确认(刷新草稿成新版本)→媒体身份复用, 对账 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const url = 'https://src.example.test/full/clip'
      const clipped = await clipArticle(db, { url, title: '剪藏标题', content: '# 剪藏正文' })
      expect(['created', 'existing', 'source-linked']).toContain(clipped.outcome)
      if (clipped.outcome === 'invalid-source' || clipped.outcome === 'skipped') {
        throw new Error(`clipArticle failed: ${JSON.stringify(clipped)}`)
      }
      const articleId = clipped.articleId

      // 提案 — freeze the refreshed source + media, NO article write.
      const proposed = await proposeRefresh(db, {
        sourceUrl: url,
        articleId,
        operationId: 'propose-a',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      expect(proposed.outcome).toBe('proposed')
      if (proposed.outcome === 'proposed') {
        expect(proposed.diff.changed).toBe(true)
        expect(proposed.proposedVersion).toBe(1)
      }

      // 确认 — five-surface loop lands a NEW draft version.
      const confirmed = await confirmRefresh(db, {
        sourceUrl: url,
        articleId,
        proposalOperationId: 'propose-a',
        expectedVersion: 1,
        operationId: 'confirm-a',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      expect(confirmed.outcome).toBe('refreshed')
      if (confirmed.outcome === 'refreshed') {
        expect(confirmed.version).toBe(2)
        expect(confirmed.revisionId).toBeNull()
      }

      // 重复剪藏同一 URL → 收敛到同一文章, 不建重复。
      const again = await clipArticle(db, { url, title: '重复剪藏', content: '# 重复' })
      expect(again.outcome).toBe('existing')
      if (again.outcome !== 'invalid-source') expect(again.articleId).toBe(articleId)

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB7(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('drift=0')
      expect(aligned.stdout).toContain('proposals=1')
      expect(aligned.stdout).toContain('records=1')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('比较/确认重放幂等: propose 与 confirm 各重放只留一条事实, 对账两次 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const url = 'https://src.example.test/replay/clip'
      const clipped = await clipArticle(db, { url, title: '剪藏标题', content: '# 剪藏正文' })
      if (clipped.outcome === 'invalid-source' || clipped.outcome === 'skipped') {
        throw new Error(`clipArticle failed: ${JSON.stringify(clipped)}`)
      }
      const articleId = clipped.articleId

      const propose = async () => proposeRefresh(db, {
        sourceUrl: url,
        articleId,
        operationId: 'propose-r',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      // First propose freezes; the replay returns the original proposal with
      // zero new rows (pending → replayed).
      await propose()
      const replayed = await propose()
      expect(['replayed', 'proposed']).toContain(replayed.outcome)

      const confirm = async () => confirmRefresh(db, {
        sourceUrl: url,
        articleId,
        proposalOperationId: 'propose-r',
        expectedVersion: 1,
        operationId: 'confirm-r',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      await confirm()
      // Confirm replay (ON CONFLICT DO NOTHING) must not duplicate the record.
      const reconfirm = await confirmRefresh(db, {
        sourceUrl: url,
        articleId,
        proposalOperationId: 'propose-r',
        expectedVersion: 1,
        operationId: 'confirm-r',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      expect(reconfirm.outcome).toBe('replayed')

      await ctx.dispose()
      // Idempotency: ONE proposal + ONE record survive the re-plays, and the
      // read-only reconciler itself is idempotent (twice → ALIGNED both times).
      const first = runReconcileB7(dir, freshReport(), ['--candidate', CANDIDATE])
      expect(first.status, first.stdout || first.stderr).toBe(0)
      expect(first.stdout).toContain('proposals=1')
      expect(first.stdout).toContain('records=1')
      expect(first.stdout).toContain('drift=0')
      const second = runReconcileB7(dir, freshReport(), ['--candidate', CANDIDATE])
      expect(second.status, second.stdout || second.stderr).toBe(0)
      expect(second.stdout).toContain('drift=0')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('正式文章刷新只形成修订; 负向探针: 篡改稳定提案快照必须 DRIFT', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const url = 'https://src.example.test/formal/clip'
      // Real clip path builds the clip article + clip link (clip never primary).
      const clipped = await clipArticle(db, { url, title: '剪藏标题', content: '# 剪藏正文' })
      if (clipped.outcome === 'invalid-source' || clipped.outcome === 'skipped') {
        throw new Error(`clipArticle failed: ${JSON.stringify(clipped)}`)
      }
      const articleId = clipped.articleId
      const slug = clipDerivedIdentity(url).slug

      // First-publish the clip DRAFT → a FORMAL article at version 1.
      const { preparePublish, confirmPublish } = await import('@/lib/first-publish')
      const hashRow = await db
        .prepare(`SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ? AND version = 1 ORDER BY id DESC LIMIT 1`)
        .bind(articleId).first<{ content_snapshot_sha256: string }>()
      const prepared = await preparePublish(db, {
        prepareId: 'prep-formal',
        articleId,
        confirmedVersion: 1,
        slug,
        title: '剪藏标题',
        contentSha256: hashRow?.content_snapshot_sha256 ?? '',
        actor: 'b7fixture',
      })
      expect(prepared.outcome).toBe('prepared')
      if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
      const published = await confirmPublish(db, {
        intentId: 'intent-formal',
        prepareId: prepared.prepareId,
        articleId,
        expectedVersion: 1,
        actor: 'b7fixture',
        siteUrl: 'https://blog.example.test',
      })
      expect(published.outcome).toBe('delivered')
      if (published.outcome !== 'delivered') throw new Error(`confirm failed: ${JSON.stringify(published)}`)

      // 提案 freezes bound to the formal version 1.
      const proposed = await proposeRefresh(db, {
        sourceUrl: url,
        articleId,
        operationId: 'propose-f',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      expect(proposed.outcome).toBe('proposed')
      if (proposed.outcome === 'proposed') expect(proposed.diff.changed).toBe(true)

      // 确认 — a FORMAL article routes to its UNIQUE active revision (正式只形成修订).
      const confirmed = await confirmRefresh(db, {
        sourceUrl: url,
        articleId,
        proposalOperationId: 'propose-f',
        expectedVersion: 1,
        operationId: 'confirm-f',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })
      expect(confirmed.outcome).toBe('refreshed')
      if (confirmed.outcome === 'refreshed') {
        expect(confirmed.revisionId).not.toBeNull()
      }

      // The settled formal state reconciles ALIGNED first.
      const pre = runReconcileB7(dir, freshReport(), ['--candidate', CANDIDATE])
      expect(pre.status, pre.stdout || pre.stderr).toBe(0)
      expect(pre.stdout).toContain('drift=0')

      // 负向探针 — tamper the real kernel's frozen proposal snapshot.
      await db
        .prepare(`UPDATE source_refresh_proposals SET snapshot_sha256 = ? WHERE operation_id = 'propose-f'`)
        .bind('b'.repeat(64)).run()

      await ctx.dispose()
      const report = freshReport()
      const drifted = runReconcileB7(dir, report, ['--candidate', CANDIDATE])
      expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
      expect(drifted.stdout).toContain('verdict=DRIFT')
      const text = readFileSync(report, 'utf8')
      expect(text).toContain('来源快照指纹篡改')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })
})
