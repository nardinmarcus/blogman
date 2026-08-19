#!/usr/bin/env node
/**
 * B2-01b — verify-content-envelope fidelity pass.
 *
 * Pulls `content` samples from the LOCAL D1 (wrangler d1 execute DB --local),
 * seeds a representative sample matrix when the store is clean-start empty, and
 * for each sample runs markdown → envelope → renderHtml against the existing
 * `html` column, producing a fidelity report (equivalent / degraded / mismatch
 * lists). Replayable: the persist dir keeps its state across runs.
 *
 * Boundary note (issue #24): production D1 is a clean-start empty store, so
 * "real historical samples" is satisfied by this representative matrix plus a
 * re-runnable script, and the report states that boundary explicitly. Envelope
 * column population itself is exercised by the route integration test, not by
 * this pass (which only reads content/html and the envelope columns if present).
 *
 * Runs under a TS loader so it can consume the envelope kernel:
 *   node --import tsx scripts/verify-content-envelope.mjs
 *
 * Usage:
 *   node --import tsx scripts/verify-content-envelope.mjs \
 *     [--persist-to <dir>] [--report <path>] [--database <name>]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkHtml from 'remark-html'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kernelUrl = pathToFileURL(join(repoRoot, 'lib', 'content-envelope', 'index.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b201b')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state')
const DEFAULT_REPORT = join(STATE_BASE, 'report.md')

/**
 * Representative historical-body sample matrix (issue #24 coverage: equivalent
 * nodes, attribute order, empty paragraphs, marks, complex blocks, media refs).
 */
const SAMPLES = [
  { slug: 'sample-heading', markdown: '# 标题一\n\n## 标题二\n\n### 标题三\n' },
  { slug: 'sample-marks', markdown: '**粗体**、*斜体*、~~删除~~ 与 `行内代码` 混合。' },
  { slug: 'sample-lists', markdown: '- 甲\n- 乙\n  - 乙一\n- 丙\n\n1. 第一\n2. 第二\n' },
  { slug: 'sample-code', markdown: '```js\nconst x = 1\n```\n' },
  { slug: 'sample-quote', markdown: '> 引用一段\n>\n> 第二行\n' },
  { slug: 'sample-link', markdown: '[文档](https://example.com/docs "标题") 与 [站内](/p/a)。' },
  { slug: 'sample-image', markdown: '![配图](https://example.com/a.webp "图注")\n' },
  { slug: 'sample-table', markdown: '| 列甲 | 列乙 |\n| --- | --- |\n| 1 | 2 |\n' },
  { slug: 'sample-hr-empty', markdown: '文本。\n\n---\n\n' },
  { slug: 'sample-paragraphs', markdown: '第一段。\n\n第二段，带\n软换行。\n\n第三段结尾。\n' },
  { slug: 'sample-frontmatterless', markdown: '普通一段，末尾无符号。' },
]

function parseArgs(argv) {
  const args = {
    persistTo: DEFAULT_PERSIST,
    report: DEFAULT_REPORT,
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--persist-to') args.persistTo = resolve(argv[++i])
    else if (flag === '--report') args.report = resolve(argv[++i])
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = argv[++i]
  }
  return args
}

