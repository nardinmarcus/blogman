/**
 * B4-02 — schedule control command kernel (issue #41).
 *
 * Five independent, operation-id idempotent commands over a scheduled-publish
 * intent. Every command shares one driver: validate the envelope, replay a
 * previously recorded operation, load the schedule, apply its OWN status
 * precondition, then perform a single guarded conditional update and record
 * the operation in the ledger for audit. Cancel / pause / re-confirm /
 * reschedule never DELETE a schedule row and never touch publish facts — they
 * only flip `publish_schedules.status` (and optionally `version`/`scheduled_at`).
 *
 * publish-now is the only command that publishes: it routes the schedule's
 * EXACT bound version through the EXISTING B3-01 first-publish kernel
 * (`preparePublish` + `confirmPublish` with the deterministic sched intent /
 * prepare ids), so an immediate publish can never bypass the shared kernel or
 * the version / lifecycle / slug / content blockers it re-evaluates on live
 * state. A non-matching bound version is therefore blocked (never misfired) —
 * the author re-confirms first.
 *
 * Each command carries a deterministic `operationId`: an adopted operation
 * replays the first recorded result (idempotent — repeated commands never
 * double-apply), and the ledger keeps every action auditable.
 */

import type { Database } from '@/lib/repositories/schema'
import {
  FIRST_PUBLISH_DEFAULT_SITE_URL,
  confirmPublish,
  preparePublish,
} from '@/lib/first-publish'
import { scheduledIntentId, scheduledPrepareId } from '@/lib/scheduled-publish'
import type {
  PauseScheduleInput,
  ReconfirmScheduleInput,
  RescheduleScheduleInput,
  ScheduleControlAction,
  ScheduleControlInput,
  ScheduleControlOpRow,
  ScheduleControlResult,
  ScheduleRowLike,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone.length > 0
  } catch {
    return false
  }
}

const SCHEDULE_COLUMNS = `schedule_id, article_id, version, scheduled_at, timezone, status,
  stale_reason, last_error, claimed_at, lease_expires_at`

async function findSchedule(db: Database, scheduleId: string): Promise<ScheduleRowLike | null> {
  return db
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM publish_schedules WHERE schedule_id = ?`)
    .bind(scheduleId)
    .first<ScheduleRowLike>()
}

/** Deterministic intent / prepare ids — SAME channel the cron kernel uses. */
export function scheduledControlIntentId(scheduleId: string): string {
  return scheduledIntentId(scheduleId)
}

export function scheduledControlPrepareId(scheduleId: string): string {
  return scheduledPrepareId(scheduleId)
}

/* ------------------------------------------------------------------ */
/* operation ledger (idempotency + audit)                             */
/* ------------------------------------------------------------------ */

async function findOperation(db: Database, operationId: string): Promise<ScheduleControlOpRow | null> {
  return db
    .prepare(
      `SELECT id, operation_id, schedule_id, action, result, created_at
       FROM schedule_control_ops WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<ScheduleControlOpRow>()
}

/**
 * If this operation was already adopted, replay its recorded result — the same
 * action against the same schedule is idempotent; reusing an operation id on a
 * DIFFERENT schedule/action is a hard conflict (never silent).
 */
async function replayIfAdopted(
  db: Database,
  operationId: string,
  action: ScheduleControlAction,
  scheduleId: string,
): Promise<ScheduleControlResult | null> {
  const op = await findOperation(db, operationId)
  if (!op) return null
  if (op.schedule_id !== scheduleId || op.action !== action) {
    return { outcome: 'conflict', scheduleId, reason: 'operation-id-reused' }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(op.result) as Record<string, unknown>
  } catch {
    parsed = { outcome: 'applied' }
  }
  return {
    outcome: 'replayed',
    scheduleId: op.schedule_id,
    operationId: op.operation_id,
    action: op.action,
    existing: true,
    result: parsed,
  }
}

