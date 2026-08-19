#!/usr/bin/env node
/**
 * B2-02 — idempotent article identity backfill.
 *
 * Scans every authoritative `posts` row (the full pre-cutover set, including
 * drafts and soft-deleted rows) and, for each, builds an immutable article
 * identity + initial version snapshot:
 *
 *   - canonical content envelope from the B2-01 kernel (markdown preferred,
 *     HTML→markdown fallback),
 *   - audit digest of the pre-migration fields + original bodies,
 *   - fidelity classification vs the stored HTML,
 *   - draft first-published time rule (never fabricate a time for drafts).
 *
 * Idempotent: a re-run creates zero new identities/versions (deduped by
 * `post_ref` on `articles` and by `operation_id` on `article_versions`).
 * Delivered via the standalone article-identity DDL channel — the issue-23
 * canonical migration freeze is untouched.
 *
 * Runs under a TS loader so it can consume the shared identity module:
 *   node --import tsx scripts/backfill-article-identity.mjs
 *
 * Usage:
 *   node --import tsx scripts/backfill-article-identity.mjs \
 *     [--local|--remote] [--persist-to <dir>] [--database <name>] [--config <path>]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const identityUrl = pathToFileURL(join(repoRoot, 'lib', 'article-identity.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b202')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-backfill')

function usage() {
  console.error(
    'usage: node --import tsx scripts/backfill-article-identity.mjs --local|--remote ' +
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

function run(label, spawnArgs) {
  const result = spawnSync(spawnArgs[0], spawnArgs.slice(1), { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stderr.trim() || result.stdout.trim() || 'failed'}`)
  }
  return result.stdout
}

function d1Execute(args, command) {
  const stdout = run('wrangler d1 execute', [
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    'd1', 'execute', args.database, ...(args.local ? ['--local'] : ['--remote']),
    '--persist-to', args.persistTo,
    '--config', args.config, '--command', command, '--json',
  ])
  return JSON.parse(stdout)[0]?.results ?? []
}

function d1ExecuteNoJson(args, command) {
  run('wrangler d1 execute', [
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    'd1', 'execute', args.database, ...(args.local ? ['--local'] : ['--remote']),
    '--persist-to', args.persistTo,
    '--config', args.config, '--command', command, '--json',
  ])
}

function ensureSchema(args) {
  run('migrations apply', [
    process.execPath,
    join(repoRoot, 'scripts', 'migrations.mjs'), 'apply',
    '--candidate', 'backfill-article-identity', '--database', args.database,
    '--local', '--persist-to', args.persistTo, '--config', args.config,
  ])
  run('article-identity ddl', [
    process.execPath,
    join(repoRoot, 'scripts', 'apply-article-identity-ddl.mjs'),
    '--local', '--persist-to', args.persistTo,
    '--database', args.database, '--config', args.config,
  ])
}

function literal(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function resolveArticleId(args, postRef) {
  const existing = d1Execute(args, `SELECT id FROM articles WHERE post_ref = ${postRef}`)
  if (existing.length > 0) return { articleId: Number(existing[0].id), created: false }
  d1ExecuteNoJson(
    args,
    `INSERT OR IGNORE INTO articles (post_ref) VALUES (${postRef})`,
  )
  const row = d1Execute(args, `SELECT id FROM articles WHERE post_ref = ${postRef}`)[0]
  return { articleId: Number(row.id), created: true }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.persistTo, { recursive: true })

  ensureSchema(args)

  const identity = (await import(identityUrl)).default ?? (await import(identityUrl))

  const posts = d1Execute(
    args,
    `SELECT id, slug, title, content, html, description, category, tags, status,
            password, is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
     FROM posts ORDER BY id`,
  )

  const tally = {
    posts: posts.length,
    identitiesCreated: 0,
    identitiesExisting: 0,
    versionsCreated: 0,
    versionsSkipped: 0,
    fidelity: { equivalent: 0, degraded: 0, mismatch: 0, error: 0 },
    drafts: 0,
    publishedKept: 0,
  }

  for (const raw of posts) {
    const post = {
      id: Number(raw.id),
      slug: String(raw.slug),
      title: String(raw.title),
      content: raw.content == null ? null : String(raw.content),
      html: raw.html == null ? null : String(raw.html),
      description: raw.description == null ? null : String(raw.description),
      category: raw.category == null ? null : String(raw.category),
      tags: raw.tags == null ? null : String(raw.tags),
      status: String(raw.status),
      password: raw.password == null ? null : String(raw.password),
      is_pinned: raw.is_pinned == null ? null : Number(raw.is_pinned),
      is_hidden: raw.is_hidden == null ? null : Number(raw.is_hidden),
      cover_image: raw.cover_image == null ? null : String(raw.cover_image),
      deleted_at: raw.deleted_at == null ? null : Number(raw.deleted_at),
      published_at: raw.published_at == null ? null : Number(raw.published_at),
      updated_at: raw.updated_at == null ? null : Number(raw.updated_at),
    }

    const snapshot = identity.buildInitialSnapshot(post)
    const operationId = identity.operationIdFor(post.id)
    tally.fidelity[snapshot.fidelity] += 1
    if (snapshot.fidelity === 'error') {
      console.error(`WARN: post ${post.id} (${post.slug}) conversion failed: ${snapshot.fidelity_detail}`)
    }

    const { articleId, created } = resolveArticleId(args, post.id)
    if (created) tally.identitiesCreated += 1
    else tally.identitiesExisting += 1

    const already = d1Execute(
      args,
      `SELECT id FROM article_versions WHERE operation_id = ${literal(operationId)}`,
    )
    if (already.length > 0) {
      tally.versionsSkipped += 1
      continue
    }

    const snapJson = JSON.stringify(snapshot)
    const hash = snapshot.content_snapshot_sha256 ?? ''
    const publishedAt = snapshot.published_at
    d1ExecuteNoJson(
      args,
      `INSERT OR IGNORE INTO article_versions
         (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
       VALUES (${articleId}, 1, ${literal(operationId)}, ${literal(snapJson)}, ${literal(hash)}, ${literal(publishedAt)})`,
    )
    tally.versionsCreated += 1
    if (post.status === 'published') tally.publishedKept += 1
    else tally.drafts += 1
  }

  console.log(
    `backfill-article-identity: posts=${tally.posts} identities_created=${tally.identitiesCreated} ` +
      `identities_existing=${tally.identitiesExisting} versions_created=${tally.versionsCreated} ` +
      `versions_skipped=${tally.versionsSkipped} fidelity=` +
      `${tally.fidelity.equivalent}eq/${tally.fidelity.degraded}deg/${tally.fidelity.mismatch}mis/${tally.fidelity.error}err ` +
      `published_kept=${tally.publishedKept} drafts=${tally.drafts}`,
  )
}

main().catch((error) => {
  console.error('backfill-article-identity failed:', error)
  process.exit(1)
})
