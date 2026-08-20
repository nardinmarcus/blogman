/**
 * B3-06 — version-bound publish suggestion DDL (issue #38).
 *
 * Idempotent tables for the author preview/apply/revoke/ignore surface over a
 * deterministic per-article analysis result. Delivered through the independent
 * B2-01b-style DDL channel (`scripts/apply-publish-suggestions-ddl.mjs`), so
 * the issue-23 delivery canonical migration freeze (exactly 001..007), the
 * first-publish set, the revision-loop set and every later batch set stay
 * untouched.
 *
 *   - `publish_preparations` — the per-article CURRENT preparation result (the
 *     analysis the suggestions belong to), bound to the exact version the AI
 *     anchored to. `status='recorded'` is the live pending result; a newer
 *     result abandons the prior one so at most ≤ 3 suggestions stay pending.
 *   - `publish_suggestions`   — the per-item suggestions. Every row is bound
 *     to a version + a content basis hash; applying goes through the article
 *     write kernel and never silently writes.
 *
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
 * EXISTS` — missing objects are created exactly once. Never drops or alters an
 * existing row/table. No local AI history is migrated into these tables.
 */

import type { Database } from '@/lib/repositories/schema'

export const PUBLISH_SUGGESTIONS_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS publish_preparations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preparation_id TEXT UNIQUE NOT NULL CHECK(length(preparation_id) > 0),
    article_id INTEGER NOT NULL,
    post_ref INTEGER NOT NULL,
    bound_version INTEGER NOT NULL CHECK(bound_version > 0),
    bound_revision TEXT,
    source TEXT NOT NULL CHECK(length(source) > 0),
    status TEXT NOT NULL CHECK(status IN ('recorded', 'applied', 'abandoned')),
    restore_point_id TEXT,
    created_at INTEGER NOT NULL,
    applied_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_publish_preparations_article
     ON publish_preparations(article_id, status)`,
  `CREATE TABLE IF NOT EXISTS publish_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id TEXT UNIQUE NOT NULL CHECK(length(suggestion_id) > 0),
    preparation_id TEXT NOT NULL CHECK(length(preparation_id) > 0),
    article_id INTEGER NOT NULL,
    field TEXT NOT NULL CHECK(field IN ('category', 'tags', 'description', 'title', 'content')),
    value TEXT NOT NULL,
    field_before TEXT,
    basis_sha256 TEXT NOT NULL CHECK(length(basis_sha256) = 64),
    bound_version INTEGER NOT NULL CHECK(bound_version > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'ignored', 'revoked', 'stale', 'abandoned')),
    applied_operation_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_publish_suggestions_article
     ON publish_suggestions(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_publish_suggestions_prep
     ON publish_suggestions(preparation_id)`,
]

/** Idempotently create the suggestion tables if absent. Never drops/alters. */
export async function ensurePublishSuggestionsTables(db: Database): Promise<void> {
  for (const statement of PUBLISH_SUGGESTIONS_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
