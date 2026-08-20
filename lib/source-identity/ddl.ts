/**
 * B6-01 — independent source-identity fact surface DDL (issue #50).
 *
 * Three tables make a writable primary source durable and idempotent:
 *
 *   - `source_identities`      — one row per canonical URL identity. The
 *     `canonical_url` / `identity_sha256` UNIQUE constraints are what converge
 *     concurrent / repeated recording onto a single identity (幂等识别).
 *   - `source_url_variants`    — explicit author merges: a variant canonical
 *     URL that resolves to a target identity WITHOUT guessing. Additive only;
 *     the variant (and any identity row it had) is never dropped (保留身份).
 *   - `article_source_links`   — the pending/confirmed/cancelled association
 *     between a source identity and an article. `pending` LINK DOES NOT take
 *     effect (待确认关联, not auto-effective) until confirmed. One live
 *     (non-cancelled) link per source identity is hard-enforced by a partial
 *     unique index, so a source can never silently own two articles and a
 *     duplicate URL always converges to the existing owner.
 *
 * Delivered through the independent B2-01b-style DDL channel
 * (`scripts/apply-source-identity-ddl.mjs`) so the issue-23 canonical migration
 * freeze (exactly 001..007) and every later batch surface stay untouched.
 * Safe to run repeatedly: missing objects are created exactly once, never
 * dropped or altered.
 */

import type { Database } from '@/lib/repositories/schema'

export const SOURCE_IDENTITY_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS source_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_url TEXT NOT NULL UNIQUE CHECK(length(canonical_url) > 0),
    identity_sha256 TEXT NOT NULL UNIQUE CHECK(length(identity_sha256) = 64),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS source_url_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    variant_canonical_url TEXT NOT NULL UNIQUE CHECK(length(variant_canonical_url) > 0),
    merged_by_operation_id TEXT NOT NULL UNIQUE CHECK(length(merged_by_operation_id) > 0),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_url_variants_identity
     ON source_url_variants(source_identity_id)`,
  `CREATE TABLE IF NOT EXISTS article_source_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled')),
    role TEXT NOT NULL DEFAULT 'primary' CHECK(role IN ('primary', 'clip')),
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  ) STRICT`,
  // At most one live (pending/confirmed) link per source identity — a source
  // never silently owns two articles. Cancelled rows remain as history and a
  // NEW attempt starts a fresh pending link.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_article_source_live
     ON article_source_links(source_identity_id) WHERE status != 'cancelled'`,
  `CREATE INDEX IF NOT EXISTS idx_article_source_article
     ON article_source_links(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_article_source_identity
     ON article_source_links(source_identity_id, status)`,
]

/** Idempotently create the source-identity tables if absent. Never drops/alters. */
export async function ensureSourceIdentityTables(db: Database): Promise<void> {
  for (const statement of SOURCE_IDENTITY_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
