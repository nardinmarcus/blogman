#!/usr/bin/env node
/**
 * B3-06 — idempotent version-bound publish suggestion DDL (issue #38).
 *
 * Delivers `publish_preparations` + `publish_suggestions` (+ indexes) through
 * the same independent DDL channel as B2-01b/B2-02/B2-G/B3-01/B3-02/B3-03/
 * B3-04/B3-05 so the issue-23 delivery canonical migration freeze (exactly
 * 001..007) and every other batch table set stay untouched. Safe to run
 * repeatedly: `CREATE ... IF NOT EXISTS`, missing objects are created once.
 *
 * Usage:
 *   node scripts/apply-publish-suggestions-ddl.mjs --local
 *   node scripts/apply-publish-suggestions-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'publish_preparations',
    sql: `CREATE TABLE IF NOT EXISTS publish_preparations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preparation_id TEXT UNIQUE NOT NULL CHECK(length(preparation_id) > 0),
      article_id INTEGER NOT NULL,
      post_ref INTEGER NOT NULL,
      bound_version INTEGER NOT NULL CHECK(bound_version > 0),
      bound_revision TEXT,
      source TEXT NOT NULL CHECK(length(source) > 0),
      status TEXT NOT NULL CHECK(status IN ('recorded', 'applied', 'abandoned')),
      restore_point_id TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_publish_preparations_article',
    sql: `CREATE INDEX IF NOT EXISTS idx_publish_preparations_article
      ON publish_preparations(article_id, status)`,
  },
  {
    name: 'publish_suggestions',
    sql: `CREATE TABLE IF NOT EXISTS publish_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id TEXT UNIQUE NOT NULL CHECK(length(suggestion_id) > 0),
      preparation_id TEXT NOT NULL CHECK(length(preparation_id) > 0),
      article_id INTEGER NOT NULL,
      field TEXT NOT NULL CHECK(field IN ('category', 'tags', 'description', 'title', 'content')),
      value TEXT NOT NULL,
      field_before TEXT,
      basis_sha256 TEXT NOT NULL CHECK(length(basis_sha256) = 64),
      bound_version INTEGER NOT NULL CHECK(bound_version > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'ignored', 'revoked', 'stale', 'abandoned')),
      applied_operation_id TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_publish_suggestions_article',
    sql: `CREATE INDEX IF NOT EXISTS idx_publish_suggestions_article
      ON publish_suggestions(article_id, status)`,
  },
  {
    name: 'idx_publish_suggestions_prep',
    sql: `CREATE INDEX IF NOT EXISTS idx_publish_suggestions_prep
      ON publish_suggestions(preparation_id)`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-publish-suggestions-ddl.mjs --local|--remote ' +
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
  const out = ['d1', 'execute', args.database, '--command', '--config', args.config]
  if (args.local) out.push('--local')
  if (args.remote) out.push('--remote')
  if (args.persistTo) out.push('--persist-to', args.persistTo)
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
  for (const statement of STATEMENTS) {
    const existing = spawnSync(
      join(repoRoot, 'node_modules', '.bin', 'wrangler'),
      [
        'd1', 'execute', args.database, '--config', args.config,
        '--local', '--persist-to', args.persistTo || join(repoRoot, '.wrangler', 'state', 'v3'),
        '--command', `SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name = '${statement.name}'`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    const alreadyExists = (existing.stdout || '').includes(statement.name)
    if (alreadyExists) {
      console.log(`exists: ${statement.name}`)
      continue
    }
    const result = spawnSync(
      join(repoRoot, 'node_modules', '.bin', 'wrangler'),
      [...wranglerArgs(args), '--command', statement.sql],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    if (result.status !== 0) {
      console.error(`failed: ${statement.name}`)
      console.error(result.stderr || result.stdout)
      process.exit(1)
    }
    created.push(statement.name)
    console.log(`created: ${statement.name}`)
  }

  console.log(`done: ${created.length} object(s) created`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
