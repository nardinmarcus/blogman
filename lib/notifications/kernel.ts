/**
 * B4-04 — activity notification kernel (issue #43).
 *
 * D1-backed notifications referencing an authoritative source type+id.
 * Race-safe: every mutation is a guarded conditional statement; concurrency
 * converges on the source UNIQUE index and the conditional WHERE — at most one
 * row per source, and resolve / acknowledge never double-apply.
 *
 * Lifecycle invariants:
 *   - record        dedup by (source_type, source_id) — re-recording replays,
 *   - acknowledge   "已知晓": silences EXTERNAL reminders only, NEVER resolves,
 *   - resolve       explicit and separate — marks the underlying item handled,
 *   - rebuild       re-query authoritative facts and reconcile the D1 set
 *                   (notifications themselves remain the D1 source of record).
 */

import type { Database } from '@/lib/repositories/schema'
import {
  notificationDedupKey,
  type AcknowledgeNotificationInput,
  type AcknowledgeNotificationResult,
  type NotificationRow,
  type RecordNotificationInput,
  type RecordNotificationResult,
  type ResolveNotificationInput,
  type ResolveNotificationResult,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

const NOTIFICATION_COLUMNS = `id, notification_id, source_type, source_id, title, detail,
  status, acknowledged, created_at, updated_at`

async function findBySource(db: Database, sourceType: string, sourceId: string): Promise<NotificationRow | null> {
  return db
    .prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM activity_notifications WHERE source_type = ? AND source_id = ?`)
    .bind(sourceType, sourceId)
    .first<NotificationRow>()
}

/**
 * Record a notification, deduplicated by (source_type, source_id).
 * Race-safe: the source UNIQUE index guarantees one row per source even under
 * concurrent `record` calls; the loser replays the existing row.
 */
export async function recordNotification(
  db: Database,
  input: RecordNotificationInput,
): Promise<RecordNotificationResult> {
  const now = input.now ?? unixNow()
  const sourceType = input.sourceType.trim()
  const sourceId = input.sourceId.trim()
  const title = input.title.trim()
  if (!sourceType || !sourceId || !title) return { outcome: 'replayed', notificationId: input.notificationId, dedupKey: notificationDedupKey(sourceType, sourceId), existing: true, existingId: -1 }

  const existing = await findBySource(db, sourceType, sourceId)
  if (existing) {
    return {
      outcome: 'replayed',
      notificationId: existing.notification_id,
      dedupKey: notificationDedupKey(sourceType, sourceId),
      existing: true,
      existingId: existing.id,
    }
  }

  // Conditional insert via UNIQUE(source_type, source_id): if a concurrent
  // writer already inserted this source, the second INSERT throws a UNIQUE
  // conflict — catch it and replay the winner's row.
  try {
    await db
      .prepare(
        `INSERT INTO activity_notifications
           (notification_id, source_type, source_id, title, detail, status, acknowledged, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
      )
      .bind(input.notificationId, sourceType, sourceId, title, input.detail ?? null, now, now)
      .run()
  } catch {
    const winner = await findBySource(db, sourceType, sourceId)
    return {
      outcome: 'replayed',
      notificationId: winner?.notification_id ?? input.notificationId,
      dedupKey: notificationDedupKey(sourceType, sourceId),
      existing: true,
      existingId: winner?.id ?? -1,
    }
  }
  return { outcome: 'recorded', notificationId: input.notificationId, dedupKey: notificationDedupKey(sourceType, sourceId), created: true, createdAt: now }
}

/**
 * Resolve — mark the underlying item HANDLED. Explicit and separate from
 * acknowledge. Idempotent: resolving an already-resolved row replays.
 * Race-safe via the scheduled-publish pattern: each concurrent writer stamps a
 * UNIQUE `updated_at` token and re-reads to confirm it owns the flip — the
 * eventual loser replays instead of double-reporting.
 */
