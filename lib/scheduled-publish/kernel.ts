/**
 * B4-01 — scheduled publish scan kernel (issue #40).
 *
 * The per-minute cron compensation loop over version-bound schedules:
 *
 *   - `schedulePublish` records an author's intent: article identity + exact
 *     confirmed version + absolute time + IANA timezone. Idempotent by
 *     schedule id; a schedule NEVER rebinds silently — a payload change with
 *     the same id, or a second pending schedule for the same version, is a
 *     conflict (issue #41 owns the re-confirm / reschedule command surface).
 *   - `cancelSchedule` is the interface seam #41's command face builds on
 *     (terminal for fired/stale rows; a pending/claimed row is cancelled).
 *   - `scanDueSchedules` is the Cron wake-up contract: it scans D1 for due
 *     intents, atomically claims each (lease, so overlapping ticks cannot
 *     double-fire), and routes the EXACT bound version through the EXISTING
 *     publish kernel (`preparePublish` + `confirmPublish` from B3-01):
 *       * version unchanged   → the scheduled version is prepared+confirmed
 *         with a deterministic intent id (`sched:<scheduleId>`), so the same
 *         schedule intent can only ever produce ONE publish event,
 *       * version changed     → recorded `stale` (never misfires, never
 *         reschedules itself — the author re-confirms / reschedules in #41),
 *       * already published / article missing / author blockers → recorded
 *         `stale` with the reason (author action needed, never a misfire),
 *       * transient/core failure (transaction aborted) → re-armed `pending`
 *         with attempt_count + last_error so the next tick retries reliably.
 *
 * Queue / Cron are NEVER a fact source here: they only wake the D1 scan; the
 * claim, idempotency, retry and terminal states are all D1 conditional updates.
 *
 * B4-03 (issue #42) adds the durable execution facts: every due-schedule
 * execution records an IMMUTABLE attempt row (idempotent key, start/finish,
 * classified outcome, sanitized error) in `publish_attempts` — the core facts
 * (schedule / events) stay separate from attempts. Transient failures retry
 * under a policy (attempt cap + exponential backoff via `next_attempt_at`),
 * business mismatches stay stale, and retries never duplicate a publish event
 * (the confirm kernel's deterministic intent id is the single-event guard).
 * The lease is ownership-checked with a per-claim `lease_token` so concurrent
 * multi-instance grabs converge on exactly ONE winner (B4-01's time-equality
 * check could not distinguish two same-instant claims), it is extendable by
 * heartbeat, reclaimed on expiry, and every transition bumps `revision`.
 */

import type { Database } from '@/lib/repositories/schema'
import {
  confirmPublish,
  FIRST_PUBLISH_DEFAULT_SITE_URL,
  preparePublish,
} from '@/lib/first-publish'
import type {
  AttemptOutcome,
  CancelScheduleInput,
  CancelScheduleResult,
  HeartbeatInput,
  HeartbeatResult,
  ScanInput,
  ScanResult,
  ScheduledScanOutcome,
  SchedulePublishInput,
  SchedulePublishResult,
  ScheduleRow,
} from './types'

export const SCHEDULED_PUBLISH_DEFAULT_TIMEZONE = 'Asia/Shanghai' as const
export const SCHEDULED_PUBLISH_DEFAULT_LEASE_SECONDS = 600
/** Retry cap — a schedule stops retrying once this many executions have run. */
export const SCHEDULED_PUBLISH_DEFAULT_MAX_ATTEMPTS = 5
/** Base backoff (seconds); attempt n waits base * factor^(n-1), capped. */
export const SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_SECONDS = 60
export const SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_FACTOR = 2
export const SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_MAX_SECONDS = 3600
/** Sanitized error length caps (logs must never leak secrets or huge blobs). */
export const SCHEDULED_PUBLISH_SCHEDULE_ERROR_LIMIT = 300
export const SCHEDULED_PUBLISH_ATTEMPT_ERROR_LIMIT = 500
export const SCHEDULED_PUBLISH_STALE_REASON_LIMIT = 200
export const SCHEDULED_PUBLISH_ACTOR = 'scheduled-cron' as const

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/** Deterministic intent id — one schedule intent can never produce two events. */
export function scheduledIntentId(scheduleId: string): string {
  return `sched:${scheduleId}`
}

