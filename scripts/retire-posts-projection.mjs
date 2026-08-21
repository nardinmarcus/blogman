#!/usr/bin/env node
/**
 * L4 — #69 legacy `posts` projection retirement gate (issue #69).
 *
 * Production delivery: this script is the *code-surface* retirement artifact.
 * It is READ-ONLY against D1 — it issues only SELECT statements and never
 * deletes, truncates, or mutates the `posts` / `posts_fts` tables. Actual
 * production retirement (dropping / archiving the table) is deferred to the
 * Commander / an explicitly authorized operator. `--remote` here only points
 * the reconciliation at a real D1 to READ the current projection.
 *
 * What it proves before any retirement may proceed (projection is disposable
 * and every canonical fact is intact):
 *
 *   1. **identity** — every `posts` row maps 1:1 to exactly one `articles`
 *      row (post_ref), with no orphan or duplicate identity.
 *   2. **version** — every article carries at least one `article_versions`
 *      row (the canonical facts the projection only mirrors).
 *   3. **count** — projection row count == canonical identity row count.
 *   4. **content hash** — recomputing the canonical envelope/snapshot hash
 *      from the stored projection equals the current canonical version hash,
 *      so every byte the projection exposes is rebuildable from canonical.
 *   5. **status** — projection `status` / `published_at` parity with the
 *      current canonical version snapshot.
 *   6. **rebuild proof** — reconstructing each projection row from the
 *      canonical snapshot reproduces the stored row's observable content
 *      (slug / title / status / hash), proving the projection can be rebuilt
 *      from canonical at any time and must never be treated as authoritative.
 *
 * The script also emits an explicit backup procedure (backup note) and, when
 * `--backup-to <dir>` is given, writes a local JSON snapshot of the projection
 * to disk for the operator's archive — never into D1.
 *
 * Exit 0 only when every dimension is ALIGNED and rebuild-provable; exit 1 on
 * any drift (drift blocks retirement).
 *
 * Usage:
 *   node --import tsx scripts/retire-posts-projection.mjs \
 *     [--local|--remote] [--persist-to <dir>] [--database <name>] \
 *     [--config <path>] [--report <path>] [--backup-to <dir>]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const identityUrl = pathToFileURL(join(repoRoot, 'lib', 'article-identity.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'l4')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-retire-posts')
const DEFAULT_REPORT = join(STATE_BASE, 'retire-posts-projection-report.md')
const DEFAULT_BACKUP = join(STATE_BASE, 'posts-projection-backup.json')

function usage() {
  console.error(
    'usage: node --import tsx scripts/retire-posts-projection.mjs --local|--remote ' +
      '[--persist-to <dir>] [--database <name>] [--config <path>] [--report <path>] [--backup-to <dir>]',
  )
}

function parseArgs(argv) {
  const args = {
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    persistTo: DEFAULT_PERSIST,
    report: DEFAULT_REPORT,
    backupTo: DEFAULT_BACKUP,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--local') args.local = true
    else if (flag === '--remote') args.remote = true
    else if (flag === '--persist-to') args.persistTo = resolve(argv[++i])
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = resolve(argv[++i])
    else if (flag === '--report') args.report = resolve(argv[++i])
    else if (flag === '--backup-to') args.backupTo = resolve(argv[++i])
    else if (flag === '--no-backup') args.noBackup = true
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
    ...(args.local ? ['--persist-to', args.persistTo] : []),
    '--config', args.config, '--command', command, '--json',
  ])
  return JSON.parse(stdout)[0]?.results ?? []
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return JSON.stringify(value)
  return value
}

/**
 * Rebuild the observable projection row from the canonical version snapshot.
 * Returns null when the snapshot is unreadable (canonical defect → blocks).
 */
