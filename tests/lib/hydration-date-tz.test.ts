/**
 * #245 — public date rendering must be time-zone deterministic (SSR = client).
 *
 * Production workerd renders in UTC while a UTC+8 browser shifts any
 * timestamp crossing local midnight (proven on production: SSR "2026年9月9日"
 * vs hydrated "2026年9月10日"). All public formatters in lib/public-date pin
 * Asia/Shanghai via formatToParts.
 *
 * RED capability: the bundled helper module is executed under TZ=UTC and
 * TZ=Asia/Shanghai child processes. For the chosen timestamps the two zones
 * disagree on the calendar day/year; before the fix the formatter followed
 * the process zone (different outputs), after the fix both runs return the
 * exact Asia/Shanghai value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const repoRoot = process.cwd()

// 1700000000 = 2023-11-14T22:13:20Z → UTC day 2023-11-14, UTC+8 day 2023-11-15.
const BOUNDARY_TS = 1700000000
// 1704042000 = 2023-12-31T17:00:00Z → UTC year 2023, UTC+8 year/day 2024-01-01.
const CROSS_YEAR_TS = 1704042000

interface Case {
  helper: string
  ts: number
  /** Exact Asia/Shanghai output. */
  expected: string
}

const CASES: Case[] = [
  { helper: 'formatDate', ts: BOUNDARY_TS, expected: '2023年11月15日' },
  { helper: 'formatDate', ts: CROSS_YEAR_TS, expected: '2024年1月1日' },
  { helper: 'formatDateLong', ts: BOUNDARY_TS, expected: '2023年11月15日' },
  { helper: 'formatDateLong', ts: CROSS_YEAR_TS, expected: '2024年1月1日' },
  { helper: 'formatDateShort', ts: BOUNDARY_TS, expected: '11.15' },
  { helper: 'formatDateShort', ts: CROSS_YEAR_TS, expected: '01.01' },
  { helper: 'formatYear', ts: BOUNDARY_TS, expected: '2023' },
  { helper: 'formatYear', ts: CROSS_YEAR_TS, expected: '2024' },
  { helper: 'formatDateCompact', ts: BOUNDARY_TS, expected: '2023-11-15' },
  { helper: 'formatDateCompact', ts: CROSS_YEAR_TS, expected: '2024-01-01' },
]

let outDir: string | null = null

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'blogman-245-tz-'))
  await build({
    entryPoints: [join(repoRoot, 'lib', 'public-date.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(outDir, 'public-date.mjs'),
    logLevel: 'silent',
  })
}, 300_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

function runHelper(helper: string, ts: number, tz: string): { out: string; ok: boolean; stderr: string } {
  const entry = join(outDir!, 'entry.mjs')
  writeFileSync(
    entry,
    `import { ${helper} } from './public-date.mjs'\nconsole.log(JSON.stringify(String(${helper}(${ts}))))\n`,
  )
  const result = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: outDir!,
    env: { ...process.env, TZ: tz, NODE_ENV: 'production' },
  })
  const line = result.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return { out: line ? (JSON.parse(line) as string) : '', ok: result.status === 0, stderr: result.stderr }
}

describe('#245 public date helpers are TZ-deterministic', { timeout: 600_000 }, () => {
  for (const c of CASES) {
    it(`${c.helper}(${c.ts}) → "${c.expected}"，与进程时区无关`, () => {
      const utc = runHelper(c.helper, c.ts, 'UTC')
      const cst = runHelper(c.helper, c.ts, 'Asia/Shanghai')
      expect(utc.ok, `UTC run failed: ${utc.stderr}`).toBe(true)
      expect(cst.ok, `Asia/Shanghai run failed: ${cst.stderr}`).toBe(true)
      expect(cst.out).toBe(c.expected)
      expect(utc.out).toBe(c.expected)
    })
  }
})
