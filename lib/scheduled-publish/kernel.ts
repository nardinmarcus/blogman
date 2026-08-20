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
 */

import type { Database } from '@/lib/repositories/schema'
import {
  confirmPublish,
  FIRST_PUBLISH_DEFAULT_SITE_URL,
  preparePublish,
} from '@/lib/first-publish'
import type {
  CancelScheduleInput,
  CancelScheduleResult,
  ScanInput,
  ScanResult,
  ScheduledScanOutcome,
  SchedulePublishInput,
  SchedulePublishResult,
  ScheduleRow,
} from './types'

export const SCHEDULED_PUBLISH_DEFAULT_TIMEZONE = 'Asia/Shanghai' as const
export const SCHEDULED_PUBLISH_DEFAULT_LEASE_SECONDS = 600
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
  attempt_count, last_error, claimed_at, lease_expires_at, stale_reason, fired_event_id, created_at, updated_at`

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
  // pending / claimed → terminal cancel; a claimed row is released for good.
  await db
    .prepare(
      `UPDATE publish_schedules SET status = 'cancelled', claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status IN ('pending', 'claimed')`,
    )
    .bind(now, scheduleId)
    .run()
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

  const { results: candidates } = await db
    .prepare(
      `SELECT ${SCHEDULE_COLUMNS} FROM publish_schedules
       WHERE scheduled_at <= ?
         AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))
       ORDER BY scheduled_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<ScheduleRow>()

  const result: ScanResult = { scanned: 0, claimed: 0, fired: 0, stale: 0, retried: 0 }
  for (const row of candidates ?? []) {
    result.scanned += 1

    // Atomic conditional claim — one winner per row across overlapping ticks.
    // This repo's DB surface deliberately does NOT expose `changes` (see
    // cloudflare-env.d.ts), so the winner is resolved by re-reading the row:
    // the conditional UPDATE is atomic — a concurrent runner's WHERE clause
    // stops matching the instant the winner claims — so only the runner that
    // owns `claimed_at`/`lease_expires_at` proceeds.
    await db
      .prepare(
        `UPDATE publish_schedules
         SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE schedule_id = ?
           AND scheduled_at <= ?
           AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))`,
      )
      .bind(now, now + leaseSeconds, now, row.schedule_id, now, now)
      .run()
    const after = await findSchedule(db, row.schedule_id)
    if (!after || after.status !== 'claimed' || after.lease_expires_at !== now + leaseSeconds) {
      continue // another runner already owns or advanced this row
    }

    result.claimed += 1
    const outcome = await processSchedule(db, row, { now, siteUrl })
    if (outcome.outcome === 'fired') result.fired += 1
    else if (outcome.outcome === 'stale') result.stale += 1
    else result.retried += 1
  }

  return result
}

async function processSchedule(
  db: Database,
  row: ScheduleRow,
  opts: { now: number; siteUrl?: string },
): Promise<ScheduledScanOutcome> {
  const { now, siteUrl } = opts
  const base = { scheduleId: row.schedule_id, articleId: row.article_id, version: row.version }

  const article = await findArticleById(db, row.article_id)
  if (!article) return markStale(db, row, now, 'article-missing')

  // Already formally published — never a second first-publish event.
  if (await findFormal(db, row.article_id)) return markStale(db, row, now, 'already-published')

  // The exact-bound version must STILL be the version fact for the article.
  const latest = await latestVersion(db, row.article_id)
  if (latest !== row.version) return markStale(db, row, now, 'version-drift')

  const verdict = await deliverBoundVersion(db, row, { now, siteUrl })
  if (verdict.delivered) {
    await db
      .prepare(
        `UPDATE publish_schedules
         SET status = 'fired', fired_event_id = ?, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE schedule_id = ? AND status = 'claimed'`,
      )
      .bind(verdict.eventId, now, row.schedule_id)
      .run()
    return { ...base, outcome: 'fired', eventId: verdict.eventId }
  }
  if (verdict.staleReason !== null) {
    return markStale(db, row, now, verdict.staleReason)
  }
  // Transient / core failure — re-arm for the next tick (reliable retry).
  return rearmSchedule(db, row, now, verdict.error)
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

async function markStale(db: Database, row: ScheduleRow, now: number, reason: string): Promise<ScheduledScanOutcome> {
  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'stale', stale_reason = ?, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status = 'claimed'`,
    )
    .bind(reason.slice(0, 200), now, row.schedule_id)
    .run()
  return { scheduleId: row.schedule_id, articleId: row.article_id, version: row.version, outcome: 'stale', reason }
}

async function rearmSchedule(db: Database, row: ScheduleRow, now: number, message: string): Promise<ScheduledScanOutcome> {
  await db
    .prepare(
      `UPDATE publish_schedules
       SET status = 'pending', attempt_count = attempt_count + 1, last_error = ?,
           claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND status = 'claimed'`,
    )
    .bind(message.slice(0, 300), now, row.schedule_id)
    .run()
  return {
    scheduleId: row.schedule_id,
    articleId: row.article_id,
    version: row.version,
    outcome: 'retried',
    reason: message,
  }
}