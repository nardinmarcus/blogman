#!/usr/bin/env node
/**
 * B4-G — batch-4 acceptance fixture (issue #45).
 *
 * Read-only reconciliation of the eight batch-4 fact surfaces over ONE
 * immutable candidate (zero production writes). The fixture is meant to run
 * locally / in CI against a D1 state that was migrated, backfilled and driven
 * through the batch-4 command kernels (scheduled scan / schedule control /
 * notification / email executor) from the same checked-out commit. Only
 * SELECT statements are issued through `wrangler d1 execute`; any difference
 * exits 1 and prints a per-item report.
 *
 * Reconciled surfaces (strictly mapped to their owning tables):
 *
 *   1. 排期 (schedule)   — publish_schedules: the status machine restricted to
 *       pending / paused / fired / stale / cancelled (claimed is the transient
 *       in-flight state owned by the lease surface). fired MUST carry its
 *       fired_event_id; stale MUST carry its stale_reason; a re-armed pending
 *       row (attempt_count > 0) MUST carry its next_attempt_at window.
 *   2. 租约 (lease)      — the claimed state: a claimed row MUST own a
 *       claimed_at / lease_expires_at / lease_token triple with expiry after
 *       the claim instant; no non-claimed row may carry a claimed_at. With
 *       `--now` a claim whose lease already lapsed (crashed runner that was
 *       never reclaimed) is an orphan and blocks acceptance.
 *   3. 尝试 (attempt)    — publish_attempts: the immutable per-execution rows.
 *       attempt_key == sched-attempt:<schedule>:<no> (deterministic), per
 *       schedule attempt_no is 1..N contiguous, schedule.attempt_count == N,
 *       every row is finalized exactly once (outcome ⇔ finished_at), at most
 *       one running row per schedule and only under a live claim, the LAST
 *       attempt's outcome agrees with the schedule's terminal status state,
 *       an `abandoned` outcome is never the last row, and every error fact is
 *       sanitized/bounded.
 *   4. 事件 (events)     — a fired schedule's fired_event_id is the canonical
 *       derivation event:sched:<id>; the row exists in publish_events with the
 *       deterministic intent sched:<id>, matching article/version, lifecycle
 *       published, and tamper-evident (evidence_sha256 == sha256(payload)).
 *       Every sched- intent event maps back to exactly one fired schedule.
 *   5. Outbox            — one outbox row per fired event with the canonical
 *       outbox:event:<id> id, kind public-receipt, matching article/version
 *       and delivered semantics (delivered ⇔ delivered_at IS NOT NULL).
 *   6. 控制操作 (control)– schedule_control_ops: every recorded op references
 *       an existing schedule, its action/outcome pairing is valid, and the
 *       LATEST recorded op for a schedule agrees with its current status
 *       (pause ⇒ paused, cancel ⇒ cancelled, publish_now ⇒ fired).
 *   7. 通知 (notify)     — activity_notifications: sources reference existing
 *       facts, dedup by (source_type, source_id) holds, and a paused /
 *       cancelled schedule must NOT present an open notification (the author
 *       already decided — no outstanding reminder).
 *   8. 邮件 (email)      — email_reminder_config + email_deliveries: at most
 *       one config row with a valid policy, and every delivery fact is
 *       internally consistent (sent ⇒ last_sent_at + sent_count ≥ 1 + no
 *       error; failed ⇒ bounded error; skipped ⇒ never attempted) and
 *       references a real notification source. 「暂停/取消后无外发」: a
 *       paused / cancelled schedule source must NEVER carry a `sent` fact.
 *
 * Optionally binds the immutable candidate: when `--candidate <sha>` is given
 * the migration ledger's last applied candidate identity must equal it.
 * Optionally passes a frozen clock `--now <epoch>` to detect orphaned leases /
 * in-flight attempts a settled acceptance snapshot must not contain.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-b4-facts.mjs --local \
 *     [--candidate <git-rev>] [--now <epoch>] [--persist-to <dir>] \
 *     [--database <name>] [--config <path>] [--report <path>]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scheduledKernelUrl = pathToFileURL(join(repoRoot, 'lib', 'scheduled-publish', 'kernel.ts')).href
const firstPublishUrl = pathToFileURL(join(repoRoot, 'lib', 'first-publish', 'kernel.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b45')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-b4')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-b4-facts-report.md')

/** Bounds copied from the sanctioned kernels — error facts must stay bounded. */
const SCHEDULED_PUBLISH_ATTEMPT_ERROR_LIMIT = 500
const EMAIL_REMINDER_ERROR_LIMIT = 513 // 512 chars + optional '…' suffix

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-b4-facts.mjs --local|--remote ' +
      '[--candidate <sha>] [--now <epoch>] [--persist-to <dir>] [--database <name>] ' +
      '[--config <path>] [--report <path>]',
  )
}

