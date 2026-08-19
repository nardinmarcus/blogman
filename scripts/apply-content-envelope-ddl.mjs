#!/usr/bin/env node
/**
 * B2-01b — idempotent content-envelope DDL for the `posts` table.
 *
 * Delivers the three envelope columns through an independent DDL channel so the
 * issue-23 delivery canonical migration freeze (exactly 001..007) is left
 * untouched. Safe to run repeatedly: for each missing column it runs a single
 * `ALTER TABLE posts ADD COLUMN`, then reports. Supports both local and remote
 * D1 via a `wrangler d1 execute` wrapper.
 *
 * Usage:
 *   node scripts/apply-content-envelope-ddl.mjs --local
 *   node scripts/apply-content-envelope-ddl.mjs --remote
 *   node scripts/apply-content-envelope-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const COLUMNS = [
  ['content_envelope', 'TEXT'],
  ['content_snapshot_sha256', 'TEXT'],
  ['source_sync_sha256', 'TEXT'],
]

function usage() {
  console.error(
    'usage: node scripts/apply-content-envelope-ddl.mjs --local|--remote ' +
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

function existingColumnNames(args) {
  const stdout = runWrangler(args, 'PRAGMA table_info(posts)')
  let rows = []
  try {
    rows = JSON.parse(stdout)[0]?.results ?? []
  } catch {
    // non-JSON / empty output means the table is absent — treat as no columns
  }
  return new Set(rows.map((row) => row.name))
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  let existing
  try {
    existing = existingColumnNames(args)
  } catch (error) {
    console.error(`WARN: could not read posts columns (${error.message}); assuming table absent`)
    existing = new Set()
  }

  const missing = COLUMNS.filter(([name]) => !existing.has(name))
  if (missing.length === 0) {
    console.log('content envelope columns already present; nothing to do')
    process.exit(0)
  }

  for (const [name, type] of missing) {
    runWrangler(args, `ALTER TABLE posts ADD COLUMN ${name} ${type}`)
    console.log(`added column ${name} ${type}`)
  }
  console.log('content envelope DDL applied:', missing.map(([name]) => name).join(', '))
}

main()
