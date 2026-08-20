/**
 * B4-01 — scheduled publish DDL (issue #40).
 *
 * Adds exactly ONE fact table to the existing publish surface —
 * `publish_schedules` — through the same independent DDL channel as B2-01b /
 * B2-02 / B2-G / B3-01 / B3-02 / B3-05 so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) and the first-publish/revision/
 * lifecycle tables stay untouched. Additive only: never drops or alters an
 * existing row/table.
 *
 * The schedule row binds: the author-generated schedule id (idempotency key),
 * the article identity, the EXACT confirmed version, the absolute execution
 * time (epoch seconds) and the IANA timezone chosen by the author. The status
 * machine is owned by the scan kernel: `pending` (armed) → `claimed` (leased
 * in-flight) → `fired` / `stale`; `paused` holds an armed intent (PAUSED —
 * fires are suspended, original time + bound version retained) until the
 * author re-confirms / reschedules (issue #41 command surface); `cancelled`
 * terminates a pending/claimed/paused row. `attempt_count` + `last_error`
 * keep the "core failure retries reliably, version drift goes stale"
 * distinction.
 */

import type { Database } from '@/lib/repositories/schema'

export const SCHEDULED_PUBLISH_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS publish_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
    article_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
    timezone TEXT NOT NULL CHECK(length(timezone) > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'paused', 'fired', 'stale', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    claimed_at INTEGER,
    lease_expires_at INTEGER,
    stale_reason TEXT,
    fired_event_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_publish_schedules_due
    ON publish_schedules(status, scheduled_at)`,
]

/** Idempotently create the scheduled-publish tables if absent. Never drops/alters. */
export async function ensureScheduledPublishTables(db: Database): Promise<void> {
  for (const statement of SCHEDULED_PUBLISH_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}