function parseArgs(argv) {
  const args = {
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    persistTo: DEFAULT_PERSIST,
    report: DEFAULT_REPORT,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--local') args.local = true
    else if (flag === '--remote') args.remote = true
    else if (flag === '--candidate') args.candidate = argv[++i]
    else if (flag === '--now') args.now = Number(argv[++i])
    else if (flag === '--persist-to') args.persistTo = resolve(argv[++i])
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = resolve(argv[++i])
    else if (flag === '--report') args.report = resolve(argv[++i])
    else {
      usage()
      process.exit(2)
    }
  }
  if (!args.local && !args.remote) {
    usage()
    process.exit(2)
  }
  return args
}

/* ------------------------------------------------------------------ */
/* single read-only wrangler pass (11 SELECT groups, one spawn)        */
/* ------------------------------------------------------------------ */

const READ_STATEMENTS = [
  'SELECT candidate_id FROM migration_ledger ORDER BY number DESC LIMIT 1',
  'SELECT id, post_ref FROM articles ORDER BY id',
  `SELECT schedule_id, article_id, version, scheduled_at, timezone, status,
          attempt_count, last_error, claimed_at, lease_expires_at, lease_token,
          revision, next_attempt_at, stale_reason, fired_event_id, created_at, updated_at
     FROM publish_schedules ORDER BY id ASC`,
  `SELECT attempt_key, schedule_id, attempt_no, started_at, finished_at, outcome, error, created_at, updated_at
     FROM publish_attempts ORDER BY id ASC`,
  `SELECT event_id, intent_id, article_id, version, slug, lifecycle, first_published_at,
          evidence_sha256, payload, created_at
     FROM publish_events ORDER BY id ASC`,
  `SELECT outbox_id, event_id, article_id, version, kind, status, attempts, delivered_at
     FROM publish_outbox ORDER BY id ASC`,
  `SELECT article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id
     FROM formal_publications ORDER BY article_id ASC`,
  `SELECT id, operation_id, schedule_id, action, result, created_at
     FROM schedule_control_ops ORDER BY id ASC`,
  `SELECT notification_id, source_type, source_id, title, status, acknowledged, created_at, updated_at
     FROM activity_notifications ORDER BY id ASC`,
  `SELECT key, enabled, recipients_json, threshold_seconds, quiet_start_minute, quiet_end_minute,
          utc_offset_minutes, cooldown_seconds
     FROM email_reminder_config ORDER BY id ASC`,
  `SELECT source_type, source_id, last_attempt_at, last_sent_at, sent_count, last_status, last_error
     FROM email_deliveries ORDER BY id ASC`,
]

