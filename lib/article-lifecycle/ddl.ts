/**
 * B3-05 — article lifecycle ledger DDL (issue #37).
 *
 * Idempotent table for the independent lifecycle commands (unpublish / relive)
 * over the formal publication surface. Delivered through the independent
 * B2-01b-style DDL channel (scripts/apply-article-lifecycle-ddl.mjs), so the
 * issue-23 delivery canonical migration freeze (exactly 001..007), the
 * first-publish six-table set and the revision-loop three-table set stay
 * untouched.
 *
 * `article_lifecycles` is an IMMUTABLE history ledger: every lifecycle
 * transition an article takes (published -> unpublished via `unpublish`,
 * unpublished -> published via `relive`, either onto the last formal version
 * or the current revision) appends exactly one row bound to its operation id.
 * The row is tamper-evident (evidence_sha256 over the canonical payload) and
 * idempotent (operation_id UNIQUE — a retry replays, never duplicates).
 *
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS` — missing objects are
 * created exactly once; never drops or alters an existing row/table.
 */

import type { Database } from '@/lib/repositories/schema'

export const ARTICLE_LIFECYCLE_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS article_lifecycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
    article_id INTEGER NOT NULL,
    post_ref INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    direction TEXT NOT NULL CHECK(direction IN ('unpublish', 'relive-formal', 'relive-revision')),
    lifecycle_before TEXT NOT NULL CHECK(lifecycle_before IN ('published', 'unpublished')),
    lifecycle_after TEXT NOT NULL CHECK(lifecycle_after IN ('published', 'unpublished')),
    source_version INTEGER,
    public_url TEXT,
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    payload TEXT NOT NULL,
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_article_lifecycles_article
     ON article_lifecycles(article_id, version)`,
]

/** Idempotently create the lifecycle ledger if absent. Never drops/alters. */
export async function ensureArticleLifecycleTables(db: Database): Promise<void> {
  for (const statement of ARTICLE_LIFECYCLE_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
