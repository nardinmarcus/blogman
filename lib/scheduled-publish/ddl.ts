/**
 * B4-01 / B4-03 — scheduled publish DDL (issues #40 + #42).
 *
 * Adds exactly TWO fact tables to the existing publish surface —
 * `publish_schedules` and `publish_attempts` — through the same independent
 * DDL channel as B2-01b / B2-02 / B2-G / B3-01 / B3-02 / B3-05 so the
 * issue-23 delivery canonical migration freeze (exactly 001..007) and the
 * first-publish/revision/lifecycle tables stay untouched. Additive only:
 * never drops or alters an existing row/table.
 *
 * B4-03 extends the schedule row with three additive columns (`revision`,
 * `next_attempt_at`, `lease_token`) and adds the immutable attempt table.
 * Because D1 cannot express `ADD COLUMN IF NOT EXISTS`, installs that already
 * own the B4-01 `publish_schedules` shape are upgraded through a PRAGMA-driven
 * conditional `ALTER TABLE ADD COLUMN` (the same pattern as the B2-01b
 * content-envelope channel) — fresh installs get the full shape straight from
 * the CREATE statement.
 *
 * The schedule row binds: the author-generated schedule id (idempotency key),
 * the article identity, the EXACT confirmed version, the absolute execution
 * time (epoch seconds) and the IANA timezone chosen by the author. The status
 * machine is owned by the scan kernel: `pending` (armed, with `next_attempt_at`
 * encoding the retry backoff) → `claimed` (leased in-flight, guarded by
 * `lease_token` + `revision`) → `fired` / `stale`; `paused` holds an armed
 * intent (PAUSED — fires suspended, original time + bound version retained)
 * until the author re-confirms / reschedules (issue #41 command surface);
 * `cancelled` terminates a pending/claimed/paused row. `attempt_count` +
 * `last_error` + the per-attempt rows keep the "core failure retries reliably
 * under a cap+backoff, version drift goes stale" distinction.
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
    lease_token TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    stale_reason TEXT,
    fired_event_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_publish_schedules_due
    ON publish_schedules(status, scheduled_at)`,
  `CREATE TABLE IF NOT EXISTS publish_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
    schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
    attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
    started_at INTEGER NOT NULL CHECK(started_at > 0),
    finished_at INTEGER,
    outcome TEXT CHECK(outcome IN ('fired', 'stale', 'retried', 'failed', 'abandoned', 'cancelled')),
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(schedule_id, attempt_no)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_publish_attempts_schedule
    ON publish_attempts(schedule_id, attempt_no)`,
]

/**
 * Additive B4-03 columns for `publish_schedules`. Applied only when absent
 * (checked via PRAGMA), so the DDL channel stays safe to run repeatedly over
 * both fresh and B4-01-era installs.
 */
export const SCHEDULED_PUBLISH_ADDITIVE_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
  { name: 'lease_token', definition: 'TEXT' },
  { name: 'revision', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'next_attempt_at', definition: 'INTEGER' },
]

/**
 * Idempotently create the scheduled-publish tables if absent and upgrade a
 * B4-01-era `publish_schedules` to the B4-03 shape. Never drops/alters
 * existing rows or tables.
 */
export async function ensureScheduledPublishTables(db: Database): Promise<void> {
  for (const statement of SCHEDULED_PUBLISH_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
  const { results } = await db.prepare('PRAGMA table_info(publish_schedules)').all<{ name: string }>()
  const existing = new Set(results.map((row) => row.name))
  for (const column of SCHEDULED_PUBLISH_ADDITIVE_COLUMNS) {
    if (!existing.has(column.name)) {
      await db.prepare(`ALTER TABLE publish_schedules ADD COLUMN ${column.name} ${column.definition}`).run()
    }
  }
}