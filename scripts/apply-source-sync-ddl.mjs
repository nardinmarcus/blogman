#!/usr/bin/env node
/**
 * B6-02 — idempotent source-sync DDL for the `media_assets`,
 * `source_media_mappings`, `source_sync_attempts` + `source_sync_baselines`
 * tables (issue #51).
 *
 * Delivered through an independent DDL channel (like B6-01's sibling
 * `apply-source-identity-ddl.mjs`) so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) stays untouched. Safe to run repeatedly:
 * each missing table/index is created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-source-sync-ddl.mjs --local
 *   node scripts/apply-source-sync-ddl.mjs --remote
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DDL = [
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

function usage() {
  console.error(
    'usage: node scripts/apply-source-sync-ddl.mjs --local|--remote ' +
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
  'idx_source_media_map_asset',
  'idx_source_sync_attempts_article',
  'idx_source_sync_baselines_article',
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
    ['idx_source_media_map_asset', DDL[2]],
    ['source_sync_attempts', DDL[3]],
    ['idx_source_sync_attempts_article', DDL[4]],
    ['source_sync_baselines', DDL[5]],
    ['idx_source_sync_baselines_article', DDL[6]],
  ]
  const applied = []
  for (const [name, sql] of statementToName) {
    if (existing.has(name)) continue
    runWrangler(args, sql)
    applied.push(name)
  }
  if (applied.length === 0) {
    console.log('source sync DDL already present; nothing to do')
    process.exit(0)
  }
  console.log('source sync DDL applied:', applied.join(', '))
}

main()
