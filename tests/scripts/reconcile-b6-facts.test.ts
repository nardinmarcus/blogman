/**
 * B6-G — batch-6 acceptance fixture tests (issue #56).
 *
 * Two layers:
 *
 *   A) SQL-seeded acceptance fixtures (wrangler-persisted states, the same
 *      channel the reconciler reads): a complete settled batch-6 fact state
 *      over the eight source-chain surfaces (身份, 关联, 基线, 同步方向,
 *      冲突选边, 恢复点, 不可用观察, 写回意图) is ALIGNED when bound to the
 *      same immutable candidate, DRIFT on a candidate mismatch, and DRIFT with
 *      itemized messages when each surface is corrupted.
 *
 *   B) Real-kernel scenario coverage (in-process Miniflare persisting into the
 *      wrangler-addressable `v3/d1` layout): drive the REAL batch-6 kernels
 *      (linkSourceToArticle / confirmSourceLink / syncSourceAhead /
 *      initiateWriteBack / executeWriteBack / confirmWriteBack /
 *      resolveConflictSide / observeSourceAvailability /
 *      unlinkSourceFromArticle / relinkSourceToArticle) through mock providers
 *      and then reconcile the resulting fact state ALIGNED:
 *      1. 全链闭环: 身份→确认关联→同步→写回确认→冲突选源稿→恢复点→不可用观察 —
 *      2. 关系状态机全转移: pending→confirmed→(unlink) cancelled→(relink)
 *         pending →confirmed, 历史全部保留且对账 ALIGNED —
 *      3. 负向探针: 篡改身份哈希 / 失败尝试携带基线 / confirmed 写回未推进基线 /
 *         已应用冲突缺 pre_resolution → DRIFT。
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
  applyB6Schema,
  cleanupB6State,
  createFormalArticle,
  createKernelContext,
  createWranglerState,
  runReconcileB6,
  runD1,
  sha256,
  snapshotFor,
} from '@/tests/scripts/reconcile-b6-helpers'
import { literal } from '@/tests/helpers/article-identity-state'
import { create, save } from '@/lib/article-commands'
import { confirmSourceLink, linkSourceToArticle, resolveSourceUrl } from '@/lib/source-identity'
import { MockMediaStore, MockSourceProvider, syncSourceAhead, type SourceContent } from '@/lib/source-sync'
import { MockSourceWriteProvider, initiateWriteBack, executeWriteBack, confirmWriteBack } from '@/lib/source-writeback'
import { observeSourceAvailability } from '@/lib/source-availability'
import { MockSourceProbe } from './reconcile-b6-probe'
import { unlinkSourceFromArticle, relinkSourceToArticle } from '@/lib/source-relink'

const T0 = 1_700_000_000
const URL = 'https://src.example.test/guide/a'
const HERO = 'assets/hero.png'

const reportDirs: string[] = []
const seedStates: string[] = []
let seedState: string | null = null

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b6-facts-report-'))
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
  await cleanupB6State()
})

/* ------------------------------------------------------------------ */
/* SQL-seeded complete fixture (eight surfaces, settled)               */
/* ------------------------------------------------------------------ */

function identitySha(url: string): string {
  return sha256(url)
}

/**
 * The settled batch-6 fixture covering all eight surfaces on ONE source chain:
 *
 *   - 身份: one canonical identity + one author-merged URL variant.
 *   - 关联: one confirmed live link (pending → confirmed; resolved_at set).
 *   - 基线: one durable baseline (source_sync_sha256 + baseline_sha256
 *     identical to the source fingerprint the synced attempt produced).
 *   - 同步方向: one `synced` attempt carrying that baseline fingerprint +
 *     synced version, plus one failed attempt with a reason but NO baseline.
 *   - 冲突选边: an applied source-side conflict resolution anchored to the
 *     baseline's source hash, with a valid pre-resolution snapshot.
 *   - 恢复点: a `conflict-pick-source:<op>` restore point referencing the
 *     applied source resolution.
 *   - 不可用观察: one readable + one unavailable observation (never touching
 *     the baseline), and a durable baseline fact.
 *   - 写回意图: a confirmed write-back intent whose version+hash equal the
 *     durable baseline (确认前不推进基线 — the only advance).
 */
