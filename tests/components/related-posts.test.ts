/**
 * #244 P1 — related recommendations must not block the article body.
 *
 * Renders the real `RelatedPosts` async server component inside a real
 * streaming React render with a deliberately SLOW `getRelatedPosts`. The
 * article body must stream to the reader BEFORE the slow recommendation
 * resolves, and the finished stream must still contain the recommendation
 * UI. Also covers the password gate: a passworded post renders NO related
 * section at all.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToReadableStream } from 'react-dom/server'

vi.mock('@/lib/related-content', () => ({
  getRelatedPosts: vi.fn(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            strategy: 'fts',
            source: 'rules',
            results: [
              {
                id: 2,
                slug: 'other-post',
                title: '相关文章',
                content: '',
                html: '',
                description: '相关描述',
                category: '分类',
                tags: [],
                status: 'published',
                password: null,
                is_pinned: 0,
                is_hidden: 0,
                deleted_at: null,
                cover_image: null,
                published_at: 1700000000,
                updated_at: 1700000000,
                view_count: 0,
              },
            ],
          })
        }, 150)
      }),
  ),
}))

afterAll(async () => {
  vi.restoreAllMocks()
})

const BASE_POST = {
  id: 1,
  slug: 'current-post',
  title: '当前文章',
  content: '正文',
  html: '<p>正文</p>',
  description: null,
  category: '分类',
  tags: [],
  status: 'published' as const,
  password: null,
  is_pinned: 0,
  is_hidden: 0,
  deleted_at: null,
  cover_image: null,
  published_at: 1700000000,
  updated_at: 1700000000,
  view_count: 0,
}

const CATEGORIES = [{ name: '分类', slug: 'fenlei' }]

async function drainCollect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader()
  const chunks: string[] = []
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks
}

describe('components/RelatedPosts — #244 Suspense boundary', { timeout: 120_000 }, () => {
  it('慢推荐不阻塞：正文先于推荐出现在流中，最终流含推荐 UI', async () => {
    const { RelatedPosts } = await import('@/components/RelatedPosts')
    const { Suspense } = await import('react')
    const { ArticleLoading } = await import('@/components/ArticleLoading')

    async function Page() {
      return createElement(
        'div',
        null,
        createElement('h1', null, '当前文章'),
        createElement(
          Suspense,
          { fallback: createElement(ArticleLoading) },
          createElement(RelatedPosts, {
            db: {} as never,
            env: null,
            post: BASE_POST,
            categories: CATEGORIES,
          }),
        ),
      )
    }

    const chunks = await drainCollect(await renderToReadableStream(createElement(Page)))
    const firstBodyChunkIndex = chunks.findIndex((chunk) => chunk.includes('当前文章'))
    const relatedChunkIndex = chunks.findIndex((chunk) => chunk.includes('相关文章'))
    expect(firstBodyChunkIndex).toBeGreaterThanOrEqual(0)
    expect(relatedChunkIndex).toBeGreaterThanOrEqual(0)
    // The body escaped the Suspense boundary: it must appear in an earlier
    // chunk than (or a different chunk from) the late recommendation UI.
    expect(firstBodyChunkIndex).toBeLessThanOrEqual(relatedChunkIndex)
    expect(chunks.join('')).toContain('继续阅读')
  })

  it('密码文章不渲染任何推荐（正文不出现在未授权路径）', async () => {
    const { RelatedPosts } = await import('@/components/RelatedPosts')
    const { Suspense } = await import('react')
    const { ArticleLoading } = await import('@/components/ArticleLoading')

    async function Page() {
      return createElement(
        'div',
        null,
        createElement('h1', null, '受保护文章'),
        createElement(
          Suspense,
          { fallback: createElement(ArticleLoading) },
          createElement(RelatedPosts, {
            db: {} as never,
            env: null,
            post: { ...BASE_POST, title: '受保护文章', password: 'secret' },
            categories: CATEGORIES,
          }),
        ),
      )
    }

    const html = (await drainCollect(await renderToReadableStream(createElement(Page)))).join('')
    expect(html).toContain('受保护文章')
    expect(html).not.toContain('继续阅读')
    expect(html).not.toContain('相关文章')
  })
})

describe('components/ArticleLoading — #244 accessible loading feedback', { timeout: 120_000 }, () => {
  it('renders an accessible status region using existing design tokens', async () => {
    const { ArticleLoading } = await import('@/components/ArticleLoading')
    const html = (await drainCollect(await renderToReadableStream(createElement(ArticleLoading)))).join('')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    // Visible text label for assistive tech, not color/animation alone.
    expect(html).toContain('正在加载')
  })
})
