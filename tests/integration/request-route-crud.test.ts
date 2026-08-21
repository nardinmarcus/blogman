import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

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

import {
  DELETE as deleteToken,
  GET as getTokens,
  POST as createToken,
} from '@/app/api/admin/tokens/route'
import { POST as articleCommands } from '@/app/api/article-commands/route'
import {
  DELETE as deleteTextProfile,
  GET as getTextProfiles,
  POST as createTextProfile,
  PUT as updateTextProfile,
} from '@/app/api/admin/ai-provider/route'
import {
  DELETE as deleteImageProfile,
  GET as getImageProfiles,
  POST as createImageProfile,
  PUT as updateImageProfile,
} from '@/app/api/admin/ai-image-provider/route'
import { GET as getGenerators, PUT as updateGenerator } from '@/app/api/admin/ai-post-generators/route'
import {
  DELETE as deleteAdminPost,
  GET as getAdminPost,
  PUT as updateAdminPost,
} from '@/app/api/admin/posts/[slug]/route'
import {
  DELETE as deleteCategory,
  PATCH as updateCategory,
  POST as createCategory,
} from '@/app/api/admin/categories/route'
import { POST as createPost } from '@/app/api/posts/route'

const repoRoot = process.cwd()
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const ledgerMigrationsPath = join(repoRoot, 'db', 'ledger-migrations')
const historicalMigrationsPath = join(repoRoot, 'db', 'migrations')
const stateDirectories: string[] = []

function createState() {
  const state = mkdtempSync(join(tmpdir(), 'blogman-route-crud-d1-'))
  stateDirectories.push(state)
  return state
}

function runD1(state: string, sql: string) {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', state,
    '--config', join(repoRoot, 'wrangler.toml'), '--command', sql, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
  return JSON.parse(result.stdout) as Array<{ results?: unknown[]; success?: boolean; meta?: Record<string, unknown> }>
}

function applyD1File(state: string, path: string) {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', state,
    '--config', join(repoRoot, 'wrangler.toml'), '--file', path, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
}

function applyHistoricalAiSchemaFixture(state: string) {
  applyD1File(state, join(ledgerMigrationsPath, '001_initial_schema.sql'))
  runD1(state, 'DROP TABLE ai_actions; DROP TABLE ai_provider_profiles;')
  applyD1File(state, join(historicalMigrationsPath, '002_add_ai_actions.sql'))
  applyD1File(state, join(historicalMigrationsPath, '004_add_ai_provider_profiles.sql'))
}

