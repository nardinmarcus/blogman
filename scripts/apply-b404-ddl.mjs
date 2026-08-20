#!/usr/bin/env node
/**
 * B4-04 — idempotent workbench + notification DDL (issue #43).
 *
 * Delivers the ADDITIVE control/notification tables through the same
 * independent DDL channel as B4-01 (application/apply-*.mjs) so the issue-23
 * delivery canonical migration freeze (exactly 001..007) stays untouched.
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`, never drops/alters.
 *
 * B4-04 is zero-production: the script is the deployment channel only and is
 * NOT run in this batch. Tests apply the same DDL idempotently through the
 * modules' exported `ensureWorkbenchTables` / `ensureNotificationTables`.
 *
 * Usage:
 *   node scripts/apply-b404-ddl.mjs --local
 *   node scripts/apply-b404-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'workbench_controls',
    sql: `CREATE TABLE IF NOT EXISTS workbench_controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL CHECK(length(key) > 0),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
  },
  {
    name: 'activity_notifications',
    sql: `CREATE TABLE IF NOT EXISTS activity_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id TEXT UNIQUE NOT NULL CHECK(length(notification_id) > 0),
      source_type TEXT NOT NULL CHECK(length(source_type) > 0),
      source_id TEXT NOT NULL CHECK(length(source_id) > 0),
      title TEXT NOT NULL CHECK(length(title) > 0),
      detail TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    ) STRICT`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-b404-ddl.mjs --local|--remote ' +
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
    const probeArgs = ['d1', 'execute', args.database, '--config', args.config]
    if (args.local) probeArgs.push('--local', '--persist-to', args.persistTo || join(repoRoot, '.wrangler', 'state', 'v3'))
    if (args.remote) probeArgs.push('--remote')
    probeArgs.push('--command', `SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name = '${statement.name}'`)
    const existing = spawnSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'), probeArgs, { cwd: repoRoot, encoding: 'utf8' })
    const alreadyExists = (existing.stdout || '').includes(statement.name)
    if (alreadyExists) {
      console.log(`exists: ${statement.name}`)
      continue
    }
    const result = spawnSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'), [...wranglerArgs(args), '--command', statement.sql], { cwd: repoRoot, encoding: 'utf8' })
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
