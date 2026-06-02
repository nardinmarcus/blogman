import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createPost: vi.fn(),
  updatePostBySlug: vi.fn(),
  ensureAuthenticatedRequest: vi.fn(),
  getRouteContextWithDb: vi.fn(),
  parseJsonBody: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
  nanoid: vi.fn(() => 'abc123'),
}))

vi.mock('@/lib/db', () => ({
  createPost: mocks.createPost,
  updatePostBySlug: mocks.updatePostBySlug,
}))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: mocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: mocks.parseJsonBody,
}))

vi.mock('@/lib/cache', () => ({
  invalidatePublicContentCache: mocks.invalidatePublicContentCache,
}))

vi.mock('@/lib/background-jobs', () => ({
  enqueueBackgroundJob: mocks.enqueueBackgroundJob,
}))

vi.mock('nanoid', () => ({
  nanoid: mocks.nanoid,
}))

import { PATCH, POST } from '@/app/api/posts/route'

describe('/api/posts route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRouteContextWithDb.mockResolvedValue({
      ok: true,
      env: { AI_QUEUE: {} },
      db: { kind: 'db' },
      ctx: { waitUntil: vi.fn() },
    })
    mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
    mocks.invalidatePublicContentCache.mockResolvedValue(undefined)
    mocks.enqueueBackgroundJob.mockResolvedValue(undefined)
  })

  it('creates a post with normalized payload fields and enqueues follow-up jobs', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      title: '  Ask AI 标题  ',
      content: '  正文内容  ',
      html: '<p>正文</p>',
      category: '  AI  ',
      tags: [' AI ', '', '提示词', '编辑器', '产品', '设计', '测试', '额外', '更多', '仍然', '超出'],
      description: '',
      cover_image: ' /covers/test.webp ',
      slug: 'custom_slug',
      status: 'draft',
      password: ' secret ',
      is_hidden: 1,
    })
    mocks.createPost.mockResolvedValue(42)

    const response = await POST({} as never)
    const body = await response.json()

    expect(mocks.createPost).toHaveBeenCalledWith(
      { kind: 'db' },
      expect.objectContaining({
        slug: 'custom_slug',
        title: 'Ask AI 标题',
        content: '正文内容',
        html: '<p>正文</p>',
        category: 'AI',
        status: 'draft',
        password: 'secret',
        is_hidden: 1,
        description: '正文内容',
        tags: ['AI', '提示词', '编辑器', '产品', '设计', '测试', '额外', '更多', '仍然', '超出'],
        cover_image: '/covers/test.webp',
      }),
    )
    expect(mocks.invalidatePublicContentCache).toHaveBeenCalled()
    expect(mocks.enqueueBackgroundJob).toHaveBeenCalledTimes(2)
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        id: 42,
        slug: 'custom_slug',
        category: 'AI',
      }),
    )
  })

  it('creates a post using frontmatter summary while storing clean markdown content', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      title: 'Claude design analysis',
      content: `---
title: Claude design analysis
excerpt: A concise guide to the visual system behind Claude.com.
---

# Claude design analysis

Claude.com uses warm editorial spacing.`,
      category: 'AI教程',
      status: 'published',
    })
    mocks.createPost.mockResolvedValue(43)

    const response = await POST({} as never)
    const body = await response.json()

    expect(mocks.createPost).toHaveBeenCalledWith(
      { kind: 'db' },
      expect.objectContaining({
        title: 'Claude design analysis',
        content: '# Claude design analysis\n\nClaude.com uses warm editorial spacing.',
        description: 'A concise guide to the visual system behind Claude.com.',
        category: 'AI教程',
        status: 'published',
      }),
    )
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        id: 43,
        description: 'A concise guide to the visual system behind Claude.com.',
      }),
    )
  })

  it('patches a post with fallback description and normalized next slug', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      current_slug: 'old-slug',
      new_slug: 'new_slug',
      title: '  新标题  ',
      content: '  新正文  ',
      description: '   ',
      status: 'draft',
      cover_image: '/covers/next.webp',
    })

    const response = await PATCH({} as never)
    const body = await response.json()

    expect(mocks.updatePostBySlug).toHaveBeenCalledWith(
      { kind: 'db' },
      'old-slug',
      expect.objectContaining({
        slug: 'new_slug',
        title: '  新标题  ',
        content: '  新正文  ',
        description: '新正文',
        status: 'draft',
        cover_image: '/covers/next.webp',
      }),
    )
    expect(body).toEqual({ success: true, slug: 'new_slug' })
  })

  it('patches a post using frontmatter summary while storing clean markdown content', async () => {
    mocks.parseJsonBody.mockResolvedValue({
      current_slug: 'old-slug',
      content: `---
abstract: Patch route summary.
---

# Patch Route

Clean body.`,
      description: '   ',
    })

    const response = await PATCH({} as never)

    expect(mocks.updatePostBySlug).toHaveBeenCalledWith(
      { kind: 'db' },
      'old-slug',
      expect.objectContaining({
        content: '# Patch Route\n\nClean body.',
        description: 'Patch route summary.',
      }),
    )
    expect(await response.json()).toEqual({ success: true, slug: 'old-slug' })
  })
})
