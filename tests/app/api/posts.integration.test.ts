/**
 * B2-08 — /api/posts external write integration (issue #31).
 *
 * Real route + real version kernel against one shared in-process Miniflare D1:
 * upgraded-client idempotent create / versioned save / publishTemp, legacy
 * draft-only create with upgrade signal + telemetry, and the authority switch
 * (legacy versionless write rejection) — zero wrangler CLI spawns.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'
import { AUTHORITY_KEY, AUTHORITY_VERSIONED, LEGACY_TELEMETRY_KEY } from '@/lib/external-write-api'

const mocks = vi.hoisted(() => ({
  getRouteContextWithDb: vi.fn(),
  ensureAuthenticatedRequest: vi.fn(),
  invalidatePublicContentCache: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
}))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: mocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: mocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: async (req: Request) => req.json(),
}))

vi.mock('@/lib/cache', () => ({ invalidatePublicContentCache: mocks.invalidatePublicContentCache }))
vi.mock('@/lib/background-jobs', () => ({ enqueueBackgroundJob: mocks.enqueueBackgroundJob }))

import { PATCH, POST } from '@/app/api/posts/route'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b208-posts-'))
  cleanup.push(state)
  await bootstrapState(state)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRouteContextWithDb.mockResolvedValue({
    ok: true,
    env: {},
    db: createDatabase(),
    ctx: { waitUntil: vi.fn() },
  })
  mocks.ensureAuthenticatedRequest.mockResolvedValue(null)
  mocks.invalidatePublicContentCache.mockResolvedValue(undefined)
  mocks.enqueueBackgroundJob.mockResolvedValue(undefined)
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function body(obj: unknown): string {
  return JSON.stringify(obj)
}

async function postReq(method: 'POST' | 'PATCH', payload: string, ua: string): Promise<NextRequest> {
  return new Request(`http://localhost/api/posts`, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: payload,
  }) as unknown as NextRequest
}

function snapshot(slug: string, title: string) {
  return { slug, title, content: '正文', html: '<p>正文</p>', status: 'published' }
}

async function articleVersions(articleId: number): Promise<Array<{ version: number; operation_id: string }>> {
  return query<{ version: number; operation_id: string }>(
    `SELECT version, operation_id FROM article_versions WHERE article_id = ${articleId} ORDER BY version`,
  )
}

describe('app/api/posts — external write integration', { timeout: 600_000 }, () => {
  it('upgraded client create is idempotent: retries never duplicate the article', async () => {
    const slug = fresh('vslug')
    const creationId = fresh('vcreate')

    const first = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'create', creationId, clientType: 'obsidian',
      snapshot: snapshot(slug, '第一稿'),
    }), 'obsidian/1.0'))).json() as { outcome: string; articleId: number; version: number; status?: string }

    expect(first.outcome).toBe('created')
    expect(first.version).toBe(1)
    // B2-08: creation always lands as a draft even when the snapshot asked published.
    const createdPost = (await query<Record<string, unknown>>(`SELECT status FROM posts WHERE slug = '${slug}'`))[0]
    expect(createdPost.status).toBe('draft')

    // Response-lost retry: same creationId, even a different payload → existing, no duplicate.
    const retry = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'create', creationId,
      snapshot: snapshot(slug, '不同重试内容'),
    }), 'obsidian/1.0'))).json() as { outcome: string; articleId: number }

    expect(retry.outcome).toBe('existing')
    expect(retry.articleId).toBe(first.articleId)

    const articles = await query<{ id: number }>(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)
    expect(articles).toHaveLength(1)
    expect(await articleVersions(first.articleId)).toHaveLength(1)
    const post = (await query<Record<string, unknown>>(`SELECT title FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.title).toBe('第一稿')
  })

  it('upgraded client save is versioned: replay does not inflate versions, stale version conflicts', async () => {
    const slug = fresh('vsave')
    const creationId = fresh('vsave-c')
    const created = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'create', creationId,
      snapshot: snapshot(slug, '基底'),
    }), 'agent/1.0'))).json() as { articleId: number }
    const articleId = created.articleId

    const saved = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'save', articleId, expectedVersion: 1, operationId: 'op-vsave-1',
      snapshot: snapshot(slug, '第二版'),
    }), 'agent/1.0'))).json() as { outcome: string; version: number }
    expect(saved.outcome).toBe('applied')
    expect(saved.version).toBe(2)

    // Same operation id replay → replayed, no version 3.
    const replay = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'save', articleId, expectedVersion: 2, operationId: 'op-vsave-1',
      snapshot: snapshot(slug, '第二版'),
    }), 'agent/1.0'))).json() as { outcome: string }
    expect(replay.outcome).toBe('replayed')

    // Stale expected version → conflict, zero writes.
    const conflict = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'save', articleId, expectedVersion: 1, operationId: 'op-vsave-2',
      snapshot: snapshot(slug, '旧版覆盖'),
    }), 'agent/1.0'))).json() as { outcome: string; serverVersion: number }
    expect(conflict.outcome).toBe('conflict')
    expect(conflict.serverVersion).toBe(2)

    expect((await articleVersions(articleId)).map((r) => r.version)).toEqual([1, 2])
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`)).at(-1)?.n).toBe(2)
  })

  it('publishTemp transitions a versioned draft to published (versioned publish path)', async () => {
    const slug = fresh('vpub')
    const created = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'create', creationId: fresh('vpub-c'),
      snapshot: snapshot(slug, '待发布'),
    }), 'agent/1.0'))).json() as { articleId: number }

    const published = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'publishTemp', articleId: created.articleId,
      expectedVersion: 1, currentStatus: 'draft', operationId: 'op-vpub-1', status: 'published',
    }), 'agent/1.0'))).json() as { outcome: string; version: number }
    expect(published.outcome).toBe('applied')
    expect(published.version).toBe(2)

    const post = (await query<Record<string, unknown>>(`SELECT status, published_at FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.status).toBe('published')
    expect(post.published_at).not.toBeNull()
  })

  it('legacy create is rejected after writer removal (upgrade signal, no write)', async () => {
    const title = '旧客户端标题'
    const content = '# 旧正文'
    const response = await POST(await postReq('POST', body({
      title, content, status: 'published', category: 'AI 工具',
    }), 'obsidian/1.0'))
    const result = await response.json() as {
      error: string; upgrade: { protocol: string; required: boolean }
    }

    expect(response.status).toBe(409)
    expect(result.error).toContain('已停用')
    expect(result.upgrade.protocol).toBe('v1')
    expect(result.upgrade.required).toBe(true)

    // No row lands and no legacy telemetry is recorded.
    const posts = await query<Record<string, unknown>>(`SELECT status FROM posts WHERE title = '${title}'`)
    expect(posts).toHaveLength(0)
    const telemetry = (await query<Record<string, unknown>>(`SELECT value FROM site_settings WHERE key = '${LEGACY_TELEMETRY_KEY}'`))[0]?.value as string | undefined
    expect(telemetry ?? '').not.toContain('"create"')
  })

  it('authority switch is moot after removal: legacy versionless writes rejected, versioned writes keep working', async () => {
    const slug = fresh('auth')
    const created = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'create', creationId: fresh('auth-c'),
      snapshot: snapshot(slug, '版本化文章'),
    }), 'agent/1.0'))).json() as { articleId: number }

    await query(`INSERT OR REPLACE INTO site_settings (key, value) VALUES ('${AUTHORITY_KEY}', '${AUTHORITY_VERSIONED}')`)

    // Legacy create → rejected (no authority gate needed to refuse it now).
    const legacyCreate = await POST(await postReq('POST', body({ title: '不支持', content: '正文' }), 'chrome/1.0'))
    expect(legacyCreate.status).toBe(409)
    const legacyErr = await legacyCreate.json() as { error: string }
    expect(legacyErr.error).toContain('protocol=v1')

    // Legacy update → rejected.
    const legacyPatch = await PATCH(await postReq('PATCH', body({ current_slug: slug, title: '旧更新' }), 'chrome/1.0'))
    expect(legacyPatch.status).toBe(409)

    // Versioned save still works.
    const saved = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'save', articleId: created.articleId,
      expectedVersion: 1, operationId: 'op-auth-1', snapshot: snapshot(slug, '切换后保存'),
    }), 'agent/1.0'))).json() as { outcome: string }
    expect(saved.outcome).toBe('applied')

    // Clean up so the shared state stays green for other tests in the file order.
    await query(`DELETE FROM site_settings WHERE key = '${AUTHORITY_KEY}'`)
  })

  it('legacy update is rejected after writer removal (no versionless save)', async () => {
    const slug = fresh('lpatch')
    const created = await (await POST(await postReq('POST', body({
      protocol: 'v1', action: 'create', creationId: fresh('lpatch-c'),
      snapshot: snapshot(slug, '草稿基底'),
    }), 'agent/1.0'))).json() as { articleId: number }

    const response = await PATCH(await postReq('PATCH', body({
      current_slug: slug, title: '旧更新标题', status: 'published',
    }), 'obsidian/1.0'))
    const result = await response.json() as { error: string; upgrade?: { required: boolean } }

    expect(response.status).toBe(409)
    expect(result.error).toContain('已停用')
    expect(result.upgrade?.required).toBe(true)

    // The article was not mutated by the legacy update and no version advanced.
    const post = (await query<Record<string, unknown>>(`SELECT title, status FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.title).toBe('草稿基底')
    expect(post.status).toBe('draft')
    expect((await articleVersions(created.articleId)).map((r) => r.version)).toEqual([1])
  })
})