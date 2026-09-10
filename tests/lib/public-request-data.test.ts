/**
 * #244 P1 — request-scoped dedup for metadata/body article resolution.
 *
 * Proves dedup in a REAL server render context: a child process runs under
 * `node --conditions=react-server` and renders an async server component with
 * the compiled RSC runtime Next.js itself uses. The component calls the actual
 * production request module (`lib/public-request-data.ts`) twice per request
 * (the generateMetadata + PostPage shape). `React.cache` itself is NOT mocked.
 *
 * Assertions:
 *   - one request render → the two same-slug calls collapse into ≤2 SELECTs
 *     (schema probe + one fact read),
 *   - a second independent render re-executes the reads (no cross-request
 *     stale cache bleed).
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const repoRoot = process.cwd()
const childPath = join(repoRoot, 'tests', 'helpers', 'public-request-data-rsc-child.mjs')

interface HarnessResult {
  ok: boolean
  error?: string
  render1Selects?: number
  render2Selects?: number
  dbBSelects?: number
  render1SettingSelects?: number
  render1ProbeSelects?: number
  render2SettingSelects?: number
  title1?: string
  title2?: string
}

describe('lib/public-request-data — real RSC render dedup (#244)', { timeout: 300_000 }, () => {
  it('同一请求内 metadata/body 去重；跨请求与跨 DB 不残留缓存', async () => {
    // Bundle the child with esbuild: `react-server` condition is applied at
    // bundle time and react + the Next RSC runtime are compiled IN, so the
    // child needs no runtime bare-import resolution (tsx is NOT a declared
    // dependency — esbuild is).
    const outDir = mkdtempSync(join(tmpdir(), 'blogman-244-rsc-child-'))
    const bundlePath = join(outDir, 'rsc-child.mjs')
    try {
      await build({
        entryPoints: [childPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        conditions: ['react-server'],
        outfile: bundlePath,
        logLevel: 'silent',
        banner: {
          js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
      })
    } catch (error) {
      rmSync(outDir, { recursive: true, force: true })
      throw error
    }

    let parsed: HarnessResult
    try {
      const result = spawnSync(process.execPath, [bundlePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 240_000,
      })
      const stdoutLine = result.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      try {
        parsed = JSON.parse(stdoutLine) as HarnessResult
      } catch {
        throw new Error(
          `harness did not emit JSON. exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
        )
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
    if (!parsed.ok) {
      throw new Error(`harness failed: ${parsed.error}`)
    }

    // Slice 4 (rev): the WHOLE request chain — layout settings (3 keys) +
    // header (nav_links/default_theme/categories incl. category_order) +
    // canonical probes + article detail — costs ONE parameterized settings
    // SELECT, ONE schema probe, ONE categories SELECT, ONE detail read.
    expect(parsed.render1Selects).toBeLessThanOrEqual(4)
    expect(parsed.render1SettingSelects).toBe(1)
    expect(parsed.render1ProbeSelects).toBe(1)
    // And the second render re-reads settings (no cross-request bleed).
    expect(parsed.render2SettingSelects).toBe(1)
    // Same DB binding, changed data → render 2 re-executes the reads and
    // shows the NEW title (no cross-request stale cache, no per-DB cache).
    expect(parsed.render2Selects).toBeGreaterThanOrEqual(1)
    expect(parsed.render2Selects).toBeLessThanOrEqual(4)
    expect(parsed.title2).toBe('再见')
    // A different DB binding in the same render resolved independently.
    expect(parsed.dbBSelects).toBeGreaterThanOrEqual(1)
    // Slice 4 (rev): the WHOLE request chain — layout settings (3 keys) +
    // header (nav_links/default_theme/categories) + canonical probes — costs
    // exactly ONE parameterized settings SELECT and ONE schema probe.
    expect(parsed.render1SettingSelects).toBe(1)
    expect(parsed.render1ProbeSelects).toBe(1)
    // And the second render re-reads settings (no cross-request bleed).
    expect(parsed.render2SettingSelects).toBe(1)
  })
})