/** Deterministic prepare id for the fire-time prepare of this schedule. */
export function scheduledPrepareId(scheduleId: string): string {
  return `sched-prepare:${scheduleId}`
}

/** Deterministic attempt idempotency key — one execution, one immutable row. */
export function scheduledAttemptKey(scheduleId: string, attemptNo: number): string {
  return `sched-attempt:${scheduleId}:${attemptNo}`
}

/* ------------------------------------------------------------------ */
/* retry policy: cap + exponential backoff                            */
/* ------------------------------------------------------------------ */

/**
 * Exponential backoff for retry attempt `attemptNo` (1-based): the first
 * retry waits `base` seconds, each subsequent retry multiplies by `factor`,
 * capped at `maxSeconds`. Never below one second (a rearmed schedule is
 * never due again in the same second it failed).
 */
export function retryBackoffSeconds(
  attemptNo: number,
  base: number = SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_SECONDS,
  factor: number = SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_FACTOR,
  maxSeconds: number = SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_MAX_SECONDS,
): number {
  if (attemptNo <= 1) return Math.min(Math.max(1, Math.round(base)), maxSeconds)
  const growth = base * Math.pow(factor, attemptNo - 1)
  return Math.min(Math.max(1, Math.round(growth)), maxSeconds)
}

/* ------------------------------------------------------------------ */
/* error sanitization — attempt/error facts never carry secrets       */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization header / Bearer tokens
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  // key=value / key: value secret assignments
  [
    /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|auth)\b\s*[:=]\s*)([^\s,;&]+)/gi,
    '$1[REDACTED]',
  ],
  // URL embedded credentials (scheme://user:pass@)
  [/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@'],
]

/**
 * Sanitize an error/outcome detail before it becomes a durable fact: redact
 * common secret shapes, collapse whitespace and cap the length. Attempt rows
 * and the schedule `last_error` only ever store sanitized text.
 */
