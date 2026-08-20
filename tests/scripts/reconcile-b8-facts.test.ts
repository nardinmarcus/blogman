/**
 * B8-G — batch-8 acceptance fixture tests (issue #65).
 *
 * SQL-seeded acceptance fixtures over the SIX mobile-matrix fact surfaces the
 * batch-8 mobile flows drive through their shared kernels (all read from D1,
 * never from UI state):
 *
 *   1. 导航/深链恢复 — activity_notifications sources resolve to real facts.
 *   2. 本机稿恢复 — contiguous article_versions chain + content hash present,
 *      the posts.current body hash agrees with the LATEST confirmed version.
 *   3. 三向冲突选择 — source_conflict_resolutions explicit side choice bound to
 *      baseline + anchored source fingerprint + anchored version.
 *   4. 建议生命周期 — publish_preparations + publish_suggestions version-bound
 *      (basis_sha256 == bound-version content hash), decided ⇔ lifecycle.
 *   5. 排期命令 — publish_schedules status machine + schedule_control_ops
 *      command/status agreement.
 *   6. 发布确认与回据 — formal_publications backed by one event (evidence
 *      re-derived), one outbox row, and one independent verified receipt.
 *
 * A complete settled state is ALIGNED when bound to the same immutable
 * candidate, DRIFT on a candidate mismatch, and DRIFT with itemized messages
 * when each surface is corrupted. Zero production: every D1 access is local /
 * tmpdir and the reconciler only issues read-only SELECTs. No full vitest run
 * — this file is targeted independently.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CANDIDATE,
  applyB8Schema,
  cleanupB8State,
  createWranglerState,
  h64,
  runD1,
  runReconcileB8,
  sha256,
} from '@/tests/scripts/reconcile-b8-helpers'
import { literal } from '@/tests/helpers/article-identity-state'

const T0 = 1_700_000_000
const SRC_URL = 'https://src.example.test/conflict/a'
const PUBLIC_URL = 'https://blog.example.test/first-post'

const reportDirs: string[] = []
const seedStates: string[] = []
let seedState: string | null = null

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b8-facts-report-'))
  reportDirs.push(dir)
  return dir + '/report.md'
}

function freshSeedState(): string {
  const state = createWranglerState()
  seedStates.push(state)
  return state
}

afterAll(() => {
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const s of seedStates.splice(0)) rmSync(s, { recursive: true, force: true })
  cleanupB8State()
})

/* ------------------------------------------------------------------ */
/* settled fixture covering all six surfaces                           */
/* ------------------------------------------------------------------ */

/**
 * Seed one immutable batch-8 state over every mobile surface:
 *
 *   - 文章 1: versions v1 (formally published) + v2 (latest draft), so the
 *     publish-receipt surface binds to v1 and the suggestion surface binds to
 *     v2. posts.current hash == v2 (server-confirmed save).
 *   - 文章 2: a plain draft with a contiguous version-1 chain.
 *   - 发布回据: one formal publication backed by one event (evidence =
 *     sha256(payload)), one outbox row, one verified receipt.
 *   - 建议: one applied suggestion bound to article 1 version 2.
 *   - 排期: one pending schedule + one reschedule control command.
 *   - 冲突: one applied 'source' side choice bound to a real identity.
 *   - 导航: two notifications whose sources (schedule / event) resolve.
 */
