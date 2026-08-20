#!/usr/bin/env node
/**
 * B6-04 — idempotent conflict-resolution DDL (issue #53).
 *
 * Creates the fact surface the explicit side-choice command needs:
 *
 *   - reuses the B6-02 sync facts verbatim (`media_assets`,
 *     `source_media_mappings`, `source_sync_attempts`),
 *   - creates the UNION `source_sync_baselines` authority (version + source
 *     hash + snapshot projection columns), superseding the two incompatible
 *     B6-02/B6-03 shapes for the same table name,
 *   - reuses the B6-03 `source_write_back_intents` + indexes verbatim,
 *   - creates `source_conflict_resolutions` — one durable explicit side-choice
 *     per operation id, bound to the baseline + the source fingerprint + the
 *     Blogman version it was anchored to (任一方变化使旧选择过期), idempotent by
 *     operation id (重复操作幂等).
 *
 * Delivered through the independent B6-01-style DDL channel so the issue-23
 * canonical migration freeze stays untouched. Safe to run repeatedly: missing
 * objects are created exactly once, never dropped or altered.
 *
 * Usage:
 *   node scripts/apply-conflict-ddl.mjs --local
 *   node scripts/apply-conflict-ddl.mjs --remote
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MEDIA_ASSETS_DDL = `CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_sha256 TEXT NOT NULL UNIQUE CHECK(length(content_sha256) = 64),
  r2_key TEXT NOT NULL UNIQUE CHECK(length(r2_key) > 0),
  media_type TEXT NOT NULL CHECK(length(media_type) > 0),
  filename TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT`

const SOURCE_MEDIA_MAPPINGS_DDL = `CREATE TABLE IF NOT EXISTS source_media_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_identity_id INTEGER NOT NULL,
  source_ref TEXT NOT NULL CHECK(length(source_ref) > 0),
  media_asset_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_identity_id, source_ref)
) STRICT`

const SOURCE_SYNC_ATTEMPTS_DDL = `CREATE TABLE IF NOT EXISTS source_sync_attempts (
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
) STRICT`

const BASELINE_DDL = `CREATE TABLE IF NOT EXISTS source_sync_baselines (
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

const WRITE_BACK_INTENT_DDL = `CREATE TABLE IF NOT EXISTS source_write_back_intents (
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

const RESOLUTION_DDL = `CREATE TABLE IF NOT EXISTS source_conflict_resolutions (
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

// Mirrors lib/source-conflict/ddl.ts — keep both in lockstep.
const DDL = [
  MEDIA_ASSETS_DDL,
  SOURCE_MEDIA_MAPPINGS_DDL,
  SOURCE_SYNC_ATTEMPTS_DDL,
  BASELINE_DDL,
  WRITE_BACK_INTENT_DDL,
  `CREATE INDEX IF NOT EXISTS idx_write_back_intents_article
     ON source_write_back_intents(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_write_back_intents_identity
     ON source_write_back_intents(source_identity_id, status)`,
  RESOLUTION_DDL,
  `CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_article
     ON source_conflict_resolutions(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_identity
     ON source_conflict_resolutions(source_identity_id, status)`,
]

function usage() {
  console.error(
    'usage: node scripts/apply-conflict-ddl.mjs --local|--remote ' +
      '[--persist-to <dir>] [--database <name>] [--config <path>]',
  )
}

function parseArgs(argv) {
  const args = { database: 'DB', config: join(repoRoot, 'wrangler.toml') }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--local') args.local = true
    else if (flag === '--remote') args.remote = true
    else if (flag === '--persist-to') args.persistTo = argv[++i]
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = argv[++i]
    else {
      usage()
      process.exit(2)
    }
  }
  if (!args.local && !args.remote) {
    usage()
    process.exit(2)
  }
  return args
}

function wranglerBin() {
  const bin = join(repoRoot, 'node_modules', '.bin', 'wrangler')
  if (!existsSync(bin)) {
    throw new Error('wrangler binary not found; run npm ci first')
  }
  return bin
}

function runWrangler(args, command) {
  const result = spawnSync(
    wranglerBin(),
    [
      'd1', 'execute', args.database,
      ...(args.local ? ['--local'] : ['--remote']),
      ...(args.persistTo ? ['--persist-to', args.persistTo] : []),
      '--config', args.config, '--command', command, '--json',
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'wrangler d1 execute failed')
  }
  return result.stdout
}

function existingObjectNames(args, names) {
  const stdout = runWrangler(
    args,
    `SELECT name FROM sqlite_schema WHERE type IN ('table','index')
     AND name IN (${names.map((n) => `'${n}'`).join(',')})`,
  )
  let rows = []
  try {
    rows = JSON.parse(stdout)[0]?.results ?? []
  } catch {
    rows = []
  }
  return new Set(rows.map((row) => row.name))
}

const OBJECT_NAMES = [
  'media_assets',
  'source_media_mappings',
  'source_sync_attempts',
  'source_sync_baselines',
  'source_write_back_intents',
  'source_conflict_resolutions',
  'idx_write_back_intents_article',
  'idx_write_back_intents_identity',
  'idx_conflict_resolutions_article',
  'idx_conflict_resolutions_identity',
]

function main() {
  const args = parseArgs(process.argv.slice(2))
  let existing
  try {
    existing = existingObjectNames(args, OBJECT_NAMES)
  } catch (error) {
    console.error(`WARN: could not read object list (${error.message}); assuming absent`)
    existing = new Set()
  }
  const statementToName = [
    ['media_assets', DDL[0]],
    ['source_media_mappings', DDL[1]],
    ['source_sync_attempts', DDL[2]],
    ['source_sync_baselines', DDL[3]],
    ['source_write_back_intents', DDL[4]],
    ['idx_write_back_intents_article', DDL[5]],
    ['idx_write_back_intents_identity', DDL[6]],
    ['source_conflict_resolutions', DDL[7]],
    ['idx_conflict_resolutions_article', DDL[8]],
    ['idx_conflict_resolutions_identity', DDL[9]],
  ]
  const applied = []
  for (const [name, sql] of statementToName) {
    if (existing.has(name)) continue
    runWrangler(args, sql)
    applied.push(name)
  }
  if (applied.length === 0) {
    console.log('conflict-resolution DDL already present; nothing to do')
    process.exit(0)
  }
  console.log('conflict-resolution DDL applied:', applied.join(', '))
}

main()