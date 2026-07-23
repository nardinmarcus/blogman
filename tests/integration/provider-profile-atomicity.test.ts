import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getAppCloudflareEnv: vi.fn(),
}))

vi.mock('@/lib/admin-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-auth')>('@/lib/admin-auth')
  return { ...actual, authenticateRequest: mocks.authenticateRequest }
})

vi.mock('@/lib/cloudflare', () => ({
  getAppCloudflareEnv: mocks.getAppCloudflareEnv,
}))

import {
  DELETE as deleteTextProfile,
  POST as createTextProfile,
  PUT as updateTextProfile,
} from '@/app/api/admin/ai-provider/route'
import {
  DELETE as deleteImageProfile,
  POST as createImageProfile,
  PUT as updateImageProfile,
} from '@/app/api/admin/ai-image-provider/route'

const miniflares: Miniflare[] = []
const fixtureStatements = [
  `CREATE TABLE ai_provider_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'custom',
    provider_name TEXT NOT NULL DEFAULT '', provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
    provider_category TEXT NOT NULL DEFAULT '', api_key_url TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL,
    model TEXT NOT NULL, temperature REAL NOT NULL DEFAULT 0.7, max_tokens INTEGER NOT NULL DEFAULT 2000,
    api_key_encrypted TEXT NOT NULL DEFAULT '', api_key_masked TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE TABLE ai_image_provider_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'custom',
    provider_name TEXT NOT NULL DEFAULT '', provider_type TEXT NOT NULL DEFAULT 'openai_images',
    provider_category TEXT NOT NULL DEFAULT '', api_key_url TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL,
    model TEXT NOT NULL, api_key_encrypted TEXT NOT NULL DEFAULT '', api_key_masked TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  'CREATE TABLE ai_actions (id INTEGER PRIMARY KEY, action_key TEXT NOT NULL UNIQUE, profile_id INTEGER)',
  'CREATE TABLE ai_image_actions (id INTEGER PRIMARY KEY, action_key TEXT NOT NULL UNIQUE, profile_id INTEGER)',
  `CREATE TABLE ai_post_generators (
    id INTEGER PRIMARY KEY, target_key TEXT NOT NULL UNIQUE, text_profile_id INTEGER, image_profile_id INTEGER
  )`,
  "INSERT INTO ai_actions VALUES (1, 'improve', NULL), (2, 'translate', NULL)",
  "INSERT INTO ai_image_actions VALUES (1, 'mondo_landscape', NULL), (2, 'mondo_portrait', NULL)",
  "INSERT INTO ai_post_generators VALUES (1, 'summary', NULL, NULL), (2, 'tags', NULL, NULL), (3, 'slug', NULL, NULL), (4, 'cover', NULL, NULL)",
]

async function createDatabase() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  })
  miniflares.push(miniflare)
  const db = await miniflare.getD1Database('DB') as unknown as D1Database
  await db.batch(fixtureStatements.map((statement) => db.prepare(statement)))
  return db
}

async function rows(db: D1Database, sql: string) {
  return (await db.prepare(sql).all()).results
}

async function snapshot(db: D1Database, domain: 'text' | 'image') {
  const profileTable = domain === 'text' ? 'ai_provider_profiles' : 'ai_image_provider_profiles'
  const actionTable = domain === 'text' ? 'ai_actions' : 'ai_image_actions'
  return {
    profiles: await rows(db, `SELECT * FROM ${profileTable} ORDER BY id`),
    actions: await rows(db, `SELECT * FROM ${actionTable} ORDER BY id`),
    generators: await rows(db, 'SELECT * FROM ai_post_generators ORDER BY id'),
  }
}

async function seedFailureFixture(db: D1Database, domain: 'text' | 'image') {
  const profileTable = domain === 'text' ? 'ai_provider_profiles' : 'ai_image_provider_profiles'
  const statements = [
    db.prepare(`
      INSERT INTO ${profileTable} (name, base_url, model, api_key_encrypted, api_key_masked, is_default)
      VALUES ('primary', 'https://primary.example.com/v1', 'primary-model', 'cipher-1', 'key-1', 1),
             ('secondary', 'https://secondary.example.com/v1', 'secondary-model', 'cipher-2', 'key-2', 0)
    `),
    ...(domain === 'text'
      ? [
          db.prepare("UPDATE ai_actions SET profile_id = CASE WHEN action_key = 'improve' THEN NULL ELSE 1 END"),
          db.prepare("UPDATE ai_post_generators SET text_profile_id = CASE WHEN target_key = 'summary' THEN NULL ELSE 1 END WHERE target_key IN ('summary', 'tags', 'slug')"),
        ]
      : [
          db.prepare("UPDATE ai_image_actions SET profile_id = CASE WHEN action_key = 'mondo_landscape' THEN NULL ELSE 1 END"),
          db.prepare("UPDATE ai_post_generators SET image_profile_id = NULL WHERE target_key = 'cover'"),
        ]),
    db.prepare(`
      CREATE TRIGGER reject_profile_reconciliation
      BEFORE UPDATE ON ai_post_generators BEGIN
        SELECT RAISE(ABORT, 'injected reconciliation failure');
      END
    `),
  ]
  await db.batch(statements)
}

async function seedConcurrentUpdateFixture(db: D1Database, domain: 'text' | 'image') {
  const profileTable = domain === 'text' ? 'ai_provider_profiles' : 'ai_image_provider_profiles'
  await db.prepare(`
    INSERT INTO ${profileTable} (name, base_url, model, api_key_encrypted, api_key_masked, is_default)
    VALUES ('primary', 'https://primary.example.com/v1', 'primary-model', 'cipher-old', 'mask-old', 1),
           ('secondary', 'https://secondary.example.com/v1', 'secondary-model', 'cipher-2', 'mask-2', 0)
  `).run()
}

function pauseInitialProfileRead(db: D1Database, domain: 'text' | 'image') {
  const profileTable = domain === 'text' ? 'ai_provider_profiles' : 'ai_image_provider_profiles'
  let releaseRead = () => {}
  let markReadStarted = () => {}
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve })
  let intercepted = false

  const wrapped = {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      if (
        intercepted
        || !new RegExp(`SELECT\\s+id(?:,\\s*api_key_masked,\\s*is_default)?\\s+FROM\\s+${profileTable}`, 'i').test(sql)
      ) {
        return statement
      }
      intercepted = true
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values)
          return {
            bind: bound.bind.bind(bound),
            all: bound.all.bind(bound),
            run: bound.run.bind(bound),
            async first<T>() {
              const result = await bound.first<T>()
              markReadStarted()
              await readReleased
              return result
            },
          }
        },
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
      }
    },
    batch: db.batch.bind(db),
  } as D1Database

  return { db: wrapped, readStarted, releaseRead }
}

function requestFor(domain: 'text' | 'image', method: 'POST' | 'PUT' | 'DELETE') {
  const path = domain === 'text' ? '/api/admin/ai-provider' : '/api/admin/ai-image-provider'
  const body = method === 'DELETE'
    ? { id: 1 }
    : {
        ...(method === 'PUT' ? { id: 2 } : {}),
        name: 'mutated',
        base_url: 'https://mutated.example.com/v1',
        model: 'mutated-model',
        api_key: 'sk-mutation-secret',
        is_default: true,
      }
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('provider profile mutation atomicity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateRequest.mockResolvedValue(true)
  })

  afterEach(async () => {
    await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
  })

  it.each([
    ['text', 'POST', createTextProfile],
    ['text', 'PUT', updateTextProfile],
    ['text', 'DELETE', deleteTextProfile],
    ['image', 'POST', createImageProfile],
    ['image', 'PUT', updateImageProfile],
    ['image', 'DELETE', deleteImageProfile],
  ] as const)('rolls back %s provider %s when reconciliation fails', async (domain, method, handler) => {
    const db = await createDatabase()
    await seedFailureFixture(db, domain)
    mocks.getAppCloudflareEnv.mockResolvedValue({
      DB: db,
      AI_CONFIG_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef',
    })
    const before = await snapshot(db, domain)

    await expect(handler(requestFor(domain, method))).rejects.toThrow('injected reconciliation failure')
    expect(await snapshot(db, domain)).toEqual(before)
  })

  it.each([
    ['text', updateTextProfile],
    ['image', updateImageProfile],
  ] as const)('does not overwrite a concurrent %s key or default when PUT omits those fields', async (domain, handler) => {
    const db = await createDatabase()
    await seedConcurrentUpdateFixture(db, domain)
    const paused = pauseInitialProfileRead(db, domain)
    mocks.getAppCloudflareEnv.mockResolvedValue({
      DB: paused.db,
      AI_CONFIG_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef',
    })
    const path = domain === 'text' ? '/api/admin/ai-provider' : '/api/admin/ai-image-provider'
    const update = handler(new NextRequest(`http://test.local${path}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        name: 'primary edited',
        base_url: 'https://primary.example.com/v1',
        model: 'primary-model-edited',
      }),
    }))

    await paused.readStarted
    const profileTable = domain === 'text' ? 'ai_provider_profiles' : 'ai_image_provider_profiles'
    await db.batch([
      db.prepare(`UPDATE ${profileTable} SET api_key_encrypted = 'cipher-new', api_key_masked = 'mask-new' WHERE id = 1`),
      db.prepare(`UPDATE ${profileTable} SET is_default = 0`),
      db.prepare(`UPDATE ${profileTable} SET is_default = 1 WHERE id = 2`),
    ])
    paused.releaseRead()

    expect((await update).status).toBe(200)
    expect(await rows(db, `SELECT id, api_key_encrypted, api_key_masked, is_default FROM ${profileTable} ORDER BY id`))
      .toEqual([
        { id: 1, api_key_encrypted: 'cipher-new', api_key_masked: 'mask-new', is_default: 0 },
        { id: 2, api_key_encrypted: 'cipher-2', api_key_masked: 'mask-2', is_default: 1 },
      ])
  })
})
