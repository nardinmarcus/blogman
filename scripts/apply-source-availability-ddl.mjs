#!/usr/bin/env node
/**
 * B6-05 — idempotent source-availability DDL for the
 * `source_availability_observations` + `source_baseline_facts` tables
 * (issue #54).
 *
 * Delivered through an independent DDL channel (mirroring B6-01's
 * `apply-source-identity-ddl.mjs`) so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) and every other batch surface stay
 * untouched. Safe to run repeatedly: each missing table/index is created
 * exactly once, then reported. The availability-observation and baseline
 * (sync-fact) tables are kept separate by design (可用性观察与同步事实分离).
 *
 * Usage:
 *   node scripts/apply-source-availability-ddl.mjs --local
 *   node scripts/apply-source-availability-ddl.mjs --remote
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DDL = [
  `CREATE TABLE IF NOT EXISTS source_availability_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL CHECK(source_identity_id > 0),
    operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
    outcome TEXT NOT NULL CHECK(outcome IN ('readable', 'temporarily-unavailable', 'confirmed-missing')),
    detail TEXT,
    observed_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_source_avail_identity
     ON source_availability_observations(source_identity_id, observed_at)`,
  `CREATE TABLE IF NOT EXISTS source_baseline_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_identity_id INTEGER NOT NULL UNIQUE CHECK(source_identity_id > 0),
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
    advanced_by_operation_id TEXT NOT NULL CHECK(length(advanced_by_operation_id) > 0),
    advanced_at INTEGER NOT NULL
  ) STRICT`,
]

function usage() {
  console.error(
    'usage: node scripts/apply-source-availability-ddl.mjs --local|--remote ' +
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

function wranglerArgs(args, extra) {
  const out = []
  if (args.local) out.push('d1', 'execute', args.database, '--local')
  else out.push('d1', 'execute', args.database, '--remote')
  if (args.persistTo) out.push('--persist-to', args.persistTo)
  if (args.config && args.config !== join(repoRoot, 'wrangler.toml')) {
    out.push('--config', args.config)
  }
  out.push('--command', extra)
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const created = []
  const skipped = []

  for (const sql of DDL) {
    const res = spawnSync('npx', wranglerArgs(args, sql), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    })
    if (res.status !== 0) {
      console.error(`apply-source-availability-ddl: failed for statement:\n${sql}`)
      process.exit(res.status ?? 1)
    }
    const out = res.stdout ?? ''
    if (out.includes('already exists')) skipped.push(sql)
    else created.push(sql)
  }

  console.log(
    `source-availability DDL ${args.local ? 'local' : 'remote'}: ` +
      `${created.length} created, ${skipped.length} already present (idempotent).`,
  )
  if (created.length === 0 && !existsSync(join(repoRoot, 'wrangler.toml'))) {
    console.warn('note: no local wrangler.toml — nothing to execute against.')
  }
}

main()
