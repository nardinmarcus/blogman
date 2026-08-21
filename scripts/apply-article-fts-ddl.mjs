#!/usr/bin/env node
/**
 * #234 Phase A — idempotent canonical article search index DDL.
 *
 * Delivers the `article_fts` fts5 surface + its `article_versions` feed
 * trigger (see lib/article-fts/ddl.ts) through the same independent DDL
 * channel as B2-01b/B2-02/B3-01/B3-04 so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) stays untouched. Safe to run
 * repeatedly. Never drops or alters an existing row/table.
 *
 * READ-ONLY against production until an explicitly authorized operator runs
 * it in Phase B/C; this script only creates the new index surface.
 *
 * Usage:
 *   node scripts/apply-article-fts-ddl.mjs --local
 *   node scripts/apply-article-fts-ddl.mjs --local --persist-to <dir> --database DB --config wrangler.toml
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATEMENTS = [
  {
    name: 'article_fts',
    sql: `CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(title, content)`,
  },
  {
    name: 'article_fts_version_indexed',
    sql: `CREATE TRIGGER IF NOT EXISTS article_fts_version_indexed
       AFTER INSERT ON article_versions
     BEGIN
       DELETE FROM article_fts WHERE rowid = new.article_id;
       INSERT INTO article_fts(rowid, title, content)
       VALUES (
         new.article_id,
         COALESCE(json_extract(new.snapshot_json, '$.fields.title'), ''),
         COALESCE(json_extract(new.snapshot_json, '$.original_content'), '')
       );
     END`,
  },
]

function usage() {
  console.error(
    'usage: node scripts/apply-article-fts-ddl.mjs --local|--remote ' +
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

function objectExists(args, name, type) {
  const stdout = runWrangler(
    args,
    `SELECT name FROM sqlite_master WHERE type='${type}' AND name='${name}'`,
  )
  let rows = []
  try {
    rows = JSON.parse(stdout)[0]?.results ?? []
  } catch {
    rows = []
  }
  return rows.length > 0
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const created = []
  const skipped = []
  for (const statement of STATEMENTS) {
    const type = statement.name === 'article_fts' ? 'table' : 'trigger'
    const missing = !objectExists(args, statement.name, type)
    if (missing) {
      runWrangler(args, statement.sql)
      created.push(statement.name)
    } else {
      skipped.push(statement.name)
    }
  }
  console.log(JSON.stringify({ created, skipped, ok: true }, null, 2))
}

main()
