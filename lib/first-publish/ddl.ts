/**
 * B3-01 — first formal publish DDL (issue #33).
 *
 * Idempotent tables for the desktop-safe publish loop, delivered through the
 * independent B2-01b-style DDL channel (`scripts/apply-first-publish-ddl.mjs`)
 * so the issue-23 delivery canonical migration freeze (exactly 001..007) stays
 * untouched. The six fact surfaces are STRICTLY separated:
 *
 *   1. `publish_prepares`       — deterministic workbench preparation (the
 *      author's decision of which exact server-saved version to publish).
 *   2. `publish_intents`        — the author's confirm decision; at most one
 *      intent per prepare, idempotent by `intent_id`.
 *   3. `publish_events`         — the single immutable event per intent.
 *   4. `publish_outbox`         — the durable external-I/O queue; at most one
 *      row per event, always written inside the same transaction as the event.
 *   5. `formal_publications`    — the current formal version + public address
 *      for an article (never fabricated by a draft; first publish only).
 *   6. `publish_receipts`       — the independent blog receipt bound to the
 *      event that produced the public address.
 *
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`; missing tables are
 * created exactly once. Never drops or alters an existing row/table.
 */

import type { Database } from '@/lib/repositories/schema'

export const FIRST_PUBLISH_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS publish_prepares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prepare_id TEXT UNIQUE NOT NULL CHECK(length(prepare_id) > 0),
    article_id INTEGER NOT NULL,
    post_ref INTEGER NOT NULL,
    prepared_version INTEGER NOT NULL CHECK(prepared_version > 0),
    prepared_slug TEXT NOT NULL CHECK(length(prepared_slug) > 0),
    prepared_title TEXT NOT NULL,
    prepared_content_sha256 TEXT NOT NULL CHECK(prepared_content_sha256 = '' OR length(prepared_content_sha256) = 64),
    blocker_saved INTEGER NOT NULL CHECK(blocker_saved IN (0, 1)),
    blocker_lifecycle INTEGER NOT NULL CHECK(blocker_lifecycle IN (0, 1)),
    blocker_slug INTEGER NOT NULL CHECK(blocker_slug IN (0, 1)),
    blocker_content INTEGER NOT NULL CHECK(blocker_content IN (0, 1)),
    status TEXT NOT NULL CHECK(status IN ('prepared', 'committed', 'aborted', 'superseded')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS publish_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT UNIQUE NOT NULL CHECK(length(intent_id) > 0),
    prepare_id TEXT UNIQUE NOT NULL CHECK(length(prepare_id) > 0),
    article_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    slug TEXT NOT NULL CHECK(length(slug) > 0),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'prepared', 'published', 'unpublished', 'deleted')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS publish_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
    intent_id TEXT UNIQUE NOT NULL CHECK(length(intent_id) > 0),
    article_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    slug TEXT NOT NULL CHECK(length(slug) > 0),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'prepared', 'published', 'unpublished', 'deleted')),
    first_published_at INTEGER NOT NULL,
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS publish_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outbox_id TEXT UNIQUE NOT NULL CHECK(length(outbox_id) > 0),
    event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
    article_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    kind TEXT NOT NULL CHECK(kind IN ('public-receipt', 'index-invalidate', 'notify')),
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS formal_publications (
    article_id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version > 0),
    slug TEXT NOT NULL UNIQUE CHECK(length(slug) > 0),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('published', 'unpublished')),
    first_published_at INTEGER NOT NULL,
    published_at INTEGER NOT NULL,
    public_url TEXT NOT NULL CHECK(length(public_url) > 0),
    event_id TEXT NOT NULL CHECK(length(event_id) > 0)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS publish_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
    article_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    slug TEXT NOT NULL,
    public_url TEXT NOT NULL,
    receipt_payload TEXT NOT NULL,
    verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
    verified_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
]

/** Idempotently create the first-publish tables if absent. Never drops/alters. */
export async function ensureFirstPublishTables(db: Database): Promise<void> {
  for (const statement of FIRST_PUBLISH_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}