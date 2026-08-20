/**
 * B4-G — batch-4 acceptance fixture tests (issue #45).
 *
 * Two layers:
 *
 *   A) SQL-seeded acceptance fixtures (wrangler-persisted states, the same
 *      channel the reconciler reads): a complete settled batch-4 fact state
 *      over the eight surfaces is ALIGNED when bound to the same immutable
 *      candidate, DRIFT on a candidate mismatch, and DRIFT with itemized
 *      messages when each surface is corrupted (schedule status, lease,
 *      attempt, event, outbox, control-op ledger, notification, email send).
 *
 *   B) Real-kernel scenario coverage (in-process Miniflare persisting into the
 *      wrangler-addressable `v3/d1` layout, verified experimentally):
 *      1. 到期→租约→attempt→事件→Outbox 全链 — a due schedule is driven by
 *         `scanDueSchedules` through the atomic claim/lease, the immutable
 *         attempt, the deterministic event and the outbox row, then reconciled
 *         ALIGNED,
 *      2. 补偿重扫幂等 — a crashed first scan (claimed + expired lease +
 *         running attempt, event already written) is re-scanned; the second
 *         scan reclaims, abandons the orphan, re-drives the confirm kernel
 *         which REPLAYS the same deterministic event — no duplicate event /
 *         outbox / formal fact; reconciled ALIGNED,
 *      3. 暂停/取消后无外发 — pausing / cancelling leaves nothing to email
 *         (no notifications, no deliveries), the executor sends nothing, and
 *         the reconciler DRIFTs on a fabricated open notification + `sent`
 *         delivery for a cancelled schedule.
 *
 * Zero production: every D1 access is local / tmpdir; the reconciler only
 * issues read-only SELECT statements.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CANDIDATE,
  applyB4Schema,
  cleanupB4State,
  createDraftArticle,
  createKernelContext,
  createWranglerState,
  runReconcileB4,
  runD1,
  sha256,
} from '@/tests/scripts/reconcile-b4-helpers'
import { eventIdFor, evidenceDigest, outboxIdFor } from '@/lib/first-publish/kernel'
import { scheduledIntentId, scheduledAttemptKey } from '@/lib/scheduled-publish/kernel'
import {
  cancelScheduleControl,
  pauseSchedule,
} from '@/lib/schedule-control/kernel'
import {
  recordNotification,
} from '@/lib/notifications/kernel'
import {
  runEmailReminders,
  setEmailRemindersConfig,
} from '@/lib/email-reminders/kernel'
import { scanDueSchedules, schedulePublish } from '@/lib/scheduled-publish/kernel'
import { literal } from '@/tests/helpers/article-identity-state'

const SITE = 'https://blog.example.test'

/* Frozen clock — every fixture timestamp is a synthetic epoch second. */
const T0 = 1_700_000_000
const T1 = 1_700_000_060
const T2 = 1_700_000_120
const T3 = 1_700_000_180
const T4 = 1_700_000_240
const T5 = 1_700_000_300
const T6 = 1_700_000_600
const T_END = 1_700_002_000

const reportDirs: string[] = []
const seedStates: string[] = []
let seedState: string | null = null

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b4-facts-report-'))
  reportDirs.push(dir)
  return join(dir, 'report.md')
}

function freshSeedState(): string {
  const state = createWranglerState()
  seedStates.push(state)
  return state
}

afterAll(async () => {
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const s of seedStates.splice(0)) rmSync(s, { recursive: true, force: true })
  await cleanupB4State()
})

/* ------------------------------------------------------------------ */
/* SQL-seeded complete fixture (all eight surfaces, settled)           */
/* ------------------------------------------------------------------ */

const eventPayload = (eventId: string, intentId: string, articleId: number, version: number, slug: string, at: number, hash: string) =>
  JSON.stringify({
    format: 'blogman-first-publish-event/v1',
    eventId, intentId, articleId, version, slug,
    lifecycle: 'published', firstPublishedAt: at, publishedAt: at, publicUrl: `${SITE}/${slug}`,
    contentSha256: hash, actor: 'scheduled-cron',
    blockerFlags: { saved: 1, lifecycle: 1, slug: 1, content: 1 },
  })
