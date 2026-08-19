/**
 * Shared D1 state helpers for the B2-02 backfill/reconcile script tests.
 * Builds a real local D1 (wrangler d1 execute --local --persist-to) with the
 * ledger schema + article-identity DDL, then seeds a representative posts
 * matrix (9 published / 5 drafts, incl. media, html-origin, pinned/hidden/
 * password variants) matching the #18 baseline.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const repoRoot = process.cwd()
export const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
export const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
export const ddlPath = join(repoRoot, 'scripts', 'apply-article-identity-ddl.mjs')
export const backfillPath = join(repoRoot, 'scripts', 'backfill-article-identity.mjs')
export const reconcilePath = join(repoRoot, 'scripts', 'reconcile-article-shadow.mjs')
export const configPath = join(repoRoot, 'wrangler.toml')

const stateDirectories: string[] = []

export function createState(): string {
  const state = mkdtempSync(join(tmpdir(), 'blogman-article-shadow-'))
  stateDirectories.push(state)
  return state
}

export function cleanupStates(): void {
  for (const state of stateDirectories.splice(0)) rmSync(state, { recursive: true, force: true })
}

export function spawnOk(label: string, args: string[], cwd = repoRoot): string {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

export function applyLedger(state: string): void {
  spawnOk('migrations apply', [
    process.execPath, runnerPath, 'apply', '--candidate', 'a'.repeat(40),
    '--database', 'DB', '--local', '--persist-to', state, '--config', configPath,
  ])
}

export function applyArticleIdentityDdl(state: string): void {
  spawnOk('article-identity ddl', [
    process.execPath, ddlPath, '--local', '--persist-to', state,
    '--database', 'DB', '--config', configPath,
  ])
}

export function runD1(state: string, sql: string): Array<{ results?: unknown[]; success?: boolean }> {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', state,
    '--config', configPath, '--command', sql, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
  return JSON.parse(result.stdout) as Array<{ results?: unknown[]; success?: boolean }>
}

export function query<T>(state: string, sql: string): T[] {
  return (runD1(state, sql).at(-1)?.results || []) as T[]
}

export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Seed a representative posts matrix. `html` is rendered from the same markdown
 * via the B2-01 kernel so the envelope projection classifies as `equivalent`.
 */
export async function seedPosts(state: string, kernel: {
  parse: (input: { markdown: string }) => { normalized: unknown }
  renderHtml: (envelope: unknown) => string
}): Promise<void> {
  interface Seed {
    slug: string
    title: string
    markdown: string
    status: 'published' | 'draft'
    published_at?: number | null
    cover_image?: string | null
    tags?: string | null
    is_pinned?: number
    is_hidden?: number
    password?: string | null
    category?: string
  }

  const seeds: Seed[] = [
    // Published — plain.
    { slug: 'pub-1', title: '发表一', markdown: '# 标题一\n\n正文一。', status: 'published' },
    { slug: 'pub-2', title: '发表二', markdown: '**粗体** 与 *斜体*。', status: 'published' },
    { slug: 'pub-3', title: '发表三', markdown: '- 甲\n- 乙\n- 丙\n', status: 'published' },
    { slug: 'pub-4', title: '发表四', markdown: '> 引用一段\n\n末尾。', status: 'published' },
    // Published — with media (cover + inline image).
    { slug: 'pub-5', title: '带图发表', markdown: '![配图](https://example.com/a.webp "图注")\n\n图片说明。', status: 'published', cover_image: 'https://example.com/cover.webp' },
    { slug: 'pub-6', title: '带码发表', markdown: '```js\nconst x = 1\n```\n', status: 'published' },
    // Published — pinned / hidden / password variants.
    { slug: 'pub-7', title: '置顶发表', markdown: '置顶内容。', status: 'published', is_pinned: 1 },
    { slug: 'pub-8', title: '隐藏发表', markdown: '隐藏内容。', status: 'published', is_hidden: 1 },
    { slug: 'pub-9', title: '加密发表', markdown: '加密内容。', status: 'published', password: 'secret', category: 'AI工具' },
    // Drafts — with an explicit legacy published_at that must NOT be inherited.
    { slug: 'draft-1', title: '草稿一', markdown: '草稿正文一。', status: 'draft', published_at: 1_600_000_000 },
    { slug: 'draft-2', title: '草稿二', markdown: '草稿正文二。', status: 'draft', published_at: 1_600_000_000 },
    { slug: 'draft-3', title: '草稿三', markdown: '- 未完成\n', status: 'draft', published_at: 1_600_000_000 },
    { slug: 'draft-4', title: '草稿四', markdown: '**加粗草稿**。', status: 'draft', published_at: 1_600_000_000 },
    { slug: 'draft-5', title: '草稿五', markdown: '末篇草稿。', status: 'draft', published_at: 1_600_000_000 },
  ]

  for (const seed of seeds) {
    const html = kernel.renderHtml(kernel.parse({ markdown: seed.markdown }))
    const publishedAt = seed.status === 'published'
      ? seed.published_at ?? 1_700_000_000
      : (seed.published_at ?? null)
    runD1(state, `INSERT INTO posts
        (slug, title, content, html, status, published_at, cover_image, tags, is_pinned, is_hidden, password, category)
      VALUES (
        ${literal(seed.slug)}, ${literal(seed.title)}, ${literal(seed.markdown)}, ${literal(html)},
        ${literal(seed.status)}, ${literal(publishedAt)}, ${literal(seed.cover_image ?? null)},
        ${literal(seed.tags ?? null)}, ${seed.is_pinned ?? 0}, ${seed.is_hidden ?? 0},
        ${literal(seed.password ?? null)}, ${literal(seed.category ?? null)}
      )`)
  }
}
