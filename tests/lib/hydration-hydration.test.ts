/**
 * #245 — real-component hydration regression (actual hydrateRoot).
 *
 * Spawns tests/helpers/hydration-harness.mjs, which server-renders the REAL
 * HomeDefault in child processes with explicit per-case TZ and hydrates it
 * in jsdom under TZ=Asia/Shanghai with onRecoverableError + a useEffect
 * commit signal:
 *   - A: with category, same TZ → 0 errors (nested-anchor regression guarded),
 *   - B: no category, server UTC vs client UTC+8 → 0 errors (TZ regression guarded),
 *   - C: positive control (mutated server date) → collector MUST fire (≥1).
 *
 * Shell components (SiteHeader/SiteFooter/Pagination) are stubbed via esbuild
 * alias; the card, next/link and React are untouched. A pre-fix baseline
 * component saved outside the repo can be recorded via HYDRATION_BASELINE_FILE
 * (recorded in the summary, not gated — CI checkouts have no git history).
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const repoRoot = process.cwd()
const harness = join(repoRoot, 'tests', 'helpers', 'hydration-harness.mjs')

interface CaseSummary {
  errors: string[]
  errorCount: number
  committed: boolean
}

interface HarnessSummary {
  ok: boolean
  error?: string
  failedCase?: string
  caseA?: CaseSummary
  caseB?: CaseSummary
  caseCErrorCount?: number
  baseline?: { nested?: CaseSummary; dateOnly?: CaseSummary }
}

describe('#245 real HomeDefault hydrateRoot (explicit TZ per side)', { timeout: 600_000 }, () => {
  it('A 同TZ有分类 0 错误；B UTC→Shanghai 无分类 0 错误；C positive control ≥1', () => {
    const result = spawnSync(process.execPath, [harness], {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: repoRoot,
      env: { ...process.env, TZ: 'Asia/Shanghai', NODE_ENV: 'production' },
    })
    expect(result.status, `harness exited ${result.status}: ${result.stderr.slice(0, 400)}`).toBe(0)
    expect(result.stderr.trim(), 'harness stderr should be empty').toBe('')
    const line = result.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    let summary: HarnessSummary
    try {
      summary = JSON.parse(line) as HarnessSummary
    } catch {
      throw new Error(
        `harness did not emit JSON. exit=${result.status}\nstdout=${result.stdout.slice(0, 400)}\nstderr=${result.stderr.slice(0, 500)}`,
      )
    }
    expect(summary.ok, `harness failed: ${JSON.stringify(summary).slice(0, 600)}`).toBe(true)
    expect(summary.caseA?.committed).toBe(true)
    expect(summary.caseA?.errorCount).toBe(0)
    expect(summary.caseB?.committed).toBe(true)
    expect(summary.caseB?.errorCount).toBe(0)
    expect(summary.caseCErrorCount).toBeGreaterThanOrEqual(1)
  })
})
