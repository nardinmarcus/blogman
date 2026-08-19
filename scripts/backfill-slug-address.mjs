#!/usr/bin/env node
/**
 * B3-04 — backfill the current observable slug addresses (issue #36).
 *
 * Migration rule: register ONLY the current observable public address for
 * every formally-first-published article (from `formal_publications`) as a
 * `current` address in the slug-address registry. It never invents history
 * (historical addresses can only be produced by a real promotion through the
 * B3-02 / B3-04 go-live loop) and it never overwrites or releases an address
 * already claimed by another article. Idempotent: a re-run registers zero new
 * rows.
 *
 * Run AFTER applying the registry DDL:
 *   node scripts/apply-slug-address-ddl.mjs --local
 *   node scripts/backfill-slug-address.mjs --local
 *
 * Usage:
 *   node scripts/backfill-slug-address.mjs --local|--remote \
 *     [--persist-to <dir>] [--database <name>] [--config <path>]
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b304')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-backfill')

function usage() {
  console.error(
    'usage: node scripts/backfill-slug-address.mjs --local|--remote ' +
      '[--persist-to <dir>] [--database <name>] [--config <path>]',
  )
}

function parseArgs(argv) {
  const args = {
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    persistTo: DEFAULT_PERSIST,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--local') args.local = true
    else if (flag === '--remote') args.remote = true
    else if (flag === '--persist-to') args.persistTo = resolve(argv[++i])
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = resolve(argv[++i])
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

function runWranglerD1(args, command) {
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
  return JSON.parse(result.stdout)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const stdout = runWranglerD1(
    args,
    'SELECT article_id, slug FROM formal_publications ORDER BY article_id ASC',
  )
  let rows = []
  try {
    rows = stdout[0]?.results ?? []
  } catch {
    rows = []
  }

  const now = Math.floor(Date.now() / 1000)
  let registered = 0
  let skipped = 0
  for (const row of rows) {
    const { article_id: articleId, slug } = row
    const out = runWranglerD1(
      args,
      `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
       SELECT '${slug}', ${articleId}, 'current', ${now}, ${now}
       WHERE NOT EXISTS (SELECT 1 FROM article_slug_addresses WHERE slug = '${slug}')
         AND NOT EXISTS (SELECT 1 FROM article_slug_addresses
                         WHERE article_id = ${articleId} AND kind = 'current')`,
    )
    const wrote =
      out[0]?.meta?.changes ?? out[0]?.meta?.rows_written ?? out[0]?.meta?.changes_count ?? 0
    if (wrote > 0) registered += 1
    else skipped += 1
  }
  console.log(JSON.stringify({ registered, skipped, ok: true, now }, null, 2))
}

main()