function seedB8Facts(state: string): void {
  const v1 = sha256('v1')
  const v2 = sha256('v2')
  const s2v1 = sha256('s2v1')
  const payload = JSON.stringify({ article: 1, version: 1, slug: 'first-post' })
  const evidence = sha256(payload)

  const rows = [
    // ---- articles + posts (本机稿恢复) ----
    `INSERT INTO articles (id, post_ref, slug, draft_ref, created_at) VALUES
      (1, 1, 'first-post', NULL, ${T0}),
      (2, 2, 'second-post', NULL, ${T0})`,
    `INSERT INTO article_versions (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at) VALUES
      (1, 1, 'op:v1', ${literal('{"a":1}')}, ${literal(v1)}, ${T0}),
      (1, 2, 'op:v2', ${literal('{"a":2}')}, ${literal(v2)}, NULL),
      (2, 1, 'op:s2v1', ${literal('{}')}, ${literal(s2v1)}, NULL)`,
    `INSERT INTO posts (id, slug, title, content, html, content_snapshot_sha256) VALUES
      (1, 'first-post', 'First', 'v2', '<p>v2</p>', ${literal(v2)}),
      (2, 'second-post', 'Second', 's2v1', '<p>s2v1</p>', ${literal(s2v1)})`,
    // ---- 发布确认与回据 (event + outbox + formal + receipt) ----
    `INSERT INTO publish_events
       (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at,
        evidence_sha256, payload, created_at)
     VALUES (${literal('ev:first')}, ${literal('int:first')}, 1, 1, 'first-post', 'published',
        ${T0}, ${literal(evidence)}, ${literal(payload)}, ${T0})`,
    `INSERT INTO publish_outbox
       (outbox_id, event_id, article_id, version, kind, payload, status, delivered_at, created_at)
     VALUES (${literal('outbox:ev:first')}, ${literal('ev:first')}, 1, 1, 'public-receipt',
        ${literal('{}')}, 'delivered', ${T0}, ${T0})`,
    `INSERT INTO formal_publications
       (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id)
     VALUES (1, 1, 'first-post', 'published', ${T0}, ${T0}, ${literal(PUBLIC_URL)}, ${literal('ev:first')})`,
    `INSERT INTO publish_receipts
       (event_id, article_id, version, slug, public_url, receipt_payload, verified, verified_at, created_at)
     VALUES (${literal('ev:first')}, 1, 1, 'first-post', ${literal(PUBLIC_URL)},
        ${literal('{}')}, 1, ${T0}, ${T0})`,
    // ---- 建议生命周期 (bound to article 1 version 2) ----
    `INSERT INTO publish_preparations
       (preparation_id, article_id, post_ref, bound_version, source, status, created_at, applied_at, updated_at)
     VALUES (${literal('prep:1')}, 1, 1, 2, 'mobile-ai', 'applied', ${T0}, ${T0}, ${T0})`,
    `INSERT INTO publish_suggestions
       (suggestion_id, preparation_id, article_id, field, value, basis_sha256, bound_version,
        status, applied_operation_id, decided_at, created_at, updated_at)
     VALUES (${literal('sug:1')}, ${literal('prep:1')}, 1, 'description', 'd',
        ${literal(v2)}, 2, 'applied', ${literal('apply:1')}, ${T0}, ${T0}, ${T0})`,
    // ---- 排期命令 (pending schedule + reschedule control op) ----
    `INSERT INTO publish_schedules
       (schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, created_at, updated_at)
     VALUES (${literal('sched:1')}, 1, 2, ${T0 + 600}, 'Asia/Shanghai', 'pending', 0, ${T0}, ${T0})`,
    `INSERT INTO schedule_control_ops (operation_id, schedule_id, action, result, created_at)
     VALUES (${literal('ctrl:1')}, ${literal('sched:1')}, 'reschedule',
        ${literal(JSON.stringify({ outcome: 'rescheduled', scheduleId: 'sched:1' }))}, ${T0})`,
    // ---- 三向冲突选择 (bound to a real identity + article 1) ----
    `INSERT INTO source_identities (id, canonical_url, identity_sha256, created_at) VALUES
      (1, ${literal(SRC_URL)}, ${literal(sha256(SRC_URL))}, ${T0})`,
    `INSERT INTO source_conflict_resolutions
       (operation_id, source_identity_id, article_id, chosen_side, baseline_version,
        baseline_sha256, anchored_source_sha256, anchored_article_version,
        source_projection_json, source_media_json, pre_resolution_snapshot_json,
        status, applied_at, created_at)
     VALUES (${literal('conflict:1')}, 1, 1, 'source', 1,
        ${literal(h64('baseline'))}, ${literal(h64('anchored'))}, 1,
        ${literal('{"title":"t"}')}, ${literal('[]')}, ${literal('{"v":1}')},
        'applied', ${T0}, ${T0})`, 
    // ---- 导航/深链恢复 (notifications resolve to real sources) ----
    `INSERT INTO activity_notifications
       (notification_id, source_type, source_id, title, status, acknowledged, created_at, updated_at)
     VALUES
      (${literal('notif:1')}, 'schedule', ${literal('sched:1')}, 't', 'open', 0, ${T0}, ${T0}),
      (${literal('notif:2')}, 'event', ${literal('ev:first')}, 't', 'resolved', 1, ${T0}, ${T0})`,
  ]
  runD1(state, rows.join(';\n'))
}

