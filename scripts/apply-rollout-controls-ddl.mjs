#!/usr/bin/env node
/**
 * B2-G — idempotent rollout-controls DDL (issue #32).
 *
 * Delivers the `rollout_controls` + `rollout_control_events` tables through the
 * same independent DDL channel as B2-01b/B2-02 so the issue-23 delivery
 * canonical migration freeze (exactly 001..007) stays untouched. The DDL is
 * mirrored verbatim from ledger migrations 006/007 so a ledger-only or
 * clean-start DB can host the authority switch without growing that set.
 *
 * Safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`, missing tables are
 * created exactly once, then reported.
 *
 * Usage:
 *   node scripts/apply-rollout-controls-ddl.mjs --local
 *   node scripts/apply-rollout-controls-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TABLES = [
  {
    name: 'rollout_controls',
    sql: `CREATE TABLE IF NOT EXISTS rollout_controls (
      control_key TEXT PRIMARY KEY,
      control_kind TEXT NOT NULL CHECK(control_kind IN ('producer', 'authority', 'executor')),
      desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN (0, 1)),
      candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0),
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      evidence_state TEXT NOT NULL CHECK(evidence_state IN ('verified', 'invalid', 'unavailable')),
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      reason TEXT NOT NULL CHECK(length(reason) > 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK(
        (control_kind = 'producer' AND control_key = 'producer')
        OR (control_kind = 'authority' AND control_key = 'authority')
        OR (
          control_kind = 'executor'
          AND control_key GLOB 'executor:[a-z0-9_-]*'
          AND length(control_key) > length('executor:')
        )
      )
    ) STRICT`,
  },
  {
    name: 'rollout_control_events',
    sql: `CREATE TABLE IF NOT EXISTS rollout_control_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
      control_key TEXT NOT NULL,
      control_kind TEXT NOT NULL CHECK(control_kind IN ('producer', 'authority', 'executor')),
      previous_enabled INTEGER CHECK(previous_enabled IS NULL OR previous_enabled IN (0, 1)),
      desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN (0, 1)),
      candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0),
      evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
      evidence_state TEXT NOT NULL CHECK(evidence_state IN ('verified', 'invalid', 'unavailable')),
      actor TEXT NOT NULL CHECK(length(actor) > 0),
      reason TEXT NOT NULL CHECK(length(reason) > 0),
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-rollout-controls-ddl.mjs --local|--remote ' +
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

function existingTableNames(args) {
  const stdout = runWrangler(
    args,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rollout_controls','rollout_control_events')`,
  )
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
    existing = existingTableNames(args)
  } catch (error) {
    console.error(`WARN: could not read rollout tables (${error.message}); assuming absent`)
    existing = new Set()
  }

  const missing = TABLES.filter(({ name }) => !existing.has(name))
  if (missing.length === 0) {
    console.log('rollout control tables already present; nothing to do')
    process.exit(0)
  }

  for (const { name, sql } of missing) {
    runWrangler(args, sql)
    console.log(`created table ${name}`)
  }
  console.log('rollout controls DDL applied:', missing.map(({ name }) => name).join(', '))
}

main()
