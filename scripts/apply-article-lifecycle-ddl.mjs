#!/usr/bin/env node
/**
 * B3-05 — idempotent article lifecycle ledger DDL (issue #37).
 *
 * Delivers the immutable `article_lifecycles` ledger (+ its article index)
 * through the same independent DDL channel as B2-01b/B2-02/B2-G/B3-01/B3-02
 * so the issue-23 delivery canonical migration freeze (exactly 001..007) and
 * the first-publish/revision tables stay untouched. Safe to run repeatedly:
 * `CREATE ... IF NOT EXISTS`, missing objects are created exactly once.
 *
 * Usage:
 *   node scripts/apply-article-lifecycle-ddl.mjs --local
 *   node scripts/apply-article-lifecycle-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'article_lifecycles',
    sql: `CREATE TABLE IF NOT EXISTS article_lifecycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
      article_id INTEGER NOT NULL,
      post_ref INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      direction TEXT NOT NULL CHECK(direction IN ('unpublish', 'relive-formal', 'relive-revision')),
      lifecycle_before TEXT NOT NULL CHECK(lifecycle_before IN ('published', 'unpublished')),
      lifecycle_after TEXT NOT NULL CHECK(lifecycle_after IN ('published', 'unpublished')),
      source_version INTEGER,
      public_url TEXT,
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      payload TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      created_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_article_lifecycles_article',
    sql: `CREATE INDEX IF NOT EXISTS idx_article_lifecycles_article
      ON article_lifecycles(article_id, version)`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-article-lifecycle-ddl.mjs --local|--remote ' +
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
