#!/usr/bin/env node
/**
 * B6-03 — idempotent write-back DDL for the `source_sync_baselines` +
 * `source_write_back_intents` tables (issue #52).
 *
 * Delivered through an independent DDL channel (like B6-01's
 * `apply-source-identity-ddl.mjs`) so the issue-23 delivery canonical migration
 * freeze (exactly 001..007) stays untouched. Safe to run repeatedly: each
 * missing table/index is created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-write-back-ddl.mjs --local
 *   node scripts/apply-write-back-ddl.mjs --remote
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DDL = [
  `CREATE TABLE IF NOT EXISTS source_sync_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    article_version INTEGER NOT NULL,
    source_sync_sha256 TEXT NOT NULL CHECK(length(source_sync_sha256) = 64),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_identity_id, article_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS source_write_back_intents (
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
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_write_back_intents_article
     ON source_write_back_intents(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_write_back_intents_identity
     ON source_write_back_intents(source_identity_id, status)`,
]

function usage() {
  console.error(
    'usage: node scripts/apply-write-back-ddl.mjs --local|--remote ' +
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
  'source_sync_baselines',
  'source_write_back_intents',
  'idx_write_back_intents_article',
  'idx_write_back_intents_identity',
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
    ['source_sync_baselines', DDL[0]],
    ['source_write_back_intents', DDL[1]],
    ['idx_write_back_intents_article', DDL[2]],
    ['idx_write_back_intents_identity', DDL[3]],
  ]
  const applied = []
  for (const [name, sql] of statementToName) {
    if (existing.has(name)) continue
    runWrangler(args, sql)
    applied.push(name)
  }
  if (applied.length === 0) {
    console.log('write-back DDL already present; nothing to do')
    process.exit(0)
  }
  console.log('write-back DDL applied:', applied.join(', '))
}

main()
