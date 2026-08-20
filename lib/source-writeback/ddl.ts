/**
 * B6-03 — 显式写回与同步基线 fact surface DDL (issue #52).
 *
 * Two tables make a Blogman-leading write-back durable, idempotent and
 * confirmation-gated:
 *
 *   - `source_sync_baselines`      — the single authority for "in sync /
 *     Blogman-leading / source-diverged". One row per (source identity, article)
 *     records the LAST externally-confirmed mutual state: the blogman article
 *     version and the source content hash that the primary source held at that
 *     moment. The baseline is advanced ONLY by an external write-back
 *     confirmation (确认前不推进基线); a failed or stale write-back never
 *     moves it, so Blogman stays leading.
 *   - `source_write_back_intents`  — an author-initiated write-back, bound once
 *     to article version + source identity + operation id. Lifecycle:
 *     `intent` → `written` (pushed to source, awaiting external confirmation) →
 *     `confirmed` (baseline advanced). A version change or baseline/conflict
 *     rejection moves it to terminal `stale` with NO baseline advance. A
 *     provider/device failure leaves it `intent` so the same operation can be
 *     retried; a lost response is answered by re-reading the same operation id
 *     (响应丢失可 query 同一操作). `operation_id` UNIQUE is the idempotency
 *     backstop for concurrent/repeated initiates.
 *
 * Delivered through the independent B6-01-style DDL channel
 * (`scripts/apply-write-back-ddl.mjs`) so the issue-23 canonical migration
 * freeze (exactly 001..007) and every later batch surface stay untouched.
 * Safe to run repeatedly: missing objects are created exactly once, never
 * dropped or altered.
 */

import type { Database } from '@/lib/repositories/schema'

/** One confirmed-sync baseline per (source identity, article). */
export const SOURCE_SYNC_BASELINE_DDL = `CREATE TABLE IF NOT EXISTS source_sync_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  article_version INTEGER NOT NULL,
  source_sync_sha256 TEXT NOT NULL CHECK(length(source_sync_sha256) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_identity_id, article_id)
) STRICT`

/** Author-initiated write-back intents (idempotent by operation id). */
export const SOURCE_WRITE_BACK_INTENT_DDL = `CREATE TABLE IF NOT EXISTS source_write_back_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  article_version INTEGER NOT NULL,
  baseline_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
  status TEXT NOT NULL CHECK(status IN ('intent', 'written', 'confirmed', 'stale')),
  external_ref TEXT,
  source_sync_sha256 TEXT CHECK(source_sync_sha256 IS NULL OR length(source_sync_sha256) = 64),
  intent_at INTEGER NOT NULL,
  written_at INTEGER,
  confirmed_at INTEGER
) STRICT`

export const SOURCE_WRITE_BACK_DDL_STATEMENTS: string[] = [
  SOURCE_SYNC_BASELINE_DDL,
  SOURCE_WRITE_BACK_INTENT_DDL,
  `CREATE INDEX IF NOT EXISTS idx_write_back_intents_article
     ON source_write_back_intents(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_write_back_intents_identity
     ON source_write_back_intents(source_identity_id, status)`,
]

/** Idempotently create the write-back tables if absent. Never drops/alters. */
export async function ensureWriteBackTables(db: Database): Promise<void> {
  for (const statement of SOURCE_WRITE_BACK_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
