import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, renderHtml } from '@/lib/content-envelope'
import {
  applyLedger,
  backfillPath,
  cleanupStates,
  configPath,
  createState,
  repoRoot,
  retirePath,
  runD1,
  seedPosts,
} from '@/tests/helpers/article-identity-state'

const kernel = { parse, renderHtml }

function runBackfill(state: string): void {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', backfillPath, '--local', '--persist-to', state,
    '--database', 'DB', '--config', configPath,
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function runRetire(state: string, report: string, backup: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', retirePath, '--local', '--persist-to', state,
    '--database', 'DB', '--config', configPath, '--report', report, '--backup-to', backup,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

const reportDirs: string[] = []

afterEach(() => {
  cleanupStates()
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-retire-posts-'))
  reportDirs.push(dir)
  return dir
}

describe('retire-posts-projection', () => {
  it('reports RETIRE-READY when projection is canonical-aligned and rebuildable', { timeout: 600_000 }, () => {
    const state = createState()
    applyLedger(state)
    void seedPosts(state, kernel)
    runBackfill(state)

    const dir = freshDir()
    const report = join(dir, 'report.md')
    const backup = join(dir, 'backup.json')

    const ready = runRetire(state, report, backup)
    expect(ready.status, ready.stdout || ready.stderr).toBe(0)
    expect(ready.stdout).toContain('verdict=RETIRE-READY')
    expect(ready.stdout).toContain('drift=0')
    expect(ready.stdout).toContain('rebuildable=ALL')
    expect(readFileSync(report, 'utf8')).toContain('RETIRE-READY')
    // Local archive snapshot written, not into D1.
    expect(existsSync(backup)).toBe(true)
    const snapshot = JSON.parse(readFileSync(backup, 'utf8'))
    expect(snapshot.posts.length).toBe(14)
    // Every projection row rebuildable.
    expect(snapshot.rebuildProof.every((p: { rebuildable: boolean }) => p.rebuildable)).toBe(true)
    // posts table untouched after the run (read-only).
    expect((runD1(state, 'SELECT COUNT(*) AS c FROM posts').at(-1)?.results as Array<{ c: number }>)[0].c).toBe(14)
  })

  it('reports DRIFT and blocks retirement when a read/write surface diverges', { timeout: 600_000 }, () => {
    const state = createState()
    applyLedger(state)
    void seedPosts(state, kernel)
    runBackfill(state)

    // Drift the projection status away from the canonical version snapshot.
    runD1(state, "UPDATE posts SET status = 'published' WHERE slug = 'draft-1'")

    const dir = freshDir()
    const report = join(dir, 'report.md')
    const backup = join(dir, 'backup.json')
    const drifted = runRetire(state, report, backup)
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('draft-1')
    expect(text).toContain('状态不一致')
  })
})
