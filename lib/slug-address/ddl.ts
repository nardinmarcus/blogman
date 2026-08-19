/**
 * B3-04 — permanent slug address registry DDL (issue #36).
 *
 * Idempotent registry that makes EVERY public address an article has ever been
 * (or is about to be) reachable under a single article identity exclusive and
 * permanent:
 *
 *   - `current`    — the live public address (resolved directly),
 *   - `candidate`  — a pending revision's not-yet-live address (reserved but
 *     never served until the promoting revision goes live),
 *   - `historical` — a superseded live address that permanently single-hops to
 *     the article's `current` address (no redirect chain).
 *
 * A single row per `slug` (global UNIQUE) is the hard enforcement of "按文章身份
 * 独占": no two articles may ever share the same current / candidate / historical
 * address, and a slug stays occupied even after a candidate edit is closed.
 * At most one `current` row per article (partial unique index); multiple
 * `historical` / `candidate` rows are allowed because an article may have been
 * renamed several times / tried several candidate slugs before go-live.
 *
 * Delivered through the same independent DDL channel
 * (`scripts/apply-slug-address-ddl.mjs`) as every other post-issue-23 fact
 * surface, so the issue-23 canonical migration freeze (exactly 001..007) stays
 * untouched. Safe to run repeatedly; never drops or alters an existing row.
 */

import type { Database } from '@/lib/repositories/schema'

export const SLUG_ADDRESS_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS article_slug_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE CHECK(length(slug) > 0),
    article_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('current', 'candidate', 'historical')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_article_slug_current
     ON article_slug_addresses(article_id) WHERE kind = 'current'`,
  `CREATE INDEX IF NOT EXISTS idx_article_slug_article
     ON article_slug_addresses(article_id, kind)`,
]

/** Idempotently create the slug-address registry if absent. Never drops/alters. */
export async function ensureSlugAddressTables(db: Database): Promise<void> {
  for (const statement of SLUG_ADDRESS_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