export function sanitizeError(message: string, maxLength: number = SCHEDULED_PUBLISH_ATTEMPT_ERROR_LIMIT): string {
  let out = String(message ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.slice(0, maxLength)
}

function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone.length > 0
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* low-level reads                                                     */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface FormalRow {
  article_id: number
  version: number
  event_id: string
}

interface VersionFacts {
  slug: string
  title: string
  contentSha256: string
}

const SCHEDULE_COLUMNS = `id, schedule_id, article_id, version, scheduled_at, timezone, status,
  attempt_count, last_error, claimed_at, lease_expires_at, lease_token, revision, next_attempt_at,
  stale_reason, fired_event_id, created_at, updated_at`

async function findSchedule(db: Database, scheduleId: string): Promise<ScheduleRow | null> {
  return db
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM publish_schedules WHERE schedule_id = ?`)
    .bind(scheduleId)
    .first<ScheduleRow>()
}

async function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<ArticleRow>()
}

async function findFormal(db: Database, articleId: number): Promise<FormalRow | null> {
  return db
    .prepare('SELECT article_id, version, event_id FROM formal_publications WHERE article_id = ?')
    .bind(articleId)
    .first<FormalRow>()
}

async function latestVersion(db: Database, articleId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
    .bind(articleId)
    .first<{ version: number }>()
  return row?.version ?? 0
}

/** The exact facts of the bound version — the ONLY content a schedule may publish. */
async function readVersionFacts(db: Database, articleId: number, version: number): Promise<VersionFacts | null> {
  const row = await db
    .prepare(
      `SELECT version, snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(articleId, version)
    .first<{ version: number; snapshot_json: string; content_snapshot_sha256: string | null }>()
  if (!row) return null
  let snapshot: { fields?: { slug?: string; title?: string } } = {}
  try {
    const parsed = JSON.parse(row.snapshot_json) as { fields?: { slug?: string; title?: string } }
    snapshot = parsed
  } catch {
    snapshot = {}
  }
  const slug = snapshot.fields?.slug ?? ''
  if (!slug || slug.trim() === '') return null
  return { slug: slug.trim(), title: snapshot.fields?.title ?? '', contentSha256: row.content_snapshot_sha256 ?? '' }
}

/* ------------------------------------------------------------------ */
/* schedulePublish — record the version-bound intent                   */
/* ------------------------------------------------------------------ */

export async function schedulePublish(db: Database, input: SchedulePublishInput): Promise<SchedulePublishResult> {
  const {
    scheduleId,
    articleId,
    version,
    scheduledAt,
    timezone = SCHEDULED_PUBLISH_DEFAULT_TIMEZONE,
    actor,
    now = unixNow(),
  } = input
  if (!scheduleId || scheduleId.trim() === '') return { outcome: 'invalid', reason: 'scheduleId is required' }
  if (!Number.isInteger(articleId) || articleId <= 0) return { outcome: 'invalid', reason: 'articleId is required' }
  if (!Number.isInteger(version) || version <= 0) return { outcome: 'invalid', reason: 'version must be a positive integer' }
  if (!Number.isInteger(scheduledAt) || scheduledAt <= 0) return { outcome: 'invalid', reason: 'scheduledAt must be a positive epoch second' }
  if (!isValidIanaTimezone(timezone)) return { outcome: 'invalid', reason: `timezone must be a valid IANA zone (got '${timezone}')` }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'actor is required' }
  if (scheduledAt <= now) return { outcome: 'invalid', reason: 'scheduledAt must be in the future' }

  const article = await findArticleById(db, articleId)
  if (!article) return { outcome: 'not-found', articleId }

  // A schedule may only plan a FIRST publish — an already formally published
  // article's next go-live is the revision/promotion path (#34), scheduled by
  // later batches. Never silently rebind an existing intent.
  if (await findFormal(db, articleId)) {
    return { outcome: 'conflict', scheduleId, reason: 'already-published', articleId }
  }

  const existing = await findSchedule(db, scheduleId)
  if (existing) {
    const identical =
      existing.article_id === articleId &&
      existing.version === version &&
      existing.scheduled_at === scheduledAt &&
      existing.timezone === timezone
    if (identical) {
      return { outcome: 'replayed', scheduleId, articleId, version, scheduledAt, timezone }
    }
    return { outcome: 'conflict', scheduleId, reason: 'payload-mismatch', articleId }
  }

  // No duplicate active intent for the SAME version — the author must cancel /
  // reschedule the old one first (issue #41). Different versions may coexist:
  // each fires only when its OWN bound version is still current.
  const duplicate = await db
    .prepare(
      `SELECT schedule_id FROM publish_schedules
       WHERE article_id = ? AND version = ? AND status IN ('pending', 'claimed') AND schedule_id != ?
       LIMIT 1`,
    )
    .bind(articleId, version, scheduleId)
    .first<{ schedule_id: string }>()
  if (duplicate) {
    return { outcome: 'conflict', scheduleId, reason: 'duplicate-version', articleId }
  }

  await db
    .prepare(
      `INSERT INTO publish_schedules
         (schedule_id, article_id, version, scheduled_at, timezone, status,
          attempt_count, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
    )
    .bind(scheduleId, articleId, version, scheduledAt, timezone, now, now)
    .run()

  return { outcome: 'scheduled', scheduleId, articleId, version, scheduledAt, timezone }
}

/* ------------------------------------------------------------------ */
/* cancelSchedule — interface seam for issue #41's command surface     */
/* ------------------------------------------------------------------ */

export async function cancelSchedule(db: Database, input: CancelScheduleInput): Promise<CancelScheduleResult> {
  const { scheduleId, actor, now = unixNow() } = input
  if (!scheduleId || scheduleId.trim() === '') return { outcome: 'invalid', reason: 'scheduleId is required' }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'actor is required' }

  const existing = await findSchedule(db, scheduleId)
  if (!existing) return { outcome: 'not-found', scheduleId }

  if (existing.status === 'cancelled') return { outcome: 'replayed', scheduleId }
  if (existing.status === 'fired' || existing.status === 'stale') {
    return { outcome: 'conflict', scheduleId, reason: `schedule is ${existing.status} and cannot be cancelled` }
  }
  // pending / claimed → terminal cancel; a claimed row is released for good and
  // its still-running attempt (if any) is finalized as `cancelled` in the SAME
  // batch — the schedule and its attempt facts stay consistent atomically.
  await db.batch([
    finalizeAttemptStatement(
      db,
      scheduledAttemptKey(scheduleId, existing.attempt_count),
      'cancelled',
      'cancelled by author before completion',
      now,
    ),
    db
      .prepare(
        `UPDATE publish_schedules SET status = 'cancelled', claimed_at = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ?
         WHERE schedule_id = ? AND status IN ('pending', 'claimed')`,
      )
      .bind(now, scheduleId),
  ])
  return { outcome: 'cancelled', scheduleId, cancelledAt: now }
}

/* ------------------------------------------------------------------ */
/* scanDueSchedules — the per-minute Cron compensation contract        */
/* ------------------------------------------------------------------ */

/**
 * Fire the due version-bound schedules. Called by the Cron wake-up (and by
 * the same command in tests): scan D1 for due intents, atomically claim each
 * under a lease, then route the EXACT bound version through the existing
 * publish kernel. Duplicate ticks / overlapping Cron invocations converge on
 * the D1 conditional claim + the confirm kernel's intent uniqueness — at most
 * one publish event per schedule intent.
 */
export async function scanDueSchedules(db: Database, input: ScanInput = {}): Promise<ScanResult> {
  const now = input.now ?? unixNow()
  const limit = input.limit ?? 20
  const leaseSeconds = input.leaseSeconds ?? SCHEDULED_PUBLISH_DEFAULT_LEASE_SECONDS
  const siteUrl = input.siteUrl
  const maxAttempts = input.maxAttempts ?? SCHEDULED_PUBLISH_DEFAULT_MAX_ATTEMPTS
  const backoffSeconds = input.retryBackoffSeconds ?? SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_SECONDS
  const backoffFactor = input.retryBackoffFactor ?? SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_FACTOR
  const backoffMax = input.retryBackoffMaxSeconds ?? SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_MAX_SECONDS

  const { results: candidates } = await db
    .prepare(
      `SELECT ${SCHEDULE_COLUMNS} FROM publish_schedules
       WHERE scheduled_at <= ?
         AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'claimed' AND lease_expires_at <= ?))
       ORDER BY scheduled_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(now, now, now, limit)
    .all<ScheduleRow>()

  const result: ScanResult = { scanned: 0, claimed: 0, fired: 0, stale: 0, retried: 0, failed: 0 }
  for (const row of candidates ?? []) {
    result.scanned += 1

    // Atomic conditional claim under a lease. Ownership is resolved by a
    // per-claim `lease_token` (this repo's DB surface deliberately does not
    // expose `changes`): a concurrent runner's conditional UPDATE stops
    // matching the instant the winner claims, and only the runner whose token
    // lands in the row proceeds — even when two scans use the same `now` and
    // `leaseSeconds`, at most one winner emerges.
    const claimed = await claimSchedule(db, row, { now, leaseSeconds })
    if (!claimed) continue // another runner already owns or advanced this row

    result.claimed += 1
    // A reclaimed crashed execution leaves its attempt `running` — finalize it
    // as `abandoned` (immutable, never deleted) before opening a new one.
    await abandonOrphanedAttempts(db, row.schedule_id, now)
    // Every Cron-triggered execution records exactly one immutable attempt row.
    await insertAttempt(db, row.schedule_id, claimed.attempt_count, now)

    const outcome = await processSchedule(db, claimed, {
      now,
      siteUrl,
      maxAttempts,
      backoffSeconds,
      backoffFactor,
      backoffMax,
    })
    if (outcome.outcome === 'fired') result.fired += 1
    else if (outcome.outcome === 'stale') result.stale += 1
    else if (outcome.outcome === 'failed') result.failed += 1
    else result.retried += 1
  }

  return result
}

