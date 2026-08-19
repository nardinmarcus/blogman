#!/usr/bin/env node
/**
 * B3-04 — idempotent permanent slug-address registry DDL (issue #36).
 *
 * Delivers the `article_slug_addresses` table (current / candidate /
 * historical addresses, globally exclusive per article identity) through the
 * same independent DDL channel as B2-01b/B2-02/B3-01/B3-02 so the issue-23
 * delivery canonical migration freeze (exactly 001..007) stays untouched. Safe
 * to run repeatedly: `CREATE TABLE IF NOT EXISTS`, missing objects are created
 * exactly once, then reported. Never drops or alters an existing row/table.
 *
 * Usage:
 *   node scripts/apply-slug-address-ddl.mjs --local
 *   node scripts/apply-slug-address-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TABLES = [
  {
    name: 'article_slug_addresses',
    sql: `CREATE TABLE IF NOT EXISTS article_slug_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE CHECK(length(slug) > 0),
      article_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('current', 'candidate', 'historical')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
]

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_article_slug_current
     ON article_slug_addresses(article_id) WHERE kind = 'current'`,
  `CREATE INDEX IF NOT EXISTS idx_article_slug_article
     ON article_slug_addresses(article_id, kind)`,
]

function usage() {
  console.error(
    'usage: node scripts/apply-slug-address-ddl.mjs --local|--remote ' +
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
  const spawnArgs = [
    'd1',
    'execute',
    args.database,
    ...(args.local ? ['--local'] : ['--remote']),
    ...(args.persistTo ? ['--persist-to', args.persistTo] : []),
    '--config',
    args.config,
    '--command',
    command,
    '--json',
  ]
  const result = spawnSync(wranglerBin(), spawnArgs, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'wrangler d1 execute failed')
  }
  return result.stdout
}

function objectExists(args, name, query) {
  const stdout = runWrangler(args, query)
  let rows = []
  try {
    rows = JSON.parse(stdout)[0]?.results ?? []
  } catch {
    rows = []
  }
  return rows.length > 0
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const created = []
  const skipped = []
  for (const table of TABLES) {
    const missing = !objectExists(
      args,
      table.name,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${table.name}'`,
    )
    if (missing) {
      runWrangler(args, table.sql)
      created.push(table.name)
    } else {
      skipped.push(table.name)
    }
  }
  for (const index of INDEXES) {
    runWrangler(args, index)
  }
  console.log(
    JSON.stringify({ created, skipped, indexes: INDEXES.length, ok: true }, null, 2),
  )
}

main()
