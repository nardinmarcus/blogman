/**
 * #244 — route-level streaming proof for the REAL article page.
 *
 * Executes the actual `app/[slug]/page.tsx` PostPage server component (only
 * peripheral UI/DB are mocked) in a streaming React render. The related
 * recommendations read is a CONTROLLED DEFERRED promise: the test proves the
 * article title/body become readable while the recommendation promise is
 * still pending — only the route's Suspense boundary allows that.
 *
 * The whole body-streaming phase is raced with a single 5s timeout measured
 * from BEFORE PostPage runs, so both a removed boundary and a top-level
 * await-related regression fail fast (RED) instead of hanging.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'

const SLUG = 'route-slug'

const DETAIL_ROW = {
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
    original_content: '路由正文',
    original_html: '<p>路由正文</p>',
    fields: {
      title: '路由标题',
      deleted_at: 0,
      password: null,
      is_hidden: 0,
      is_pinned: 0,
      updated_at: 1700000000,
    },
  }),
  latest_snapshot_json: null,
  post_ref: 7,
}

function makeDb() {
  return {
    prepare(sql: string) {
      const first = async () => (/sqlite_master/.test(sql) ? { name: 'formal_publications' } : DETAIL_ROW)
      const all = async () => ({ results: /sqlite_master/.test(sql) ? [] : [DETAIL_ROW] })
      const bind = () => ({ first, all, run: async () => ({}) })
      return { bind, first, all, run: async () => ({}) }
    },
    batch: async () => [],
  }
}

const { relatedGate } = vi.hoisted(() => {
  type Gate = {
    promise: Promise<unknown>
    reset: () => void
    release: () => void
  }
  const gate: Gate = {
    promise: Promise.resolve({ strategy: 'fts', source: 'rules', results: [] }),
    reset: () => {},
    release: () => {},
  }
  gate.reset = () => {
    gate.promise = new Promise<unknown>((resolve) => {
      gate.release = () =>
        resolve({
          strategy: 'fts',
          source: 'rules',
          results: [
            {
              id: 2,
              slug: 'related-post',
              title: '慢推荐标题',
              content: '',
              html: '',
              description: '慢推荐描述',
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
    })
  }
  return { relatedGate: gate }
})

vi.mock('@/lib/cloudflare', () => ({
  getAppCloudflareEnv: vi.fn(async () => ({ DB: makeDb() })),
}))

vi.mock('@/lib/related-content', () => ({
  getRelatedPosts: vi.fn(() => relatedGate.promise),
}))

vi.mock('@/lib/site', () => ({
  getSiteHeaderData: vi.fn(async () => ({
    navLinks: [],
    categories: [{ name: '分类', slug: 'fenlei' }],
    defaultTheme: 'default',
  })),
}))

// Peripheral UI: keep the page logic real, replace interactive islands.
vi.mock('@/components/SiteHeader', () => ({ SiteHeader: () => null }))
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => null }))
vi.mock('@/components/FrontPostAdminBoundary', () => ({
  FrontPostAdminBoundary: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/components/PasswordPrompt', () => ({ PasswordPrompt: () => null }))
vi.mock('@/components/CopyArticleLink', () => ({ CopyArticleLink: () => null }))
vi.mock('@/components/DownloadMarkdown', () => ({ DownloadMarkdown: () => null }))
vi.mock('@/components/TwitterEmbedsEnhancer', () => ({ TwitterEmbedsEnhancer: () => null }))
vi.mock('@/components/ArticleOutline', () => ({ ArticleOutline: () => null }))

const BODY_DEADLINE_MS = 5000

async function drainReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let html = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    html += decoder.decode(value, { stream: true })
  }
  return html
}

describe('app/[slug] — real PostPage streaming (#244)', { timeout: 120_000 }, () => {
  it('推荐未释放前标题/正文已可读；释放后推荐 UI 完整出现', async () => {
    relatedGate.reset()
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      // Phase 1: one raced promise covers EVERYTHING up to the body being
      // readable — PostPage execution (incl. top-level data reads), render,
      // and streaming chunks. The gate stays PENDING the whole time, so a
      // removed boundary / top-level related await fails within 5s (RED).
      const bodyPromise = (async () => {
        const { default: PostPage } = await import('@/app/[slug]/page')
        const element = await PostPage({
          params: Promise.resolve({ slug: SLUG }),
          searchParams: Promise.resolve({}),
        })
        const { renderToReadableStream } = await import('react-dom/server')
        const stream = await renderToReadableStream(element)
        const streamReader = stream.getReader()
        reader = streamReader
        const decoder = new TextDecoder()
        let html = ''
        for (;;) {
          const { done, value } = await streamReader.read()
          if (done) break
          html += decoder.decode(value, { stream: true })
          if (html.includes('路由标题') && html.includes('路由正文')) {
            return html
          }
        }
        throw new Error('stream ended before the article body became readable')
      })()

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const bodyHtml = await Promise.race([
        bodyPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('article body not readable within deadline while recommendations pending')),
            BODY_DEADLINE_MS,
          )
        }),
      ]).finally(() => clearTimeout(timeoutHandle))
      expect(bodyHtml).toContain('路由标题')
      expect(bodyHtml).toContain('路由正文')

      // Phase 2: release the recommendations; the boundary chunk must land.
      relatedGate.release()
      const restHtml = await drainReader(reader!)
      const full = bodyHtml + restHtml
      expect(full).toContain('继续阅读')
      expect(full).toContain('慢推荐标题')
    } finally {
      // Never leave the gate pending (a RED run must fail, not hang).
      relatedGate.release()
    }
  })
  it('header 非 migration DB 故障原样传播（不降级为空导航）', async () => {
    relatedGate.reset()
    try {
      const site = await import('@/lib/site')
      vi.mocked(site.getSiteHeaderData).mockRejectedValueOnce(new Error('D1_ERROR: connection reset by peer'))
      const { default: PostPage } = await import('@/app/[slug]/page')

      await expect(
        PostPage({
          params: Promise.resolve({ slug: SLUG }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow('connection reset by peer')
    } finally {
      relatedGate.release()
    }
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
})
