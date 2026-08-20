#!/usr/bin/env node
/**
 * B3-01 — idempotent first-publish DDL (issue #33).
 *
 * Delivers the six first-publish fact tables (`publish_prepares`,
 * `publish_intents`, `publish_events`, `publish_outbox`, `formal_publications`,
 * `publish_receipts`) through the same independent DDL channel as B2-01b/B2-02/
 * B2-G so the issue-23 delivery canonical migration freeze (exactly 001..007)
 * stays untouched. Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`,
 * missing tables are created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-first-publish-ddl.mjs --local
 *   node scripts/apply-first-publish-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TABLES = [
  {
    name: 'publish_prepares',
    sql: `CREATE TABLE IF NOT EXISTS publish_prepares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prepare_id TEXT UNIQUE NOT NULL CHECK(length(prepare_id) > 0),
      article_id INTEGER NOT NULL,
      post_ref INTEGER NOT NULL,
      prepared_version INTEGER NOT NULL CHECK(prepared_version > 0),
      prepared_slug TEXT NOT NULL CHECK(length(prepared_slug) > 0),
      prepared_title TEXT NOT NULL,
      prepared_content_sha256 TEXT NOT NULL CHECK(prepared_content_sha256 = '' OR length(prepared_content_sha256) = 64),
      blocker_saved INTEGER NOT NULL CHECK(blocker_saved IN (0, 1)),
      blocker_lifecycle INTEGER NOT NULL CHECK(blocker_lifecycle IN (0, 1)),
      blocker_slug INTEGER NOT NULL CHECK(blocker_slug IN (0, 1)),
      blocker_content INTEGER NOT NULL CHECK(blocker_content IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN ('prepared', 'committed', 'aborted', 'superseded')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'publish_intents',
    sql: `CREATE TABLE IF NOT EXISTS publish_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT UNIQUE NOT NULL CHECK(length(intent_id) > 0),
      prepare_id TEXT UNIQUE NOT NULL CHECK(length(prepare_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'prepared', 'published', 'unpublished', 'deleted')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
      created_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'publish_events',
    sql: `CREATE TABLE IF NOT EXISTS publish_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
      intent_id TEXT UNIQUE NOT NULL CHECK(length(intent_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'prepared', 'published', 'unpublished', 'deleted')),
      first_published_at INTEGER NOT NULL,
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'publish_outbox',
    sql: `CREATE TABLE IF NOT EXISTS publish_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id TEXT UNIQUE NOT NULL CHECK(length(outbox_id) > 0),
      event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      kind TEXT NOT NULL CHECK(kind IN ('public-receipt', 'index-invalidate', 'notify')),
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    ) STRICT`,
  },
  {
    name: 'formal_publications',
    sql: `CREATE TABLE IF NOT EXISTS formal_publications (
      article_id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL UNIQUE CHECK(length(slug) > 0),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('published', 'unpublished')),
      first_published_at INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      public_url TEXT NOT NULL CHECK(length(public_url) > 0),
      event_id TEXT NOT NULL CHECK(length(event_id) > 0)
    ) STRICT`,
  },
  {
    name: 'publish_receipts',
    sql: `CREATE TABLE IF NOT EXISTS publish_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL CHECK(length(event_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      slug TEXT NOT NULL,
      public_url TEXT NOT NULL,
      receipt_payload TEXT NOT NULL,
      verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
      verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-first-publish-ddl.mjs --local|--remote ' +
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
    else if (flag === '--help' || flag === '-h') {
      usage()
      process.exit(0)
    }
  }
  return args
}

function wranglerArgs(args) {
  const out = ['d1', 'execute', args.database, '--config', args.config]
  if (args.local) out.push('--local')
  if (args.remote) out.push('--remote')
  if (args.persistTo) {
    out.push('--persist-to', args.persistTo)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.local && !args.remote) {
    console.error('error: choose --local or --remote')
    usage()
    process.exit(1)
  }
  if (!existsSync(args.config)) {
    console.error(`error: config not found: ${args.config}`)
    process.exit(1)
  }

  const created = []
  for (const table of TABLES) {
    const existing = spawnSync(
      join(repoRoot, 'node_modules', '.bin', 'wrangler'),
      [
        'd1', 'execute', args.database, '--config', args.config,
        '--local', '--persist-to', args.persistTo || join(repoRoot, '.wrangler', 'state', 'v3'),
        '--command', `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table.name}'`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    const alreadyExists = /"name":"[^"]*"|'name'\s*:/.test(existing.stdout || '') && (existing.stdout || '').includes(table.name)
    if (alreadyExists) {
      console.log(`exists: ${table.name}`)
      continue
    }
    const result = spawnSync(
      join(repoRoot, 'node_modules', '.bin', 'wrangler'),
      [...wranglerArgs(args), '--command', table.sql],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    if (result.status !== 0) {
      console.error(`failed: ${table.name}`)
      console.error(result.stderr || result.stdout)
      process.exit(1)
    }
    created.push(table.name)
    console.log(`created: ${table.name}`)
  }

  console.log(`done: ${created.length} table(s) created`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})