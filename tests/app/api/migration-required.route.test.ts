import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseMigrationRequiredError } from '@/lib/database-errors'

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  isAdminAuthenticated: vi.fn(),
  getAppCloudflareEnv: vi.fn(),
  getAppCloudflareContext: vi.fn(),
}))

vi.mock('@/lib/admin-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-auth')>('@/lib/admin-auth')
  return {
    ...actual,
    authenticateRequest: mocks.authenticateRequest,
    isAdminAuthenticated: mocks.isAdminAuthenticated,
  }
})

vi.mock('@/lib/cloudflare', () => ({
  getAppCloudflareEnv: mocks.getAppCloudflareEnv,
  getAppCloudflareContext: mocks.getAppCloudflareContext,
}))

import { GET as getSearch } from '@/app/api/search/route'
import { GET as getAppearance } from '@/app/api/settings/appearance/route'
import { GET as getEditorActions } from '@/app/api/editor/ai-actions/route'
import { ensureAuthenticatedRequest } from '@/lib/server/route-helpers'
import { GET as getTokens } from '@/app/api/admin/tokens/route'
import { GET as getTextProviders } from '@/app/api/admin/ai-provider/route'
import { GET as getImageProviders } from '@/app/api/admin/ai-image-provider/route'
import { GET as getTextActions } from '@/app/api/admin/ai-actions/route'
import { GET as getImageActions } from '@/app/api/admin/ai-image-actions/route'
import { GET as getPostGenerators } from '@/app/api/admin/ai-post-generators/route'
import { GET as getCategories } from '@/app/api/admin/categories/route'
import { PATCH as patchCategory, POST as createCategory } from '@/app/api/admin/categories/route'
import { PATCH as patchPost, POST as createPost } from '@/app/api/posts/route'
import {
  DELETE as deleteAdminPost,
  GET as getAdminPost,
  PUT as updateAdminPost,
} from '@/app/api/admin/posts/[slug]/route'
import { POST as uploadAsset } from '@/app/api/uploads/route'
import { GET as getWechatBridge } from '@/app/api/admin/wechat-bridge/route'
import { POST as publishWechat } from '@/app/api/admin/wechat-publish/route'
import { POST as runEditorAi } from '@/app/api/editor/ai/route'
import { POST as runEditorImage } from '@/app/api/editor/ai-image/route'
import { POST as runEditorPostMetadata } from '@/app/api/editor/ai-post-metadata/route'

function missingSchemaDb(
  message = 'D1_ERROR: no such table: site_settings; token=nm_private',
): D1Database {
  const failure = new Error(message)
  const statement = {
    bind: () => statement,
    first: async () => { throw failure },
    all: async () => { throw failure },
    run: async () => { throw failure },
  }
  return { prepare: () => statement } as unknown as D1Database
}

async function expectMigrationRequired(response: Response, forbidden: string[] = []) {
  expect(response.status).toBe(503)
  const body = await response.json()
  expect(body).toEqual({
    error: '数据库结构未就绪，请先运行账本迁移',
    code: 'DATABASE_MIGRATION_REQUIRED',
  })
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain('nm_private')
  expect(serialized).not.toContain('site_settings')
  for (const value of forbidden) expect(serialized).not.toContain(value)
}