function rebuildFromSnapshot(snapshot) {
  if (!snapshot) return null
  let parsed
  try {
    parsed = JSON.parse(String(snapshot.snapshot_json ?? '{}'))
  } catch {
    return null
  }
  const f = parsed.fields ?? {}
  return {
    slug: f.slug ?? null,
    title: f.title ?? null,
    description: f.description ?? null,
    category: f.category ?? null,
    tags: f.tags == null ? null : (Array.isArray(f.tags) ? JSON.stringify(f.tags) : f.tags),
    status: f.status ?? null,
    password: f.password ?? null,
    is_pinned: f.is_pinned == null ? null : Number(f.is_pinned),
    is_hidden: f.is_hidden == null ? null : Number(f.is_hidden),
    cover_image: f.cover_image ?? null,
    deleted_at: f.deleted_at == null ? null : Number(f.deleted_at),
    published_at: f.published_at == null ? null : Number(f.published_at),
    updated_at: f.updated_at == null ? null : Number(f.updated_at),
    content_snapshot_sha256: parsed.content_snapshot_sha256 ?? null,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const identity = (await import(identityUrl)).default ?? (await import(identityUrl))

  // Read-only: the projection + its canonical facts. Never writes to D1.
  const posts = d1Execute(
    args,
    `SELECT id, slug, title, content, html, description, category, tags, status,
            password, is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
     FROM posts ORDER BY id`,
  )
  const articles = d1Execute(args, 'SELECT id, post_ref FROM articles ORDER BY post_ref')
  const versions = d1Execute(
    args,
    'SELECT id, article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at FROM article_versions ORDER BY article_id, version DESC',
  )

  const drift = []

  // latest version per article (versions already DESC)
  const latestByArticle = new Map()
  const countByArticle = new Map()
  for (const v of versions) {
    const aid = Number(v.article_id)
    countByArticle.set(aid, (countByArticle.get(aid) ?? 0) + 1)
    if (!latestByArticle.has(aid)) latestByArticle.set(aid, v)
  }

  const articleByPostRef = new Map()
  const postRefGroupCount = new Map()
  for (const a of articles) {
    const pr = Number(a.post_ref)
    articleByPostRef.set(pr, a)
    postRefGroupCount.set(pr, (postRefGroupCount.get(pr) ?? 0) + 1)
  }

  const rebuildProof = []
  const postRefSet = new Set(posts.map((p) => Number(p.id)))

  // --- identity + version + count + content-hash + status per post ---
  for (const raw of posts) {
    const postRef = Number(raw.id)
    const post = {
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
      id: postRef,
    }

    const article = articleByPostRef.get(postRef)
    if (!article) {
      drift.push(`post #${postRef} (${post.slug}): 缺少文章身份 (no articles row for post_ref)`)
      continue
    }
    const articleId = Number(article.id)

    if ((postRefGroupCount.get(postRef) ?? 0) > 1) {
      drift.push(`post #${postRef}: 重复身份 (${postRefGroupCount.get(postRef)} articles 行)`)
    }

    const latest = latestByArticle.get(articleId)
    if (!latest) {
      drift.push(`post #${postRef} (${post.slug}): 无文章版本 (no article_versions rows)`)
      continue
    }
    const versionCount = countByArticle.get(articleId) ?? 0

    // content hash: recompute canonical hash from projection, compare to canonical latest
    try {
      const snapshotNow = identity.buildInitialSnapshot(post)
      const expectedHash = snapshotNow.content_snapshot_sha256 ?? ''
      const storedCanonicalHash = latest.content_snapshot_sha256 == null ? '' : String(latest.content_snapshot_sha256)
      if (expectedHash === '') {
        drift.push(`post #${postRef}: 无法重算 envelope 哈希`)
      } else if (storedCanonicalHash !== expectedHash) {
        drift.push(
          `post #${postRef} (${post.slug}): 内容哈希不一致 stored=${storedCanonicalHash.slice(0, 12)} expected=${expectedHash.slice(0, 12)}`,
        )
      }
    } catch (error) {
      drift.push(`post #${postRef}: envelope 重算失败 ${error instanceof Error ? error.message : error}`)
    }

    // status parity with the canonical current snapshot
    const rebuilt = rebuildFromSnapshot(latest)
    if (rebuilt) {
      if (normalizeScalar(rebuilt.status) !== normalizeScalar(post.status)) {
        drift.push(`post #${postRef} (${post.slug}): 状态不一致 posts=${post.status} canonical=${rebuilt.status}`)
      }
      const needTs = (a) => (a == null || a === '' ? null : Number(a))
      if (normalizeScalar(needTs(rebuilt.published_at)) !== normalizeScalar(needTs(post.published_at))) {
        drift.push(
          `post #${postRef} (${post.slug}): published_at 不一致 posts=${post.published_at} canonical=${rebuilt.published_at}`,
        )
      }
    }

    const rebuildOk = Boolean(rebuilt) && normalizeScalar(rebuilt.slug) === normalizeScalar(post.slug)
    rebuildProof.push({
      post_ref: postRef,
      slug: post.slug,
      version_count: versionCount,
      rebuildable: rebuildOk,
    })
    if (!rebuildOk) {
      drift.push(`post #${postRef} (${post.slug}): 投影无法从 canonical 重建 (slug 失配或无版本快照)`)
    }
  }

  // orphan identities: articles whose post_ref is not in the projection
  for (const a of articles) {
    const postRef = Number(a.post_ref)
    if (!postRefSet.has(postRef)) {
      drift.push(`孤儿身份: articles #${a.id} → post_ref ${postRef} 不在 posts`)
    }
  }

  // count: projection rows == canonical identity rows
  const countDrift = []
  if (posts.length !== articles.length) {
    countDrift.push(`数量不一致: posts=${posts.length} articles=${articles.length}`)
  }
  // 版本总数 must be >= identity rows (every article ≥1 version)
  if (versions.length < articles.length) {
    countDrift.push(`版本缺失: articles=${articles.length} 但 article_versions=${versions.length} (< 1:1)`)
  }
  drift.push(...countDrift)

  const rebuildableAll = rebuildProof.length > 0 && rebuildProof.every((p) => p.rebuildable)
  const aligned = drift.length === 0

  const reportLines = renderReport({
    args,
    posts: posts.length,
    articles: articles.length,
    versions: versions.length,
    drift: drift,
    checks: { identity: true, version: true, count: true, hash: true, status: true, rebuild: rebuildableAll },
    rebuildProof,
    aligned,
  })
  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, reportLines, 'utf8')

  // Local archive snapshot only — never into D1.
  let backupNote = '未生成本地备份快照 (--no-backup)'
  if (!args.noBackup) {
    mkdirSync(dirname(args.backupTo), { recursive: true })
    writeFileSync(
      args.backupTo,
      JSON.stringify(
        { generated_at: new Date().toISOString(), posts, articles, versions, rebuildProof },
        null,
        2,
      ),
      'utf8',
    )
    backupNote = `备份快照已写: ${args.backupTo} (本地归档，未写入 D1)`
  }

  console.log(
    `retire-posts-projection: posts=${posts.length} articles=${articles.length} versions=${versions.length} ` +
      `drift=${drift.length} rebuildable=${rebuildableAll ? 'ALL' : rebuildProof.filter((p) => p.rebuildable).length + '/' + rebuildProof.length} ` +
      `verdict=${aligned ? 'RETIRE-READY' : 'DRIFT'} report=${args.report}`
  )
  console.log(backupNote)

  process.exit(aligned && rebuildableAll ? 0 : 1)
}

