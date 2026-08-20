#!/usr/bin/env node
/**
 * B5-01/B5-02 — idempotent WeChat draft-task DDL (issues #46 + #47).
 *
 * Delivers the ADDITIVE `wechat_draft_tasks` table through the same
 * independent DDL channel as every earlier batch (application/apply-*.mjs) so
 * the issue-23 delivery canonical migration freeze (exactly 001..007) stays
 * untouched. Safe to run repeatedly: `CREATE ... IF NOT EXISTS`; missing
 * objects are created exactly once, then reported. Never drops/alters.
 *
 * B5-02 (issue #47) adds the immutable `wechat_draft_attempts` execution table
 * and nine additive columns on `wechat_draft_tasks` (revision, attempt_count,
 * classification, needs_author, next_attempt_at, last_error, claimed_at,
 * lease_token, lease_expires_at) that carry the provider failure / retry /
 * result-unknown state machine. A B5-01-era install is upgraded through
 * PRAGMA-driven conditional `ALTER TABLE ADD COLUMN`; the B5-01 status CHECK
 * intentionally keeps its four values (a CHECK cannot be altered in place).
 *
 * B5-03 (issue #48) adds the delivery-settings / generation / replacement
 * surface: two more additive columns on `wechat_draft_tasks` (generation,
 * settings_revision) plus `wechat_draft_settings` (设置修订, 初始映射修订 1),
 * `wechat_draft_generations` (渠道交付组任务代次台账 with replaces_task_id chain),
 * and `wechat_draft_replacements` (交付后显式替代草稿, full lifecycle columns so
 * the shared executor/retry state machine can process them). Old rows, media_ids
 * and generations are never deleted or overwritten.
 *
 * B5-01/B5-02 are zero-production: the script is the deployment channel only
 * and is NOT run in this batch. Tests apply the same DDL idempotently through
 * the module's exported `ensureWechatDraftTables`.
 *
 * Usage:
 *   node scripts/apply-wechat-draft-ddl.mjs --local
 *   node scripts/apply-wechat-draft-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'wechat_draft_tasks',
    sql: `CREATE TABLE IF NOT EXISTS wechat_draft_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL CHECK(length(task_id) > 0),
      article_id INTEGER NOT NULL CHECK(article_id > 0),
      post_ref INTEGER NOT NULL CHECK(post_ref > 0),
      version INTEGER NOT NULL CHECK(version > 0),
      account_id TEXT NOT NULL CHECK(length(account_id) > 0),
      status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'failed', 'superseded')),
      title TEXT NOT NULL,
      html_projection TEXT NOT NULL,
      plaintext_projection TEXT NOT NULL,
      cover_image_url TEXT,
      digest TEXT,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
      projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64),
      source_url TEXT NOT NULL CHECK(length(source_url) > 0),
      remote_draft_id TEXT,
      provider_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      classification TEXT,
      needs_author INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT,
      claimed_at INTEGER,
      lease_token TEXT,
      lease_expires_at INTEGER,
      UNIQUE (article_id, version, account_id)
    ) STRICT`,
  },
  {
    name: 'idx_wechat_draft_tasks_article',
    sql: `CREATE INDEX IF NOT EXISTS idx_wechat_draft_tasks_article
      ON wechat_draft_tasks(article_id, account_id, version)`,
  },
  {
    name: 'wechat_draft_attempts',
    sql: `CREATE TABLE IF NOT EXISTS wechat_draft_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
      task_id TEXT NOT NULL CHECK(length(task_id) > 0),
      attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
      classification TEXT NOT NULL CHECK(
        classification IN ('ok', 'retryable', 'needs-author', 'unknown')
      ),
      outcome TEXT NOT NULL CHECK(
        outcome IN ('submitted', 'retried', 'failed', 'unknown', 'reconciled', 'abandoned', 'cancelled')
      ),
      started_at INTEGER NOT NULL CHECK(started_at > 0),
      finished_at INTEGER,
      remote_draft_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_wechat_draft_attempts_task',
    sql: `CREATE INDEX IF NOT EXISTS idx_wechat_draft_attempts_task
      ON wechat_draft_attempts(task_id, id)`,
  },
  {
    name: 'wechat_draft_settings',
    sql: `CREATE TABLE IF NOT EXISTS wechat_draft_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL CHECK(article_id > 0),
      account_id TEXT NOT NULL CHECK(length(account_id) > 0),
      settings_revision INTEGER NOT NULL CHECK(settings_revision > 0),
      title_override TEXT,
      digest_override TEXT,
      cover_image_override TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (article_id, account_id)
    ) STRICT`,
  },
  {
    name: 'idx_wechat_draft_settings_article',
    sql: `CREATE INDEX IF NOT EXISTS idx_wechat_draft_settings_article
      ON wechat_draft_settings(article_id, account_id)`,
  },
  {
    name: 'wechat_draft_generations',
    sql: `CREATE TABLE IF NOT EXISTS wechat_draft_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL CHECK(article_id > 0),
      account_id TEXT NOT NULL CHECK(length(account_id) > 0),
      generation INTEGER NOT NULL CHECK(generation > 0),
      version INTEGER NOT NULL CHECK(version > 0),
      task_id TEXT NOT NULL CHECK(length(task_id) > 0),
      replaces_task_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'failed', 'superseded')),
      settings_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (article_id, account_id, generation),
      UNIQUE (task_id)
    ) STRICT`,
  },
  {
    name: 'idx_wechat_draft_generations_group',
    sql: `CREATE INDEX IF NOT EXISTS idx_wechat_draft_generations_group
      ON wechat_draft_generations(article_id, account_id, generation)`,
  },
  {
    name: 'wechat_draft_replacements',
    sql: `CREATE TABLE IF NOT EXISTS wechat_draft_replacements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      replacement_key TEXT UNIQUE NOT NULL CHECK(length(replacement_key) > 0),
      article_id INTEGER NOT NULL CHECK(article_id > 0),
      version INTEGER NOT NULL CHECK(version > 0),
      account_id TEXT NOT NULL CHECK(length(account_id) > 0),
      replaces_task_id TEXT NOT NULL CHECK(length(replaces_task_id) > 0),
      generation INTEGER NOT NULL CHECK(generation > 0),
      status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'failed', 'superseded')),
      title TEXT NOT NULL,
      html_projection TEXT NOT NULL,
      plaintext_projection TEXT NOT NULL,
      cover_image_url TEXT,
      digest TEXT,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
      projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64),
      source_url TEXT NOT NULL CHECK(length(source_url) > 0),
      remote_draft_id TEXT,
      provider_error TEXT,
      settings_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      classification TEXT,
      needs_author INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT,
      claimed_at INTEGER,
      lease_token TEXT,
      lease_expires_at INTEGER
    ) STRICT`,
  },
  {
    name: 'idx_wechat_draft_replacements_group',
    sql: `CREATE INDEX IF NOT EXISTS idx_wechat_draft_replacements_group
      ON wechat_draft_replacements(article_id, account_id, version)`,
  },
  {
    name: 'idx_wechat_draft_replacements_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_wechat_draft_replacements_status
      ON wechat_draft_replacements(status, next_attempt_at)`,
  },
]

/** Additive B5-02/B5-03 columns for a B5-01-era wechat_draft_tasks (PRAGMA-guarded). */
const TASK_COLUMNS = [
  ['revision', 'INTEGER NOT NULL DEFAULT 0'],
  ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['classification', 'TEXT'],
  ['needs_author', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_attempt_at', 'INTEGER'],
  ['last_error', 'TEXT'],
  ['claimed_at', 'INTEGER'],
  ['lease_token', 'TEXT'],
  ['lease_expires_at', 'INTEGER'],
  ['generation', 'INTEGER NOT NULL DEFAULT 1'],
  ['settings_revision', 'INTEGER NOT NULL DEFAULT 0'],
]

function usage() {
  console.error(
    'usage: node scripts/apply-wechat-draft-ddl.mjs --local|--remote ' +
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

  // Additive column upgrade for a B5-01-era wechat_draft_tasks (PRAGMA-driven,
  // ALTER only columns that are missing — idempotent across repeated runs; the
  // B5-01 status CHECK keeps its four values and is never altered).
  const addedColumns = []
  const columnsProbe = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    [...wranglerArgs(args), '--command', 'PRAGMA table_info(wechat_draft_tasks)'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (columnsProbe.status === 0) {
    let rows = []
    try {
      rows = JSON.parse(columnsProbe.stdout)[0]?.results ?? []
    } catch {
      rows = []
    }
    const existingColumns = new Set(rows.map((row) => row.name))
    for (const [name, type] of TASK_COLUMNS) {
      if (existingColumns.has(name)) {
        console.log(`column exists: wechat_draft_tasks.${name}`)
        continue
      }
      const result = spawnSync(
        join(repoRoot, 'node_modules', '.bin', 'wrangler'),
        [...wranglerArgs(args), '--command', `ALTER TABLE wechat_draft_tasks ADD COLUMN ${name} ${type}`],
        { cwd: repoRoot, encoding: 'utf8' },
      )
      if (result.status !== 0) {
        console.error(`failed: wechat_draft_tasks.${name}`)
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }
      addedColumns.push(name)
      console.log(`column added: wechat_draft_tasks.${name}`)
    }
  } else {
    console.warn('WARN: could not read wechat_draft_tasks columns; assuming full B5-02 shape already present')
  }

  console.log(`done: ${created.length} object(s) created, ${addedColumns.length} column(s) added`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})