/**
 * Atomically claim a due schedule for THIS runner. Returns the claimed row
 * (attempt_count already incremented) only when the runner truly owns the
 * lease token; otherwise null (a concurrent runner won or advanced the row).
 */
async function claimSchedule(
  db: Database,
  row: ScheduleRow,
  opts: { now: number; leaseSeconds: number },
): Promise<ScheduleRow | null> {
  const { now, leaseSeconds } = opts
  const token = crypto.randomUUID()
  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, lease_token = ?,
           attempt_count = attempt_count + 1, revision = revision + 1, updated_at = ?
       WHERE schedule_id = ?
         AND scheduled_at <= ?
         AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'claimed' AND lease_expires_at <= ?))`,
    )
    .bind(now, now + leaseSeconds, token, now, row.schedule_id, now, now, now)
    .run()
  const after = await findSchedule(db, row.schedule_id)
  if (!after || after.status !== 'claimed' || after.lease_token !== token) {
    return null // our conditional UPDATE matched nothing — another runner owns it
  }
  return after
}

/* ------------------------------------------------------------------ */
/* immutable attempt lifecycle                                         */
/* ------------------------------------------------------------------ */

/**
 * One immutable row per execution: written `running` at claim time (started_at
 * = the claim instant), finalized exactly once with `finished_at` + outcome + a
 * SANITIZED error. The `finished_at IS NULL` guard makes the running→terminal
 * transition single-shot — a terminal row can never be touched again, so later
 * scans can only ever append new rows.
 */
async function insertAttempt(db: Database, scheduleId: string, attemptNo: number, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO publish_attempts
         (attempt_key, schedule_id, attempt_no, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(scheduledAttemptKey(scheduleId, attemptNo), scheduleId, attemptNo, now, now, now)
    .run()
}

/** Finalize a still-running attempt (no-op once terminal — immutability guard). */
function finalizeAttemptStatement(
  db: Database,
  attemptKey: string,
  outcome: AttemptOutcome,
  error: string | null,
  now: number,
) {
  return db
    .prepare(
      `UPDATE publish_attempts
       SET finished_at = ?, outcome = ?, error = ?, updated_at = ?
       WHERE attempt_key = ? AND finished_at IS NULL`,
    )
    .bind(now, outcome, error === null ? null : sanitizeError(error), now, attemptKey)
}

/** A reclaimed crashed run leaves its attempt `running` — finalize it abandoned. */
async function abandonOrphanedAttempts(db: Database, scheduleId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE publish_attempts
       SET finished_at = ?, outcome = 'abandoned', error = ?, updated_at = ?
       WHERE schedule_id = ? AND finished_at IS NULL`,
    )
    .bind(now, 'abandoned: lease expired before the run completed (crash?)', now, scheduleId)
    .run()
}