function applyLedger(state: string) {
  const result = spawnSync(process.execPath, [
    runnerPath, 'apply', '--candidate', 'route-crud-fixture', '--database', 'DB', '--local',
    '--persist-to', state, '--config', join(repoRoot, 'wrangler.toml'),
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function applyContentEnvelopeDdl(state: string) {
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'apply-content-envelope-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', join(repoRoot, 'wrangler.toml'),
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function applyArticleIdentityDdl(state: string) {
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'apply-article-identity-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', join(repoRoot, 'wrangler.toml'),
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function applySlugAddressDdl(state: string) {
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'apply-slug-address-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', join(repoRoot, 'wrangler.toml'),
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function applyArticleFtsDdl(state: string) {
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'apply-article-fts-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', join(repoRoot, 'wrangler.toml'),
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function literal(value: unknown) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function bindSql(sql: string, values: unknown[]) {
  let index = 0
  return sql.replace(/\?/g, () => literal(values[index++]))
}

function createDatabase(state: string): D1Database {
  class Statement {
    constructor(private readonly sql: string, private readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values) }
    render() { return bindSql(this.sql, this.values) }
    async all<T>() {
      const result = runD1(state, this.render()).at(-1)
      return { results: (result?.results || []) as T[], success: result?.success ?? true, meta: result?.meta || {} }
    }
    async first<T>() { return (await this.all<T>()).results[0] ?? null }
    async run<T>() { return this.all<T>() }
  }
  return {
    prepare(sql: string) { return new Statement(sql) },
    async batch(statements: Statement[]) {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
  } as unknown as D1Database
}

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: { Cookie: 'blogman_admin=session', Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function query<T>(state: string, sql: string): T[] {
  return (runD1(state, sql).at(-1)?.results || []) as T[]
}

afterEach(() => {
  for (const state of stateDirectories.splice(0)) rmSync(state, { recursive: true, force: true })
})

describe('real route CRUD on a ledger-migrated D1', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateRequest.mockResolvedValue(true)
    mocks.isAdminAuthenticated.mockResolvedValue(true)
  })

  it('performs representative business mutations on the repository historical schema without schema or non-target seed drift', { timeout: 300_000 }, async () => {
    const state = createState()
    applyHistoricalAiSchemaFixture(state)
    applyLedger(state)
    const db = createDatabase(state)
    const env = { DB: db, AI_CONFIG_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef' }
    mocks.getAppCloudflareEnv.mockResolvedValue(env)
    mocks.getAppCloudflareContext.mockResolvedValue({ env, ctx: { waitUntil: vi.fn() } })
    const schemaBefore = query(state, `
      SELECT type, name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name
    `)
    const protectedSeedsBefore = query(state, `
      SELECT 'setting' AS kind, key AS row_key, value AS value FROM site_settings
      UNION ALL SELECT 'action', action_key, json_object('prompt', prompt, 'profile_id', profile_id, 'updated_at', updated_at) FROM ai_actions
      UNION ALL SELECT 'image_action', action_key, json_object('prompt', prompt, 'profile_id', profile_id, 'updated_at', updated_at) FROM ai_image_actions
      UNION ALL SELECT 'generator', target_key, json_object('prompt', prompt, 'text_profile_id', text_profile_id, 'image_profile_id', image_profile_id, 'updated_at', updated_at) FROM ai_post_generators WHERE target_key <> 'summary'
      ORDER BY kind, row_key
    `)

    const createdTokenResponse = await createToken(request('/api/admin/tokens', 'POST', { name: 'Route token' }))
    expect(createdTokenResponse.status).toBe(200)
    const tokenId = query<{ id: number }>(state, "SELECT id FROM api_tokens WHERE name = 'Route token'")[0].id
    expect((await getTokens(request('/api/admin/tokens', 'GET'))).status).toBe(200)
    expect((await deleteToken(request('/api/admin/tokens', 'DELETE', { id: tokenId }))).status).toBe(200)
    expect(query(state, "SELECT id FROM api_tokens WHERE name = 'Route token'")).toEqual([])

    const textCreated = await createTextProfile(request('/api/admin/ai-provider', 'POST', {
      name: 'Text route', base_url: 'https://text.example.com/v1', model: 'text-model', api_key: 'sk-text', is_default: true,
    }))
    expect(textCreated.status).toBe(200)
    const textId = query<{ id: number }>(state, "SELECT id FROM ai_provider_profiles WHERE name = 'Text route'")[0].id
    expect(query(state, `SELECT max_tokens FROM ai_provider_profiles WHERE id = ${textId}`)).toEqual([{ max_tokens: 2000 }])
    expect((await getTextProfiles(request('/api/admin/ai-provider', 'GET'))).status).toBe(200)
    expect((await updateTextProfile(request('/api/admin/ai-provider', 'PUT', {
      id: textId, name: 'Text updated', base_url: 'https://text.example.com/v1', model: 'text-model-2', is_default: true,
    }))).status).toBe(200)
    expect(query(state, `SELECT name, model FROM ai_provider_profiles WHERE id = ${textId}`)).toEqual([{ name: 'Text updated', model: 'text-model-2' }])
    expect((await deleteTextProfile(request('/api/admin/ai-provider', 'DELETE', { id: textId }))).status).toBe(200)

    const imageCreated = await createImageProfile(request('/api/admin/ai-image-provider', 'POST', {
      name: 'Image route', base_url: 'https://image.example.com/v1', model: 'image-model', api_key: 'sk-image', is_default: true,
    }))
    expect(imageCreated.status).toBe(200)
    const imageId = query<{ id: number }>(state, "SELECT id FROM ai_image_provider_profiles WHERE name = 'Image route'")[0].id
    expect((await getImageProfiles(request('/api/admin/ai-image-provider', 'GET'))).status).toBe(200)
    expect((await updateImageProfile(request('/api/admin/ai-image-provider', 'PUT', {
      id: imageId, name: 'Image updated', base_url: 'https://image.example.com/v1', model: 'image-model-2', is_default: true,
    }))).status).toBe(200)
    expect(query(state, `SELECT name, model FROM ai_image_provider_profiles WHERE id = ${imageId}`)).toEqual([{ name: 'Image updated', model: 'image-model-2' }])
    expect((await deleteImageProfile(request('/api/admin/ai-image-provider', 'DELETE', { id: imageId }))).status).toBe(200)

    expect((await getGenerators(request('/api/admin/ai-post-generators', 'GET'))).status).toBe(200)
    expect((await updateGenerator(request('/api/admin/ai-post-generators', 'PUT', {
      target_key: 'summary', prompt: '作者 route summary prompt', provider_mode: 'workers_ai', workers_model: '@cf/meta/llama-3.1-8b-instruct', temperature: 0, max_tokens: 1,
    }))).status).toBe(200)
    expect(query(state, "SELECT prompt, temperature, max_tokens FROM ai_post_generators WHERE target_key = 'summary'"))
      .toEqual([{ prompt: '作者 route summary prompt', temperature: 0, max_tokens: 1 }])

    expect((await createCategory(request('/api/admin/categories', 'POST', { name: 'Route Category', slug: 'route-category' }))).status).toBe(200)
    expect((await updateCategory(request('/api/admin/categories', 'PATCH', { oldSlug: 'route-category', name: 'Route Renamed', slug: 'route-renamed' }))).status).toBe(200)
    expect(query(state, "SELECT name, slug FROM categories WHERE slug = 'route-renamed'"))
      .toEqual([{ name: 'Route Renamed', slug: 'route-renamed' }])
    expect((await deleteCategory(request('/api/admin/categories', 'DELETE', { slug: 'route-renamed' }))).status).toBe(200)
    expect(query(state, "SELECT slug FROM categories WHERE slug = 'route-renamed'")).toEqual([])

    expect(query(state, `
      SELECT type, name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name
    `)).toEqual(schemaBefore)
    expect(query(state, `
      SELECT 'setting' AS kind, key AS row_key, value AS value FROM site_settings
      UNION ALL SELECT 'action', action_key, json_object('prompt', prompt, 'profile_id', profile_id, 'updated_at', updated_at) FROM ai_actions
      UNION ALL SELECT 'image_action', action_key, json_object('prompt', prompt, 'profile_id', profile_id, 'updated_at', updated_at) FROM ai_image_actions
      UNION ALL SELECT 'generator', target_key, json_object('prompt', prompt, 'text_profile_id', text_profile_id, 'image_profile_id', image_profile_id, 'updated_at', updated_at) FROM ai_post_generators WHERE target_key <> 'summary'
      ORDER BY kind, row_key
    `)).toEqual(protectedSeedsBefore)
  })

  it('runs article CRUD and keeps FTS synchronized on the canonical ledger schema', { timeout: 180_000 }, async () => {
    const state = createState()
    applyLedger(state)
    // B2-01b: envelope columns arrive via the independent DDL channel (not a
    // ledger migration), so the write path needs them applied before POST.
    applyContentEnvelopeDdl(state)
    // L1 (#66): the legacy direct-`posts` writer is removed, so versioned
    // writes need the B2-02 identity tables present.
    applyArticleIdentityDdl(state)
    // #234 Phase A — canonical slug registry + article FTS (kernel deps).
    applySlugAddressDdl(state)
    applyArticleFtsDdl(state)
    const db = createDatabase(state)
    const env = { DB: db }
    mocks.getAppCloudflareEnv.mockResolvedValue(env)
    mocks.getAppCloudflareContext.mockResolvedValue({ env, ctx: { waitUntil: vi.fn() } })
    const schemaBefore = query(state, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    const postContext = { params: Promise.resolve({ slug: 'route-post' }) }

    // Versioned create (protocol v1) → article identity + version 1 + registry
    // reservation + canonical FTS index. The posts projection is retired.
    const created = await (await createPost(request('/api/posts', 'POST', {
      protocol: 'v1', action: 'create', creationId: 'route-crud-create',
      snapshot: {
        slug: 'route-post', title: 'Original title', content: 'original searchable body',
        html: '<p>original searchable body</p>', status: 'draft',
      },
    }))).json() as { outcome: string; articleId: number; version: number; postRef: number }
    expect(created.outcome).toBe('created')
    expect(created.version).toBe(1)
    expect(query(state, "SELECT rowid, title, content FROM article_fts WHERE article_fts MATCH 'original'"))
      .toEqual([{ rowid: created.articleId, title: 'Original title', content: 'original searchable body' }])
    // The frozen v1 snapshot carries the canonical envelope + both hashes.
    const v1 = query(state, "SELECT snapshot_json FROM article_versions WHERE article_id = 1 AND version = 1")
    expect(v1).toHaveLength(1)
    const v1record = JSON.parse(v1[0].snapshot_json) as {
      envelope: { format?: string } | null
      content_snapshot_sha256: string | null
      source_sync_sha256: string | null
    }
    expect(String(v1record.envelope?.format)).toContain('blogman-content-envelope/v1')
    expect(v1record.content_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(v1record.source_sync_sha256).toMatch(/^[0-9a-f]{64}$/)
    // The slug is reserved in the address registry for this article.
    const reg = query(state, "SELECT article_id, kind FROM article_slug_addresses WHERE slug = 'route-post'")
    expect(reg).toEqual([{ article_id: created.articleId, kind: 'candidate' }])

    // Negative probe: an unversioned direct create is rejected (writer removed).
    const legacyCreate = await createPost(request('/api/posts', 'POST', {
      slug: 'legacy-rejected', title: 'Legacy', content: 'should not land', status: 'draft',
    }))
    expect(legacyCreate.status).toBe(409)
    expect(query(state, "SELECT id FROM articles WHERE slug = 'legacy-rejected'")).toEqual([])

    expect((await getAdminPost(request('/api/admin/posts/route-post', 'GET'), postContext)).status).toBe(200)
    // Versioned content save through the command kernel.
    const saved = await (await articleCommands(request('/api/article-commands', 'POST', {
      action: 'save', articleId: created.articleId, expectedVersion: 1, operationId: 'route-crud-save-1',
      snapshot: {
        slug: 'route-post', title: 'Updated title', content: 'updated searchable body',
        html: '<p>updated searchable body</p>', status: 'draft',
      },
    }))).json() as { outcome: string; version: number }
    expect(saved.outcome).toBe('applied')
    expect(saved.version).toBe(2)
    // The canonical FTS index follows the latest version (trigger-fed).
    expect(query(state, "SELECT rowid, title, content FROM article_fts WHERE article_fts MATCH 'updated'"))
      .toEqual([{ rowid: created.articleId, title: 'Updated title', content: 'updated searchable body' }])
    expect(query(state, "SELECT rowid FROM article_fts WHERE article_fts MATCH 'original'"))
      .toEqual([])

    // Versioned publish (publishTemp) – status transition only, no content write.
    const published = await (await articleCommands(request('/api/article-commands', 'POST', {
      action: 'publishTemp', articleId: created.articleId, expectedVersion: 2, currentStatus: 'draft',
      operationId: 'route-crud-pub-1', status: 'published',
    }))).json() as { outcome: string; version: number }
    expect(published.outcome).toBe('applied')
    const pubStatus = query(state, "SELECT json_extract(snapshot_json, '$.fields.status') AS status FROM article_versions WHERE article_id = 1 ORDER BY version DESC LIMIT 1")
    expect(pubStatus).toEqual([{ status: 'published' }])

    // Admin DELETE routes through the explicit softDelete command (canonical).
    expect((await deleteAdminPost(request('/api/admin/posts/route-post', 'DELETE'), postContext)).status).toBe(200)
    const delStatus = query(state, "SELECT json_extract(snapshot_json, '$.fields.deleted_at') AS deleted_at FROM article_versions WHERE article_id = 1 ORDER BY version DESC LIMIT 1")
    expect(delStatus[0]?.deleted_at).not.toBeNull()
    // Soft delete keeps the index row — exclusion happens at read time via
    // the snapshot's deleted_at (search filters access-control canonically).
    expect(query(state, "SELECT rowid FROM article_fts WHERE article_fts MATCH 'updated'"))
      .toEqual([{ rowid: created.articleId }])
    expect(query(state, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"))
      .toEqual(schemaBefore)
  })
})
