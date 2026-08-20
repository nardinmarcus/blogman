/**
 * B6-02 — 源稿领先同步事实面 DDL (issue #51).
 *
 * Four tables make a source-ahead sync durable and idempotent, STRICTLY
 * separated from the B6-01 identity/link surface (which stays untouched):
 *
 *   - `media_assets`          — the durable media registry keyed by PATH-AGNOSTIC
 *     content identity (`content_sha256` UNIQUE) with the exact R2 key. Media is
 *     reused across article paths ONLY when its content is verified — never by
 *     filename (既有 R2 仅在内容身份可验证时复用, 不凭文件名推断).
 *   - `source_media_mappings` — for a given source identity + source ref, which
 *     media asset it resolves to. UNIQUE(source_identity_id, source_ref) makes a
 *     repeated sync converge on one mapping (幂等, 不丢事实).
 *   - `source_sync_attempts`  — one durable fact row PER sync operation
 *     (operation_id UNIQUE), recording BOTH successful and failed attempts so a
 *     partial failure is never silent (不丢事实). Replay by operation id returns
 *     the original outcome with zero new rows.
 *   - `source_sync_baselines` — the advanced baseline: the source fingerprint
 *     (`baseline_sha256`, source-content-only) + the synced projection + the
 *     Blogman version/revision it landed on. ONLY advanced (insert/update) when
 *     the WHOLE sync succeeds — 全部成功才推进基线. A partial or conflicting sync
 *     leaves this row untouched.
 *
 * Delivered through an independent DDL channel (`scripts/apply-source-sync-ddl.mjs`)
 * so the issue-23 canonical migration freeze and every later batch surface stay
 * untouched. Safe to run repeatedly: missing objects are created exactly once,
 * never dropped or altered.
 */

import type { Database } from '@/lib/repositories/schema'
import { ensureSourceIdentityTables } from '@/lib/source-identity'

export const SOURCE_SYNC_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_sha256 TEXT NOT NULL UNIQUE CHECK(length(content_sha256) = 64),
    r2_key TEXT NOT NULL UNIQUE CHECK(length(r2_key) > 0),
    media_type TEXT NOT NULL CHECK(length(media_type) > 0),
    filename TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS source_media_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    source_ref TEXT NOT NULL CHECK(length(source_ref) > 0),
    media_asset_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(source_identity_id, source_ref)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_media_map_asset
     ON source_media_mappings(media_asset_id)`,
  `CREATE TABLE IF NOT EXISTS source_sync_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    post_ref INTEGER,
    outcome TEXT NOT NULL CHECK(outcome IN ('synced', 'failed')),
    reason TEXT,
    baseline_sha256 TEXT,
    synced_version INTEGER,
    synced_revision_id TEXT,
    projection_json TEXT,
    media_json TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_sync_attempts_article
     ON source_sync_attempts(article_id)`,
  `CREATE TABLE IF NOT EXISTS source_sync_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256) = 64),
    synced_version INTEGER NOT NULL,
    synced_revision_id TEXT,
    synced_title TEXT NOT NULL,
    synced_markdown TEXT NOT NULL,
    synced_html TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_identity_id, article_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_sync_baselines_article
     ON source_sync_baselines(article_id)`,
]

/**
 * Idempotently create the source-sync tables if absent, AFTER the B6-01
 * source-identity tables they reference (先 identity 后 source-sync). Every
 * object is `CREATE ... IF NOT EXISTS`, so applying this DDL next to
 * `apply-article-identity-ddl` / `apply-source-identity-ddl` on the same DB is
 * a repeat-safe no-op and never drops or alters an existing object.
 */
export async function ensureSourceSyncTables(db: Database): Promise<void> {
  // B6-02 facts reference source identities — guarantee the B6-01 surface first.
  await ensureSourceIdentityTables(db)
  for (const statement of SOURCE_SYNC_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
