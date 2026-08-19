/**
 * B3-02 — formal-article pending revision DDL (issue #34).
 *
 * Idempotent tables for the revision loop, delivered through the independent
 * B2-01b-style DDL channel (`scripts/apply-publish-revision-ddl.mjs`), so the
 * issue-23 delivery canonical migration freeze (exactly 001..007) and the
 * first-publish six-table set stay untouched. The three fact surfaces:
 *
 *   1. `publish_revisions`      — the pending revision row; the partial unique
 *      index on (article_id, status='active') enforces at most ONE active
 *      revision per article, so every writer lands in the same row.
 *   2. `publish_restore_points` — the pre-promotion formal snapshot written in
 *      the same transaction as the promotion (rollback material).
 *   3. `publish_promotions`     — one immutable event per promotion, with a
 *      canonical evidence payload bound to the promoted version + public URL.
 *
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX
 * IF NOT EXISTS`; missing objects are created exactly once. Never drops or
 * alters an existing row/table.
 */

import type { Database } from '@/lib/repositories/schema'

export const PUBLISH_REVISION_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS publish_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revision_id TEXT UNIQUE NOT NULL CHECK(length(revision_id) > 0),
    article_id INTEGER NOT NULL,
    base_version INTEGER NOT NULL CHECK(base_version > 0),
    revision_number INTEGER NOT NULL CHECK(revision_number > 0),
    status TEXT NOT NULL CHECK(status IN ('active', 'promoted', 'discarded')),
    slug TEXT NOT NULL CHECK(length(slug) > 0),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    html TEXT NOT NULL,
    description TEXT,
    category TEXT,
    tags TEXT,
    password TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
    is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0, 1)),
    cover_image TEXT,
    content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_revisions_active
     ON publish_revisions(article_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS publish_restore_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restore_point_id TEXT UNIQUE NOT NULL CHECK(length(restore_point_id) > 0),
    article_id INTEGER NOT NULL,
    formal_version INTEGER NOT NULL CHECK(formal_version > 0),
    promoted_version INTEGER NOT NULL CHECK(promoted_version > 0),
    snapshot_json TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
    reason TEXT NOT NULL CHECK(length(reason) > 0),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS publish_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id TEXT UNIQUE NOT NULL CHECK(length(promotion_id) > 0),
    article_id INTEGER NOT NULL,
    revision_id TEXT NOT NULL CHECK(length(revision_id) > 0),
    base_version INTEGER NOT NULL CHECK(base_version > 0),
    promoted_version INTEGER NOT NULL CHECK(promoted_version > 0),
    slug TEXT NOT NULL CHECK(length(slug) > 0),
    public_url TEXT NOT NULL CHECK(length(public_url) > 0),
    content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    payload TEXT NOT NULL,
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_promotions_article
     ON publish_promotions(article_id, promoted_version)`,
  `CREATE TABLE IF NOT EXISTS publish_restore_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restore_operation_id TEXT UNIQUE NOT NULL CHECK(length(restore_operation_id) > 0),
    article_id INTEGER NOT NULL,
    source_restore_point_id TEXT NOT NULL CHECK(length(source_restore_point_id) > 0),
    target TEXT NOT NULL CHECK(target IN ('revision', 'draft')),
    expected_version INTEGER NOT NULL CHECK(expected_version > 0),
    pre_restore_snapshot_json TEXT NOT NULL,
    pre_restore_content_sha256 TEXT NOT NULL,
    revision_id TEXT,
    draft_article_id INTEGER,
    post_ref INTEGER,
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    status TEXT NOT NULL CHECK(status IN ('active', 'undone')),
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_publish_restore_ops_article
     ON publish_restore_ops(article_id)`,
]

/** Idempotently create the revision-loop tables if absent. Never drops/alters. */
export async function ensurePublishRevisionTables(db: Database): Promise<void> {
  for (const statement of PUBLISH_REVISION_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}