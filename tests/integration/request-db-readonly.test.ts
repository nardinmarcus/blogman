import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyApiToken } from '@/lib/admin-auth'
import { resolveConfig } from '@/lib/ai'
import {
  reconcileImageProfileReferencesAfterMutation,
  resolveAiImageProfileConfig,
} from '@/lib/ai-image-config'
import {
  encryptApiKey,
  reconcileTextProfileReferencesAfterMutation,
  resolveAiProfileConfig,
} from '@/lib/ai-provider-profiles'
import {
  getAiPostGeneratorByTarget,
  listAiPostGenerators,
} from '@/lib/ai-post-generator/storage'
import {
  DatabaseMigrationRequiredError,
  migrationRequiredResponse,
} from '@/lib/database-errors'
import { getPosts, getSetting } from '@/lib/db'
import { getSiteHeaderData } from '@/lib/site'

const repoRoot = process.cwd()
const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const stateDirectories: string[] = []

function createD1State(): string {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-request-d1-'))
  stateDirectories.push(directory)
  return directory
}

function runD1(stateDirectory: string, sql: string) {
  const result = spawnSync(
    wranglerPath,
    [
      'd1', 'execute', 'DB', '--local', '--persist-to', stateDirectory,
      '--config', join(repoRoot, 'wrangler.toml'), '--command', sql, '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(result.stdout || result.stderr)
  }
  return JSON.parse(result.stdout) as Array<{
    results?: unknown[]
    success?: boolean
    meta?: Record<string, unknown>
  }>
}

function queryD1<T>(stateDirectory: string, sql: string): T[] {
  return (runD1(stateDirectory, sql).at(-1)?.results || []) as T[]
}

function applyLedger(stateDirectory: string): void {
  const result = spawnSync(
    process.execPath,
    [
      runnerPath, 'apply', '--candidate', 'request-readonly-fixture',
      '--database', 'DB', '--local', '--persist-to', stateDirectory,
      '--config', join(repoRoot, 'wrangler.toml'),
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function applyD1File(stateDirectory: string, path: string): void {
  const result = spawnSync(
    wranglerPath,
    [
      'd1', 'execute', 'DB', '--local', '--persist-to', stateDirectory,
      '--config', join(repoRoot, 'wrangler.toml'), '--file', path, '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replaceAll("'", "''")}'`
}

function bindSql(sql: string, values: unknown[]): string {
  let index = 0
  return sql.replace(/\?/g, () => {
    if (index >= values.length) throw new Error('Missing D1 test binding')
    return sqlLiteral(values[index++])
  })
}

function createWranglerD1Database(stateDirectory: string): D1Database {
  class Statement {
    constructor(
      private readonly sql: string,
      private readonly values: unknown[] = [],
    ) {}

    bind(...values: unknown[]) {
      return new Statement(this.sql, values)
    }

    async all<T>() {
      const response = runD1(stateDirectory, bindSql(this.sql, this.values)).at(-1)
      return {
        results: (response?.results || []) as T[],
        success: response?.success ?? true,
        meta: response?.meta || {},
      }
    }

    async first<T>() {
      const response = await this.all<T>()
      return response.results[0] ?? null
    }

    async run<T>() {
      const response = runD1(stateDirectory, bindSql(this.sql, this.values)).at(-1)
      return {
        results: (response?.results || []) as T[],
        success: response?.success ?? true,
        meta: response?.meta || {},
      }
    }

    toSql() {
      return bindSql(this.sql, this.values)
    }
  }

  return {
    prepare(sql: string) {
      return new Statement(sql)
    },
    async batch(statements: Statement[]) {
      return statements.map((statement) => {
        const response = runD1(stateDirectory, statement.toSql()).at(-1)
        return {
          results: response?.results || [],
          success: response?.success ?? true,
          meta: response?.meta || {},
        }
      })
    },
  } as unknown as D1Database
}

afterEach(() => {
  for (const directory of stateDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('request-time D1 behavior', () => {
  it('keeps schema and mutable rows byte-for-byte stable across representative reads', { timeout: 120_000 }, async () => {
    const stateDirectory = createD1State()
    applyLedger(stateDirectory)
    const secret = '0123456789abcdef0123456789abcdef'
    const encryptedKey = await encryptApiKey('sk-author-runtime', secret)
    queryD1(stateDirectory, `
UPDATE site_settings SET value = 'noto-serif-sc' WHERE key = 'body_font';
INSERT INTO posts (slug, title, content, html, description, category, tags, status, published_at)
VALUES ('ledger-ready', 'Ledger Ready', 'body', '<p>body</p>', 'description', 'AI', '["D1"]', 'published', 1700000000);
INSERT INTO ai_provider_profiles (
  name, base_url, model, api_key_encrypted, api_key_masked, is_default
) VALUES ('作者文本配置', 'https://ai.example.com/v1', 'author-text', ${sqlLiteral(encryptedKey)}, 'sk-aut...time', 1);
INSERT INTO ai_image_provider_profiles (
  name, base_url, model, api_key_encrypted, api_key_masked, is_default
) VALUES ('作者图像配置', 'https://image.example.com/v1', 'author-image', ${sqlLiteral(encryptedKey)}, 'sk-aut...time', 1);
UPDATE ai_actions SET profile_id = 1 WHERE action_key = 'improve';
UPDATE ai_image_actions SET profile_id = 1 WHERE action_key = 'mondo_landscape';
UPDATE ai_post_generators SET text_profile_id = 1 WHERE target_key = 'summary';
UPDATE ai_post_generators SET image_profile_id = 1 WHERE target_key = 'cover';
`)
    const db = createWranglerD1Database(stateDirectory)
    const schemaBefore = queryD1(stateDirectory, `
SELECT type, name, sql FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
  AND name NOT LIKE 'migration_ledger%'
ORDER BY type, name
`)
    const rowsBefore = queryD1(stateDirectory, `
SELECT 'setting' AS kind, key AS row_key, json_object('value', value) AS row_value FROM site_settings
UNION ALL SELECT 'action', action_key, json_object('id', id, 'label', label, 'description', description, 'prompt', prompt, 'temperature', temperature, 'profile_id', profile_id, 'sort_order', sort_order, 'is_enabled', is_enabled, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_actions
UNION ALL SELECT 'image_action', action_key, json_object('id', id, 'label', label, 'description', description, 'prompt', prompt, 'aspect_ratio', aspect_ratio, 'resolution', resolution, 'size', size, 'quality', quality, 'profile_id', profile_id, 'sort_order', sort_order, 'is_enabled', is_enabled, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_image_actions
UNION ALL SELECT 'generator', target_key, json_object('id', id, 'label', label, 'description', description, 'prompt', prompt, 'provider_mode', provider_mode, 'text_profile_id', text_profile_id, 'image_profile_id', image_profile_id, 'workers_model', workers_model, 'temperature', temperature, 'max_tokens', max_tokens, 'aspect_ratio', aspect_ratio, 'resolution', resolution, 'is_enabled', is_enabled, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_post_generators
UNION ALL SELECT 'post', slug, json_object('title', title, 'content', content, 'html', html, 'status', status, 'view_count', view_count, 'updated_at', updated_at) FROM posts
ORDER BY kind, row_key
`)
    const profilesBefore = {
      text: queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id'),
      image: queryD1(stateDirectory, 'SELECT * FROM ai_image_provider_profiles ORDER BY id'),
    }

    await expect(getSetting(db, 'body_font')).resolves.toBe('noto-serif-sc')
    await expect(getPosts(db)).resolves.toEqual([
      expect.objectContaining({ slug: 'ledger-ready', title: 'Ledger Ready' }),
    ])
    await expect(getSiteHeaderData(db)).resolves.toEqual(expect.objectContaining({
      defaultTheme: 'editorial',
    }))
    await expect(listAiPostGenerators(db)).resolves.toHaveLength(4)
    await expect(getAiPostGeneratorByTarget(db, 'summary')).resolves.toEqual(
      expect.objectContaining({ target_key: 'summary', text_profile_id: 1 }),
    )
    await expect(resolveAiProfileConfig(db, secret, 1)).resolves.toEqual(
      expect.objectContaining({ model: 'author-text', api_key: 'sk-author-runtime' }),
    )
    await expect(resolveAiImageProfileConfig(db, secret, 1)).resolves.toEqual(
      expect.objectContaining({ model: 'author-image', api_key: 'sk-author-runtime' }),
    )

    expect(queryD1(stateDirectory, `
SELECT type, name, sql FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
  AND name NOT LIKE 'migration_ledger%'
ORDER BY type, name
`)).toEqual(schemaBefore)
    expect(queryD1(stateDirectory, `
SELECT 'setting' AS kind, key AS row_key, json_object('value', value) AS row_value FROM site_settings
UNION ALL SELECT 'action', action_key, json_object('id', id, 'label', label, 'description', description, 'prompt', prompt, 'temperature', temperature, 'profile_id', profile_id, 'sort_order', sort_order, 'is_enabled', is_enabled, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_actions
UNION ALL SELECT 'image_action', action_key, json_object('id', id, 'label', label, 'description', description, 'prompt', prompt, 'aspect_ratio', aspect_ratio, 'resolution', resolution, 'size', size, 'quality', quality, 'profile_id', profile_id, 'sort_order', sort_order, 'is_enabled', is_enabled, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_image_actions
UNION ALL SELECT 'generator', target_key, json_object('id', id, 'label', label, 'description', description, 'prompt', prompt, 'provider_mode', provider_mode, 'text_profile_id', text_profile_id, 'image_profile_id', image_profile_id, 'workers_model', workers_model, 'temperature', temperature, 'max_tokens', max_tokens, 'aspect_ratio', aspect_ratio, 'resolution', resolution, 'is_enabled', is_enabled, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_post_generators
UNION ALL SELECT 'post', slug, json_object('title', title, 'content', content, 'html', html, 'status', status, 'view_count', view_count, 'updated_at', updated_at) FROM posts
ORDER BY kind, row_key
`)).toEqual(rowsBefore)
    expect({
      text: queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id'),
      image: queryD1(stateDirectory, 'SELECT * FROM ai_image_provider_profiles ORDER BY id'),
    }).toEqual(profilesBefore)
  })

  it('fails missing-schema paths as migration-required without leaking request secrets', { timeout: 60_000 }, async () => {
    const stateDirectory = createD1State()
    const db = createWranglerD1Database(stateDirectory)

    await expect(getSetting(db, 'body_font')).rejects.toBeInstanceOf(DatabaseMigrationRequiredError)
    await expect(getSiteHeaderData(db)).rejects.toBeInstanceOf(DatabaseMigrationRequiredError)
    await expect(resolveConfig({ AI_API_KEY: 'sk-must-not-fallback' }, db))
      .rejects.toBeInstanceOf(DatabaseMigrationRequiredError)

    let authError: unknown
    try {
      await verifyApiToken(db, 'nm_token_must_not_leak')
    } catch (error) {
      authError = error
    }
    expect(authError).toBeInstanceOf(DatabaseMigrationRequiredError)
    const response = migrationRequiredResponse(authError)
    expect(response?.status).toBe(503)
    const body = JSON.stringify(await response?.json())
    expect(body).toContain('DATABASE_MIGRATION_REQUIRED')
    expect(body).not.toContain('nm_token_must_not_leak')
    expect(body).not.toContain('sk-must-not-fallback')
    expect(body).not.toContain('site_settings')
  })

  it('forward-migrates the versioned schema and seed fixture while preserving custom and deleted rows across domain reads', { timeout: 150_000 }, async () => {
    const stateDirectory = createD1State()
    applyD1File(stateDirectory, join(repoRoot, 'db', 'schema.sql'))
    applyD1File(stateDirectory, join(repoRoot, 'db', 'seed-template.sql'))
    queryD1(stateDirectory, `
UPDATE site_settings SET value = 'author-font' WHERE key = 'body_font';
UPDATE ai_actions SET prompt = '作者 action prompt', updated_at = 111 WHERE action_key = 'improve';
UPDATE ai_post_generators SET prompt = '作者 summary prompt', temperature = 0, max_tokens = 1, updated_at = 222 WHERE target_key = 'summary';
DELETE FROM ai_post_generators WHERE target_key = 'cover';
INSERT INTO posts (slug, title, content, html, status) VALUES ('current-fixture', 'Current fixture', 'body', '<p>body</p>', 'published');
`)
    applyLedger(stateDirectory)
    const db = createWranglerD1Database(stateDirectory)
    const schemaBefore = queryD1(stateDirectory, `
SELECT type, name, sql FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name
`)
    const rowsBefore = queryD1(stateDirectory, `
SELECT 'setting' AS kind, key AS row_key, value AS row_value FROM site_settings
UNION ALL SELECT 'action', action_key, json_object('prompt', prompt, 'updated_at', updated_at) FROM ai_actions
UNION ALL SELECT 'image_action', action_key, json_object('prompt', prompt, 'updated_at', updated_at) FROM ai_image_actions
UNION ALL SELECT 'generator', target_key, json_object('prompt', prompt, 'temperature', temperature, 'max_tokens', max_tokens, 'updated_at', updated_at) FROM ai_post_generators
UNION ALL SELECT 'post', slug, json_object('title', title, 'content', content, 'status', status) FROM posts
ORDER BY kind, row_key
`)

    await expect(getSetting(db, 'body_font')).resolves.toBe('author-font')
    await expect(getPosts(db)).resolves.toEqual([
      expect.objectContaining({ slug: 'current-fixture', title: 'Current fixture' }),
    ])
    await expect(listAiPostGenerators(db)).resolves.toHaveLength(3)
    await expect(getAiPostGeneratorByTarget(db, 'summary')).resolves.toEqual(
      expect.objectContaining({ prompt: '作者 summary prompt', temperature: 0, max_tokens: 1 }),
    )
    await expect(getAiPostGeneratorByTarget(db, 'cover')).resolves.toBeNull()

    expect(queryD1(stateDirectory, `
SELECT type, name, sql FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name
`)).toEqual(schemaBefore)
    expect(queryD1(stateDirectory, `
SELECT 'setting' AS kind, key AS row_key, value AS row_value FROM site_settings
UNION ALL SELECT 'action', action_key, json_object('prompt', prompt, 'updated_at', updated_at) FROM ai_actions
UNION ALL SELECT 'image_action', action_key, json_object('prompt', prompt, 'updated_at', updated_at) FROM ai_image_actions
UNION ALL SELECT 'generator', target_key, json_object('prompt', prompt, 'temperature', temperature, 'max_tokens', max_tokens, 'updated_at', updated_at) FROM ai_post_generators
UNION ALL SELECT 'post', slug, json_object('title', title, 'content', content, 'status', status) FROM posts
ORDER BY kind, row_key
`)).toEqual(rowsBefore)
  })

  it('backfills generator references only inside explicit first-profile mutations, then keeps reads pure', { timeout: 120_000 }, async () => {
    const stateDirectory = createD1State()
    applyLedger(stateDirectory)
    const db = createWranglerD1Database(stateDirectory)
    expect(queryD1(stateDirectory, `
SELECT target_key, text_profile_id, image_profile_id
FROM ai_post_generators ORDER BY target_key
`)).toEqual([
      { target_key: 'cover', text_profile_id: null, image_profile_id: null },
      { target_key: 'slug', text_profile_id: null, image_profile_id: null },
      { target_key: 'summary', text_profile_id: null, image_profile_id: null },
      { target_key: 'tags', text_profile_id: null, image_profile_id: null },
    ])

    queryD1(stateDirectory, `
INSERT INTO ai_provider_profiles (name, base_url, model, is_default)
VALUES ('首次文本配置', 'https://text.example.com/v1', 'text-model', 0);
INSERT INTO ai_image_provider_profiles (name, base_url, model, is_default)
VALUES ('首次图像配置', 'https://image.example.com/v1', 'image-model', 0);
`)
    await reconcileTextProfileReferencesAfterMutation(db)
    await reconcileImageProfileReferencesAfterMutation(db)

    const rowsAfterMutation = queryD1(stateDirectory, `
SELECT target_key, text_profile_id, image_profile_id, updated_at
FROM ai_post_generators ORDER BY target_key
`)
    expect(rowsAfterMutation).toEqual([
      expect.objectContaining({ target_key: 'cover', text_profile_id: null, image_profile_id: 1 }),
      expect.objectContaining({ target_key: 'slug', text_profile_id: 1, image_profile_id: null }),
      expect.objectContaining({ target_key: 'summary', text_profile_id: 1, image_profile_id: null }),
      expect.objectContaining({ target_key: 'tags', text_profile_id: 1, image_profile_id: null }),
    ])
    expect(queryD1(stateDirectory, 'SELECT id, is_default FROM ai_provider_profiles')).toEqual([
      { id: 1, is_default: 1 },
    ])
    expect(queryD1(stateDirectory, 'SELECT id, is_default FROM ai_image_provider_profiles')).toEqual([
      { id: 1, is_default: 1 },
    ])

    await expect(listAiPostGenerators(db)).resolves.toHaveLength(4)
    await expect(getAiPostGeneratorByTarget(db, 'cover')).resolves.toEqual(
      expect.objectContaining({ image_profile_id: 1 }),
    )
    expect(queryD1(stateDirectory, `
SELECT target_key, text_profile_id, image_profile_id, updated_at
FROM ai_post_generators ORDER BY target_key
`)).toEqual(rowsAfterMutation)
  })
})
