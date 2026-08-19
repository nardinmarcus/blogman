#!/usr/bin/env node
/**
 * B3-02 — idempotent formal-article revision-loop DDL (issue #34).
 *
 * Delivers the three revision fact tables (`publish_revisions`,
 * `publish_restore_points`, `publish_promotions`) plus the partial unique
 * index that enforces at-most-one active revision per article, through the
 * same independent DDL channel as B2-01b/B2-02/B2-G/B3-01 so the issue-23
 * delivery canonical migration freeze (exactly 001..007) stays untouched.
 * Safe to run repeatedly: `CREATE ... IF NOT EXISTS`, missing objects are
 * created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-publish-revision-ddl.mjs --local
 *   node scripts/apply-publish-revision-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'publish_revisions',
    sql: `CREATE TABLE IF NOT EXISTS publish_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id TEXT UNIQUE NOT NULL CHECK(length(revision_id) > 0),
      article_id INTEGER NOT NULL,
      base_version INTEGER NOT NULL CHECK(base_version > 0),
      revision_number INTEGER NOT NULL CHECK(revision_number > 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'promoted', 'discarded')),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      description TEXT,
      category TEXT,
      tags TEXT,
      password TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0, 1)),
      cover_image TEXT,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_publish_revisions_active',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_revisions_active
      ON publish_revisions(article_id) WHERE status = 'active'`,
  },
  {
    name: 'publish_restore_points',
    sql: `CREATE TABLE IF NOT EXISTS publish_restore_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restore_point_id TEXT UNIQUE NOT NULL CHECK(length(restore_point_id) > 0),
      article_id INTEGER NOT NULL,
      formal_version INTEGER NOT NULL CHECK(formal_version > 0),
      promoted_version INTEGER NOT NULL CHECK(promoted_version > 0),
      snapshot_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
      reason TEXT NOT NULL CHECK(length(reason) > 0),
      created_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'publish_promotions',
    sql: `CREATE TABLE IF NOT EXISTS publish_promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_id TEXT UNIQUE NOT NULL CHECK(length(promotion_id) > 0),
      article_id INTEGER NOT NULL,
      revision_id TEXT NOT NULL CHECK(length(revision_id) > 0),
      base_version INTEGER NOT NULL CHECK(base_version > 0),
      promoted_version INTEGER NOT NULL CHECK(promoted_version > 0),
      slug TEXT NOT NULL CHECK(length(slug) > 0),
      public_url TEXT NOT NULL CHECK(length(public_url) > 0),
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      payload TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      created_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_publish_promotions_article',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_promotions_article
      ON publish_promotions(article_id, promoted_version)`,
  },
  {
    name: 'publish_restore_ops',
    sql: `CREATE TABLE IF NOT EXISTS publish_restore_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restore_operation_id TEXT UNIQUE NOT NULL CHECK(length(restore_operation_id) > 0),
      article_id INTEGER NOT NULL,
      source_restore_point_id TEXT NOT NULL CHECK(length(source_restore_point_id) > 0),
      target TEXT NOT NULL CHECK(target IN ('revision', 'draft')),
      expected_version INTEGER NOT NULL CHECK(expected_version > 0),
      pre_restore_snapshot_json TEXT NOT NULL,
      pre_restore_content_sha256 TEXT NOT NULL,
      revision_id TEXT,
      draft_article_id INTEGER,
      post_ref INTEGER,
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'undone')),
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    ) STRICT`,
  },
  {
    name: 'idx_publish_restore_ops_article',
    sql: `CREATE INDEX IF NOT EXISTS idx_publish_restore_ops_article
      ON publish_restore_ops(article_id)`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-publish-revision-ddl.mjs --local|--remote ' +
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