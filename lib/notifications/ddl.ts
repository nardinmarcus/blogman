/**
 * B4-04 — activity notification DDL (issue #43).
 *
 * D1 is the source of record for notifications (never derived on the fly) and
 * every row references an authoritative SOURCE by type + id so the UI can navigate
 * and re-read current state. Deduplicated by `(source_type, source_id)` via a
 * UNIQUE index; status is `open` or `resolved`; `acknowledged` is independent —
 * acknowledging silences external reminders ONLY and never fakes a resolution.
 *
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`, never drops/alters.
 */

import type { Database } from '@/lib/repositories/schema'

export const NOTIFICATIONS_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS activity_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id TEXT UNIQUE NOT NULL CHECK(length(notification_id) > 0),
    source_type TEXT NOT NULL CHECK(length(source_type) > 0),
    source_id TEXT NOT NULL CHECK(length(source_id) > 0),
    title TEXT NOT NULL CHECK(length(title) > 0),
    detail TEXT,
    status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_type, source_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_activity_notifications_source
    ON activity_notifications(source_type, source_id)`,
]

/** Idempotently create the notification tables if absent. Never drops/alters. */
export async function ensureNotificationTables(db: Database): Promise<void> {
  for (const statement of NOTIFICATIONS_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