function seedB6Facts(state: string): void {
  const fingerprint = identitySha('source-content-v1')
  const articleVersion = 2

  const rows = [
    `INSERT INTO articles (id, post_ref, slug) VALUES (1, 1, 'b6-one')`,
    `INSERT INTO article_versions (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at) VALUES
      (1, 1, 'op:1:v1', ${literal('{}')}, ${literal(identitySha('b6-v1'))}, ${T0}),
      (1, 2, 'op:1:v2', ${literal('{}')}, ${literal(identitySha('b6-v2'))}, NULL)`,
    `INSERT INTO formal_publications (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id) VALUES
      (1, 1, 'b6-one', 'published', ${T0}, ${T0}, '${URL}', 'ev:1')`,
    // ---- 身份 + URL 变体 ----
    `INSERT INTO source_identities (id, canonical_url, identity_sha256, created_at) VALUES
      (1, ${literal(URL)}, ${literal(identitySha(URL))}, ${T0})`,
    `INSERT INTO source_url_variants (id, source_identity_id, variant_canonical_url, merged_by_operation_id, created_at) VALUES
      (1, 1, ${literal('https://src.example.test/guide/a?ref=clip')}, ${literal('merge-1')}, ${T0})`,
    // ---- 关联（pending → confirmed，resolved_at 已设）----
    `INSERT INTO article_source_links (id, source_identity_id, article_id, status, operation_id, created_at, resolved_at) VALUES
      (1, 1, 1, 'confirmed', ${literal('link-1')}, ${T0}, ${T0})`,
    // ---- 基线（union: 源稿指纹 + 版本）----
    `INSERT INTO source_sync_baselines
       (source_identity_id, article_id, article_version, source_sync_sha256, baseline_sha256,
        synced_version, synced_revision_id, synced_title, synced_markdown, synced_html,
        synced_media_json, updated_at)
     VALUES (1, 1, ${articleVersion}, ${literal(fingerprint)}, ${literal(fingerprint)},
        ${articleVersion}, NULL, '源稿标题', '# 正文', '<p>正文</p>', '[]', ${T0})`,
    // ---- 同步方向: synced 尝试（携带基线） + failed 尝试（无基线）----
    `INSERT INTO source_sync_attempts
       (operation_id, source_identity_id, article_id, post_ref, outcome, reason,
        baseline_sha256, synced_version, projection_json, media_json, created_at)
     VALUES (${literal('sync-1')}, 1, 1, 1, 'synced', NULL, ${literal(fingerprint)}, ${articleVersion},
        ${literal('{"title":"源稿标题","markdown":"# 正文","html":"<p>正文</p>"}')}, ${literal('[]')}, ${T0}),
       (${literal('sync-fail-1')}, 1, 1, 1, 'failed', 'media-failed: hero', NULL, NULL, NULL, NULL, ${T0})`,
    // ---- 媒体（内容身份寻址）----
    `INSERT INTO media_assets (id, content_sha256, r2_key, media_type, filename, size, created_at) VALUES
      (1, ${literal(identitySha('hero-bytes'))}, ${literal('source-media/' + identitySha('hero-bytes'))}, 'image/png', 'hero.png', 10, ${T0})`,
    `INSERT INTO source_media_mappings (id, source_identity_id, source_ref, media_asset_id, created_at) VALUES
      (1, 1, ${literal(HERO)}, 1, ${T0})`,
    // ---- 冲突选边: applied source-side resolution ----
    `INSERT INTO source_conflict_resolutions
       (operation_id, source_identity_id, article_id, chosen_side, baseline_version,
        baseline_sha256, anchored_source_sha256, anchored_article_version,
        source_projection_json, source_media_json, pre_resolution_snapshot_json,
        write_back_content_json, status, created_at, applied_at)
     VALUES (${literal('conflict-1')}, 1, 1, 'source', ${articleVersion}, ${literal(fingerprint)},
        ${literal(fingerprint)}, ${articleVersion},
        ${literal('{"title":"源稿标题","markdown":"# 正文","html":"<p>正文</p>"}')},
        ${literal('[]')}, ${literal('{"title":"旧标题","content":"旧正文"}')}, NULL, 'applied', ${T0}, ${T0})`,
    // ---- 恢复点 (conflict-pick-source:<op>) ----
    `INSERT INTO publish_restore_points
       (id, restore_point_id, article_id, formal_version, promoted_version, snapshot_json,
        content_sha256, reason, created_at)
     VALUES (1, 'restore:1:v1:manual:1:1', 1, 1, 1, ${literal('{}')},
        ${literal(identitySha('restore-snap'))}, ${literal('conflict-pick-source:conflict-1')}, ${T0})`,
    // ---- 不可用观察 + 基线事实 ----
    `INSERT INTO source_availability_observations
       (id, source_identity_id, operation_id, outcome, detail, observed_at) VALUES
      (1, 1, ${literal('avail-1')}, 'readable', '{"outcome":"readable"}', ${T0}),
      (2, 1, ${literal('avail-2')}, 'temporarily-unavailable', '{"outcome":"temporarily-unavailable","reason":"timeout"}', ${T0})`,
    `INSERT INTO source_baseline_facts
       (id, source_identity_id, content_sha256, advanced_by_operation_id, advanced_at) VALUES
      (1, 1, ${literal(fingerprint)}, ${literal('advance-1')}, ${T0})`,
    // ---- 写回意图（confirmed, 匹配 durable baseline）----
    `INSERT INTO source_write_back_intents
       (id, source_identity_id, article_id, article_version, baseline_version, operation_id,
        status, external_ref, source_sync_sha256, intent_at, written_at, confirmed_at)
     VALUES (1, 1, 1, ${articleVersion}, 1, ${literal('wb-1')}, 'confirmed',
        'ext:1', ${literal(fingerprint)}, ${T0}, ${T0}, ${T0})`,
  ]
  runD1(state, rows.join(';\n'))
}

