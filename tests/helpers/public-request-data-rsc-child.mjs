/**
 * #244 P1 — RSC child harness for real server-render dedup proof.
 *
 * Built by the parent test with esbuild (`conditions: ['react-server']`,
 * full bundling — react and the Next RSC runtime are compiled IN, so the
 * child has no runtime bare-import resolution at all).
 *
 * The harness renders a real async server component in INDEPENDENT request
 * renders. Render 1 and render 2 REUSE THE SAME DB binding object while the
 * canned row's title changes between renders — this rules out a global
 * per-DB cache: render 2 must re-execute the reads and surface the NEW
 * value. A different DB binding inside ONE render resolves independently.
 * React cache itself is never mocked.
 *
 * Emits one JSON line on stdout:
 *   { ok, error?, render1Selects, render2Selects, dbBSelects,
 *     render1SettingSelects, render1ProbeSelects, render2SettingSelects,
 *     title1, title2 }
 */

import { PassThrough } from 'node:stream'
import { cache, createElement } from 'react'
// The compiled RSC server runtime that Next.js itself uses.
import { renderToPipeableStream } from 'next/dist/compiled/react-server-dom-webpack/server.node'
import {
  getPublicArticleForRequest,
  getPublicSettingForRequest,
  canonicalFactsAvailableForRequest,
  canonicalFactsAvailableStrictForRequest,
} from '../../lib/public-request-data.ts'
import { getSiteHeaderData } from '../../lib/site.ts'

const SLUG = 'hello'

function detailRow(title) {
  return {
    reg_kind: 'current',
    reg_article_id: 1,
    reg_current_slug: SLUG,
    article_id: 1,
    version: 1,
    slug: SLUG,
    lifecycle: 'published',
    first_published_at: 1700000000,
    published_at: 1700000000,
    snapshot_json: JSON.stringify({
      original_content: '正文',
      original_html: '<p>正文</p>',
      fields: { title, deleted_at: 0, password: null, is_hidden: 0, is_pinned: 0, updated_at: 1700000000 },
    }),
    latest_snapshot_json: null,
    post_ref: 7,
  }
}

/** Minimal counting DB stub: schema probe present + one mutable detail row. */
function makeCountingDb(initialTitle) {
  const selects = []
  let row = detailRow(initialTitle)
  let themeValue = 'default'
  return {
    selects,
    setDetailTitle(title) {
      row = detailRow(title)
    },
    setThemeValue(value) {
      themeValue = value
    },
    countByPattern(pattern) {
      return selects.filter((sql) => sql.includes(pattern)).length
    },
    prepare(sql) {
      const isSelect = /^\s*(SELECT|WITH)\b/i.test(sql)
      if (isSelect) selects.push(sql)
      let first
      if (/sqlite_master/.test(sql)) first = async () => ({ name: 'formal_publications' })
      else if (/site_settings/.test(sql)) first = async () => ({ value: themeValue })
      else first = async () => row
      const all = async () => {
        if (/sqlite_master/.test(sql)) return { results: [] }
        if (/site_settings/.test(sql)) return { results: [{ key: 'default_theme', value: themeValue }] }
        return { results: [row] }
      }
      const bind = () => ({ first, all, run: async () => ({}) })
      return { bind, first, all, run: async () => ({}) }
    },
    batch: async () => [],
  }
}

async function renderOnce(db, expectedTitle, extraDb) {
  async function RequestComponent() {
    // Mirrors the REAL production request chain (#244): root layout settings
    // (custom_js/body_font/default_theme) + site header (nav_links,
    // default_theme, categories incl. category_order probe) + metadata/page
    // article resolution + related/search canonical probes — ONE render.
    const calls = [
      getPublicArticleForRequest(db, SLUG),
      getPublicArticleForRequest(db, SLUG),
      getPublicSettingForRequest(db, 'custom_js'),
      getPublicSettingForRequest(db, 'body_font'),
      getPublicSettingForRequest(db, 'default_theme'),
      getPublicSettingForRequest(db, 'nav_links'),
      getSiteHeaderData(db),
      getPublicArticleForRequest(db, SLUG),
      canonicalFactsAvailableForRequest(db),
      canonicalFactsAvailableStrictForRequest(db),
    ]
    // A different DB binding in the SAME render must resolve independently.
    const extraCall = extraDb ? getPublicArticleForRequest(extraDb, SLUG) : null
    if (extraCall) calls.push(extraCall)
    const settled = await Promise.all(calls)
    const first = settled[0]
    if (first?.article?.title !== expectedTitle) {
      throw new Error(`expected title ${expectedTitle}, got ${first?.article?.title}`)
    }
    const theme = settled[4]
    if (typeof theme !== 'string' && theme !== null) {
      throw new Error(`setting read failed: ${String(theme)}`)
    }
    const header = settled[6]
    if (!header || typeof header.defaultTheme !== 'string') {
      throw new Error(`header data failed: ${JSON.stringify(header)}`)
    }
    if (extraCall) {
      const other = settled[10]
      if (other?.article?.title !== expectedTitle) {
        throw new Error(`extra db expected title ${expectedTitle}, got ${other?.article?.title}`)
      }
    }
    return createElement('p', null, String(first?.article?.title))
  }

  const selectsBefore = db.selects.length
  let rendered = ''
  const { pipe } = renderToPipeableStream(createElement(RequestComponent), {
    onError(error) {
      throw error
    },
  })
  const sink = new PassThrough()
  const done = new Promise((resolve, reject) => {
    sink.on('data', (chunk) => {
      rendered += String(chunk)
    })
    sink.on('end', resolve)
    sink.on('error', reject)
  })
  pipe(sink)
  await done
  if (!rendered.includes(expectedTitle)) throw new Error(`render output missing title: ${rendered.slice(0, 200)}`)
  return db.selects.length - selectsBefore
}

try {
  if (cache === undefined) throw new Error('react cache unavailable')

  // ONE DB binding across two independent request renders.
  const db = makeCountingDb('你好')
  const dbB = makeCountingDb('你好')
  const render1Selects = await renderOnce(db, '你好', dbB)
  const dbBSelects = dbB.selects.length

  // Slice 4: within render 1 the settings read and the canonical probe were
  // each executed exactly once despite multiple callers.
  const render1SettingSelects = db.countByPattern('site_settings')
  const render1ProbeSelects = db.countByPattern('sqlite_master')

  // Same binding, changed facts: render 2 must RE-READ and show the new value
  // (no cross-request stale cache, no global per-DB object cache).
  db.setDetailTitle('再见')
  db.setThemeValue('sepia')
  const render2Selects = await renderOnce(db, '再见')
  const render2SettingSelects = db.countByPattern('site_settings') - render1SettingSelects

  process.stdout.write(
    JSON.stringify({
      ok: true,
      render1Selects,
      render2Selects,
      dbBSelects,
      render1SettingSelects,
      render1ProbeSelects,
      render2SettingSelects,
      title1: '你好',
      title2: '再见',
    }) + '\n',
  )
  process.exit(0)
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n',
  )
  process.exit(1)
}