export async function resolveNotification(
  db: Database,
  input: ResolveNotificationInput,
): Promise<ResolveNotificationResult> {
  const now = input.now ?? unixNow()
  const sourceType = input.sourceType.trim()
  const sourceId = input.sourceId.trim()
  const dedupKey = notificationDedupKey(sourceType, sourceId)
  // Unique per-writer token so concurrent resolvers can recognise the winner.
  const token = `${now}`

  const existing = await findBySource(db, sourceType, sourceId)
  if (!existing) return { outcome: 'not-found', dedupKey }
  if (existing.status === 'resolved') return { outcome: 'replayed', dedupKey, alreadyResolved: true }

  await db
    .prepare(
      `UPDATE activity_notifications SET status = 'resolved', updated_at = ?
       WHERE source_type = ? AND source_id = ? AND status = 'open'`,
    )
    .bind(token, sourceType, sourceId)
    .run()
  const after = await findBySource(db, sourceType, sourceId)
  // This writer owns the flip iff its token matches — otherwise a concurrent
  // resolver already moved the row and we replay.
  if (!after || String(after.updated_at) !== token) {
    return { outcome: 'replayed', dedupKey, alreadyResolved: true }
  }
  return { outcome: 'resolved', dedupKey, resolvedAt: now, wasAcknowledged: existing.acknowledged === 1 }
}

/**
 * "已知晓" — acknowledge. Silences EXTERNAL reminders ONLY; the item's
 * `status` stays `open` (never fakes a resolution). Idempotent. Race-safe with
 * the same unique-token ownership pattern as resolve.
 */
export async function acknowledgeNotification(
  db: Database,
  input: AcknowledgeNotificationInput,
): Promise<AcknowledgeNotificationResult> {
  const now = input.now ?? unixNow()
  const sourceType = input.sourceType.trim()
  const sourceId = input.sourceId.trim()
  const dedupKey = notificationDedupKey(sourceType, sourceId)
  const token = `${now}`

  const existing = await findBySource(db, sourceType, sourceId)
  if (!existing) return { outcome: 'not-found', dedupKey }
  if (existing.acknowledged === 1) {
    return { outcome: 'replayed', dedupKey, alreadyAcknowledged: true, status: existing.status }
  }

  await db
    .prepare(
      `UPDATE activity_notifications SET acknowledged = 1, updated_at = ?
       WHERE source_type = ? AND source_id = ? AND acknowledged = 0`,
    )
    .bind(token, sourceType, sourceId)
    .run()
  const after = await findBySource(db, sourceType, sourceId)
  if (!after || String(after.updated_at) !== token) {
    return { outcome: 'replayed', dedupKey, alreadyAcknowledged: true, status: after?.status ?? 'open' }
  }
  return {
    outcome: 'acknowledged',
    dedupKey,
    acknowledgedAt: now,
    status: after.status,
  }
}

/**
 * Rebuild — reconcile the D1 notification set against current authoritative
 * facts. `wanted` is the authoritative fact surface (source rows that still
 * need a notification); each is recorded (dedup), and notifications whose
 * source is no longer wanted are resolved. Never deletes a row; notifications
 * remain the D1 source of record and this only syncs membership.
 */
export async function rebuildNotifications(
  db: Database,
  input: {
    wanted: { sourceType: string; sourceId: string; title: string; detail?: string | null }[]
    now?: number
  },
): Promise<{ outcome: 'rebuilt'; recorded: number; resolved: number; total: number }> {
  const now = input.now ?? unixNow()
  let recorded = 0
  let resolved = 0

  const wanted = new Set(input.wanted.map((w) => notificationDedupKey(w.sourceType, w.sourceId)))
  for (const w of input.wanted) {
    const res = await recordNotification(db, {
      notificationId: `rebuild-${notificationDedupKey(w.sourceType, w.sourceId)}`,
      sourceType: w.sourceType,
      sourceId: w.sourceId,
      title: w.title,
      detail: w.detail,
      now,
    })
    if (res.outcome === 'recorded') recorded += 1
  }

  const { results: all } = await db
    .prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM activity_notifications`)
    .all<NotificationRow>()
  for (const row of all ?? []) {
    const key = notificationDedupKey(row.source_type, row.source_id)
    if (!wanted.has(key) && row.status === 'open') {
      await resolveNotification(db, { sourceType: row.source_type, sourceId: row.source_id, now })
      resolved += 1
    }
  }

  const total = (all ?? []).length
  return { outcome: 'rebuilt', recorded, resolved, total }
}

/** Read the full notification surface. */
export async function listNotifications(db: Database): Promise<NotificationRow[]> {
  const { results } = await db
    .prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM activity_notifications ORDER BY updated_at DESC`)
    .all<NotificationRow>()
  return results ?? []
}