function buildSeedState(): string {
  if (seedState) return seedState
  const state = freshSeedState()
  applyB6Schema(state)
  seedB6Facts(state)
  seedState = state
  return state
}

/* ------------------------------------------------------------------ */
/* Layer A — SQL-seeded acceptance fixtures                            */
/* ------------------------------------------------------------------ */

describe('reconcile-b6-facts (SQL-seeded acceptance fixture)', { timeout: 600_000 }, () => {
  it('reports ALIGNED on a complete batch-6 fact state bound to the same candidate', () => {
    const state = buildSeedState()
    const report = freshReport()
    const aligned = runReconcileB6(state, report, ['--candidate', CANDIDATE])
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('drift=0')
    expect(aligned.stdout).toContain('identities=1')
    expect(aligned.stdout).toContain('variants=1')
    expect(aligned.stdout).toContain('links=1')
    expect(aligned.stdout).toContain('baselines=1')
    expect(aligned.stdout).toContain('attempts=2')
    expect(aligned.stdout).toContain('conflicts=1')
    expect(aligned.stdout).toContain('restorePoints=1')
    expect(aligned.stdout).toContain('avail=2')
    expect(aligned.stdout).toContain('writebacks=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('ALIGNED')
    expect(text).toContain('八面源稿链事实完整')
  })

  it('reports DRIFT with a single candidate item when the ledger candidate mismatches', () => {
    const state = buildSeedState()
    const report = freshReport()
    const drifted = runReconcileB6(state, report, ['--candidate', 'd'.repeat(40)])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    expect(drifted.stdout).toContain('drift=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('候选漂移')
  })

  it('reports DRIFT with itemized items when each B6-G surface is corrupted', () => {
    const state = buildSeedState()

    // 1. 身份 — tamper identity_sha256 to break the canonical binding.
    runD1(state, `UPDATE source_identities SET identity_sha256 = '${'0'.repeat(64)}' WHERE id = 1`)
    // 2. 关联 — strip resolved_at from the confirmed link (终态必须记录解决时刻).
    runD1(state, `UPDATE article_source_links SET resolved_at = NULL WHERE id = 1`)
    // 3. 同步方向 — a failed attempt must NOT carry a baseline.
    runD1(state, `UPDATE source_sync_attempts SET baseline_sha256 = '${'a'.repeat(64)}' WHERE operation_id = 'sync-fail-1'`)
    // 4. 冲突 — applied resolution must carry applied_at AND a valid pre snapshot.
    runD1(state, `UPDATE source_conflict_resolutions SET applied_at = NULL WHERE operation_id = 'conflict-1'`)
    // 5. 恢复点 — the restore point no longer names the applied source op.
    runD1(state, `UPDATE publish_restore_points SET reason = 'conflict-pick-source:other' WHERE id = 1`)
    // 6. 不可用观察 — an observation must reference a real identity.
    runD1(state, `UPDATE source_availability_observations SET source_identity_id = 999 WHERE operation_id = 'avail-1'`)
    // 7. 写回 — a confirmed intent that did NOT advance the baseline to its hash.
    runD1(state, `UPDATE source_write_back_intents SET source_sync_sha256 = '${'b'.repeat(64)}' WHERE operation_id = 'wb-1'`)

    const report = freshReport()
    const drifted = runReconcileB6(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('identity_sha256 与 canonical_url 不符')
    expect(text).toContain('终态必须记录解决时刻')
    expect(text).toContain('失败不推进基线')
    expect(text).toContain('已应用解决')
    expect(text).toContain('无对应已应用选源稿解决')
    expect(text).toContain('引用不存在的源稿身份')
    expect(text).toContain('确认未推进基线')
  })
})

/* ------------------------------------------------------------------ */
/* Layer B — real-kernel scenario coverage                             */
/* ------------------------------------------------------------------ */

function baseContent(): SourceContent {
  return {
    title: '  新款手机 评测  ',
    markdown: `![主图](${HERO})\n\n全新段落正文`,
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

async function linkAndConfirm(db: D1Database, url: string, articleId: number, tag: string): Promise<void> {
  const linked = await linkSourceToArticle(db, { operationId: `link-${tag}`, url, articleId })
  expect(['applied', 'replayed']).toContain(linked.outcome)
  const res = await resolveSourceUrl(db, url)
  expect(res.outcome).toBe('resolved')
  if (res.outcome !== 'resolved') throw new Error('resolve failed')
  const confirmed = await confirmSourceLink(db, {
    sourceIdentityId: res.identity.id,
    articleId,
    operationId: `confirm-${tag}`,
    expectedStatus: 'pending',
  })
  expect(confirmed.outcome).toBe('confirmed')
}

describe('reconcile-b6-facts (real-kernel scenarios)', { timeout: 600_000 }, () => {
  it('全链闭环: 身份→确认关联→写回(确认前不推进基线)→确认→不可用观察, 对账 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const url = 'https://src.example.test/full/a'
      const created = await create(db, {
        creationId: 'full-article',
        snapshot: snapshotFor('full-a', '原标题', '# 原标题\n\n正文。', 'draft'),
        source: { url },
      })
      expect(created.outcome).toBe('created')
      if (created.outcome !== 'created') throw new Error('create failed')
      const articleId = created.articleId
      const res = await resolveSourceUrl(db, url)
      if (res.outcome !== 'resolved') throw new Error('resolve failed')
      const confirmed = await confirmSourceLink(db, {
        sourceIdentityId: res.identity.id,
        articleId,
        operationId: 'confirm-a',
        expectedStatus: 'pending',
      })
      expect(confirmed.outcome).toBe('confirmed')

      // B6-03 baseline seed (source holds H0 at v1 — the sanctioned kernel
      // convention; no earlier sync).
      const H0 = sha256('v1-content')
      await db.prepare(
        `INSERT INTO source_sync_baselines
           (source_identity_id, article_id, article_version, source_sync_sha256, baseline_sha256,
            synced_version, synced_title, synced_markdown, synced_html, synced_media_json, updated_at)
         VALUES (?, ?, 1, ?, ?, 1, '原标题', '# 原标题', '<p>原标题</p>', '[]', ?)`,
      ).bind(res.identity.id, articleId, H0, H0, T0).run()

      // Blogman 领先: advance the article past the baseline so the write-back
      // is initiate-able (version > baseline).
      const saved = await save(db, {
        articleId,
        expectedVersion: 1,
        operationId: 'save-a',
        snapshot: snapshotFor('full-a', '改写标题', '# 改写标题\n\n领先正文。', 'draft'),
      })
      expect(saved.outcome).toBe('applied')
      if (saved.outcome !== 'applied') throw new Error('save failed')

      // B6-03 write-back: initiate → execute → confirm. The confirmed intent
      // is the ONLY thing that advances the durable baseline.
      const write = new MockSourceWriteProvider(H0, (c) => sha256(`${c.title}\n${c.body}`))
      const wbInit = await initiateWriteBack(db, write, {
        articleId,
        sourceIdentityId: res.identity.id,
        operationId: 'wb-a',
      })
      expect(wbInit.outcome).toBe('intent')
      const wbExec = await executeWriteBack(db, write, { operationId: 'wb-a' })
      expect(wbExec.outcome).toBe('written')
      const wbConfirm = await confirmWriteBack(db, { operationId: 'wb-a' })
      expect(wbConfirm.outcome).toBe('confirmed')

      // B6-05 availability observations (never advance the baseline).
      const probe = new MockSourceProbe([{ outcome: 'readable' }, { outcome: 'temporarily-unavailable', reason: 'timeout' }])
      await observeSourceAvailability(db, { operationId: 'avail-a', url, probe, now: T0 })

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB6(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('drift=0')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('关系状态机全转移: pending→confirmed→cancelled(unlink)→pending(relink)→confirmed, 历史保留且对账 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const url = 'https://src.example.test/relink/a'
      await linkAndConfirm(db, url, article.articleId, 'r1')
      const res = await resolveSourceUrl(db, url)
      if (res.outcome !== 'resolved') throw new Error('resolve failed')
      const identityId = res.identity.id

      // Sync + confirm a baseline so relink has a preserved durable baseline.
      await syncSourceAhead(db, {
        sourceUrl: url,
        articleId: article.articleId,
        expectedVersion: 1,
        operationId: 'sync-relink',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })

      // 解除 (confirmed → cancelled, 保留 baseline)。
      const unlinked = await unlinkSourceFromArticle(db, { operationId: 'unlink-r', sourceUrl: url, articleId: article.articleId, now: T0 + 1 })
      expect(unlinked.outcome).toBe('unlinked')
      if (unlinked.outcome === 'unlinked') expect(unlinked.baselinePreserved).toBe(true)

      // 重新关联 (cancelled → fresh pending via the #50 identity chain)。
      const relinked = await relinkSourceToArticle(db, { operationId: 'relink-r', sourceUrl: url, articleId: article.articleId, now: T0 + 2 })
      expect(relinked.outcome).toBe('relinked')
      if (relinked.outcome !== 'relinked') throw new Error('relink failed')
      expect(relinked.autoSynced).toBe(false)
      expect(relinked.baselineInherited).toBe(false)

      // Re-confirm the relinked pending link.
      const confirmed = await confirmSourceLink(db, {
        sourceIdentityId: identityId,
        articleId: article.articleId,
        operationId: 'confirm-r2',
        expectedStatus: 'pending',
      })
      expect(confirmed.outcome).toBe('confirmed')

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB6(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('drift=0')
      // History: link-created (cancelled) + relink link, both under one identity.
      const links = (await runD1(dir, 'SELECT status FROM article_source_links'))[0].results as Array<{ status: string }>
      const statuses = links.map((l: { status: string }) => l.status).sort()
      expect(statuses).toContain('cancelled')
      expect(statuses).toContain('confirmed')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('负向探针: 真实内核产生的稳定状态被伪造后必须 DRIFT', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const url = 'https://src.example.test/neg/a'
      await linkAndConfirm(db, url, article.articleId, 'n1')
      await syncSourceAhead(db, {
        sourceUrl: url,
        articleId: article.articleId,
        expectedVersion: 1,
        operationId: 'sync-neg',
        provider: providerFor(baseContent()),
        mediaStore: new MockMediaStore(),
        now: T0,
      })

      // Fabricate drift: tamper the produced synced attempt to look failed-less.
      await db.prepare('UPDATE source_sync_attempts SET baseline_sha256 = NULL, synced_version = NULL WHERE operation_id = ?')
        .bind('sync-neg').run()

      await ctx.dispose()
      const report = freshReport()
      const drifted = runReconcileB6(dir, report, ['--candidate', CANDIDATE])
      expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
      expect(drifted.stdout).toContain('verdict=DRIFT')
      const text = readFileSync(report, 'utf8')
      expect(text).toContain('成功尝试')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })
})