function d1ReadAll(args) {
  const result = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    [
      'd1', 'execute', args.database,
      ...(args.local ? ['--local'] : ['--remote']),
      ...(args.local ? ['--persist-to', args.persistTo] : []),
      '--config', args.config,
      '--command', READ_STATEMENTS.join(';\n'),
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(
      `wrangler d1 execute failed (is every batch-4 table present? run the ` +
        `apply-*-ddl.mjs scripts or the ensure* DDL channel first): ${detail.slice(0, 600)}`,
    )
  }
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected wrangler output: ${String(result.stdout).slice(0, 200)}`)
  }
  return parsed.map((entry) => entry.results ?? [])
}

/* ------------------------------------------------------------------ */
/* canonical kernels (same implementations the command layer uses)     */
/* ------------------------------------------------------------------ */

async function loadKernels() {
  const scheduled = (await import(scheduledKernelUrl)).default ?? (await import(scheduledKernelUrl))
  const firstPublish = (await import(firstPublishUrl)).default ?? (await import(firstPublishUrl))
  return {
    scheduledIntentId: scheduled.scheduledIntentId,
    scheduledAttemptKey: scheduled.scheduledAttemptKey,
    eventIdFor: firstPublish.eventIdFor,
    outboxIdFor: firstPublish.outboxIdFor,
    evidenceDigest: firstPublish.evidenceDigest,
  }
}

/* ------------------------------------------------------------------ */
/* fact reconciliation                                                 */
/* ------------------------------------------------------------------ */

const SCHEDULE_STATUSES = new Set(['pending', 'paused', 'claimed', 'fired', 'stale', 'cancelled'])
const ATTEMPT_OUTCOMES = new Set(['fired', 'stale', 'retried', 'failed', 'abandoned', 'cancelled'])
const CONTROL_ACTION_OUTCOME = {
  pause: 'paused',
  reconfirm: 'reconfirmed',
  reschedule: 'rescheduled',
  cancel: 'cancelled',
  publish_now: 'published',
}

function reconcile(args, kernels, rows, drift) {
  const schedulesById = new Map(rows.schedules.map((s) => [String(s.schedule_id), s]))
  const attemptsBySchedule = new Map()
  for (const a of rows.attempts) {
    const key = String(a.schedule_id)
    if (!attemptsBySchedule.has(key)) attemptsBySchedule.set(key, [])
    attemptsBySchedule.get(key).push(a)
  }
  for (const list of attemptsBySchedule.values()) list.sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no))
  const eventsByEventId = new Map(rows.events.map((e) => [String(e.event_id), e]))
  const outboxesByEvent = new Map(rows.outboxes.map((o) => [String(o.event_id), o]))
  const formalsByArticle = new Map(rows.formals.map((f) => [Number(f.article_id), f]))
  const opsBySchedule = new Map()
  for (const op of rows.controlOps) {
    const key = String(op.schedule_id)
    if (!opsBySchedule.has(key)) opsBySchedule.set(key, [])
    opsBySchedule.get(key).push(op)
  }
  for (const list of opsBySchedule.values()) list.sort((a, b) => Number(a.id) - Number(b.id))

  /* ---- candidate binding ------------------------------------------ */
  if (args.candidate) {
    const ledger = rows.ledger[0]
    if (!ledger) {
      drift.push('候选绑定: migration_ledger 为空，无法绑定不可变候选')
    } else if (String(ledger.candidate_id) !== args.candidate) {
      drift.push(
        `候选漂移: ledger candidate_id=${String(ledger.candidate_id).slice(0, 12)}… ` +
          `!= 提供 --candidate=${args.candidate.slice(0, 12)}…`,
      )
    }
  }

  /* ---- 1. 排期 (schedule status machine) ----*/
  const articleIds = new Set(rows.articles.map((a) => Number(a.id)))
  for (const s of rows.schedules) {
    const sid = String(s.schedule_id)
    if (SCHEDULE_STATUSES.has(s.status) && !articleIds.has(Number(s.article_id))) {
      drift.push(`排期: 排期 ${sid} 引用的 article #${s.article_id} 不存在`)
    }
    if (!SCHEDULE_STATUSES.has(s.status)) {
      drift.push(`排期: 排期 ${sid} 未知状态 '${s.status}'`)
    }
    if (!(Number(s.article_id) > 0) || !(Number(s.version) > 0)) {
      drift.push(`排期: 排期 ${sid} 绑定无效 article/version`)
    }
    if (!(Number(s.scheduled_at) > 0)) drift.push(`排期: 排期 ${sid} scheduled_at 无效`)
    if (!String(s.timezone || '').trim()) drift.push(`排期: 排期 ${sid} 缺少时区`)

    if (s.status === 'fired') {
      if (s.fired_event_id == null || String(s.fired_event_id) === '') {
        drift.push(`排期: 已触发排期 ${sid} 缺少 fired_event_id`)
      }
    } else if (s.fired_event_id != null) {
      drift.push(`排期: 未触发排期 ${sid} 却残留 fired_event_id`)
    }
    if (s.status === 'stale' && (s.stale_reason == null || String(s.stale_reason) === '')) {
      drift.push(`排期: 停滞排期 ${sid} 缺少 stale_reason`)
    }
    if (s.status === 'pending' && Number(s.attempt_count) === 0 && s.next_attempt_at != null) {
      drift.push(`排期: 全新排期 ${sid} 不应携带 next_attempt_at`)
    }
    if (s.status === 'pending' && Number(s.attempt_count) > 0 && s.next_attempt_at == null) {
      drift.push(`排期: 重排排期 ${sid} (attempt_count=${s.attempt_count}) 缺少 next_attempt_at 退避窗口`)
    }
    if (s.status === 'claimed' && Number(s.attempt_count) === 0) {
      drift.push(`排期: 已认领排期 ${sid} 的 attempt_count 不得为 0`)
    }
  }

  /* ---- 2. 租约 (lease ownership) ---------------------------------- */
  for (const s of rows.schedules) {
    const sid = String(s.schedule_id)
    if (s.status === 'claimed') {
      if (s.claimed_at == null || s.lease_expires_at == null || s.lease_token == null) {
        drift.push(`租约: 已认领排期 ${sid} 的租约三元组 (claimed_at/lease_expires_at/lease_token) 不完整`)
      } else if (Number(s.lease_expires_at) <= Number(s.claimed_at)) {
        drift.push(`租约: 排期 ${sid} 租约到期时间 ${s.lease_expires_at} 不晚于认领时间 ${s.claimed_at}`)
      }
      if (String(s.lease_token || '').trim() === '') {
        drift.push(`租约: 已认领排期 ${sid} 的 lease_token 为空`)
      }
      if (args.now != null && Number(s.lease_expires_at) <= Number(args.now)) {
        drift.push(`租约: 排期 ${sid} 的租约已过期 (lease_expires_at=${s.lease_expires_at} <= now=${args.now}) — 孤立认领未被回收`)
      }
    } else if (s.claimed_at != null) {
      drift.push(`租约: 非 claimed 排期 ${sid} (status='${s.status}') 残留 claimed_at=${s.claimed_at}`)
    }
    if (Number(s.revision) < Number(s.attempt_count)) {
      drift.push(`租约: 排期 ${sid} revision=${s.revision} < attempt_count=${s.attempt_count} (每次认领同时递增)`)
    }
  }

  /* ---- 3. 尝试 (immutable attempt facts) --------------------------- */
  for (const s of rows.schedules) {
    const sid = String(s.schedule_id)
    const list = attemptsBySchedule.get(sid) ?? []
    if (list.length !== Number(s.attempt_count)) {
      drift.push(`尝试: 排期 ${sid} attempt_count=${s.attempt_count} 但存在 ${list.length} 条尝试事实`)
      continue
    }
    const running = list.filter((a) => a.finished_at == null)
    if (running.length > 1) {
      drift.push(`尝试: 排期 ${sid} 有 ${running.length} 条进行中尝试（不可变事实最多一条运行中）`)
    }
    let previous = 0
    for (const a of list) {
      const no = Number(a.attempt_no)
      const expectedKey = kernels.scheduledAttemptKey(sid, no)
      if (no !== previous + 1) {
        drift.push(`尝试: 排期 ${sid} 尝试序号不连续（期望 ${previous + 1}，实际 ${no}）`)
      }
      previous = no
      if (String(a.attempt_key) !== expectedKey) {
        drift.push(`尝试: 尝试 ${a.attempt_key} 不是 排期 ${sid} 第 ${no} 次的规范键 ${expectedKey}`)
      }
      if ((a.outcome == null) !== (a.finished_at == null)) {
        drift.push(`尝试: 排期 ${sid} 第 ${no} 次 outcome 与 finished_at 不一致（outcome 与终态必须同时存在）`)
      }
      if (a.outcome != null && !ATTEMPT_OUTCOMES.has(a.outcome)) {
        drift.push(`尝试: 尝试 ${a.attempt_key} 未知 outcome '${a.outcome}'`)
      }
      if (a.outcome != null && a.error != null && String(a.error).length > SCHEDULED_PUBLISH_ATTEMPT_ERROR_LIMIT) {
        drift.push(`尝试: 尝试 ${a.attempt_key} 的 error 超出长度上限 ${SCHEDULED_PUBLISH_ATTEMPT_ERROR_LIMIT}`)
      }
    }
    if (running.length === 1) {
      const sched = schedulesById.get(sid)
      if (!sched || sched.status !== 'claimed') {
        drift.push(`尝试: 排期 ${sid} 有进行中尝试但无有效 claimed 租约`)
      } else if (args.now != null && Number(sched.lease_expires_at) <= Number(args.now)) {
        drift.push(`尝试: 排期 ${sid} 的进行中尝试租约已过期 — 孤立运行片段`)
      }
    }
    const last = list[list.length - 1]
    if (!last || last.outcome == null) continue
    const sched = schedulesById.get(sid)
    if (!sched) continue
    if (last.outcome === 'abandoned') {
      drift.push(`尝试: 排期 ${sid} 最后一条尝试不可是 abandoned（被回收后必有新尝试）`)
    } else if (last.outcome === 'fired' && sched.status !== 'fired') {
      drift.push(`尝试: 排期 ${sid} 最后尝试为 fired 但状态为 '${sched.status}'`)
    } else if (last.outcome === 'cancelled' && sched.status !== 'cancelled') {
      drift.push(`尝试: 排期 ${sid} 最后尝试为 cancelled 但状态为 '${sched.status}'`)
    } else if (last.outcome === 'retried') {
      if (sched.status !== 'pending' || sched.next_attempt_at == null) {
        drift.push(`尝试: 排期 ${sid} 最后尝试为 retried 但未回到 pending + next_attempt_at`)
      }
    } else if (last.outcome === 'stale' && sched.status !== 'stale' && sched.status !== 'pending') {
      drift.push(`尝试: 排期 ${sid} 最后尝试为 stale 但状态为 '${sched.status}'（应 stale 或已重确认 pending）`)
    } else if (last.outcome === 'failed' && sched.status !== 'stale' && sched.status !== 'pending') {
      drift.push(`尝试: 排期 ${sid} 最后尝试为 failed（重试耗尽）但状态为 '${sched.status}'（应 stale 或已重确认 pending）`)
    }
  }
  // Orphan attempts pointing at a schedule that no longer exists.
  for (const [sid] of attemptsBySchedule) {
    if (!schedulesById.has(sid)) drift.push(`尝试: 尝试事实引用不存在的排期 ${sid}`)
  }

  /* ---- 4. 事件 (publish events from fired schedules) -------------- */
  for (const s of rows.schedules) {
    if (s.status !== 'fired' || s.fired_event_id == null) continue
    const sid = String(s.schedule_id)
    const intentId = kernels.scheduledIntentId(sid)
    const expectedEventId = kernels.eventIdFor(intentId)
    if (String(s.fired_event_id) !== expectedEventId) {
      drift.push(`事件: 排期 ${sid} fired_event_id=${s.fired_event_id} 不是规范派生值 ${expectedEventId}`)
      continue
    }
    const ev = eventsByEventId.get(String(s.fired_event_id))
    if (!ev) {
      drift.push(`事件: 已触发排期 ${sid} 缺少其发布事件 ${expectedEventId}`)
      continue
    }
    if (String(ev.intent_id) !== intentId) {
      drift.push(`事件: 事件 ${ev.event_id} 的 intent_id=${ev.intent_id} != 排期 ${sid} 的 ${intentId}`)
    }
    if (Number(ev.article_id) !== Number(s.article_id) || Number(ev.version) !== Number(s.version)) {
      drift.push(`事件: 事件 ${ev.event_id} 的 article/version 与排期 ${sid} 不一致`)
    }
    if (String(ev.lifecycle) !== 'published') {
      drift.push(`事件: 事件 ${ev.event_id} lifecycle='${ev.lifecycle}' 非 published`)
    }
    const expected = kernels.evidenceDigest(String(ev.payload))
    if (String(ev.evidence_sha256) !== expected) {
      drift.push(`事件: 事件 ${ev.event_id} 证据哈希不匹配 stored=${String(ev.evidence_sha256).slice(0, 12)}… expected=${expected.slice(0, 12)}…`)
    }
    const formal = formalsByArticle.get(Number(s.article_id))
    if (!formal) {
      drift.push(`事件: 已触发排期 ${sid} 无正式发布事实（定时发布必须落地 formal_publications）`)
    } else if (String(formal.event_id) !== String(s.fired_event_id)) {
      drift.push(`事件: 正式发布 event_id=${formal.event_id} != 排期 ${sid} fired_event_id=${s.fired_event_id}`)
    }
  }
  // Every sched- intent event must map back to exactly one fired schedule.
  for (const ev of rows.events) {
    const intent = String(ev.intent_id)
    if (!intent.startsWith('sched:')) continue
    const expectedEventId = kernels.eventIdFor(intent)
    if (String(ev.event_id) !== expectedEventId) {
      drift.push(`事件: 事件 ${ev.event_id} 不是 intent ${intent} 的规范派生值 ${expectedEventId}`)
    }
    const sid = intent.slice('sched:'.length)
    const sched = schedulesById.get(sid)
    if (!sched) {
      drift.push(`事件: 事件 ${ev.event_id} 的 intent ${intent} 无对应排期 ${sid}`)
    } else if (sched.status !== 'fired') {
      drift.push(`事件: 排期 ${sid} 已产生事件 ${ev.event_id} 却仍为 '${sched.status}'（sched 事件只属于 fired）`)
    }
  }

  /* ---- 5. Outbox -------------------------------------------------- */
  for (const ev of rows.events) {
    if (!String(ev.intent_id).startsWith('sched:')) continue
    const expectedOutboxId = kernels.outboxIdFor(String(ev.event_id))
    const o = outboxesByEvent.get(String(ev.event_id))
    if (!o) {
      drift.push(`Outbox: 事件 ${ev.event_id} 缺少 outbox 行（事件与 outbox 必须同一事务写入）`)
      continue
    }
    if (String(o.outbox_id) !== expectedOutboxId) {
      drift.push(`Outbox: outbox_id ${o.outbox_id} 不是事件 ${ev.event_id} 的规范派生值 ${expectedOutboxId}`)
    }
    if (Number(o.article_id) !== Number(ev.article_id) || Number(o.version) !== Number(ev.version)) {
      drift.push(`Outbox: ${o.outbox_id} 的 article/version 与事件 ${ev.event_id} 不一致`)
    }
    if (String(o.kind) !== 'public-receipt') {
      drift.push(`Outbox: ${o.outbox_id} kind='${o.kind}' 非 public-receipt`)
    }
    const delivered = o.status === 'delivered'
    const hasMarker = o.delivered_at !== null && o.delivered_at !== undefined
    if (delivered !== hasMarker) {
      drift.push(`Outbox: ${o.outbox_id} status='${o.status}' 与 delivered_at 标记不一致 (delivered_at=${o.delivered_at})`)
    }
  }
  for (const o of rows.outboxes) {
    if (!eventsByEventId.has(String(o.event_id))) {
      drift.push(`Outbox: ${o.outbox_id} 引用不存在的 event ${o.event_id}`)
    }
  }

  /* ---- 6. 控制操作 (schedule_control_ops ledger) ------------------- */
  for (const op of rows.controlOps) {
    const opId = String(op.operation_id)
    const sched = schedulesById.get(String(op.schedule_id))
    if (!sched) {
      drift.push(`控制操作: 操作 ${opId} 引用不存在的排期 ${op.schedule_id}`)
      continue
    }
    const expectedOutcome = CONTROL_ACTION_OUTCOME[op.action]
    if (!expectedOutcome) {
      drift.push(`控制操作: 操作 ${opId} 未知动作 '${op.action}'`)
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse(String(op.result))
    } catch {
      drift.push(`控制操作: 操作 ${opId} 的 result 不是有效 JSON`)
      continue
    }
    if (parsed == null || parsed.outcome !== expectedOutcome) {
      drift.push(`控制操作: 操作 ${opId} outcome='${parsed?.outcome}' 与 action='${op.action}' 不符（应为 ${expectedOutcome}）`)
    }
    if (parsed != null && parsed.scheduleId !== undefined && String(parsed.scheduleId) !== String(op.schedule_id)) {
      drift.push(`控制操作: 操作 ${opId} 记录的 scheduleId=${parsed.scheduleId} 与排期 ${op.schedule_id} 不一致`)
    }
    if (!(Number(op.created_at) > 0)) drift.push(`控制操作: 操作 ${opId} created_at 无效`)
  }
  for (const s of rows.schedules) {
    const sid = String(s.schedule_id)
    const ops = opsBySchedule.get(sid) ?? []
    if (ops.length === 0) continue
    const latest = ops[ops.length - 1]
    if (latest.action === 'cancel' && s.status !== 'cancelled') {
      drift.push(`控制操作: 排期 ${sid} 最新操作是 cancel 但状态为 '${s.status}'（cancel 是终态）`)
    }
    if (latest.action === 'pause' && s.status !== 'paused') {
      drift.push(`控制操作: 排期 ${sid} 最新操作是 pause 但状态为 '${s.status}'`)
    }
    if (latest.action === 'publish_now' && s.status !== 'fired') {
      drift.push(`控制操作: 排期 ${sid} 最新操作是 publish_now 但状态为 '${s.status}'（成功发布必为 fired）`)
    }
    if (s.status === 'pending' && (latest.action === 'pause' || latest.action === 'cancel' || latest.action === 'publish_now')) {
      drift.push(`控制操作: 排期 ${sid} 状态为 pending 但最新操作是 '${latest.action}'`)
    }
  }

  /* ---- 7. 通知 (activity notifications) --------------------------- */
  for (const n of rows.notifications) {
    const sourceType = String(n.source_type)
    const sourceId = String(n.source_id)
    if (sourceType === 'schedule') {
      const sched = schedulesById.get(sourceId)
      if (!sched) {
        drift.push(`通知: 通知 ${n.notification_id} 的源排期 ${sourceId} 不存在`)
      } else if (n.status === 'open' && (sched.status === 'paused' || sched.status === 'cancelled')) {
        drift.push(`通知: 排期 ${sourceId} 已 ${sched.status} 却仍有未处理通知 ${n.notification_id}`)
      }
    } else if (sourceType === 'event') {
      if (!eventsByEventId.has(sourceId)) {
        drift.push(`通知: 通知 ${n.notification_id} 的源事件 ${sourceId} 不存在`)
      }
    }
  }

  /* ---- 8. 邮件 (email send facts) ---------------------------------- */
  if (rows.emailConfigs.length > 1) {
    drift.push(`邮件: email_reminder_config 存在 ${rows.emailConfigs.length} 行（应至多 1 行执行器配置）`)
  }
  for (const c of rows.emailConfigs) {
    if (String(c.key) !== 'email-reminders') {
      drift.push(`邮件: 配置行 key='${c.key}' 非法（应为 email-reminders）`)
    }
    if (String(c.enabled) !== '1' && String(c.enabled) !== '0') {
      drift.push(`邮件: 配置行 key=${c.key} enabled 非法`)
    }
    let recipients = null
    try {
      const parsed = JSON.parse(String(c.recipients_json))
      if (Array.isArray(parsed)) recipients = parsed
    } catch {
      recipients = null
    }
    if (recipients === null || !recipients.every((r) => typeof r === 'string' && r.trim().length > 0)) {
      drift.push(`邮件: 配置行 key=${c.key} recipients_json 必须是非空邮箱数组`)
    }
    if (!(Number(c.threshold_seconds) >= 0)) drift.push(`邮件: 配置行 threshold_seconds 非法`)
    if (!(Number(c.quiet_start_minute) >= 0 && Number(c.quiet_start_minute) <= 1439)) drift.push(`邮件: 配置行 quiet_start_minute 非法`)
    if (!(Number(c.quiet_end_minute) >= 0 && Number(c.quiet_end_minute) <= 1439)) drift.push(`邮件: 配置行 quiet_end_minute 非法`)
    if (!(Number(c.cooldown_seconds) >= 0)) drift.push(`邮件: 配置行 cooldown_seconds 非法`)
  }
  for (const d of rows.deliveries) {
    const sourceKey = `${d.source_type}:${d.source_id}`
    const hasSourceNotification = rows.notifications.some(
      (n) => String(n.source_type) === String(d.source_type) && String(n.source_id) === String(d.source_id),
    )
    if (!hasSourceNotification) {
      drift.push(`邮件: 源 ${sourceKey} 的发送事实无对应通知事实 (email 是通知适配器，不发明事实)`)
    }
    const status = String(d.last_status)
    const hasAttempt = d.last_attempt_at !== null && d.last_attempt_at !== undefined
    const hasSent = d.last_sent_at !== null && d.last_sent_at !== undefined
    const sentCount = Number(d.sent_count ?? 0)
    if (status === 'sent') {
      if (!hasSent || sentCount < 1) {
        drift.push(`邮件: 源 ${sourceKey} last_status='sent' 但缺 last_sent_at 或 sent_count<1`)
      }
      if (d.last_error !== null && d.last_error !== undefined) {
        drift.push(`邮件: 源 ${sourceKey} last_status='sent' 却残留 last_error`)
      }
    } else if (status === 'failed') {
      if (d.last_error == null || String(d.last_error) === '') {
        drift.push(`邮件: 源 ${sourceKey} last_status='failed' 但缺错误事实`)
      } else if (String(d.last_error).length > EMAIL_REMINDER_ERROR_LIMIT) {
        drift.push(`邮件: 源 ${sourceKey} 的错误事实超出长度上限 ${EMAIL_REMINDER_ERROR_LIMIT}`)
      }
      if (!hasAttempt) drift.push(`邮件: 源 ${sourceKey} last_status='failed' 但缺 last_attempt_at`)
    } else if (status === 'skipped') {
      if (hasAttempt || hasSent || sentCount !== 0) {
        drift.push(`邮件: 源 ${sourceKey} last_status='skipped' 却已有尝试/发送痕迹`)
      }
      if (d.last_error != null) drift.push(`邮件: 源 ${sourceKey} last_status='skipped' 却残留 last_error`)
    } else {
      drift.push(`邮件: 源 ${sourceKey} 未知 last_status '${status}'`)
    }
    if (hasSent && sentCount < 1) {
      drift.push(`邮件: 源 ${sourceKey} 有 last_sent_at 但 sent_count<1`)
    }
    if (hasAttempt && status === 'skipped') {
      drift.push(`邮件: 源 ${sourceKey} 有 last_attempt_at 但 last_status='skipped'`)
    }
    if (sourceKey.startsWith('schedule:')) {
      const sid = sourceKey.slice('schedule:'.length)
      const sched = schedulesById.get(sid)
      if (!sched) {
        drift.push(`邮件: 发送事实源排期 ${sid} 不存在`)
      } else if ((sched.status === 'paused' || sched.status === 'cancelled') && status === 'sent') {
        drift.push(`邮件: 排期 ${sid} 已 ${sched.status} 却有 last_status='sent'（暂停/取消后无外发）`)
      }
    }
  }
}

