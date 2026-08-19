#!/usr/bin/env node
/**
 * B2-02 — shadow reconciliation: old `posts` (authority) vs the shadow layer
 * (`articles` + `article_versions`).
 *
 * For every authoritative post it checks, per item:
 *
 *   - one-to-one: exactly one identity row (post_ref), and at least one version,
 *   - field integrity: the current authoritative field digest matches the digest
 *     captured at backfill time (itemizes which fields drifted),
 *   - envelope consistency: the recomputed canonical snapshot hash equals the
 *     stored version hash (content drift without field drift is caught here),
 *   - publish-time rule: drafts must NOT carry a first-published time; published
 *     posts must carry one.
 *
 * Any identity / count / status / content difference blocks the authority
 * cutover: the script prints a per-post diff report and exits 1 when drift is
 * found (0 when fully aligned). Read-only; it never writes to the shadow layer.
 *
 * Runs under a TS loader to reuse the shared identity module:
 *   node --import tsx scripts/reconcile-article-shadow.mjs
 *
 * Usage:
 *   node --import tsx scripts/reconcile-article-shadow.mjs \
 *     [--local|--remote] [--persist-to <dir>] [--database <name>] [--config <path>] [--report <path>]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const identityUrl = pathToFileURL(join(repoRoot, 'lib', 'article-identity.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b202')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-backfill')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-shadow-report.md')

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-article-shadow.mjs --local|--remote ' +
      '[--persist-to <dir>] [--database <name>] [--config <path>] [--report <path>]',
  )
}

function parseArgs(argv) {
  const args = {
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    persistTo: DEFAULT_PERSIST,
    report: DEFAULT_REPORT,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--local') args.local = true
    else if (flag === '--remote') args.remote = true
    else if (flag === '--persist-to') args.persistTo = resolve(argv[++i])
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = resolve(argv[++i])
    else if (flag === '--report') args.report = resolve(argv[++i])
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const identity = (await import(identityUrl)).default ?? (await import(identityUrl))

  const posts = d1Execute(
    args,
    `SELECT id, slug, title, content, html, description, category, tags, status,
            password, is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
     FROM posts ORDER BY id`,
  )
  const articles = d1Execute(args, 'SELECT id, post_ref, created_at FROM articles ORDER BY post_ref')
  const versions = d1Execute(
    args,
    'SELECT id, article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at FROM article_versions ORDER BY article_id, version ASC',
  )

  const versionsByArticle = new Map()
  for (const v of versions) {
    const aid = Number(v.article_id)
    if (!versionsByArticle.has(aid)) versionsByArticle.set(aid, [])
    versionsByArticle.get(aid).push(v)
  }

  const drift = []
  let checked = 0

  const articlesByPostRef = new Map()
  for (const a of articles) {
    const pr = Number(a.post_ref)
    if (!articlesByPostRef.has(pr)) articlesByPostRef.set(pr, [])
    articlesByPostRef.get(pr).push(a)
  }
  const firstArticleByPostRef = new Map(
    [...articlesByPostRef.entries()].map(([pr, list]) => [pr, list[0]]),
  )

  for (const raw of posts) {
    checked += 1
    const postRef = Number(raw.id)
    const post = {
      id: postRef,
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

    // One-to-one identity.
    const article = firstArticleByPostRef.get(postRef)
    if (!article) {
      drift.push(`post #${postRef} (${post.slug}): 缺少文章身份 (no articles row for post_ref)`)
      continue
    }
    const articleId = Number(article.id)

    // At least one version (the initial snapshot).
    const postVersions = versionsByArticle.get(articleId) ?? []
    if (postVersions.length === 0) {
      drift.push(`post #${postRef} (${post.slug}): 无初始版本 (no article_versions rows)`)
      continue
    }
    const v0 = postVersions[0]

    // Envelope consistency: recompute canonical hash from current content.
    try {
      const snapshotNow = identity.buildInitialSnapshot(post)
      const expectedHash = snapshotNow.content_snapshot_sha256 ?? ''
      if (expectedHash === '') {
        drift.push(`post #${postRef}: 无法重算 envelope 哈希`)
      } else if (String(v0.content_snapshot_sha256) !== expectedHash) {
        drift.push(
          `post #${postRef} (${post.slug}): envelope 哈希不一致 stored=${String(v0.content_snapshot_sha256).slice(0, 12)} expected=${expectedHash.slice(0, 12)}`,
        )
      }
    } catch (error) {
      drift.push(`post #${postRef} (${post.slug}): envelope 重算失败 ${error instanceof Error ? error.message : error}`)
    }

    // Field integrity: compare current authoritative fields vs snapshot fields.
    const snapshot = JSON.parse(String(v0.snapshot_json))
    const fieldDiff = diffSnapshot(post, snapshot)
    if (fieldDiff.length > 0) {
      drift.push(`post #${postRef} (${post.slug}): 权威字段漂移 [${fieldDiff.join(', ')}]`)
    }

    // Publish-time rule: drafts must have NULL; published must be non-null.
    const versionPublishedAt = v0.published_at == null ? null : Number(v0.published_at)
    const expectedPublishedAt = post.status === 'published' ? post.published_at ?? null : null
    if ((versionPublishedAt === null) !== (expectedPublishedAt === null)) {
      drift.push(
        `post #${postRef} (${post.slug}): 首次发布时间规则违背 stored=${versionPublishedAt} expected=${expectedPublishedAt}`,
      )
    } else if (expectedPublishedAt !== null && versionPublishedAt !== expectedPublishedAt) {
      drift.push(
        `post #${postRef} (${post.slug}): 发布时间不一致 stored=${versionPublishedAt} expected=${expectedPublishedAt}`,
      )
    }
  }

  // Orphan identities: articles pointing at post_ref not present in authority.
  const postRefSet = new Set(posts.map((p) => Number(p.id)))
  for (const article of articles) {
    const postRef = Number(article.post_ref)
    if (!postRefSet.has(postRef)) {
      drift.push(`孤儿身份: articles #${article.id} → post_ref ${postRef} 不存在`)
    }
  }

  // Duplicate identities for a single post (should be impossible — UNIQUE).
  for (const [pr, list] of articlesByPostRef) {
    if (list.length > 1) {
      drift.push(`重复身份: post_ref ${pr} 有 ${list.length} 个 articles 行`)
    }
  }

  const aligned = drift.length === 0
  const reportLines = renderReport({ args, posts: posts.length, articles: articles.length, versions: versions.length, checked, drift, aligned })
  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, reportLines, 'utf8')

  console.log(
    `reconcile-article-shadow: posts=${posts.length} articles=${articles.length} versions=${versions.length} ` +
      `checked=${checked} drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

function diffSnapshot(post, snapshot) {
  const keys = [
    'slug', 'title', 'description', 'category', 'tags', 'status', 'password',
    'is_pinned', 'is_hidden', 'cover_image', 'deleted_at', 'published_at', 'updated_at',
  ]
  const changed = []
  for (const key of keys) {
    const a = snapshot.fields?.[key] ?? null
    const b = post[key] ?? null
    if (normalizeScalar(a) !== normalizeScalar(b)) changed.push(key)
  }
  if ((snapshot.original_content ?? null) !== (post.content ?? null)) changed.push('content')
  if ((snapshot.original_html ?? null) !== (post.html ?? null)) changed.push('html')
  return changed
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return JSON.stringify(value)
  return value
}

function renderReport({ args, posts, articles, versions, checked, drift, aligned }) {
  const lines = []
  lines.push('# B2-02 Shadow Reconciliation 报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  lines.push(`- posts(权威) 总数: ${posts}`)
  lines.push(`- articles(身份) 总数: ${articles}`)
  lines.push(`- article_versions(版本) 总数: ${versions}`)
  lines.push(`- 逐篇检查: ${checked}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（无差异，可安全切换）' : 'DRIFT（存在差异，阻断切换）'}`)
  lines.push('')
  if (drift.length === 0) {
    lines.push('## 差异清单')
    lines.push('')
    lines.push('（无）')
  } else {
    lines.push('## 差异清单')
    lines.push('')
    for (const item of drift) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('> 注：任何身份 / 数量 / 状态 / 内容差异都会阻断 authority 切换（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

main().catch((error) => {
  console.error('reconcile-article-shadow failed:', error)
  process.exit(2)
})