function buildSeedState(): string {
  if (seedState) return seedState
  const state = freshSeedState()
  applyB8Schema(state)
  seedB8Facts(state)
  seedState = state
  return state
}

/* ------------------------------------------------------------------ */
/* aligned / candidate / corruption / idempotency                      */
/* ------------------------------------------------------------------ */

describe('reconcile-b8-facts (SQL-seeded acceptance fixture)', { timeout: 600_000 }, () => {
  it('reports ALIGNED on a complete mobile-matrix fact state bound to the same candidate', () => {
    const state = buildSeedState()
    const report = freshReport()
    const aligned = runReconcileB8(state, report, ['--candidate', CANDIDATE])
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('drift=0')
    expect(aligned.stdout).toContain('articles=2')
    expect(aligned.stdout).toContain('versions=3')
    expect(aligned.stdout).toContain('notifications=2')
    expect(aligned.stdout).toContain('conflicts=1')
    expect(aligned.stdout).toContain('preparations=1')
    expect(aligned.stdout).toContain('suggestions=1')
    expect(aligned.stdout).toContain('schedules=1')
    expect(aligned.stdout).toContain('controlOps=1')
    expect(aligned.stdout).toContain('formals=1')
    expect(aligned.stdout).toContain('receipts=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('ALIGNED')
    expect(text).toContain('六面移动矩阵事实完整')
  })

  it('reports DRIFT with a single candidate item when the ledger candidate mismatches', () => {
    const state = buildSeedState()
    const report = freshReport()
    const drifted = runReconcileB8(state, report, ['--candidate', 'd'.repeat(40)])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    expect(drifted.stdout).toContain('drift=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('候选漂移')
  })

  it('is idempotent: running the reconciler twice over the same state stays ALIGNED', () => {
    const state = buildSeedState()
    const first = runReconcileB8(state, freshReport(), ['--candidate', CANDIDATE])
    expect(first.status, first.stdout || first.stderr).toBe(0)
    const second = runReconcileB8(state, freshReport(), ['--candidate', CANDIDATE])
    expect(second.status, second.stdout || second.stderr).toBe(0)
    expect(second.stdout).toContain('drift=0')
  })

  it('reports DRIFT with itemized items when each B8-G surface is corrupted', () => {
    const state = buildSeedState()

    // 1. 导航/深链 — notification source no longer resolves to a real schedule.
    runD1(state, `UPDATE activity_notifications SET source_id = 'sched:missing' WHERE notification_id = 'notif:1'`)
    // 2. 本机稿 — posts.current body hash no longer agrees with the latest version.
    runD1(state, `UPDATE posts SET content_snapshot_sha256 = '${sha256('tampered')}' WHERE id = 1`)
    // 3. 三向冲突 — an applied side choice must carry its applied_at.
    runD1(state, `UPDATE source_conflict_resolutions SET applied_at = NULL WHERE operation_id = 'conflict:1'`)
    // 4. 建议 — an applied suggestion loses its applied_operation_id.
    runD1(state, `UPDATE publish_suggestions SET applied_operation_id = NULL WHERE suggestion_id = 'sug:1'`)
    // 5. 排期命令 — the recorded control command no longer matches its action.
    runD1(state, `UPDATE schedule_control_ops SET result = '{"outcome":"paused"}' WHERE operation_id = 'ctrl:1'`)
    // 6. 发布回据 — the receipt is no longer verified.
    runD1(state, `UPDATE publish_receipts SET verified = 0 WHERE event_id = 'ev:first'`)

    const report = freshReport()
    const drifted = runReconcileB8(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('深链指向不存在的排期')
    expect(text).toContain('当前 posts 内容哈希')
    expect(text).toContain('已应用解决 conflict:1 却缺少 applied_at')
    expect(text).toContain('缺少 applied_operation_id')
    expect(text).toContain('与 action=')
    expect(text).toContain('未验证 (verified=0)')
  })

  it('reports DRIFT when a version chain gap or a missing content hash blocks draft restore', () => {
    const state = buildSeedState()
    // Break article 2's version-1 content hash (a restore has no basis).
    runD1(state, `UPDATE article_versions SET content_snapshot_sha256 = 'broken' WHERE article_id = 2 AND version = 1`)
    const report = freshReport()
    const drifted = runReconcileB8(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('版本 1 缺少内容快照哈希')
  })
})
