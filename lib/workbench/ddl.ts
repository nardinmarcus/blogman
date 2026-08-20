/**
 * B4-04 — workbench projection DDL (issue #43).
 *
 * Additive control surfaces only — the workbench itself is a READ ONLY
 * projection over authoritative tables, so the only thing this module owns is
 * a tiny control table used to switch the projection on/off (never to store
 * derived workbench facts, which would make it a false recovery source).
 *
 * `workbench_controls` holds a single `workbench` row whose `enabled` flag the
 * read path consults. Disabling the projection never touches a source task,
 * schedule, article or publish fact — it only stops presenting the derived
 * view. Safe to run repeatedly via `CREATE TABLE IF NOT EXISTS`.
 */

import type { Database } from '@/lib/repositories/schema'

export const WORKBENCH_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_controls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL CHECK(length(key) > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT`,
]

/** Idempotently create the workbench control table if absent. Never drops/alters. */
export async function ensureWorkbenchTables(db: Database): Promise<void> {
  for (const statement of WORKBENCH_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