const outboxPayload = (outboxId: string, eventId: string, articleId: number, version: number, slug: string, hash: string) =>
  JSON.stringify({
    format: 'blogman-first-publish-outbox/v1',
    outboxId, eventId, articleId, version, slug, publicUrl: `${SITE}/${slug}`, contentSha256: hash,
  })
const versionSnapshot = (postRef: number, version: number, slug: string, title: string, markdown: string) =>
  JSON.stringify({
    format: 'blogman-article-snapshot/v1',
    post_ref: postRef, version,
    fields: { slug, title, content: markdown },
    original_content: markdown, original_html: `<p>${markdown}</p>`,
    content_snapshot_sha256: sha256(markdown), source_sync_sha256: sha256(markdown),
  })

/**
 * The settled batch-4 fixture:
 *
 *   sched-fired    — article 1: 到期→租约→attempt(fired)→event→outbox→formal
 *   sched-pending  — article 2: one transient retry, re-armed with backoff,
 *                    open notification + failed (retryable) email delivery
 *   sched-paused   — article 3: paused via control op (no notification, no
 *                    delivery)
 *   sched-stale    — article 4: version-drift, stale_reason, open notification
 *                    + sent (provider-accepted) email delivery
 *   sched-cancelled— article 5: cancelled via control op, notification RESOLVED
 */
