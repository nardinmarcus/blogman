#!/usr/bin/env node
/**
 * B7-02 — idempotent source-refresh DDL for the `source_refresh_proposals` +
 * `source_refresh_records` tables (issue #58).
 *
 * Delivered through an independent DDL channel (like B6-02's sibling
 * `apply-source-sync-ddl.mjs`) so the issue-23 delivery canonical migration
 * freeze (exactly 001..007) stays untouched. Media reuse rides the shared
 * `media_assets` / `source_media_mappings` tables (created by the source-sync
 * DDL); this channel only adds the two refresh fact tables. Safe to run
 * repeatedly: each missing object is created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-source-refresh-ddl.mjs --local
 *   node scripts/apply-source-refresh-ddl.mjs --remote
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DDL = [
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

const OBJECT_NAMES = [
  'source_refresh_proposals',
  'source_refresh_records',
  'idx_source_refresh_proposals_article',
  'idx_source_refresh_records_article',
]

function usage() {
  console.error(
    'usage: node scripts/apply-source-refresh-ddl.mjs --local|--remote ' +
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
    ['source_refresh_proposals', DDL[0]],
    ['idx_source_refresh_proposals_article', DDL[1]],
    ['source_refresh_records', DDL[2]],
    ['idx_source_refresh_records_article', DDL[3]],
  ]
  const applied = []
  for (const [name, sql] of statementToName) {
    if (existing.has(name)) continue
    runWrangler(args, sql)
    applied.push(name)
  }
  if (applied.length === 0) {
    console.log('source refresh DDL already present; nothing to do')
    process.exit(0)
  }
  console.log('source refresh DDL applied:', applied.join(', '))
}

main()
