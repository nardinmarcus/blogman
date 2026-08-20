/**
 * B6-05 — 保留关系地报告主要源稿不可用 DDL (issue #54).
 *
 * Two independent fact surfaces, kept deliberately separate:
 *
 *   - `source_availability_observations` — append-only log of every provider
 *     read attempt. This is the 可用性观察 (availability observation) fact
 *     surface. Each row is keyed by a UNIQUE `operation_id` so replayed
 *     observations converge onto one row (幂等). The `outcome` CHECK is
 *     exactly the three durable probe outcomes — readable / temporarily-
 *     unavailable / confirmed-missing — and an observation NEVER mutates a
 *     relationship or baseline.
 *   - `source_baseline_facts` — the durable sync-projection baseline (同步
 *     事实), one row per source identity. It is advanced ONLY by an explicit,
 *     author-authorized advance that first proves a reliable readable read;
 *     an unavailability observation never touches it (不可用不推进基线). The
 *     `advanced_by_operation_id` column gives idempotent replay while
 *     permitting a later author advance with a new operation id.
 *
 * Delivered through the independent DDL channel
 * (`scripts/apply-source-availability-ddl.mjs`), mirroring B6-01, so the
 * issue-23 canonical migration freeze and every other batch surface stay
 * untouched. Safe to run repeatedly: missing objects are created exactly once.
 */

import type { Database } from '@/lib/repositories/schema'

export const SOURCE_AVAILABILITY_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS source_availability_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL CHECK(source_identity_id > 0),
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    outcome TEXT NOT NULL CHECK(outcome IN ('readable', 'temporarily-unavailable', 'confirmed-missing')),
    detail TEXT,
    observed_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_avail_identity
     ON source_availability_observations(source_identity_id, observed_at)`,
  `CREATE TABLE IF NOT EXISTS source_baseline_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL UNIQUE CHECK(source_identity_id > 0),
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
    advanced_by_operation_id TEXT NOT NULL CHECK(length(advanced_by_operation_id) > 0),
    advanced_at INTEGER NOT NULL
  ) STRICT`,
]

/** Idempotently create the source-availability tables if absent. Never drops/alters. */
export async function ensureSourceAvailabilityTables(db: Database): Promise<void> {
  for (const statement of SOURCE_AVAILABILITY_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
