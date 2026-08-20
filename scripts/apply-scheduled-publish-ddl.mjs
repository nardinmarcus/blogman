#!/usr/bin/env node
/**
 * B4-01 — idempotent scheduled-publish DDL (issue #40).
 *
 * Delivers the `publish_schedules` fact table (+ its due-scan index) through
 * the same independent DDL channel as B2-01b/B2-02/B2-G/B3-01/B3-02/B3-05 so
 * the issue-23 delivery canonical migration freeze (exactly 001..007) and the
 * first-publish/revision/lifecycle tables stay untouched. Safe to run
 * repeatedly: `CREATE ... IF NOT EXISTS`, missing objects are created exactly
 * once, then reported.
 *
 * B4-01 is zero-production: this script is the deployment channel only and is
 * NOT run in this batch (the Cron trigger / remote execution land in a later
 * batch). Tests apply the same DDL idempotently through the module's exported
 * `ensureScheduledPublishTables`.
 *
 * Usage:
 *   node scripts/apply-scheduled-publish-ddl.mjs --local
 *   node scripts/apply-scheduled-publish-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'publish_schedules',
    sql: `CREATE TABLE IF NOT EXISTS publish_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
      timezone TEXT NOT NULL CHECK(length(timezone) > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'fired', 'stale', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      stale_reason TEXT,
      fired_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'idx_publish_schedules_due',
    sql: `CREATE INDEX IF NOT EXISTS idx_publish_schedules_due
      ON publish_schedules(status, scheduled_at)`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-scheduled-publish-ddl.mjs --local|--remote ' +
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
    // Probe the SAME target as the execute below: `--remote` checks the remote
    // database (no persist-to), `--local` checks the local persistent state.
    const probeArgs = ['d1', 'execute', args.database, '--config', args.config]
    if (args.local) probeArgs.push('--local', '--persist-to', args.persistTo || join(repoRoot, '.wrangler', 'state', 'v3'))
    if (args.remote) probeArgs.push('--remote')
    probeArgs.push('--command', `SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name = '${statement.name}'`)

    const existing = spawnSync(
      join(repoRoot, 'node_modules', '.bin', 'wrangler'),
      probeArgs,
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