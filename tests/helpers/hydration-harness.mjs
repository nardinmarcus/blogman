/**
 * #245 — actual hydrateRoot harness against the REAL HomeDefault component.
 *
 * Architecture (spawned by tests/lib/hydration-hydration.test.ts):
 *   - this helper runs under TZ=Asia/Shanghai (the "browser" side);
 *   - server HTML is produced by child processes with an EXPLICIT TZ per
 *     case (renderToReadableStream via react-dom/server, REAL HomeDefault);
 *   - client hydration happens in-process against jsdom (HTML5 parser, same
 *     anchor-nesting rules as browsers) with onRecoverableError collection
 *     and a useEffect commit signal bounded by a timeout — "no errors"
 *     before the commit signal fails instead of passing;
 *   - non-target shells (SiteHeader/SiteFooter/Pagination) are stubbed via
 *     esbuild alias only; the card, next/link and React are untouched.
 *
 * Cases (no git-history dependency at runtime):
 *   A  with category,    server TZ = client TZ → structural regression: 0 errors
 *   B  no category,      server TZ = UTC, client Asia/Shanghai → TZ regression: 0 errors
 *   C  positive control: case A's HTML with a mutated date → collector MUST fire (≥1)
 *   D  optional baseline: when HYDRATION_BASELINE_FILE (a pre-fix HomeDefault
 *      source saved outside the repo) is provided, run case A against it and
 *      record the error count in the summary (recorded, not gated).
 */

import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const BOUNDARY_TS = 1700000000 // UTC 2023-11-14, Asia/Shanghai 2023-11-15

import { mkdirSync } from 'node:fs'
mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true })
const tmp = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'b245-hydration-'))
function finish(ok, summary) {
  rmSync(tmp, { recursive: true, force: true })
  console.log(JSON.stringify({ ok, ...summary }))
  process.exit(ok ? 0 : 1)
}

writeFileSync(
  join(tmp, 'shell-stub.mjs'),
  'export function SiteHeader() { return null }\nexport function SiteFooter() { return null }\nexport function Pagination() { return null }\n',
)

function props(withCategory) {
  return `{
    initialTheme: 'default',
    posts: [{
      id: 1, articleId: 1, slug: 'hydration-post', version: 1,
      lifecycle: 'published', live: true, status: 'published', deleted_at: null,
      title: '水合标题', content: '正文', html: '<p>正文</p>', description: '描述',
      category: ${withCategory ? "'Engineering'" : 'null'}, tags: [], password: null,
      is_pinned: 0, is_hidden: 0, cover_image: null,
      first_published_at: ${BOUNDARY_TS}, published_at: ${BOUNDARY_TS},
      updated_at: ${BOUNDARY_TS}, view_count: 0,
    }],
    categories: [{ name: 'Engineering', slug: 'engineering' }],
    navLinks: [],
    currentPage: 1,
    totalPages: 1,
    categorySlugMap: { Engineering: 'engineering' },
  }`
}

const COMMON_BUILD = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  logLevel: 'silent',
  absWorkingDir: repoRoot,
  alias: {
    '@/components/SiteHeader': join(tmp, 'shell-stub.mjs'),
    '@/components/SiteFooter': join(tmp, 'shell-stub.mjs'),
    '@/components/Pagination': join(tmp, 'shell-stub.mjs'),
  },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
}

/** SSR the REAL component in a child process with the given TZ. */
async function serverRender(label, componentFile, withCategory, tz) {
  const entry = join(tmp, `${label}-ssr-entry.mjs`)
  writeFileSync(
    entry,
    `import { createElement } from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { HomeDefault } from '${componentFile}'
const tree = createElement('div', null, createElement(HomeDefault, ${props(withCategory)}))
const stream = await renderToReadableStream(tree)
const reader = stream.getReader()
const decoder = new TextDecoder()
let out = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  out += decoder.decode(value, { stream: true })
}
console.log(JSON.stringify(out))
`,
  )
  const bundle = join(tmp, `${label}-ssr.mjs`)
  await build({ entryPoints: [entry], outfile: bundle, ...COMMON_BUILD })
  const result = spawnSync(process.execPath, [bundle], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TZ: tz, NODE_ENV: 'production' },
  })
  if (result.status !== 0) throw new Error(`SSR failed (${label}): ${result.stderr.slice(0, 400)}`)
  const line = result.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return JSON.parse(line)
}