function seedB4Facts(state: string): void {
  const h1 = sha256('# 正文一\n\n内容一。')
  const h2 = sha256('# 正文二\n\n内容二。')
  const h3 = sha256('# 正文三\n\n内容三。')
  const h4 = sha256('# 正文四\n\n内容四。')
  const h5 = sha256('# 正文五\n\n内容五。')
  const htmlOf = (md: string) => `<p>${md}</p>`

  const eFired = eventIdFor(scheduledIntentId('sched-fired'))
  const intentFired = scheduledIntentId('sched-fired')
  const evPayload = eventPayload(eFired, intentFired, 1, 1, 'pub-fired', T1, h1)
  const evOutboxId = outboxIdFor(eFired)
  const evOutboxPayload = outboxPayload(evOutboxId, eFired, 1, 1, 'pub-fired', h1)

  runD1(state, [
    // Posts + identity + version facts (five drafts, one of them fired).
    `INSERT INTO posts (id, slug, title, content, html, status, published_at, content_snapshot_sha256) VALUES
      (1, 'pub-fired', '定时发表一', ${literal('# 正文一\n\n内容一。')}, ${literal(htmlOf('# 正文一\n\n内容一。'))}, 'published', ${T1}, ${literal(h1)}),
      (2, 'pub-pending', '待发二', ${literal('# 正文二\n\n内容二。')}, ${literal(htmlOf('# 正文二\n\n内容二。'))}, 'draft', NULL, ${literal(h2)}),
      (3, 'pub-paused', '暂停三', ${literal('# 正文三\n\n内容三。')}, ${literal(htmlOf('# 正文三\n\n内容三。'))}, 'draft', NULL, ${literal(h3)}),
      (4, 'pub-stale', '停滞四', ${literal('# 正文四\n\n内容四。')}, ${literal(htmlOf('# 正文四\n\n内容四。'))}, 'draft', NULL, ${literal(h4)}),
      (5, 'pub-cancelled', '取消五', ${literal('# 正文五\n\n内容五。')}, ${literal(htmlOf('# 正文五\n\n内容五。'))}, 'draft', NULL, ${literal(h5)})`,
    `INSERT INTO articles (id, post_ref, slug) VALUES
      (1, 1, 'pub-fired'), (2, 2, 'pub-pending'), (3, 3, 'pub-paused'), (4, 4, 'pub-stale'), (5, 5, 'pub-cancelled')`,
    `INSERT INTO article_versions (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at) VALUES
      (1, 1, 'op:a1:v1', ${literal(versionSnapshot(1, 1, 'pub-fired', '定时发表一', '# 正文一\n\n内容一。'))}, ${literal(h1)}, NULL),
      (2, 1, 'op:a2:v1', ${literal(versionSnapshot(2, 1, 'pub-pending', '待发二', '# 正文二\n\n内容二。'))}, ${literal(h2)}, NULL),
      (3, 1, 'op:a3:v1', ${literal(versionSnapshot(3, 1, 'pub-paused', '暂停三', '# 正文三\n\n内容三。'))}, ${literal(h3)}, NULL),
      (4, 1, 'op:a4:v1', ${literal(versionSnapshot(4, 1, 'pub-stale', '停滞四', '# 正文四\n\n内容四。'))}, ${literal(h4)}, NULL),
      (5, 1, 'op:a5:v1', ${literal(versionSnapshot(5, 1, 'pub-cancelled', '取消五', '# 正文五\n\n内容五。'))}, ${literal(h5)}, NULL)`,
    // ---- publish_schedules (five intents, one per terminal/armed state) ----
    `INSERT INTO publish_schedules
       (schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, last_error,
        claimed_at, lease_expires_at, lease_token, revision, next_attempt_at, stale_reason, fired_event_id, created_at, updated_at) VALUES
      ('sched-fired', 1, 1, ${T0 + 30}, 'Asia/Shanghai', 'fired', 1, NULL, NULL, NULL, NULL, 1, NULL, NULL, ${literal(eFired)}, ${T0}, ${T1}),
      ('sched-pending', 2, 1, ${T0 + 40}, 'Asia/Shanghai', 'pending', 1, 'transient: connection reset', NULL, NULL, NULL, 1, ${T2 + 60}, NULL, NULL, ${T0}, ${T2}),
      ('sched-paused', 3, 1, ${T0 + 70}, 'Asia/Shanghai', 'paused', 0, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, ${T0}, ${T3}),
      ('sched-stale', 4, 1, ${T0 + 50}, 'Asia/Shanghai', 'stale', 1, NULL, NULL, NULL, NULL, 1, NULL, 'version-drift', NULL, ${T0}, ${T4}),
      ('sched-cancelled', 5, 1, ${T0 + 90}, 'Asia/Shanghai', 'cancelled', 0, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, ${T0}, ${T5})`,
    // ---- publish_attempts (immutable, one per execution) ----
    `INSERT INTO publish_attempts (attempt_key, schedule_id, attempt_no, started_at, finished_at, outcome, error, created_at, updated_at) VALUES
      (${literal(scheduledAttemptKey('sched-fired', 1))}, 'sched-fired', 1, ${T1}, ${T1}, 'fired', NULL, ${T1}, ${T1}),
      (${literal(scheduledAttemptKey('sched-pending', 1))}, 'sched-pending', 1, ${T2}, ${T2}, 'retried', 'transient: connection reset', ${T2}, ${T2}),
      (${literal(scheduledAttemptKey('sched-stale', 1))}, 'sched-stale', 1, ${T4}, ${T4}, 'stale', NULL, ${T4}, ${T4})`,
    // ---- fired event + outbox + formal publication (the 全链 result) ----
    `INSERT INTO publish_events
       (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at, evidence_sha256, payload, created_at)
     VALUES (${literal(eFired)}, ${literal(intentFired)}, 1, 1, 'pub-fired', 'published', ${T1},
       ${literal(evidenceDigest(evPayload))}, ${literal(evPayload)}, ${T1})`,
    `INSERT INTO publish_outbox
       (outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at, delivered_at)
     VALUES (${literal(evOutboxId)}, ${literal(eFired)}, 1, 1, 'public-receipt',
       ${literal(evOutboxPayload)}, 'delivered', 1, ${T1}, ${T1 + 30})`,
    `INSERT INTO formal_publications
       (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id)
     VALUES (1, 1, 'pub-fired', 'published', ${T1}, ${T1}, '${SITE}/pub-fired', ${literal(eFired)})`,
    // ---- schedule_control_ops (audit ledger) ----
    `INSERT INTO schedule_control_ops (operation_id, schedule_id, action, result, created_at) VALUES
      ('op-pause-3', 'sched-paused', 'pause',
        ${literal(JSON.stringify({ outcome: 'paused', scheduleId: 'sched-paused', articleId: 3, version: 1, scheduledAt: T0 + 70, timezone: 'Asia/Shanghai', pausedAt: T3, reason: null }))}, ${T3}),
      ('op-cancel-5', 'sched-cancelled', 'cancel',
        ${literal(JSON.stringify({ outcome: 'cancelled', scheduleId: 'sched-cancelled', cancelledAt: T5 }))}, ${T5})`,
    // ---- email reminder config + delivery + dedup facts ----
    `INSERT INTO email_reminder_config
       (key, enabled, recipients_json, from_address, threshold_seconds, quiet_start_minute, quiet_end_minute, utc_offset_minutes, cooldown_seconds, updated_at)
     VALUES ('email-reminders', 1, '["author@example.com"]', 'no-reply@blog.example.test', 60, 0, 0, 480, 300, ${T0})`,
    `INSERT INTO email_deliveries
       (source_type, source_id, last_attempt_at, last_sent_at, sent_count, last_status, last_error, updated_at) VALUES
      ('schedule', 'sched-pending', ${T6}, NULL, 0, 'failed', 'provider rejected: 550 5.1.1 mailbox unavailable', ${T6}),
      ('schedule', 'sched-stale', ${T6}, ${T6}, 1, 'sent', NULL, ${T6})`,
    // ---- activity_notifications (author attention loop) ----
    `INSERT INTO activity_notifications
       (notification_id, source_type, source_id, title, detail, status, acknowledged, created_at, updated_at) VALUES
      ('nf-pending', 'schedule', 'sched-pending', '定时任务待重试', NULL, 'open', 0, ${T2 + 5}, ${T2 + 5}),
      ('nf-stale', 'schedule', 'sched-stale', '版本漂移，需重新确认', NULL, 'open', 0, ${T4 + 5}, ${T4 + 5}),
      ('nf-cancelled', 'schedule', 'sched-cancelled', '已取消', NULL, 'resolved', 0, ${T5}, ${T5})`,
  ].join(';\n'))
}

