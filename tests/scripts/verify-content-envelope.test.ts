import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const verifyPath = join(repoRoot, 'scripts', 'verify-content-envelope.mjs')
const stateDirectories: string[] = []

function createState(): string {
  const state = mkdtempSync(join(tmpdir(), 'blogman-envelope-verify-'))
  stateDirectories.push(state)
  return state
}

afterEach(() => {
  for (const state of stateDirectories.splice(0)) rmSync(state, { recursive: true, force: true })
})

describe('verify-content-envelope fidelity pass', () => {
  it('produces a fidelity report over the seeded sample matrix', { timeout: 600_000 }, () => {
    const persistTo = join(createState(), 'd1')
    const report = join(createState(), 'report.md')

    const result = spawnSync(process.execPath, [
      '--import', 'tsx', verifyPath,
      '--persist-to', persistTo,
      '--report', report,
    ], { cwd: repoRoot, encoding: 'utf8' })

    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toMatch(/equivalent \/ \d+ degraded \/ \d+ mismatch/)
    expect(existsSync(report)).toBe(true)

    const content = readFileSync(report, 'utf8')
    expect(content).toContain('## 汇总')
    expect(content).toContain('等价 equivalent')
    expect(content).toContain('本次是否 seed 代表性样本矩阵: 是')
    expect(content).toContain('边界说明')
    expect(content).toContain('sample-heading')
    expect(content).toContain('sample-marks')
  })
})
