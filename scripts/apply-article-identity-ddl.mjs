#!/usr/bin/env node
/**
 * B2-02 — idempotent article-identity DDL for the `articles` +
 * `article_versions` shadow tables.
 *
 * Delivered through an independent DDL channel (like B2-01b's
 * `apply-content-envelope-ddl.mjs`) so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) stays untouched. Safe to run repeatedly:
 * each missing table is created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-article-identity-ddl.mjs --local
 *   node scripts/apply-article-identity-ddl.mjs --remote
 *   node scripts/apply-article-identity-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TABLES = [
  {
    name: 'articles',
    sql: `CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_ref INTEGER UNIQUE NOT NULL,
      slug TEXT,
      draft_ref TEXT,
      source_page_identity TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,
  },
  {
    name: 'article_versions',
    sql: `CREATE TABLE IF NOT EXISTS article_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL,
      content_snapshot_sha256 TEXT NOT NULL,
      published_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE (article_id, version)
    )`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-article-identity-ddl.mjs --local|--remote ' +
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

function tableNames(args) {
  const stdout = runWrangler(args, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('articles','article_versions')")
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
    existing = tableNames(args)
  } catch (error) {
    console.error(`WARN: could not read table list (${error.message}); assuming tables absent`)
    existing = new Set()
  }

  const created = []
  for (const table of TABLES) {
    if (existing.has(table.name)) {
      continue
    }
    runWrangler(args, table.sql)
    created.push(table.name)
  }

  if (created.length === 0) {
    console.log('article identity tables already present; nothing to do')
    process.exit(0)
  }
  console.log('article identity DDL applied:', created.join(', '))
}

main()