/* ------------------------------------------------------------------ */
/* terminal transitions — attempt finalize + schedule update, atomic  */
/* ------------------------------------------------------------------ */

async function fireSchedule(db: Database, row: ScheduleRow, eventId: string, now: number): Promise<void> {
  await db.batch([
    finalizeAttemptStatement(db, scheduledAttemptKey(row.schedule_id, row.attempt_count), 'fired', null, now),
    db
      .prepare(
        `UPDATE publish_schedules
         SET status = 'fired', fired_event_id = ?, claimed_at = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ?
         WHERE schedule_id = ? AND status = 'claimed'`,
      )
      .bind(eventId, now, row.schedule_id),
  ])
}

async function markStale(db: Database, row: ScheduleRow, now: number, reason: string): Promise<void> {
  await db.batch([
    finalizeAttemptStatement(db, scheduledAttemptKey(row.schedule_id, row.attempt_count), 'stale', reason, now),
    db
      .prepare(
        `UPDATE publish_schedules
         SET status = 'stale', stale_reason = ?, claimed_at = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ?
         WHERE schedule_id = ? AND status = 'claimed'`,
      )
      .bind(reason.slice(0, SCHEDULED_PUBLISH_STALE_REASON_LIMIT), now, row.schedule_id),
  ])
}

/** Transient failure below the retry cap — re-arm with a backoff window. */
async function rearmSchedule(
  db: Database,
  row: ScheduleRow,
  now: number,
  message: string,
  nextAttemptAt: number,
): Promise<void> {
  await db.batch([
    finalizeAttemptStatement(db, scheduledAttemptKey(row.schedule_id, row.attempt_count), 'retried', message, now),
    db
      .prepare(
        `UPDATE publish_schedules
         SET status = 'pending', last_error = ?, next_attempt_at = ?,
             claimed_at = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ?
         WHERE schedule_id = ? AND status = 'claimed'`,
      )
      .bind(sanitizeError(message, SCHEDULED_PUBLISH_SCHEDULE_ERROR_LIMIT), nextAttemptAt, now, row.schedule_id),
  ])
}