/** Record the operation result. UNIQUE(operation_id) resolves concurrent races to a replay. */
async function recordOperation(
  db: Database,
  operationId: string,
  scheduleId: string,
  action: ScheduleControlAction,
  result: ScheduleControlResult,
  now: number,
): Promise<ScheduleControlResult> {
  try {
    await db
      .prepare(
        `INSERT INTO schedule_control_ops (operation_id, schedule_id, action, result, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(operationId, scheduleId, action, JSON.stringify(result), now)
      .run()
    return result
  } catch {
    // Concurrent identical operation won the UNIQUE race → replay it.
    const adopted = await findOperation(db, operationId)
    if (adopted && adopted.schedule_id === scheduleId && adopted.action === action) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(adopted.result) as Record<string, unknown>
      } catch {
        parsed = { outcome: 'applied' }
      }
      return {
        outcome: 'replayed',
        scheduleId: adopted.schedule_id,
        operationId: adopted.operation_id,
        action: adopted.action,
        existing: true,
        result: parsed,
      }
    }
    throw new Error(`schedule-control: failed to record operation '${operationId}'`)
  }
}

function validateEnvelope(
  input: { scheduleId?: string; operationId?: string; actor?: string },
): string | null {
  if (!input.scheduleId || input.scheduleId.trim() === '') return 'scheduleId is required'
  if (!input.operationId || input.operationId.trim() === '') return 'operationId is required'
  if (!input.actor || input.actor.trim() === '') return 'actor is required'
  return null
}

/* ------------------------------------------------------------------ */
/* pause — suspend an armed intent, retain original time + version     */
/* ------------------------------------------------------------------ */

export async function pauseSchedule(db: Database, input: PauseScheduleInput): Promise<ScheduleControlResult> {
  const bad = validateEnvelope(input)
  if (bad) return { outcome: 'invalid', reason: bad }
  const now = input.now ?? unixNow()
  const reason = input.reason?.trim() ?? null

  const adopted = await replayIfAdopted(db, input.operationId, 'pause', input.scheduleId)
  if (adopted) return adopted

  const s = await findSchedule(db, input.scheduleId)
  if (!s) return { outcome: 'not-found', scheduleId: input.scheduleId }
  if (s.status === 'paused') {
    return recordOperation(db, input.operationId, s.schedule_id, 'pause', {
      outcome: 'paused',
      scheduleId: s.schedule_id,
      articleId: s.article_id,
      version: s.version,
      scheduledAt: s.scheduled_at,
      timezone: s.timezone,
      pausedAt: now,
      reason,
    }, now)
  }
  if (s.status !== 'pending' && s.status !== 'claimed') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: `cannot pause a schedule in state '${s.status}'`,
    }
  }

  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'paused', claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status IN ('pending', 'claimed')`,
    )
    .bind(now, s.schedule_id)
    .run()

  const result: ScheduleControlResult = {
    outcome: 'paused',
    scheduleId: s.schedule_id,
    articleId: s.article_id,
    version: s.version,
    scheduledAt: s.scheduled_at,
    timezone: s.timezone,
    pausedAt: now,
    reason,
  }
  return recordOperation(db, input.operationId, s.schedule_id, 'pause', result, now)
}

/* ------------------------------------------------------------------ */
/* reconfirm — bind an EXACT new saved version and re-arm              */
/* ------------------------------------------------------------------ */

export async function reconfirmSchedule(db: Database, input: ReconfirmScheduleInput): Promise<ScheduleControlResult> {
  const bad = validateEnvelope(input)
  if (bad) return { outcome: 'invalid', reason: bad }
  if (!Number.isInteger(input.newVersion) || input.newVersion <= 0) {
    return { outcome: 'invalid', reason: 'newVersion must be a positive integer' }
  }
  const now = input.now ?? unixNow()

  const adopted = await replayIfAdopted(db, input.operationId, 'reconfirm', input.scheduleId)
  if (adopted) return adopted

  const s = await findSchedule(db, input.scheduleId)
  if (!s) return { outcome: 'not-found', scheduleId: input.scheduleId }
  if (s.status === 'fired' || s.status === 'cancelled') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: `cannot re-confirm a schedule in state '${s.status}'`,
    }
  }
  // Idempotent no-op: already pending OR paused/stale bound to this version.
  if (s.version === input.newVersion && s.status !== 'claimed') {
    return recordOperation(db, input.operationId, s.schedule_id, 'reconfirm', {
      outcome: 'reconfirmed',
      scheduleId: s.schedule_id,
      articleId: s.article_id,
      version: s.version,
      scheduledAt: s.scheduled_at,
      timezone: s.timezone,
      reconfirmedAt: now,
    }, now)
  }

  // "未保存时不能重新确认" — the new version must be a real saved version fact.
  const saved = await db
    .prepare(
      `SELECT 1 AS present FROM article_versions WHERE article_id = ? AND version = ? LIMIT 1`,
    )
    .bind(s.article_id, input.newVersion)
    .first<{ present: number }>()
  if (!saved) {
    return { outcome: 'conflict', scheduleId: s.schedule_id, reason: 'version-not-saved' }
  }

  // "冲突时不能重新确认" — never re-confirm onto an already-published article,
  // nor onto a version another active schedule already owns.
  const formal = await db
    .prepare('SELECT article_id FROM formal_publications WHERE article_id = ?')
    .bind(s.article_id)
    .first<{ article_id: number }>()
  if (formal) {
    return { outcome: 'conflict', scheduleId: s.schedule_id, reason: 'already-published' }
  }
  const duplicate = await db
    .prepare(
      `SELECT schedule_id FROM publish_schedules
       WHERE article_id = ? AND version = ? AND status IN ('pending', 'claimed', 'paused') AND schedule_id != ? LIMIT 1`,
    )
    .bind(s.article_id, input.newVersion, s.schedule_id)
    .first<{ schedule_id: string }>()
  if (duplicate) {
    return { outcome: 'conflict', scheduleId: s.schedule_id, reason: 'duplicate-version' }
  }

  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'pending', version = ?, stale_reason = NULL, last_error = NULL,
           claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ?`,
    )
    .bind(input.newVersion, now, s.schedule_id)
    .run()

  const result: ScheduleControlResult = {
    outcome: 'reconfirmed',
    scheduleId: s.schedule_id,
    articleId: s.article_id,
    version: input.newVersion,
    scheduledAt: s.scheduled_at,
    timezone: s.timezone,
    reconfirmedAt: now,
  }
  return recordOperation(db, input.operationId, s.schedule_id, 'reconfirm', result, now)
}

/* ------------------------------------------------------------------ */
/* reschedule — move to a new absolute time (re-arms to pending)       */
/* ------------------------------------------------------------------ */

export async function rescheduleSchedule(db: Database, input: RescheduleScheduleInput): Promise<ScheduleControlResult> {
  const bad = validateEnvelope(input)
  if (bad) return { outcome: 'invalid', reason: bad }
  if (!Number.isInteger(input.newScheduledAt) || input.newScheduledAt <= 0) {
    return { outcome: 'invalid', reason: 'newScheduledAt must be a positive epoch second' }
  }
  const now = input.now ?? unixNow()
  if (input.newScheduledAt <= now) {
    return { outcome: 'invalid', reason: 'newScheduledAt must be in the future' }
  }

  const adopted = await replayIfAdopted(db, input.operationId, 'reschedule', input.scheduleId)
  if (adopted) return adopted

  const s = await findSchedule(db, input.scheduleId)
  if (!s) return { outcome: 'not-found', scheduleId: input.scheduleId }
  if (s.status === 'fired' || s.status === 'stale' || s.status === 'cancelled') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: `cannot reschedule a schedule in state '${s.status}'`,
    }
  }
  const timezone = input.timezone ?? s.timezone
  if (!isValidIanaTimezone(timezone)) {
    return { outcome: 'invalid', reason: `timezone must be a valid IANA zone (got '${timezone}')` }
  }
  // Idempotent no-op: same time already bound.
  if (s.scheduled_at === input.newScheduledAt && s.timezone === timezone) {
    return recordOperation(db, input.operationId, s.schedule_id, 'reschedule', {
      outcome: 'rescheduled',
      scheduleId: s.schedule_id,
      articleId: s.article_id,
      version: s.version,
      scheduledAt: s.scheduled_at,
      timezone,
      rescheduledAt: now,
    }, now)
  }

  await db
    .prepare(
      `UPDATE publish_schedules
       SET scheduled_at = ?, timezone = ?, status = 'pending',
           claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status IN ('pending', 'claimed', 'paused')`,
    )
    .bind(input.newScheduledAt, timezone, now, s.schedule_id)
    .run()

  const result: ScheduleControlResult = {
    outcome: 'rescheduled',
    scheduleId: s.schedule_id,
    articleId: s.article_id,
    version: s.version,
    scheduledAt: input.newScheduledAt,
    timezone,
    rescheduledAt: now,
  }
  return recordOperation(db, input.operationId, s.schedule_id, 'reschedule', result, now)
}

/* ------------------------------------------------------------------ */
/* cancel — terminal, fact-preserving (pending/claimed/paused → cancel)*/
/* ------------------------------------------------------------------ */

export async function cancelScheduleControl(db: Database, input: ScheduleControlInput): Promise<ScheduleControlResult> {
  const bad = validateEnvelope(input)
  if (bad) return { outcome: 'invalid', reason: bad }
  const now = input.now ?? unixNow()

  const adopted = await replayIfAdopted(db, input.operationId, 'cancel', input.scheduleId)
  if (adopted) return adopted

  const s = await findSchedule(db, input.scheduleId)
  if (!s) return { outcome: 'not-found', scheduleId: input.scheduleId }
  if (s.status === 'cancelled') {
    return recordOperation(db, input.operationId, s.schedule_id, 'cancel', {
      outcome: 'cancelled',
      scheduleId: s.schedule_id,
      cancelledAt: now,
    }, now)
  }
  if (s.status === 'fired' || s.status === 'stale') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: `schedule is ${s.status} and cannot be cancelled`,
    }
  }

  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'cancelled', claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status IN ('pending', 'claimed', 'paused')`,
    )
    .bind(now, s.schedule_id)
    .run()

  const result: ScheduleControlResult = {
    outcome: 'cancelled',
    scheduleId: s.schedule_id,
    cancelledAt: now,
  }
  return recordOperation(db, input.operationId, s.schedule_id, 'cancel', result, now)
}

