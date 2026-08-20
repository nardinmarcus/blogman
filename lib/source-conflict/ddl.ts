/**
 * B6-04 — 明确选边解决主要源稿内容冲突 fact surface DDL (issue #53).
 *
 * The conflict resolution surface is derived from the B6-01 identity/link
 * tables, the B6-02 sync facts (media_assets / source_media_mappings /
 * source_sync_attempts) and the B6-03 write-back facts (source_write_back_
 * intents), PLUS one new table and one upgraded table:
 *
 *   - `source_sync_baselines` — the SINGLE confirmed-sync authority. B6-02 and
 *     B6-03 shipped two incompatible shapes for the same table name (each
 *     `CREATE TABLE IF NOT EXISTS` skips when the other already created it).
 *     This channel owns the UNION shape so every consumer reads the same row:
 *     the B6-03 version+source-hash authority (`article_version`,
 *     `source_sync_sha256`) and the B6-02 projection snapshot
 *     (`baseline_sha256`, `synced_version`, `synced_revision_id`,
 *     `synced_title/markdown/html`, `synced_media_json`). All projection
 *     columns are nullable so each writer stores what it knows; the conflict
 *     kernel reads defensively and NEVER fabricates a value.
 *   - `source_conflict_resolutions` — one durable explicit side-choice per
 *     operation id. Binds the choice to the baseline, the source fingerprint
 *     and the Blogman version it was anchored to, so ANY change on either side
 *     expires it (任一方变化使旧选择过期), and the whole resolution is idempotent
 *     by operation id (重复操作幂等). Status is a command lifecycle label
 *     (`open` → `applied` / `expired`) — it is NOT a手改权威状态; the conflict
 *     itself is always re-derived by probing both projections vs the baseline.
 *
 * Delivered through the independent B6-01-style DDL channel
 * (`scripts/apply-conflict-ddl.mjs`) so the issue-23 canonical migration
 * freeze and every earlier batch surface stay untouched. Safe to run
 * repeatedly: missing objects are created exactly once, never dropped or
 * altered.
 */

import type { Database } from '@/lib/repositories/schema'
import { ensureSourceIdentityTables } from '@/lib/source-identity'
import { SOURCE_SYNC_DDL_STATEMENTS } from '@/lib/source-sync/ddl'
import { SOURCE_WRITE_BACK_DDL_STATEMENTS } from '@/lib/source-writeback/ddl'

/** Namespaced resolution operation ids (kept apart from the write-back intents). */
export const CONFLICT_SAVE_OP_PREFIX = 'conflict-src:'
export const CONFLICT_WRITE_BACK_OP_PREFIX = 'conflict-wb:'

export const SOURCE_CONFLICT_BASELINE_DDL = `CREATE TABLE IF NOT EXISTS source_sync_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  article_version INTEGER,
  source_sync_sha256 TEXT CHECK(source_sync_sha256 IS NULL OR length(source_sync_sha256) = 64),
  baseline_sha256 TEXT CHECK(baseline_sha256 IS NULL OR length(baseline_sha256) = 64),
  synced_version INTEGER,
  synced_revision_id TEXT,
  synced_title TEXT,
  synced_markdown TEXT,
  synced_html TEXT,
  synced_media_json TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL,
  UNIQUE(source_identity_id, article_id)
) STRICT`

export const SOURCE_CONFLICT_RESOLUTION_DDL = `CREATE TABLE IF NOT EXISTS source_conflict_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
  source_identity_id INTEGER NOT NULL,
  article_id INTEGER NOT NULL,
  chosen_side TEXT NOT NULL CHECK(chosen_side IN ('source', 'blogman')),
  baseline_version INTEGER NOT NULL,
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256) = 64),
  anchored_source_sha256 TEXT NOT NULL CHECK(length(anchored_source_sha256) = 64),
  anchored_article_version INTEGER NOT NULL,
  source_projection_json TEXT NOT NULL,
  source_media_json TEXT NOT NULL,
  pre_resolution_snapshot_json TEXT NOT NULL,
  write_back_content_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'applied', 'expired')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER
) STRICT`

/**
 * The full DDL set this channel owns. B6-02/B6-03 statements are reused
 * verbatim except their own `source_sync_baselines` shapes (superseded by the
 * union above) — media/mappings/attempts and write-back intents keep their
 * exact original definitions.
 */
export const SOURCE_CONFLICT_DDL_STATEMENTS: string[] = [
  // sync facts (media/mappings/attempts) verbatim, WITHOUT the B6-02 baseline
  // table AND its index (superseded by the union baseline below), so no
  // statement ever references the table before it exists.
  ...SOURCE_SYNC_DDL_STATEMENTS.filter((statement) => !statement.includes('source_sync_baselines')),
  SOURCE_CONFLICT_BASELINE_DDL,
  // write-back intents + indexes verbatim, without B6-03's baseline table.
  ...SOURCE_WRITE_BACK_DDL_STATEMENTS.filter((statement) => !statement.includes('source_sync_baselines')),
  SOURCE_CONFLICT_RESOLUTION_DDL,
  `CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_article
     ON source_conflict_resolutions(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_identity
     ON source_conflict_resolutions(source_identity_id, status)`,
]

/** Idempotently create the conflict tables if absent, after the B6-01 surface. */
export async function ensureConflictTables(db: Database): Promise<void> {
  await ensureSourceIdentityTables(db)
  for (const statement of SOURCE_CONFLICT_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}