function renderReport({ args, drift, counts }) {
  const aligned = drift.length === 0
  const lines = []
  lines.push('# B4-G 批次 4 验收对账报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  if (args.candidate) lines.push(`- 候选绑定: \`${args.candidate}\``)
  if (args.now != null) lines.push(`- 冻结时钟: \`${args.now}\``)
  lines.push(`- 事实表计数: 排期 ${counts.schedules} · 尝试 ${counts.attempts} · 事件 ${counts.events} · ` +
    `Outbox ${counts.outboxes} · 正式发布 ${counts.formals} · 控制操作 ${counts.controlOps} · ` +
    `通知 ${counts.notifications} · 邮件配置 ${counts.emailConfigs} · 发送事实 ${counts.deliveries}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（八面事实完整，同一候选一致）' : 'DRIFT（存在事实缺失或篡改，阻断验收）'}`)
  lines.push('')
  if (drift.length === 0) {
    lines.push('## 差异清单')
    lines.push('')
    lines.push('（无）')
  } else {
    lines.push('## 差异清单')
    lines.push('')
    for (const item of drift) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('> 注：任何 排期 / 租约 / 尝试 / 事件 / Outbox / 控制操作 / 通知 / 邮件 差异都会阻断批次 4 验收（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.now != null && Number.isNaN(args.now)) {
    console.error('reconcile-b4-facts: --now must be an epoch second')
    process.exit(2)
  }
  mkdirSync(dirname(args.report), { recursive: true })

  const kernels = await loadKernels()
  const [ledger, articles, schedules, attempts, events, outboxes, formals,
    controlOps, notifications, emailConfigs, deliveries] = d1ReadAll(args)

  const rows = {
    ledger, articles, schedules, attempts, events, outboxes, formals,
    controlOps, notifications, emailConfigs, deliveries,
  }
  const counts = {
    schedules: schedules.length,
    attempts: attempts.length,
    events: events.length,
    outboxes: outboxes.length,
    formals: formals.length,
    controlOps: controlOps.length,
    notifications: notifications.length,
    emailConfigs: emailConfigs.length,
    deliveries: deliveries.length,
  }

  const drift = []
  reconcile(args, kernels, rows, drift)
  const uniqueDrift = [...new Set(drift)]
  drift.length = 0
  drift.push(...uniqueDrift)

  const aligned = drift.length === 0
  const report = renderReport({ args, drift, counts })
  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, report, 'utf8')

  console.log(
    `reconcile-b4-facts: schedules=${counts.schedules} attempts=${counts.attempts} events=${counts.events} ` +
      `outboxes=${counts.outboxes} formals=${counts.formals} controlOps=${counts.controlOps} ` +
      `notifications=${counts.notifications} deliveries=${counts.deliveries} ` +
      `drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

main().catch((error) => {
  console.error('reconcile-b4-facts failed:', error)
  process.exit(2)
})