/**
 * B4-05 — email reminder DDL (issue #44).
 *
 * Additive fact surfaces only, through the same independent DDL channel as the
 * notification tables (#43): the executor CONTROL row (`email_reminder_config`,
 * kill-switch + policy) and the DELIVERY + DEDUP facts (`email_deliveries`,
 * keyed by the same (source_type, source_id) the notification kernel uses).
 *
 * Boundaries:
 *   - never writes to `activity_notifications` or any source/publish table —
 *     email is a consumer/task adapter and the provider is non-authoritative,
 *   - `email_deliveries` is additive retry/dedup evidence, never a recovery
 *     source for the underlying facts,
 *   - safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`, never drops/alters.
 */

import type { Database } from '@/lib/repositories/schema'

export const EMAIL_REMINDERS_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS email_reminder_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL CHECK(length(key) > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    recipients_json TEXT NOT NULL,
    from_address TEXT,
    threshold_seconds INTEGER NOT NULL DEFAULT 0 CHECK(threshold_seconds >= 0),
    quiet_start_minute INTEGER NOT NULL DEFAULT 0 CHECK(quiet_start_minute BETWEEN 0 AND 1439),
    quiet_end_minute INTEGER NOT NULL DEFAULT 0 CHECK(quiet_end_minute BETWEEN 0 AND 1439),
    utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
    cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_seconds >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS email_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK(length(source_type) > 0),
    source_id TEXT NOT NULL CHECK(length(source_id) > 0),
    last_attempt_at INTEGER,
    last_sent_at INTEGER,
    sent_count INTEGER NOT NULL DEFAULT 0 CHECK(sent_count >= 0),
    last_status TEXT NOT NULL DEFAULT 'skipped' CHECK(last_status IN ('skipped', 'sent', 'failed')),
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_type, source_id)
  ) STRICT`,
]

/** Idempotently create the email reminder tables if absent. Never drops/alters. */
export async function ensureEmailReminderTables(db: Database): Promise<void> {
  for (const statement of EMAIL_REMINDERS_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}