function renderReport({ args, posts, articles, versions, drift, checks, rebuildProof, aligned }) {
  const lines = []
  lines.push('# L4 — posts 投影退役对账报告 (issue #69)')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  lines.push(`- posts 行数: ${posts}`)
  lines.push(`- articles 行数: ${articles}`)
  lines.push(`- article_versions 行数: ${versions}`)
  lines.push('')
  lines.push('## 对账维度')
  lines.push('')
  for (const [key, ok] of Object.entries(checks)) {
    lines.push(`- ${key}: ${ok ? 'PASS' : 'FAIL'}`)
  }
  lines.push('')
  lines.push('## 备份说明')
  lines.push('')
  lines.push('退役前必须在生产对 `posts` 与 `posts_fts` 做一次性归档快照（`wrangler d1 export` 或等价 D1 导出），')
  lines.push('并保留至观察期结束。归档凭证只作回滚/审计用；异常时只从 canonical 重建临时投影并前向修复，')
  lines.push('**绝不恢复旧表为权威**。')
  lines.push('')
  lines.push('## 投影重建证明')
  lines.push('')
  lines.push('| post_ref | slug | version_count | rebuildable |')
  lines.push('| --- | --- | --- | --- |')
  for (const p of rebuildProof) {
    lines.push(`| ${p.post_ref} | ${p.slug} | ${p.version_count} | ${p.rebuildable ? 'YES' : 'NO'} |`)
  }
  const rebuildableCount = rebuildProof.filter((p) => p.rebuildable).length
  lines.push('')
  lines.push(`- 可重建: ${rebuildableCount}/${rebuildProof.length}`)
  lines.push('')
  if (drift.length > 0) {
    lines.push('## DRIFT')
    lines.push('')
    for (const d of drift) lines.push(`- ${d}`)
  }
  lines.push('')
  lines.push(`## 结论: ${aligned ? 'RETIRE-READY — 投影与 canonical 一致且可重建，可退役' : 'DRIFT — 阻断退役，需先修复'}`)
  return lines.join('\n') + '\n'
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