/* ------------------------------------------------------------------ */
/* publish-now — fire the bound version through the EXISTING kernel   */
/* ------------------------------------------------------------------ */

interface VersionFacts {
  slug: string
  title: string
  contentSha256: string
}

async function readBoundVersion(db: Database, articleId: number, version: number): Promise<VersionFacts | null> {
  const row = await db
    .prepare(
      `SELECT snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(articleId, version)
    .first<{ snapshot_json: string; content_snapshot_sha256: string | null }>()
  if (!row) return null
  let fields: { slug?: string; title?: string } = {}
  try {
    const parsed = JSON.parse(row.snapshot_json) as { fields?: { slug?: string; title?: string } }
    fields = parsed.fields ?? {}
  } catch {
    fields = {}
  }
  const slug = fields.slug?.trim()
  if (!slug) return null
  return { slug, title: fields.title ?? '', contentSha256: row.content_snapshot_sha256 ?? '' }
}

export async function publishNowSchedule(
  db: Database,
  input: ScheduleControlInput & { siteUrl?: string },
): Promise<ScheduleControlResult> {
  const bad = validateEnvelope(input)
  if (bad) return { outcome: 'invalid', reason: bad }
  const now = input.now ?? unixNow()

  const adopted = await replayIfAdopted(db, input.operationId, 'publish_now', input.scheduleId)
  if (adopted) return adopted

  const s = await findSchedule(db, input.scheduleId)
  if (!s) return { outcome: 'not-found', scheduleId: input.scheduleId }
  if (s.status === 'fired') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: 'schedule is already fired (already published)',
    }
  }
  if (s.status === 'stale') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: 'schedule is stale — re-confirm before publishing',
    }
  }
  if (s.status === 'cancelled') {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: 'schedule is cancelled — create a new schedule',
    }
  }
  // pending / paused are the actionable states.

  const facts = await readBoundVersion(db, s.article_id, s.version)
  if (!facts) {
    return {
      outcome: 'conflict',
      scheduleId: s.schedule_id,
      reason: 'version-facts-unavailable',
    }
  }

  // Route the EXACT bound version through the SHARED B3-01 kernel — never
  // bypasses it. The prepare re-evaluates the four live blockers; the confirm
  // re-checks everything inside one transaction with the deterministic sched
  // intent id (one event per schedule ever).
  const prepare = await preparePublish(db, {
    prepareId: scheduledControlPrepareId(s.schedule_id),
    articleId: s.article_id,
    confirmedVersion: s.version,
    slug: facts.slug,
    title: facts.title,
    contentSha256: facts.contentSha256,
    actor: input.actor,
    now,
  })
  if (prepare.outcome !== 'prepared') {
    const reason =
      prepare.outcome === 'aborted' ? `blocked:${prepare.failures.join(',')}` : prepare.outcome
    return markPublishedBlocked(db, s, now, reason)
  }

  const confirm = await confirmPublish(db, {
    intentId: scheduledControlIntentId(s.schedule_id),
    prepareId: scheduledControlPrepareId(s.schedule_id),
    articleId: s.article_id,
    expectedVersion: s.version,
    actor: input.actor,
    siteUrl: input.siteUrl || FIRST_PUBLISH_DEFAULT_SITE_URL,
    now,
  })

  switch (confirm.outcome) {
    case 'delivered':
    case 'replayed': {
      await db
        .prepare(
          `UPDATE publish_schedules
           SET status = 'fired', fired_event_id = ?, stale_reason = NULL,
               claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE schedule_id = ? AND status IN ('pending', 'paused', 'claimed')`,
        )
        .bind(confirm.eventId, now, s.schedule_id)
        .run()
      const result: ScheduleControlResult = {
        outcome: 'published',
        scheduleId: s.schedule_id,
        articleId: s.article_id,
        version: s.version,
        eventId: confirm.eventId,
        publishedAt: now,
      }
      return recordOperation(db, input.operationId, s.schedule_id, 'publish_now', result, now)
    }
    case 'already-published':
      return markPublishedBlocked(db, s, now, 'already-published')
    case 'slug-conflict':
      return markPublishedBlocked(db, s, now, 'slug-conflict')
    case 'conflict':
      return markPublishedBlocked(db, s, now, `conflict:${confirm.reason}`)
    case 'blocked':
      return markPublishedBlocked(db, s, now, `blocked:${confirm.failures.join(',')}`)
    case 'aborted': {
      // Transient/core failure — leave the schedule as-is so a later attempt
      // can retry; never fabricate a publish fact.
      return {
        outcome: 'conflict',
        scheduleId: s.schedule_id,
        reason: `aborted:${confirm.reason}`,
      }
    }
    case 'invalid':
      return { outcome: 'invalid', reason: confirm.reason }
  }
}

/** A publish-now reachable kernel-block → record the schedule stale (author must act). */
async function markPublishedBlocked(
  db: Database,
  s: ScheduleRowLike,
  now: number,
  reason: string,
): Promise<ScheduleControlResult> {
  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'stale', stale_reason = ?, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status IN ('pending', 'paused', 'claimed')`,
    )
    .bind(reason.slice(0, 200), now, s.schedule_id)
    .run()
  return { outcome: 'conflict', scheduleId: s.schedule_id, reason }
}

/* ------------------------------------------------------------------ */
