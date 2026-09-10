/**
 * #245 — HomeDefault must not render anchors inside anchors.
 *
 * The article card wraps the whole entry (title, description, time AND the
 * category chip) in one <Link>, and the category chip is its own <Link> —
 * producing nested <a>…<a>…</a></a> in SSR HTML. The HTML5 parser cannot
 * nest anchors: it flattens the structure (proven via DOMParser: the inner
 * category anchor lands OUTSIDE the outer one), so React hydration sees a
 * different tree → "Minified React error #418; args[]=HTML".
 *
 * Contract: rendered HTML contains BOTH the article and the category as
 * independent anchors (keyboard/click navigation preserved), and no anchor
 * is nested inside another anchor.
 */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToReadableStream } from 'react-dom/server'

const FIXTURE_POST = {
  id: 1,
  slug: 'hydration-post',
  title: '水合测试标题',
  content: '正文',
  html: '<p>正文</p>',
  description: '描述',
  category: 'Engineering',
  tags: [],
  status: 'published' as const,
  password: null,
  is_pinned: 1,
  is_hidden: 0,
  deleted_at: null,
  cover_image: null,
  published_at: 1700000000,
  updated_at: 1700000000,
  view_count: 0,
}

const PROPS = {
  initialTheme: 'default' as const,
  posts: [FIXTURE_POST],
  categories: [{ name: 'Engineering', slug: 'engineering' }],
  navLinks: [],
  currentPage: 1,
  totalPages: 1,
  categorySlugMap: { Engineering: 'engineering' },
}

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

/** Scan rendered HTML: report every anchor that opens while another is open. */
function findNestedAnchors(html: string): number {
  let depth = 0
  let nested = 0
  const tagRe = /<\/?a\b[^>]*>/gi
  for (const match of html.matchAll(tagRe)) {
    if (match[0].startsWith('</')) depth = Math.max(0, depth - 1)
    else {
      if (depth > 0) nested += 1
      depth += 1
    }
  }
  return nested
}

describe('#245 HomeDefault anchor structure', { timeout: 120_000 }, () => {
  it('渲染 HTML 无嵌套 <a>；文章与分类为独立可导航锚点', async () => {
    const { HomeDefault } = await import('@/components/themes/HomeDefault')
    const html = await drain(await renderToReadableStream(createElement(HomeDefault, PROPS)))

    expect(findNestedAnchors(html)).toBe(0)
    expect(html).toContain('href="/hydration-post"')
    expect(html).toContain('href="/category/engineering"')
  })
})