/** Retry cap exhausted — the schedule stops retrying and becomes an author todo. */
async function exhaustSchedule(
  db: Database,
  row: ScheduleRow,
  now: number,
  message: string,
): Promise<void> {
  await db.batch([
    finalizeAttemptStatement(db, scheduledAttemptKey(row.schedule_id, row.attempt_count), 'failed', message, now),
    db
      .prepare(
        `UPDATE publish_schedules
         SET status = 'stale', stale_reason = ?, last_error = ?,
             claimed_at = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ?
         WHERE schedule_id = ? AND status = 'claimed'`,
      )
      .bind(
        'retries-exhausted',
        sanitizeError(message, SCHEDULED_PUBLISH_SCHEDULE_ERROR_LIMIT),
        now,
        row.schedule_id,
      ),
  ])
}

async function processSchedule(
  db: Database,
  row: ScheduleRow,
  opts: {
    now: number
    siteUrl?: string
    maxAttempts: number
    backoffSeconds: number
    backoffFactor: number
    backoffMax: number
  },
): Promise<ScheduledScanOutcome> {
  const { now, siteUrl, maxAttempts, backoffSeconds, backoffFactor, backoffMax } = opts
  const base = { scheduleId: row.schedule_id, articleId: row.article_id, version: row.version }

  const article = await findArticleById(db, row.article_id)
  if (!article) {
    await markStale(db, row, now, 'article-missing')
    return { ...base, outcome: 'stale', reason: 'article-missing' }
  }

  // Already formally published — never a second first-publish event.
  if (await findFormal(db, row.article_id)) {
    await markStale(db, row, now, 'already-published')
    return { ...base, outcome: 'stale', reason: 'already-published' }
  }

  // The exact-bound version must STILL be the version fact for the article.
  const latest = await latestVersion(db, row.article_id)
  if (latest !== row.version) {
    await markStale(db, row, now, 'version-drift')
    return { ...base, outcome: 'stale', reason: 'version-drift' }
  }

  const verdict = await deliverBoundVersion(db, row, { now, siteUrl })
  if (verdict.delivered) {
    await fireSchedule(db, row, verdict.eventId, now)
    return { ...base, outcome: 'fired', eventId: verdict.eventId }
  }
  if (verdict.staleReason !== null) {
    await markStale(db, row, now, verdict.staleReason)
    return { ...base, outcome: 'stale', reason: verdict.staleReason }
  }
  // Transient / core failure: retry per policy — cap + backoff. Below the cap
  // the schedule is re-armed with a next_attempt_at window; at the cap it
  // stops retrying and becomes an author todo (`retries-exhausted` stale).
  if (row.attempt_count >= maxAttempts) {
    await exhaustSchedule(db, row, now, verdict.error)
    return { ...base, outcome: 'failed', reason: verdict.error }
  }
  const nextAttemptAt = now + retryBackoffSeconds(row.attempt_count, backoffSeconds, backoffFactor, backoffMax)
  await rearmSchedule(db, row, now, verdict.error, nextAttemptAt)
  return { ...base, outcome: 'retried', reason: verdict.error }
}

/**
 * Route the bound version through the EXISTING B3-01 first-publish kernel.
 * The prepare re-evaluates the four blockers against LIVE state; the confirm
 * re-checks everything inside ONE D1 transaction with a deterministic intent
 * id — the same schedule intent can only ever write one event.
 */
async function deliverBoundVersion(
  db: Database,
  row: ScheduleRow,
  opts: { now: number; siteUrl?: string },
): Promise<
  | { delivered: true; eventId: string }
  | { delivered: false; staleReason: string; error: null }
  | { delivered: false; staleReason: null; error: string }
