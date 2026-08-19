import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLedger,
  backfillPath,
  cleanupStates,
  configPath,
  createState,
  reconcilePath,
  repoRoot,
  runD1,
  seedPosts,
} from '@/tests/helpers/article-identity-state'
import { parse, renderHtml } from '@/lib/content-envelope'

const kernel = { parse, renderHtml }

function runBackfill(state: string): void {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', backfillPath, '--local', '--persist-to', state,
    '--database', 'DB', '--config', configPath,
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function runReconcile(state: string, report: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', reconcilePath, '--local', '--persist-to', state,
    '--database', 'DB', '--config', configPath, '--report', report,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

const reportDirs: string[] = []

afterEach(() => {
  cleanupStates()
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-reconcile-report-'))
  reportDirs.push(dir)
  return join(dir, 'report.md')
}

describe('reconcile-article-shadow', () => {
  it('reports ALIGNED on a spoon-fed backfill, then DRIFT with an itemized diff when authority changes', { timeout: 600_000 }, () => {
    const state = createState()
    applyLedger(state)
    void seedPosts(state, kernel)
    runBackfill(state)

    // Aligned baseline.
    const report1 = freshReport()
    const aligned = runReconcile(state, report1)
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('posts=14')
    expect(aligned.stdout).toContain('drift=0')
    expect(readFileSync(report1, 'utf8')).toContain('ALIGNED')

    // Introduce authority drift: change a published title + draft content.
    runD1(state, "UPDATE posts SET title = '改名后的发表一' WHERE slug = 'pub-1'")
    runD1(state, "UPDATE posts SET content = '草稿正文一，已改。' WHERE slug = 'draft-1'")
    runD1(state, "INSERT INTO posts (slug, title, content, html, status, published_at) VALUES ('new-draft', '新草稿', '新内容。', '<p>新内容。</p>', 'draft', 1600000000)")

    const report2 = freshReport()
    const drifted = runReconcile(state, report2)
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report2, 'utf8')
    expect(text).toContain('pub-1')
    expect(text).toContain('title')
    expect(text).toContain('draft-1')
    expect(text).toContain('content')
    // The un-backfilled new post is flagged as a missing identity.
    expect(text).toContain('new-draft')
    expect(text).toContain('缺少文章身份')
    expect(existsSync(report2)).toBe(true)
  })
})