function buildSeedState(): string {
  if (seedState) return seedState
  const state = freshSeedState()
  applyB4Schema(state)
  seedB4Facts(state)
  seedState = state
  return state
}

/* ------------------------------------------------------------------ */
/* Layer A — SQL-seeded acceptance fixtures                            */
/* ------------------------------------------------------------------ */

describe('reconcile-b4-facts (SQL-seeded acceptance fixture)', () => {
  it('reports ALIGNED on a complete batch-4 fact state bound to the same candidate', { timeout: 600_000 }, () => {
    const state = buildSeedState()
    const report = freshReport()
    const aligned = runReconcileB4(state, report, ['--candidate', CANDIDATE, '--now', String(T_END)])
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('drift=0')
    expect(aligned.stdout).toContain('schedules=5')
    expect(aligned.stdout).toContain('attempts=3')
    expect(aligned.stdout).toContain('events=1')
    expect(aligned.stdout).toContain('outboxes=1')
    expect(aligned.stdout).toContain('controlOps=2')
    expect(aligned.stdout).toContain('notifications=3')
    expect(aligned.stdout).toContain('deliveries=2')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('ALIGNED')
    expect(text).toContain('八面事实完整')
  })

  it('reports DRIFT with a single candidate item when the ledger candidate mismatches', { timeout: 300_000 }, () => {
    const state = buildSeedState()
    const report = freshReport()
    const drifted = runReconcileB4(state, report, ['--candidate', 'c'.repeat(40)])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    expect(drifted.stdout).toContain('drift=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('候选漂移')
  })

  it('reports DRIFT with itemized items when each fact surface is corrupted', { timeout: 300_000 }, () => {
    const state = buildSeedState()
    const eFired = eventIdFor(scheduledIntentId('sched-fired'))

    // 1. 排期 — a stale schedule loses its stale_reason.
    runD1(state, "UPDATE publish_schedules SET stale_reason = NULL WHERE schedule_id = 'sched-stale'")
    // 2. 租约 — a non-claimed row carries a claimed_at.
    runD1(state, `UPDATE publish_schedules SET claimed_at = ${T1} WHERE schedule_id = 'sched-fired'`)
    // 3. 尝试 — a stale schedule's final attempt claims outcome 'fired'.
    runD1(state, "UPDATE publish_attempts SET outcome = 'fired' WHERE attempt_key = 'sched-attempt:sched-stale:1'")
    // 4. 事件 — tamper the event payload (evidence digest breaks).
    runD1(state, `UPDATE publish_events SET payload = 'tampered' WHERE event_id = '${eFired}'`)
    // 5. Outbox — delivered marker disagrees with status.
    runD1(state, `UPDATE publish_outbox SET status = 'pending' WHERE event_id = '${eFired}'`)
    // 6. 控制操作 — a recorded pause is rewritten as cancel.
    runD1(state, "UPDATE schedule_control_ops SET action = 'cancel' WHERE operation_id = 'op-pause-3'")
    // 7. 通知 — cancelled schedule presents an open notification.
    runD1(state, "UPDATE activity_notifications SET status = 'open' WHERE source_id = 'sched-cancelled'")
    // 8. 邮件 — cancelled schedule carries a `sent` delivery fact (无外发违背).
    runD1(state, `INSERT INTO email_deliveries
       (source_type, source_id, last_attempt_at, last_sent_at, sent_count, last_status, last_error, updated_at)
     VALUES ('schedule', 'sched-cancelled', ${T5}, ${T5}, 1, 'sent', NULL, ${T5})`)

    const report = freshReport()
    const drifted = runReconcileB4(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    // 1. schedule surface
    expect(text).toContain('排期: 停滞排期 sched-stale 缺少 stale_reason')
    // 2. lease surface
    expect(text).toContain("租约: 非 claimed 排期 sched-fired (status='fired') 残留 claimed_at")
    // 3. attempt surface
    expect(text).toContain('最后尝试为 fired 但状态为')
    // 4. event surface (tamper-evidence)
    expect(text).toContain('事件: 事件 event:sched:sched-fired 证据哈希不匹配')
    // 5. outbox surface
    expect(text).toContain("Outbox: outbox:event:sched:sched-fired status='pending' 与 delivered_at 标记不一致")
    // 6. control-op ledger surface
    expect(text).toContain("outcome='paused' 与 action='cancel' 不符")
    expect(text).toContain('最新操作是 cancel 但状态为')
    // 7. notification surface
    expect(text).toContain('已 cancelled 却仍有未处理通知')
    // 8. email surface (no outbound after cancellation)
    expect(text).toContain('已 cancelled 却有 last_status=\'sent\'（暂停/取消后无外发）')
  })
})

/* ------------------------------------------------------------------ */
/* Layer B — real-kernel scenario coverage                             */
/* ------------------------------------------------------------------ */

const site = { siteUrl: SITE }
const mockProvider = {
  kind: 'mock',
  send: async () => ({ accepted: true, providerMessageId: 'mock-1' }),
}

async function schedulePending(db: D1Database, scheduleId: string, articleId: number, at: number, now: number): Promise<void> {
  const result = await schedulePublish(db, {
    scheduleId, articleId, version: 1, scheduledAt: at, timezone: 'Asia/Shanghai', actor: 'fixture', now,
  })
  expect(result.outcome).toBe('scheduled')
}

describe('reconcile-b4-facts (real-kernel scenarios)', () => {
  it('全链: 到期→租约→attempt→事件→Outbox 通过真实内核驱动并对账 ALIGNED', { timeout: 600_000 }, async () => {
    const ctx = await createKernelContext()
    const { db, query, dir } = ctx
    try {
      const article = await createDraftArticle(db)
      await schedulePending(db, 'sched-chain', article.articleId, T1, T0)

      const scan = await scanDueSchedules(db, { now: T1, ...site })
      expect(scan.fired).toBe(1)
      expect(scan.claimed).toBe(1)

      const eFired = eventIdFor(scheduledIntentId('sched-chain'))
      const [schedule] = await query<Record<string, unknown>>(
        `SELECT schedule_id, status, attempt_count, revision, claimed_at, lease_expires_at, lease_token, fired_event_id
         FROM publish_schedules WHERE schedule_id = 'sched-chain'`,
      )
      expect(schedule.status).toBe('fired')
      expect(schedule.fired_event_id).toBe(eFired)
      expect(schedule.attempt_count).toBe(1)
      expect(schedule.revision).toBe(1)
      expect(schedule.claimed_at).toBeNull()
      expect(schedule.lease_expires_at).toBeNull()
      expect(schedule.lease_token).toBeNull()

      const attempts = await query<Record<string, unknown>>(
        `SELECT attempt_key, attempt_no, outcome, finished_at, error FROM publish_attempts WHERE schedule_id = 'sched-chain'`,
      )
      expect(attempts).toHaveLength(1)
      expect(attempts[0].outcome).toBe('fired')
      expect(attempts[0].attempt_key).toBe(scheduledAttemptKey('sched-chain', 1))

      const events = await query<Record<string, unknown>>(`SELECT * FROM publish_events WHERE intent_id = '${scheduledIntentId('sched-chain')}'`)
      expect(events).toHaveLength(1)
      expect(events[0].event_id).toBe(eFired)
      expect(events[0].evidence_sha256).toBe(evidenceDigest(String(events[0].payload)))

      const outboxes = await query<Record<string, unknown>>(`SELECT * FROM publish_outbox WHERE event_id = '${eFired}'`)
      expect(outboxes).toHaveLength(1)
      expect(outboxes[0].outbox_id).toBe(outboxIdFor(eFired))
      expect(outboxes[0].kind).toBe('public-receipt')

      const formals = await query<Record<string, unknown>>(`SELECT * FROM formal_publications WHERE article_id = ${article.articleId}`)
      expect(formals).toHaveLength(1)
      expect(formals[0].event_id).toBe(eFired)

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB4(dir, report, ['--candidate', CANDIDATE, '--now', String(T1)])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('schedules=1')
      expect(aligned.stdout).toContain('attempts=1')
      expect(aligned.stdout).toContain('events=1')
      expect(aligned.stdout).toContain('outboxes=1')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('补偿重扫幂等: 崩溃重扫回收租约、废弃孤儿尝试、确定性 intent 守卫不重复事件/Outbox', { timeout: 600_000 }, async () => {
    const ctx = await createKernelContext()
    const { db, query, dir } = ctx
    try {
      const article = await createDraftArticle(db)
      await schedulePending(db, 'sched-rescan', article.articleId, T1, T0)
      const eFired = eventIdFor(scheduledIntentId('sched-rescan'))

      // Simulate a crashed FIRST execution that claimed the due schedule but
      // died BEFORE the confirm batch committed: claimed with an expired lease
      // + a running attempt, and no event/outbox/formal written yet.
      await db
        .prepare(
          `UPDATE publish_schedules
           SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, lease_token = 'crash-token',
               attempt_count = 1, revision = 1
           WHERE schedule_id = 'sched-rescan'`,
        )
        .bind(T1 - 10, T1 + 20)
        .run()
      await db
        .prepare(
          `INSERT INTO publish_attempts (attempt_key, schedule_id, attempt_no, started_at, created_at, updated_at)
           VALUES (?, 'sched-rescan', 1, ?, ?, ?)`,
        )
        .bind(scheduledAttemptKey('sched-rescan', 1), T1 - 10, T1 - 10, T1 - 10)
        .run()

      // Compensation scan at T1+60: the expired lease is reclaimed, the orphan
      // attempt is abandoned, and the confirm kernel fires the deterministic
      // event exactly ONCE (idempotent re-scan).
      const second = await scanDueSchedules(db, { now: T1 + 60, ...site })
      expect(second.claimed).toBe(1)
      expect(second.fired).toBe(1)

      const attempts = await query<Record<string, unknown>>(
        `SELECT attempt_no, outcome, error FROM publish_attempts WHERE schedule_id = 'sched-rescan' ORDER BY attempt_no ASC`,
      )
      expect(attempts.map((a) => a.outcome)).toEqual(['abandoned', 'fired'])

      const events = await query<Record<string, unknown>>(`SELECT event_id FROM publish_events WHERE intent_id = '${scheduledIntentId('sched-rescan')}'`)
      expect(events).toHaveLength(1) // 确定性 intent id — 单事件守卫，重扫不重复
      const outboxes = await query<Record<string, unknown>>(`SELECT outbox_id FROM publish_outbox WHERE event_id = '${eFired}'`)
      expect(outboxes).toHaveLength(1)
      const formals = await query<Record<string, unknown>>(`SELECT article_id FROM formal_publications WHERE article_id = ${article.articleId}`)
      expect(formals).toHaveLength(1)

      const [schedule] = await query<Record<string, unknown>>(`SELECT status, attempt_count, revision, fired_event_id FROM publish_schedules WHERE schedule_id = 'sched-rescan'`)
      expect(schedule.status).toBe('fired')
      expect(schedule.attempt_count).toBe(2)
      expect(schedule.fired_event_id).toBe(eFired)

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB4(dir, report, ['--candidate', CANDIDATE, '--now', String(T1 + 60)])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('attempts=2')
      expect(aligned.stdout).toContain('events=1')
      expect(aligned.stdout).toContain('outboxes=1')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('暂停/取消后无外发: 暂停/取消后执行器零外发，对账 ALIGNED；伪造发送事实则 DRIFT', { timeout: 600_000 }, async () => {
    // -- positive: pause + cancel drive the executor to send NOTHING ------
    const ctx = await createKernelContext()
    const { db, query, dir } = ctx
    try {
      const a = await createDraftArticle(db)
      const b = await createDraftArticle(db)
      await schedulePending(db, 'sched-pause-me', a.articleId, T2, T0)
      await schedulePending(db, 'sched-cancel-me', b.articleId, T3, T0)

      const pause = await pauseSchedule(db, { operationId: 'op-pause-me', scheduleId: 'sched-pause-me', actor: 'fixture', now: T2 })
      expect(pause.outcome).toBe('paused')
      const cancel = await cancelScheduleControl(db, { operationId: 'op-cancel-me', scheduleId: 'sched-cancel-me', actor: 'fixture', now: T3 })
      expect(cancel.outcome).toBe('cancelled')

      await setEmailRemindersConfig(db, {
        enabled: true,
        policy: {
          recipients: ['author@example.com'],
          fromAddress: 'no-reply@blog.example.test',
          thresholdSeconds: 1,
          quietHours: null,
          utcOffsetMinutes: 480,
          cooldownSeconds: 10,
        },
        now: T3,
      })
      const run = await runEmailReminders(db, { now: T4, provider: mockProvider })
      expect(run.outcome).toBe('ran')
      if (run.outcome === 'ran') {
        expect(run.summary.open).toBe(0)
        expect(run.summary.eligible).toBe(0)
        expect(run.summary.attempted).toBe(0)
        expect(run.summary.sent).toBe(0)
        expect(run.summary.digestEmails).toBe(0)
      }
      const deliveries = await query<Record<string, unknown>>(`SELECT * FROM email_deliveries`)
      expect(deliveries).toHaveLength(0) // 无外发事实

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB4(dir, report, ['--candidate', CANDIDATE, '--now', String(T4)])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('deliveries=0')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }

    // -- negative: a wrongly-wired source carrying an open notification +
    //    a `sent` delivery for a cancelled schedule must be caught ---------
    const ctx2 = await createKernelContext()
    const { db: db2, dir: dir2 } = ctx2
    try {
      const art = await createDraftArticle(db2)
      await schedulePending(db2, 'sched-cancel-bad', art.articleId, T3, T0)
      const cancelled = await cancelScheduleControl(db2, { operationId: 'op-cancel-bad', scheduleId: 'sched-cancel-bad', actor: 'fixture', now: T3 })
      expect(cancelled.outcome).toBe('cancelled')

      // Fabricated (wrong wiring): an open notification + a sent delivery for
      // a cancelled schedule — the reconciler must flag both.
      await recordNotification(db2, {
        notificationId: 'nf-bad-cancel',
        sourceType: 'schedule',
        sourceId: 'sched-cancel-bad',
        title: '已取消（错误保留）',
        now: T4,
      })
      await db2
        .prepare(
          `INSERT INTO email_deliveries
             (source_type, source_id, last_attempt_at, last_sent_at, sent_count, last_status, last_error, updated_at)
           VALUES ('schedule', 'sched-cancel-bad', ?, ?, 1, 'sent', NULL, ?)`,
        )
        .bind(T4, T4, T4)
        .run()

      await ctx2.dispose()
      const report = freshReport()
      const drifted = runReconcileB4(dir2, report, ['--candidate', CANDIDATE, '--now', String(T4)])
      expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
      expect(drifted.stdout).toContain('verdict=DRIFT')
      const text = readFileSync(report, 'utf8')
      expect(text).toContain('已 cancelled 却仍有未处理通知')
      expect(text).toContain('已 cancelled 却有 last_status=\'sent\'（暂停/取消后无外发）')
    } finally {
      await ctx2.dispose().catch(() => undefined)
    }
  })
})