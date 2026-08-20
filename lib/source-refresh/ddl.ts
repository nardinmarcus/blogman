/**
 * B7-02 — 比较后显式刷新来源网页事实面 DDL (issue #58).
 *
 * Two tables make a clip-source refresh durable, idempotent and DEFINITELY not
 * the source of continuous writing authority — the DDL is STRICTLY separated
 * from the B6 primary-source facts (`source_sync_attempts` / baselines), which
 * a refresh NEVER touches (来源网页不取得持续写作权威):
 *
 *   - `source_refresh_proposals` — one durable row PER 提出 (propose) operation
 *     (operation_id UNIQUE). A proposal freezes the SOURCE SNAPSHOT (normalized
 *     title + rewritten Markdown + rendered HTML + media facts) PLUS the diff
 *     against the current article and the Blogman VERSION it was bound to
 *     (`proposed_version`). It does NOT write the article. Re-proposing the
 *     same operation id replays the original snapshot with zero new rows.
 *     `status`: `proposed` (confirmable) | `no-diff` (nothing to refresh) |
 *     `confirmed` | `cancelled` | `stale` (version moved → re-comparison needed).
 *   - `source_refresh_records` — one durable row PER 确认 (confirm) operation
 *     (operation_id UNIQUE): the completed refresh's applied version / revision
 *     id, its snapshot + diff + media facts. Replaying the same confirm
 *     operation id returns the original facts with zero new writes.
 *
 * Media reuse is by PATH-AGNOSTIC content identity through the shared
 * `media_assets` / `source_media_mappings` tables (reused from the B6-02
 * surface, never duplicated here) — content is reused only when its sha256 is
 * verified, never guessed from a filename (不凭文件名推断).
 *
 * Delivered through an independent DDL channel (`scripts/apply-source-refresh-ddl.mjs`)
 * so the issue-23 canonical migration freeze and every earlier batch surface
 * stay untouched. Safe to run repeatedly: missing objects are created exactly
 * once, never dropped or altered.
 */

import type { Database } from '@/lib/repositories/schema'
import { ensureSourceIdentityTables } from '@/lib/source-identity'
import { ensureSourceSyncTables } from '@/lib/source-sync'

export const SOURCE_REFRESH_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS source_refresh_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    post_ref INTEGER,
    role TEXT NOT NULL DEFAULT 'clip' CHECK(role = 'clip'),
    proposed_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK(status IN ('proposed', 'no-diff', 'confirmed', 'cancelled', 'stale')),
    source_title TEXT NOT NULL,
    source_markdown TEXT NOT NULL,
    source_html TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
    diff_json TEXT NOT NULL,
    media_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_refresh_proposals_article
     ON source_refresh_proposals(article_id)`,
  `CREATE TABLE IF NOT EXISTS source_refresh_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    proposal_operation_id TEXT NOT NULL CHECK(length(proposal_operation_id) > 0),
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    post_ref INTEGER,
    role TEXT NOT NULL DEFAULT 'clip' CHECK(role = 'clip'),
    outcome TEXT NOT NULL CHECK(outcome IN ('refreshed', 'failed')),
    reason TEXT,
    expected_version INTEGER NOT NULL,
    applied_version INTEGER,
    applied_revision_id TEXT,
    baseline_sha256 TEXT,
    projection_json TEXT,
    media_json TEXT,
    diff_json TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_refresh_records_article
     ON source_refresh_records(article_id)`,
]

/**
 * Idempotently create the source-refresh tables if absent. They reference the
 * B6-01 source-identity tables AND share the B6-02 `media_assets` /
 * `source_media_mappings` for content-identity media reuse — so identity and
 * sync surfaces are guaranteed first. Every object is `CREATE ... IF NOT
 * EXISTS`, so applying this DDL next to the earlier batch DDLs on the same DB
 * is a repeat-safe no-op.
 */
export async function ensureSourceRefreshTables(db: Database): Promise<void> {
  await ensureSourceIdentityTables(db)
  await ensureSourceSyncTables(db)
  for (const statement of SOURCE_REFRESH_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