> {
  const { now, siteUrl } = opts
  const facts = await readVersionFacts(db, row.article_id, row.version)
  if (!facts) return { delivered: false, staleReason: 'version-facts-unavailable', error: null }

  const prepare = await preparePublish(db, {
    prepareId: scheduledPrepareId(row.schedule_id),
    articleId: row.article_id,
    confirmedVersion: row.version,
    slug: facts.slug,
    title: facts.title,
    contentSha256: facts.contentSha256,
    actor: SCHEDULED_PUBLISH_ACTOR,
    now,
  })
  if (prepare.outcome !== 'prepared') {
    const failures = prepare.outcome === 'aborted' ? prepare.failures.join(',') : `${prepare.outcome}`
    return { delivered: false, staleReason: `blocked:${failures}`, error: null }
  }

  const confirm = await confirmPublish(db, {
    intentId: scheduledIntentId(row.schedule_id),
    prepareId: scheduledPrepareId(row.schedule_id),
    articleId: row.article_id,
    expectedVersion: row.version,
    actor: SCHEDULED_PUBLISH_ACTOR,
    siteUrl: siteUrl || FIRST_PUBLISH_DEFAULT_SITE_URL,
    now,
  })

  switch (confirm.outcome) {
    case 'delivered':
    case 'replayed':
      return { delivered: true, eventId: confirm.eventId }
    case 'already-published':
      return { delivered: false, staleReason: 'already-published', error: null }
    case 'conflict':
      return { delivered: false, staleReason: `conflict:${confirm.reason}`, error: null }
    case 'slug-conflict':
      return { delivered: false, staleReason: 'slug-conflict', error: null }
    case 'blocked':
      return { delivered: false, staleReason: `blocked:${confirm.failures.join(',')}`, error: null }
    case 'aborted':
    case 'invalid':
      return { delivered: false, staleReason: null, error: confirm.reason }
  }
}

/* ------------------------------------------------------------------ */
/* heartbeat — extend a lease the runner still owns                    */
/* ------------------------------------------------------------------ */

/**
 * Extend the lease of a schedule THIS runner still owns. Ownership is proven
 * by the per-claim `lease_token` plus a still-valid lease, so a crashed
 * runner whose lease was reclaimed can never resurrect it (the reclaim
 * rotated the token). Returns `extended` with the new expiry when the lease
 * was renewed, or `lost` with the reason otherwise — the runner must stop.
 */
export async function heartbeatScheduleLease(
  db: Database,
  input: HeartbeatInput,
): Promise<HeartbeatResult> {
  const { scheduleId, leaseToken } = input
  const now = input.now ?? unixNow()
  const leaseSeconds = input.leaseSeconds ?? SCHEDULED_PUBLISH_DEFAULT_LEASE_SECONDS
  if (!scheduleId || scheduleId.trim() === '' || !leaseToken || leaseToken.trim() === '') {
    return { outcome: 'lost', scheduleId, reason: 'not-claimed' }
  }

  const newExpiry = now + leaseSeconds
  await db
    .prepare(
      `UPDATE publish_schedules
       SET lease_expires_at = ?, revision = revision + 1, updated_at = ?
       WHERE schedule_id = ? AND status = 'claimed' AND lease_token = ? AND lease_expires_at > ?`,
    )
    .bind(newExpiry, now, scheduleId, leaseToken, now)
    .run()

  const after = await findSchedule(db, scheduleId)
  if (!after) {
    return { outcome: 'lost', scheduleId, reason: 'not-claimed' }
  }
  if (after.status !== 'claimed' || after.lease_token !== leaseToken) {
    // The row is gone / no longer ours — a reclaim (or terminal transition by
    // another owner) rotated the token. This runner must stop.
    return { outcome: 'lost', scheduleId, reason: 'reclaimed' }
  }
  if (after.lease_expires_at !== newExpiry) {
    // Still ours but the lease had already lapsed, so the guard blocked renewal.
    return { outcome: 'lost', scheduleId, reason: 'lease-expired' }
  }
  return { outcome: 'extended', scheduleId, leaseExpiresAt: after.lease_expires_at, revision: after.revision }
}