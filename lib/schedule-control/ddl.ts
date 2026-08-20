/**
 * B4-02 — schedule control command DDL (issue #41).
 *
 * Every control action (pause / re-confirm / reschedule / cancel / publish-now)
 * is an independently idempotent command keyed by an author-generated
 * `operationId`. This table is the operation ledger: it makes a repeated
 * command replay exactly what the first run recorded (never a second side
 * effect) and doubles as the audit trail — "各动作可预测可审计". It is purely
 * additive: it never drops, alters, nor reads article / schedule / publish
 * facts, so "取消/暂停不删事实" holds by construction.
 *
 * Cancelling / pausing a schedule only flips the `publish_schedules.status`
 * (a pause retains the original `scheduled_at` + bound `version`); the update
 * is a single guarded conditional statement, so no schedule row is ever
 * deleted and no publish fact is ever destroyed.
 */

import type { Database } from '@/lib/repositories/schema'

export const SCHEDULE_CONTROL_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schedule_control_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
    schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
    action TEXT NOT NULL CHECK(action IN ('pause', 'reconfirm', 'reschedule', 'cancel', 'publish_now')),
    result TEXT NOT NULL CHECK(length(result) > 0),
    created_at INTEGER NOT NULL
  ) STRICT`,
]

/** Idempotently create the schedule-control ledger if absent. Never drops/alters. */
export async function ensureScheduleControlTables(db: Database): Promise<void> {
  for (const statement of SCHEDULE_CONTROL_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