/** Client bundle: hydrates with the same REAL component and baked props. */
async function bundleClient(label, componentFile, withCategory) {
  const entry = join(tmp, `${label}-client-entry.mjs`)
  writeFileSync(
    entry,
    `import { createElement, useEffect } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { HomeDefault } from '${componentFile}'
function CommitMarker() {
  useEffect(() => { window.__committed = true }, [])
  return null
}
export async function hydrate(html) {
  const container = document.body
  container.innerHTML = html
  const errors = []
  const root = hydrateRoot(
    container,
    createElement('div', null,
      createElement(CommitMarker),
      createElement(HomeDefault, ${props(withCategory)}),
    ),
    { onRecoverableError: (error) => errors.push(String(error)) },
  )
  const deadline = Date.now() + 5000
  while (!window.__committed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const committed = Boolean(window.__committed)
  window.__committed = false
  root.unmount()
  return { errors: errors.slice(0, 3), errorCount: errors.length, committed }
}
`,
  )
  const bundle = join(tmp, `${label}-client.mjs`)
  await build({ entryPoints: [entry], outfile: bundle, ...COMMON_BUILD })
  return bundle
}

/** Browser side: jsdom-parse `html`, hydrate with the given client bundle. */
async function hydrateInBrowser(label, html) {
  const dom = new JSDOM(html)
  const win = dom.window
  for (const key of ['self', 'window', 'document', 'location', 'Document', 'Element', 'Node', 'HTMLElement', 'SVGElement', 'Text', 'Comment']) {
    globalThis[key] = win[key]
  }
  try {
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
  } catch {
    // Node ≥21 exposes a getter-only navigator — the built-in one suffices.
  }
  const { hydrate } = await import(join(tmp, `${label}-client.mjs`))
  const summary = await hydrate(win.document.body.innerHTML)
  win.close()
  return summary
}

async function runCase(label, componentFile, withCategory, ssrTz) {
  const html = await serverRender(label, componentFile, withCategory, ssrTz)
  const clientBundle = await bundleClient(label, componentFile, withCategory)
  // hydrateInBrowser re-imports the SAME bundle path — pre-import to fail fast.
  await import(clientBundle)
  return hydrateInBrowser(label, html)
}

try {
  const currentFile = join(repoRoot, 'components', 'themes', 'HomeDefault.tsx')

  // A — with category, same TZ: the nested-anchor regression (fixed → 0).
  const caseA = await runCase('caseA', currentFile, true, 'Asia/Shanghai')
  if (!(caseA.committed && caseA.errorCount === 0)) {
    finish(false, { failedCase: 'A', caseA })
  }

  // B — no category, server UTC vs client Asia/Shanghai: the TZ regression (fixed → 0).
  const caseB = await runCase('caseB', currentFile, false, 'UTC')
  if (!(caseB.committed && caseB.errorCount === 0)) {
    finish(false, { failedCase: 'B', caseB })
  }

  // C — positive control: case A HTML with a mutated server date; the
  // collector MUST fire or it is broken.
  const controlHtml = (await serverRender('caseC', currentFile, true, 'Asia/Shanghai')).replace(
    /<time>[^<]*<\/time>/,
    '<time>9999年99月99日</time>',
  )
  const clientBundleC = await bundleClient('caseC', currentFile, true)
  await import(clientBundleC)
  const caseC = await hydrateInBrowser('caseC', controlHtml)
  if (caseC.errorCount === 0) {
    finish(false, { failedCase: 'C', caseC, note: 'positive control did not error — collector broken' })
  }

  // D — optional pre-fix baseline (test-only input saved OUTSIDE the repo).
  let baseline
  const baselineInput = process.env.HYDRATION_BASELINE_FILE
  if (baselineInput) {
    // Copy the external baseline into the in-repo temp dir so bare imports
    // (next/link) resolve; the original stays untouched outside the repo.
    const { readFileSync } = await import('node:fs')
    const baselineFile = join(tmp, 'HomeDefault-baseline.tsx')
    writeFileSync(baselineFile, readFileSync(baselineInput, 'utf8'))
    const clientBundleNested = await bundleClient('caseD', baselineFile, true)
    await import(clientBundleNested)
    const nestedHtml = await serverRender('caseD', baselineFile, true, 'Asia/Shanghai')
    const nested = await hydrateInBrowser('caseD', nestedHtml)
    const clientBundleDate = await bundleClient('caseDdate', baselineFile, false)
    await import(clientBundleDate)
    const dateHtml = await serverRender('caseDdate', baselineFile, false, 'UTC')
    const dateOnly = await hydrateInBrowser('caseDdate', dateHtml)
    baseline = { nested, dateOnly }
  }

  finish(true, { caseA, caseB, caseCErrorCount: caseC.errorCount, ...(baseline ? { baseline } : {}) })
} catch (error) {
  finish(false, { error: error instanceof Error ? error.message : String(error) })
}
