/**
 * #245 — search results page must not render anchors inside anchors.
 *
 * The search page had the same illegal structure as HomeDefault: the article
 * <Link> wrapped the whole card INCLUDING the category <Link>, so the HTML5
 * parser flattened the nesting and React hydration failed (#418).
 *
 * Renders the REAL page component (next/link and React untouched; the
 * DB/env boundary and non-target shells are mocked) with the same scanner used for
 * HomeDefault: zero nested anchors, both the article and the category
 * exposed as independent anchors.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { renderToReadableStream } from 'react-dom/server'

vi.mock('@/lib/cloudflare', () => ({
  getAppCloudflareEnv: vi.fn(async () => ({ DB: {} as never })),
}))

vi.mock('@/lib/public-read', () => ({
  searchPublicArticles: vi.fn(async () => [
    {
      id: 1,
      articleId: 1,
      slug: 'search-hit',
      version: 1,
      lifecycle: 'published' as const,
      live: true,
      status: 'published' as const,
      deleted_at: null,
      title: '搜索命中',
      content: '正文',
      html: '<p>正文</p>',
      description: '描述',
      category: 'Engineering',
      tags: [],
      password: null,
      is_pinned: 0,
      is_hidden: 0,
      cover_image: null,
      first_published_at: 1700000000,
      published_at: 1700000000,
      updated_at: 1700000000,
      view_count: 0,
    },
  ]),
}))

vi.mock('@/lib/site', () => ({
  getSiteHeaderData: vi.fn(async () => ({
    navLinks: [],
    categories: [{ name: 'Engineering', slug: 'engineering' }],
    defaultTheme: 'default' as const,
  })),
}))

vi.mock('@/components/SiteHeader', () => ({ SiteHeader: () => null }))
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => null }))

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let html = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    html += decoder.decode(value, { stream: true })
  }
  return html
}

/** Scan rendered HTML: count anchors that open while another anchor is open. */
function findNestedAnchors(html: string): number {
  let depth = 0
  let nested = 0
  for (const match of html.matchAll(/<\/?a\b[^>]*>/gi)) {
    if (match[0].startsWith('</')) depth = Math.max(0, depth - 1)
    else {
      if (depth > 0) nested += 1
      depth += 1
    }
  }
  return nested
}

describe('#245 search results page anchor structure', { timeout: 120_000 }, () => {
  it('渲染 HTML 无嵌套 <a>；文章与分类为独立可导航锚点', async () => {
    const { default: SearchPage } = await import('@/app/search/page')
    const element = await SearchPage({
      searchParams: Promise.resolve({ q: '搜索' }),
    })
    const html = await drain(await renderToReadableStream(element))

    expect(findNestedAnchors(html)).toBe(0)
    expect(html).toContain('href="/search-hit"')
    expect(html).toContain('href="/category/engineering"')
    expect(html).toContain('搜索命中')
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
})