describe('migration-required route responses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const db = missingSchemaDb()
    mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db })
    mocks.getAppCloudflareContext.mockResolvedValue({ env: { DB: db }, ctx: {} })
    mocks.authenticateRequest.mockResolvedValue(true)
    mocks.isAdminAuthenticated.mockResolvedValue(true)
  })

  it('returns a diagnostic 503 for public appearance reads', async () => {
    await expectMigrationRequired(await getAppearance())
  })

  it('executes the frozen smoke routes through the real cookie authentication contract', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'test-only-route-password')
    vi.stubEnv('ADMIN_TOKEN_SALT', 'test-only-route-salt')
    try {
      const statement = {
        bind: vi.fn(),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }
      statement.bind.mockReturnValue(statement)
      const db = { prepare: vi.fn(() => statement) } as unknown as D1Database
      mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db })
      mocks.getAppCloudflareContext.mockResolvedValue({ env: { DB: db }, ctx: { waitUntil: vi.fn() } })

      const auth = await vi.importActual<typeof import('@/lib/admin-auth')>('@/lib/admin-auth')
      mocks.isAdminAuthenticated.mockImplementation(auth.isAdminAuthenticated)
      mocks.authenticateRequest.mockImplementation(auth.authenticateRequest)
      const session = await auth.getSessionToken()
      expect(auth.COOKIE_NAME).toBe('blogman_admin')
      expect(session).toMatch(/^[a-f0-9]{64}$/u)

      const cookie = `${auth.COOKIE_NAME}=${session}`
      const routeCases = [
        ['/api/search', 200, () => getSearch(new NextRequest('http://test.local/api/search?q=frozen'))],
        ['/api/settings/appearance', 200, () => getAppearance()],
        ['/api/admin/tokens', 200, () => getTokens(new NextRequest('http://test.local/api/admin/tokens', { headers: { Cookie: cookie } }))],
        ['/api/admin/ai-provider', 200, () => getTextProviders(new NextRequest('http://test.local/api/admin/ai-provider', { headers: { Cookie: cookie } }))],
        ['/api/admin/ai-post-generators', 200, () => getPostGenerators(new NextRequest('http://test.local/api/admin/ai-post-generators', { headers: { Cookie: cookie } }))],
        ['/api/admin/posts/__blogman_smoke_absent__', 404, () => getAdminPost(
          new NextRequest('http://test.local/api/admin/posts/__blogman_smoke_absent__', { headers: { Cookie: cookie } }),
          { params: Promise.resolve({ slug: '__blogman_smoke_absent__' }) },
        )],
      ] as const

      const observed: Array<{ path: string, status: number }> = []
      for (const [path, expectedStatus, invoke] of routeCases) {
        const response = await invoke()
        observed.push({ path, status: response.status })
        expect(response.status).toBe(expectedStatus)
      }
      expect(observed).toEqual([
        { path: '/api/search', status: 200 },
        { path: '/api/settings/appearance', status: 200 },
        { path: '/api/admin/tokens', status: 200 },
        { path: '/api/admin/ai-provider', status: 200 },
        { path: '/api/admin/ai-post-generators', status: 200 },
        { path: '/api/admin/posts/__blogman_smoke_absent__', status: 404 },
      ])

      const unauthorized = await getTokens(new NextRequest('http://test.local/api/admin/tokens'))
      expect(unauthorized.status).toBe(401)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('returns a diagnostic 503 instead of an empty editor action fallback', async () => {
    await expectMigrationRequired(await getEditorActions())
  })

  it('returns a diagnostic 503 instead of disguising Bearer schema failure as 401', async () => {
    mocks.authenticateRequest.mockRejectedValue(new DatabaseMigrationRequiredError())
    const request = new Request('http://test.local/api/posts', {
      headers: { Authorization: 'Bearer nm_private' },
    })

    const response = await ensureAuthenticatedRequest(request as never, missingSchemaDb())
    expect(response).not.toBeNull()
    await expectMigrationRequired(response as Response)
  })

  it.each([
    ['tokens', getTokens, '/api/admin/tokens'],
    ['text providers', getTextProviders, '/api/admin/ai-provider'],
    ['image providers', getImageProviders, '/api/admin/ai-image-provider'],
    ['text actions', getTextActions, '/api/admin/ai-actions'],
    ['image actions', getImageActions, '/api/admin/ai-image-actions'],
    ['post generators', getPostGenerators, '/api/admin/ai-post-generators'],
    ['categories', getCategories, '/api/admin/categories'],
  ])('returns a fixed diagnostic 503 at the %s management boundary', async (_name, handler, path) => {
    const request = new NextRequest(`http://test.local${path}`, {
      headers: { Cookie: 'blogman_admin=session' },
    })
    await expectMigrationRequired(await handler(request))
  })

  it('returns a fixed 503 from the real article POST when the posts table is missing', async () => {
    const db = missingSchemaDb(
      'D1_ERROR: no such table: posts; token=nm_post_secret; content=private article body',
    )
    mocks.getAppCloudflareContext.mockResolvedValue({ env: { DB: db }, ctx: {} })
    const request = new NextRequest('http://test.local/api/posts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer nm_post_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Private title', content: 'private article body' }),
    })

    await expectMigrationRequired(await createPost(request), [
      'posts',
      'nm_post_secret',
      'private article body',
    ])
  })

  it('returns a fixed 503 from the real article PATCH when a posts column is missing', async () => {
    const db = missingSchemaDb(
      'D1_ERROR: no such column: posts.deleted_at; token=nm_patch_secret; content=private patch body',
    )
    mocks.getAppCloudflareContext.mockResolvedValue({ env: { DB: db }, ctx: {} })
    const request = new NextRequest('http://test.local/api/posts', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer nm_patch_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ current_slug: 'private-post', content: 'private patch body' }),
    })

    await expectMigrationRequired(await patchPost(request), [
      'posts.deleted_at',
      'nm_patch_secret',
      'private patch body',
    ])
  })

  it.each([
    ['GET', getAdminPost],
    ['PUT', updateAdminPost],
    ['DELETE', deleteAdminPost],
  ])('returns a fixed safe 503 from the real admin article %s handler', async (method, handler) => {
    const db = missingSchemaDb('D1_ERROR: no such table: posts; token=nm_admin_post; content=private admin body')
    mocks.getAppCloudflareContext.mockResolvedValue({ env: { DB: db }, ctx: {} })
    const request = new NextRequest('http://test.local/api/admin/posts/private-post', {
      method,
      headers: { Cookie: 'blogman_admin=session', 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ title: 'Private title', content: 'private admin body' }),
    })

    await expectMigrationRequired(await handler(request, { params: Promise.resolve({ slug: 'private-post' }) }), [
      'posts',
      'nm_admin_post',
      'private admin body',
    ])
  })

  it.each([
    ['POST', createCategory, { name: 'Private category', slug: 'private-category' }],
    ['PATCH', patchCategory, { oldSlug: 'private-category', name: 'Renamed', slug: 'renamed' }],
  ])('returns a fixed safe 503 from the real category %s handler', async (method, handler, body) => {
    const db = missingSchemaDb('D1_ERROR: no such table: categories; token=nm_category_secret')
    mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db })
    const request = new NextRequest('http://test.local/api/admin/categories', {
      method,
      headers: { Authorization: 'Bearer nm_category_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await expectMigrationRequired(await handler(request), ['categories', 'nm_category_secret'])
  })

  it.each([
    ['wechat bridge', getWechatBridge, '/api/admin/wechat-bridge', undefined],
    ['wechat publish', publishWechat, '/api/admin/wechat-publish', {
      account_id: 'private-account',
      title: 'Private title',
      content_html: '<p>private wechat body</p>',
    }],
  ])('returns a fixed safe 503 from the real %s handler', async (_name, handler, path, body) => {
    const db = missingSchemaDb('D1_ERROR: no such table: site_settings; token=nm_boundary_secret')
    mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db })
    mocks.getAppCloudflareContext.mockResolvedValue({ env: { DB: db }, ctx: {} })
    const request = new NextRequest(`http://test.local${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer nm_boundary_secret', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    await expectMigrationRequired(await handler(request), [
      'site_settings',
      'nm_boundary_secret',
      'private wechat body',
    ])
  })

  it('returns a fixed safe 503 from the real upload Bearer boundary', async () => {
    mocks.authenticateRequest.mockRejectedValue(
      new Error('D1_ERROR: no such table: api_tokens; token=nm_upload_secret'),
    )
    const request = new NextRequest('http://test.local/api/uploads', {
      method: 'POST',
      headers: { Authorization: 'Bearer nm_upload_secret' },
    })
    await expectMigrationRequired(await uploadAsset(request), ['api_tokens', 'nm_upload_secret'])
  })

  it.each([
    ['text AI', runEditorAi, '/api/editor/ai'],
    ['image AI', runEditorImage, '/api/editor/ai-image'],
    ['post metadata AI', runEditorPostMetadata, '/api/editor/ai-post-metadata'],
  ])('returns a fixed 503 from the real %s handler when Bearer schema is missing', async (_name, handler, path) => {
    mocks.authenticateRequest.mockRejectedValue(
      new Error('D1_ERROR: no such table: api_tokens; token=nm_bearer_secret; key=sk-private'),
    )
    const request = new NextRequest(`http://test.local${path}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer nm_bearer_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'improve',
        target: 'summary',
        title: 'Private title',
        text: 'private selected text',
        content: 'private article body',
        prompt: 'private image prompt',
      }),
    })

    await expectMigrationRequired(await handler(request), [
      'api_tokens',
      'nm_bearer_secret',
      'sk-private',
      'private article body',
      'private selected text',
      'private image prompt',
    ])
  })

  it('returns a fixed 503 from the real text AI handler when ai_actions is missing', async () => {
    const db = missingSchemaDb(
      'D1_ERROR: no such table: ai_actions; token=nm_ai_secret; content=private selected text',
    )
    mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db })
    const request = new NextRequest('http://test.local/api/editor/ai', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer nm_ai_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'improve', text: 'private selected text' }),
    })

    await expectMigrationRequired(await runEditorAi(request), [
      'ai_actions',
      'nm_ai_secret',
      'private selected text',
    ])
  })

  it('returns a fixed 503 from the real image AI business path when ai_image_actions is missing', async () => {
    const db = missingSchemaDb('D1_ERROR: no such table: ai_image_actions; key=sk-private-image')
    mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db, IMAGES: { put: vi.fn() } })
    const request = new NextRequest('http://test.local/api/editor/ai-image', {
      method: 'POST',
      headers: { Authorization: 'Bearer nm_image_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mondo_landscape', prompt: 'private image prompt' }),
    })
    await expectMigrationRequired(await runEditorImage(request), [
      'ai_image_actions',
      'sk-private-image',
      'private image prompt',
    ])
  })

  it('returns a fixed 503 from the real metadata AI business path when generators are missing', async () => {
    const db = missingSchemaDb('D1_ERROR: no such table: ai_post_generators; key=sk-private-metadata')
    mocks.getAppCloudflareEnv.mockResolvedValue({ DB: db })
    const request = new NextRequest('http://test.local/api/editor/ai-post-metadata', {
      method: 'POST',
      headers: { Authorization: 'Bearer nm_metadata_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'summary', title: 'Private title', content: 'private metadata body' }),
    })
    await expectMigrationRequired(await runEditorPostMetadata(request), [
      'ai_post_generators',
      'sk-private-metadata',
      'private metadata body',
    ])
  })
})