function run(resultLabel, spawnArgs) {
  const result = spawnSync(spawnArgs[0], spawnArgs.slice(1), { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${resultLabel}: ${result.stderr.trim() || result.stdout.trim() || 'failed'}`)
  }
  return result.stdout
}

function d1Execute(args, command) {
  const stdout = run('wrangler d1 execute', [
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    'd1', 'execute', args.database, '--local', '--persist-to', args.persistTo,
    '--config', args.config, '--command', command, '--json',
  ])
  return JSON.parse(stdout)[0]?.results ?? []
}

function ensureSchema(args) {
  run('migrations apply', [
    process.execPath,
    join(repoRoot, 'scripts', 'migrations.mjs'), 'apply',
    '--candidate', 'b'.repeat(40), '--database', args.database, '--local',
    '--persist-to', args.persistTo, '--config', args.config,
  ])
  run('content-envelope ddl', [
    process.execPath,
    join(repoRoot, 'scripts', 'apply-content-envelope-ddl.mjs'),
    '--local', '--persist-to', args.persistTo,
    '--database', args.database, '--config', args.config,
  ])
}

async function renderMarkdownHtml(markdown) {
  return (await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(markdown)).toString()
}

async function seedSamples(args) {
  for (const sample of SAMPLES) {
    const html = await renderMarkdownHtml(sample.markdown)
    const escaped = sample.markdown.replaceAll("'", "''")
    const htmlEscaped = html.replaceAll("'", "''")
    d1Execute(
      args,
      `INSERT INTO posts (slug, title, content, html, status) VALUES ('${sample.slug}', '${sample.slug}', '${escaped}', '${htmlEscaped}', 'draft')`,
    )
  }
}

/** Text tokens only (no tags), whitespace-collapsed — used to compare body text. */
function textSequence(html) {
  const tokens = []
  const re = /<[^>]*>|([^<]+)/g
  let match
  while ((match = re.exec(String(html))) !== null) {
    if (match[1] !== undefined) {
      const text = match[1].replace(/\s+/g, ' ').trim()
      if (text) tokens.push(text)
    }
  }
  return tokens.join(' ')
}

/** Block-aware structural fingerprint: tags + text tokens in order. */
function normalizeForCompare(html) {
  const tokens = []
  const re = /<\/?([a-zA-Z0-9]+)[^>]*>|([^<]+)/g
  let match
  while ((match = re.exec(String(html))) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[0][1] === '/' ? `/${match[1]}` : match[1])
    } else if (match[2] !== undefined) {
      const text = match[2].replace(/\s+/g, ' ').trim()
      if (text) tokens.push(text)
    }
  }
  return tokens.join(' ')
}

function classify(rendered, storedHtml, error) {
  if (error) return 'error'
  if (normalizeForCompare(rendered) === normalizeForCompare(storedHtml)) return 'equivalent'
  if (textSequence(rendered) === textSequence(storedHtml)) return 'degraded'
  return 'mismatch'
}

function tally(rows) {
  const summary = { equivalent: 0, degraded: 0, mismatch: 0, error: 0 }
  for (const row of rows) summary[row.classification] += 1
  return summary
}

function renderReport({ args, seeded, rows, summary }) {
  const lines = []
  lines.push('# B2-01b Content-Envelope 保真验证报告')
  lines.push('')
  lines.push(`- 脚本: \`scripts/verify-content-envelope.mjs\``)
  lines.push(`- D1 模式: local (persist-to: \`${args.persistTo}\`)`)
  lines.push(`- 本次是否 seed 代表性样本矩阵: ${seeded ? '是（clean-start 空库）' : '否（读取既有样本）'}`)
  lines.push(`- 样本总数: ${rows.length}`)
  lines.push('')
  lines.push('> **边界说明（issue #24）**: 生产 D1 为 clean-start 空库，票面要求的"真实历史样本"')
  lines.push('> 以本脚本内置的代表性样本矩阵 + 可重放脚本满足；本报告未覆盖真实线上文章。旧')
  lines.push('> content/html 列仍为只读回退，本 pass 只读、不回填/覆盖任何权威内容（转换失败阻止后续回填）。')
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push('| 类别 | 数量 |')
  lines.push('| --- | --- |')
  lines.push(`| 等价 equivalent | ${summary.equivalent} |`)
  lines.push(`| 降级 degraded（正文等价、标记不同） | ${summary.degraded} |`)
  lines.push(`| 失配 mismatch | ${summary.mismatch} |`)
  lines.push(`| 转换失败 error | ${summary.error} |`)
  lines.push('')
  lines.push('## 明细')
  lines.push('')
  lines.push('| slug | 类别 | 落库 envelope | snapshot_hash | source_hash |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(
      `| ${row.slug} | ${row.classification} | ${row.hasEnvelope ? 'yes' : 'no'} | ` +
      `${row.snapshotHash ? row.snapshotHash.slice(0, 12) : '-'} | ${row.sourceHash ? row.sourceHash.slice(0, 12) : '-'} |`,
    )
  }
  lines.push('')
  lines.push('## 失配清单（mismatch / error）')
  lines.push('')
  const problemRows = rows.filter((row) => row.classification === 'mismatch' || row.classification === 'error')
  if (problemRows.length === 0) {
    lines.push('（无）')
  } else {
    for (const row of problemRows) {
      lines.push(`- **${row.slug}** (${row.classification})`)
      if (row.error) lines.push(`  - 转换失败: ${row.error}`)
      else {
        lines.push(`  - 既有 html: ${row.storedHtml}`)
        lines.push(`  - envelope html: ${row.rendered}`)
      }
    }
  }
  lines.push('')
  lines.push('> 注：本 pass 只做 markdown→envelope→HTML 保真比对；envelope 列的写入与哈希由')
  lines.push('> 写路径（app/api/posts/route.ts + lib/content-envelope-columns.ts）负责，见路由集成测试。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.persistTo, { recursive: true })
  mkdirSync(dirname(args.report), { recursive: true })

  ensureSchema(args)

  const [{ count } = { count: 0 }] = d1Execute(args, 'SELECT COUNT(*) AS count FROM posts')
  let seeded = false
  if (Number(count) === 0) {
    await seedSamples(args)
    seeded = true
  }

  const posts = d1Execute(
    args,
    'SELECT id, slug, content, html, content_envelope, content_snapshot_sha256, source_sync_sha256 FROM posts ORDER BY id',
  )

  const kernel = (await import(kernelUrl)).default ?? (await import(kernelUrl))

  const rows = []
  for (const post of posts) {
    const content = String(post.content ?? '')
    const storedHtml = String(post.html ?? '')
    let rendered = ''
    let error = null
    try {
      const envelope = kernel.parse({ markdown: content })
      rendered = kernel.renderHtml(envelope)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    rows.push({
      slug: post.slug,
      classification: classify(rendered, storedHtml, error),
      storedHtml,
      rendered,
      hasEnvelope: Boolean(post.content_envelope),
      snapshotHash: post.content_snapshot_sha256 ?? null,
      sourceHash: post.source_sync_sha256 ?? null,
      error,
    })
  }

  const summary = tally(rows)
  const report = renderReport({ args, seeded, rows, summary })

  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, report, 'utf8')

  console.log(
    `verify-content-envelope: ${summary.equivalent} equivalent / ${summary.degraded} degraded / ` +
      `${summary.mismatch} mismatch / ${summary.error} error; report=${args.report}`,
  )
}

main().catch((error) => {
  console.error('verify-content-envelope failed:', error)
  process.exit(1)
})
