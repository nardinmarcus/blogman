#!/usr/bin/env node
/**
 * B6-01 — idempotent source-identity DDL for the `source_identities`,
 * `source_url_variants` + `article_source_links` tables (issue #50).
 *
 * Delivered through an independent DDL channel (like B6-01's sibling
 * `apply-article-identity-ddl.mjs`) so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) stays untouched. Safe to run repeatedly:
 * each missing table/index is created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-source-identity-ddl.mjs --local
 *   node scripts/apply-source-identity-ddl.mjs --remote
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DDL = [
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
  // B7-01 — additive `role` column for pre-existing tables (issue #57): a
  // CREATE TABLE IF NOT EXISTS never adds a column to an existing table, so
  // the clip/link role is provisioned here when absent. Existing rows default
  // to 'primary' (writable source); the Chrome clip entry inserts 'clip'.
  `ALTER TABLE article_source_links ADD COLUMN role TEXT NOT NULL DEFAULT 'primary' CHECK(role IN ('primary', 'clip'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_article_source_live
     ON article_source_links(source_identity_id) WHERE status != 'cancelled'`,
  `CREATE INDEX IF NOT EXISTS idx_article_source_article
     ON article_source_links(article_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_article_source_identity
     ON article_source_links(source_identity_id, status)`,
]

function usage() {
  console.error(
    'usage: node scripts/apply-source-identity-ddl.mjs --local|--remote ' +
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

function objectsPresent(args, names) {
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

/** True when `article_source_links.role` already exists (B7-01 clip role). */
function hasRoleColumn(args) {
  try {
    const stdout = runWrangler(
      args,
      "SELECT name FROM pragma_table_info('article_source_links') WHERE name = 'role'",
    )
    const rows = JSON.parse(stdout)[0]?.results ?? []
    return rows.length > 0
  } catch {
    return true // cannot inspect → assume present (skip the additive ALTER)
  }
}

const OBJECT_NAMES = [
  'source_identities',
  'source_url_variants',
  'article_source_links',
  'idx_source_url_variants_identity',
  'idx_article_source_live',
  'idx_article_source_article',
  'idx_article_source_identity',
]

function main() {
  const args = parseArgs(process.argv.slice(2))
  let existing
  try {
    existing = objectsPresent(args, OBJECT_NAMES)
  } catch (error) {
    console.error(`WARN: could not read object list (${error.message}); assuming absent`)
    existing = new Set()
  }
  const statementToName = [
    ['source_identities', DDL[0]],
    ['source_url_variants', DDL[1]],
    ['idx_source_url_variants_identity', DDL[2]],
    ['article_source_links', DDL[3]],
    // DDL[4] is the additive `role` ALTER — applied only when the column is
    // missing and the table already exists (CREATE TABLE IF NOT EXISTS cannot
    // alter an existing table).
    ['idx_article_source_live', DDL[5]],
    ['idx_article_source_article', DDL[6]],
    ['idx_article_source_identity', DDL[7]],
  ]
  const applied = []
  for (const [name, sql] of statementToName) {
    if (existing.has(name)) continue
    runWrangler(args, sql)
    applied.push(name)
  }
  // Add the `role` column to an existing table when absent (B7-01, #57).
  if (existing.has('article_source_links') && !hasRoleColumn(args)) {
    runWrangler(args, DDL[4])
    applied.push('article_source_links.role')
  }
  if (applied.length === 0) {
    console.log('source identity DDL already present; nothing to do')
    process.exit(0)
  }
  console.log('source identity DDL applied:', applied.join(', '))
}

main()
