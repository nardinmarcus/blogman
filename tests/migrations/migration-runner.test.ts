import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptApiKey } from '@/lib/ai-provider-profiles'
import { DEFAULT_GENERATORS, LEGACY_PROMPT_VARIANTS } from '@/lib/ai-post-generator/constants'

const repoRoot = process.cwd()
const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const currentSchemaPath = join(repoRoot, 'db', 'schema.sql')
const seedTemplatePath = join(repoRoot, 'db', 'seed-template.sql')
const canonicalMigrationsPath = join(repoRoot, 'db', 'ledger-migrations')
const historicalMigrationsPath = join(repoRoot, 'db', 'migrations')
const stateDirectories: string[] = []

function createD1State(): string {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-d1-migrations-'))
  stateDirectories.push(directory)
  return directory
}

function createMigrationsDirectory(stateDirectory: string): string {
  const directory = join(stateDirectory, 'migrations')
  mkdirSync(directory)
  return directory
}

function writeMigration(directory: string, number: number, name: string, sql: string): void {
  const paddedNumber = String(number).padStart(3, '0')
  writeFileSync(
    join(directory, `${paddedNumber}_${name}.sql`),
    `-- migration-number: ${paddedNumber}\n${sql.trim()}\n`,
  )
}

function copyCanonicalBaseline(directory: string): void {
  for (const name of ['001_initial_schema.sql', '001_initial_schema.baseline.sql']) {
    writeFileSync(
      join(directory, name),
      readFileSync(join(canonicalMigrationsPath, name), 'utf8'),
    )
  }
}

function copyCanonicalMigrationSet(directory: string): void {
  for (const name of [
    '001_initial_schema.sql',
    '001_initial_schema.baseline.sql',
    '002_add_ai_image_configuration.sql',
    '002_add_ai_image_configuration.preflight.sql',
    '003_migrate_runtime_ai_configuration.sql',
    '003_migrate_runtime_ai_configuration.data.mjs',
    '004_complete_historical_text_ai_schema.sql',
    '004_complete_historical_text_ai_schema.baseline.sql',
    '005_fix_posts_fts_sync.sql',
    '006_add_rollout_safety_controls.sql',
  ]) {
    writeFileSync(
      join(directory, name),
      readFileSync(join(canonicalMigrationsPath, name), 'utf8'),
    )
  }
}

function runMigrationCommand(stateDirectory: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      runnerPath,
      ...args,
      '--database',
      'DB',
      '--local',
      '--persist-to',
      stateDirectory,
      '--config',
      join(repoRoot, 'wrangler.toml'),
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

function readCommandOutput<T>(result: ReturnType<typeof runMigrationCommand>): T {
  return JSON.parse(result.stdout) as T
}

function queryD1<T>(stateDirectory: string, sql: string): T[] {
  const result = runD1Sql(stateDirectory, sql)
  if (result.status !== 0) {
    throw new Error(result.stdout || result.stderr)
  }
  const response = JSON.parse(result.stdout) as Array<{ results: T[] }>
  return response[0]?.results ?? []
}

function runD1Sql(stateDirectory: string, sql: string) {
  return spawnSync(
    wranglerPath,
    [
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      stateDirectory,
      '--config',
      join(repoRoot, 'wrangler.toml'),
      '--command',
      sql,
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

function applySqlFile(stateDirectory: string, path: string): void {
  execFileSync(
    wranglerPath,
    [
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      stateDirectory,
      '--config',
      join(repoRoot, 'wrangler.toml'),
      '--file',
      path,
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

function applyCurrentSchemaFixture(stateDirectory: string): void {
  applySqlFile(stateDirectory, currentSchemaPath)
  applySqlFile(stateDirectory, seedTemplatePath)
}

function applyHistoricalAiSchemaFixture(stateDirectory: string): void {
  applySqlFile(stateDirectory, join(canonicalMigrationsPath, '001_initial_schema.sql'))
  queryD1(stateDirectory, 'DROP TABLE ai_actions; DROP TABLE ai_provider_profiles;')
  applySqlFile(stateDirectory, join(historicalMigrationsPath, '002_add_ai_actions.sql'))
  applySqlFile(stateDirectory, join(historicalMigrationsPath, '004_add_ai_provider_profiles.sql'))
}

function applyCurrentSchemaVariant(
  stateDirectory: string,
  replacements: Array<[string, string]>,
): void {
  let schema = readFileSync(currentSchemaPath, 'utf8')
  for (const [current, replacement] of replacements) {
    expect(schema).toContain(current)
    schema = schema.replace(current, replacement)
  }
  const path = join(stateDirectory, 'schema-variant.sql')
  writeFileSync(path, schema)
  applySqlFile(stateDirectory, path)
  applySqlFile(stateDirectory, seedTemplatePath)
}

function expectBaselineRejected(
  stateDirectory: string,
  issues: string[],
  assertRowsUnchanged: () => void = () => {},
): void {
  const schemaBefore = queryD1(
    stateDirectory,
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
  )
  const plan = runMigrationCommand(stateDirectory, 'plan')
  expect(plan.status).toBe(1)
  for (const issue of issues) expect(plan.stderr).toContain(issue)
  expect(queryD1(stateDirectory, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'migration_ledger%'"))
    .toEqual([{ count: 0 }])
  expect(queryD1(
    stateDirectory,
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
  )).toEqual(schemaBefore)
  assertRowsUnchanged()

  const apply = runMigrationCommand(
    stateDirectory,
    'apply',
    '--candidate',
    'drifted-baseline',
  )

  expect(apply.status).toBe(1)
  for (const issue of issues) expect(apply.stderr).toContain(issue)
  expect(
    queryD1<{ count: number }>(
      stateDirectory,
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'migration_ledger%'",
    ),
  ).toEqual([{ count: 0 }])
  expect(queryD1(
    stateDirectory,
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
  )).toEqual(schemaBefore)
  assertRowsUnchanged()
}

function snapshotHistoricalTextAiRows(stateDirectory: string) {
  const result = runD1Sql(stateDirectory, `
SELECT * FROM ai_actions ORDER BY id;
SELECT * FROM ai_provider_profiles ORDER BY id;
SELECT * FROM ai_post_generators ORDER BY id;
SELECT * FROM site_settings ORDER BY key;
SELECT * FROM categories ORDER BY id;
SELECT * FROM posts ORDER BY id;
SELECT * FROM api_tokens ORDER BY id;
`)
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
  const response = JSON.parse(result.stdout) as Array<{ results: unknown[] }>
  return {
    actions: response[0]?.results ?? [],
    profiles: response[1]?.results ?? [],
    generators: response[2]?.results ?? [],
    settings: response[3]?.results ?? [],
    categories: response[4]?.results ?? [],
    posts: response[5]?.results ?? [],
    tokens: response[6]?.results ?? [],
  }
}

function expectHistoricalBaselineRejected(stateDirectory: string, ...issues: string[]): void {
  const rowsBefore = snapshotHistoricalTextAiRows(stateDirectory)
  expectBaselineRejected(
    stateDirectory,
    issues,
    () => expect(snapshotHistoricalTextAiRows(stateDirectory)).toEqual(rowsBefore),
  )
}

function createLedgerContractFixture(stateDirectory: string, tableSql: string): void {
  queryD1(
    stateDirectory,
    `${tableSql};
CREATE TRIGGER migration_ledger_no_update
BEFORE UPDATE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END;
CREATE TRIGGER migration_ledger_no_delete
BEFORE DELETE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END;`,
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of stateDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('D1 migration runner', () => {
  it('applies every canonical migration to an empty D1 database', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'test-candidate-empty',
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(
      queryD1<{ name: string }>(
        stateDirectory,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('posts', 'ai_image_provider_profiles', 'ai_image_actions', 'migration_ledger') ORDER BY name",
      ),
    ).toEqual([
      { name: 'ai_image_actions' },
      { name: 'ai_image_provider_profiles' },
      { name: 'migration_ledger' },
      { name: 'posts' },
    ])
    expect(
      queryD1<{ number: number; candidate_id: string }>(
        stateDirectory,
        'SELECT number, candidate_id FROM migration_ledger ORDER BY number',
      ),
    ).toEqual([
      { number: 1, candidate_id: 'test-candidate-empty' },
      { number: 2, candidate_id: 'test-candidate-empty' },
      { number: 3, candidate_id: 'test-candidate-empty' },
      { number: 4, candidate_id: 'test-candidate-empty' },
      { number: 5, candidate_id: 'test-candidate-empty' },
      { number: 6, candidate_id: 'test-candidate-empty' },
      { number: 7, candidate_id: 'test-candidate-empty' },
    ])
  })

  it('baselines an existing current schema without changing unrelated schema, seed, or data', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
ALTER TABLE ai_actions ADD COLUMN author_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_profiles ADD COLUMN author_note TEXT;
UPDATE ai_actions SET author_rank = 9 WHERE action_key = 'improve';
INSERT INTO posts (slug, title, content, html, status)
VALUES ('kept', 'Kept', 'body', '<p>body</p>', 'draft');
`)
    const schemaBefore = queryD1<{ type: string; name: string; sql: string | null }>(
      stateDirectory,
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('posts_au', 'posts_ad') ORDER BY type, name",
    )
    const seedBefore = queryD1(
      stateDirectory,
      'SELECT action_key, prompt FROM ai_actions ORDER BY action_key',
    )
    expect(queryD1(stateDirectory, "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('ai_actions') WHERE name = 'profile_id'"))
      .toEqual([{ name: 'profile_id', type: 'INTEGER', notnull: 0, dflt_value: null }])
    expect(queryD1(stateDirectory, "SELECT dflt_value FROM pragma_table_info('ai_provider_profiles') WHERE name = 'max_tokens'"))
      .toEqual([{ dflt_value: '2000' }])

    const plan = runMigrationCommand(stateDirectory, 'plan')
    expect(plan.status).toBe(0)
    expect(readCommandOutput<{ pending: Array<{ number: number; action: string }> }>(plan).pending).toEqual([
      expect.objectContaining({ number: 1, action: 'baseline' }),
      expect.objectContaining({ number: 2, action: 'apply' }),
      expect.objectContaining({ number: 3, action: 'apply' }),
      expect.objectContaining({ number: 4, action: 'apply' }),
      expect.objectContaining({ number: 5, action: 'apply' }),
      expect.objectContaining({ number: 6, action: 'apply' }),
      expect.objectContaining({ number: 7, action: 'apply' }),
    ])

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'test-candidate-current',
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(
      queryD1(stateDirectory, "SELECT slug, title, status FROM posts WHERE slug = 'kept'"),
    ).toEqual([{ slug: 'kept', title: 'Kept', status: 'draft' }])
    expect(queryD1(stateDirectory, 'SELECT action_key, prompt FROM ai_actions ORDER BY action_key')).toEqual(seedBefore)
    expect(queryD1(stateDirectory, "SELECT author_rank FROM ai_actions WHERE action_key = 'improve'"))
      .toEqual([{ author_rank: 9 }])
    const existingSchemaAfter = queryD1<{ type: string; name: string; sql: string | null }>(
      stateDirectory,
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name IN (${schemaBefore.map(({ name }) => `'${name.replaceAll("'", "''")}'`).join(', ')})
       ORDER BY type, name`,
    )
    expect(existingSchemaAfter).toEqual(schemaBefore)
    expect(
      queryD1<{ number: number; candidate_id: string }>(
        stateDirectory,
        'SELECT number, candidate_id FROM migration_ledger',
      ),
    ).toEqual([
      { number: 1, candidate_id: 'test-candidate-current' },
      { number: 2, candidate_id: 'test-candidate-current' },
      { number: 3, candidate_id: 'test-candidate-current' },
      { number: 4, candidate_id: 'test-candidate-current' },
      { number: 5, candidate_id: 'test-candidate-current' },
      { number: 6, candidate_id: 'test-candidate-current' },
      { number: 7, candidate_id: 'test-candidate-current' },
    ])
  })

  it('accepts the approved production Text AI schema without legacy index definitions', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applySqlFile(stateDirectory, currentSchemaPath)
    queryD1(stateDirectory, `
DROP INDEX idx_api_tokens_token;
DROP INDEX idx_posts_category;
DROP INDEX idx_posts_published;
DROP INDEX idx_posts_slug;
`)

    const plan = runMigrationCommand(stateDirectory, 'plan')

    expect(plan.stderr).toBe('')
    expect(plan.status).toBe(0)
    expect(readCommandOutput<{ pending: Array<{ number: number; action: string }> }>(plan).pending).toEqual([
      expect.objectContaining({ number: 1, action: 'baseline' }),
      expect.objectContaining({ number: 2, action: 'apply' }),
      expect.objectContaining({ number: 3, action: 'apply' }),
      expect.objectContaining({ number: 4, action: 'apply' }),
      expect.objectContaining({ number: 5, action: 'apply' }),
      expect.objectContaining({ number: 6, action: 'apply' }),
      expect.objectContaining({ number: 7, action: 'apply' }),
    ])
    expect(queryD1(stateDirectory, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'migration_ledger%'"))
      .toEqual([{ count: 0 }])
  })

  it('forward-migrates the repository historical text AI schema without changing author data', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyHistoricalAiSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
ALTER TABLE ai_actions ADD COLUMN author_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_profiles ADD COLUMN author_note TEXT;
UPDATE ai_actions
SET label = '作者操作', description = '作者描述', prompt = '作者提示词', temperature = 0,
    sort_order = 77, is_enabled = 0, is_builtin = 1, author_rank = 9, updated_at = 123456
WHERE action_key = 'improve';
INSERT INTO ai_provider_profiles (
  name, base_url, model, temperature, max_tokens, api_key_encrypted, api_key_masked,
  is_default, created_at, updated_at, author_note
) VALUES (
  '作者历史配置', 'https://legacy.example.com/v1', 'legacy-model', 0, 777,
  'ciphertext', 'masked', 1, 111111, 222222, '作者扩展列'
);
`)
    const actionsBefore = queryD1<{
      action_key: string
      label: string
      description: string
      prompt: string
      temperature: number
      sort_order: number
      is_enabled: number
      is_builtin: number
      created_at: number
      updated_at: number
    }>(stateDirectory, `
SELECT action_key, label, description, prompt, temperature, sort_order,
       is_enabled, is_builtin, created_at, updated_at
FROM ai_actions ORDER BY id
`)
    const profilesBefore = queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id')

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'repository-historical-text-ai',
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT number, name FROM migration_ledger ORDER BY number')).toEqual([
      { number: 1, name: '001_initial_schema' },
      { number: 2, name: '002_add_ai_image_configuration' },
      { number: 3, name: '003_migrate_runtime_ai_configuration' },
      { number: 4, name: '004_complete_historical_text_ai_schema' },
      { number: 5, name: '005_fix_posts_fts_sync' },
      { number: 6, name: '006_add_rollout_safety_controls' },
      { number: 7, name: '007_seed_rollout_executor' },
    ])
    expect(queryD1(stateDirectory, `
SELECT action_key, label, description, prompt, temperature, sort_order,
       is_enabled, is_builtin, created_at, updated_at
FROM ai_actions ORDER BY id
`)).toEqual(actionsBefore)
    expect(queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id')).toEqual(profilesBefore)
    expect(queryD1(stateDirectory, "SELECT dflt_value FROM pragma_table_info('ai_provider_profiles') WHERE name = 'max_tokens'"))
      .toEqual([{ dflt_value: '1200' }])
    expect(queryD1(stateDirectory, "SELECT name, type FROM pragma_table_info('ai_actions') WHERE name = 'profile_id'"))
      .toEqual([{ name: 'profile_id', type: 'INTEGER' }])
    expect(queryD1(stateDirectory, 'SELECT action_key, profile_id FROM ai_actions ORDER BY id'))
      .toEqual(actionsBefore.map((action) => ({ action_key: action.action_key, profile_id: 1 })))
    expect(queryD1(stateDirectory, "SELECT author_rank FROM ai_actions WHERE action_key = 'improve'"))
      .toEqual([{ author_rank: 9 }])
    expect(queryD1(stateDirectory, "SELECT author_note FROM ai_provider_profiles WHERE name = '作者历史配置'"))
      .toEqual([{ author_note: '作者扩展列' }])

    const repeated = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'repository-historical-text-ai-repeat',
    )
    expect(repeated.stderr).toBe('')
    expect(repeated.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM migration_ledger')).toEqual([{ count: 7 }])
  })

  it('accepts the repository historical text AI schema after old runtime ensure and preserves author references', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyHistoricalAiSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
ALTER TABLE ai_actions ADD COLUMN profile_id INTEGER;
INSERT INTO ai_provider_profiles (
  name, base_url, model, max_tokens, api_key_encrypted, api_key_masked,
  is_default, created_at, updated_at
) VALUES
  ('作者非默认配置', 'https://first.example.com/v1', 'first-model', 333, 'first-cipher', 'first-mask', 0, 101, 201),
  ('作者默认配置', 'https://default.example.com/v1', 'default-model', 444, 'default-cipher', 'default-mask', 1, 102, 202);
UPDATE ai_actions SET profile_id = 1, label = '作者固定引用', prompt = '作者固定提示' WHERE action_key = 'improve';
`)
    const profilesBefore = queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id')
    const authoredActionBefore = queryD1(stateDirectory, `
SELECT action_key, label, description, prompt, temperature, sort_order, is_enabled,
       is_builtin, profile_id, created_at, updated_at
FROM ai_actions WHERE action_key = 'improve'
`)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'repository-historical-runtime-ensured',
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT number, name FROM migration_ledger ORDER BY number')).toEqual([
      { number: 1, name: '001_initial_schema' },
      { number: 2, name: '002_add_ai_image_configuration' },
      { number: 3, name: '003_migrate_runtime_ai_configuration' },
      { number: 4, name: '004_complete_historical_text_ai_schema' },
      { number: 5, name: '005_fix_posts_fts_sync' },
      { number: 6, name: '006_add_rollout_safety_controls' },
      { number: 7, name: '007_seed_rollout_executor' },
    ])
    expect(queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id')).toEqual(profilesBefore)
    expect(queryD1(stateDirectory, `
SELECT action_key, label, description, prompt, temperature, sort_order, is_enabled,
       is_builtin, profile_id, created_at, updated_at
FROM ai_actions WHERE action_key = 'improve'
`)).toEqual(authoredActionBefore)
    expect(queryD1(stateDirectory, "SELECT COUNT(*) AS count FROM ai_actions WHERE action_key <> 'improve' AND profile_id = 2"))
      .toEqual([{ count: 5 }])
    expect(queryD1(stateDirectory, "SELECT dflt_value FROM pragma_table_info('ai_provider_profiles') WHERE name = 'max_tokens'"))
      .toEqual([{ dflt_value: '1200' }])

    const repeated = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'repository-historical-runtime-ensured-repeat',
    )
    expect(repeated.stderr).toBe('')
    expect(repeated.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM migration_ledger')).toEqual([{ count: 7 }])
    expect(queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles ORDER BY id')).toEqual(profilesBefore)
  })

  it('rejects text AI baseline shapes that the repository never produced', { timeout: 720_000 }, () => {
    const absentWithCanonicalDefault = createD1State()
    applyCurrentSchemaVariant(absentWithCanonicalDefault, [['  profile_id INTEGER,\n', '']])
    expectHistoricalBaselineRejected(absentWithCanonicalDefault, 'column ai_actions.profile_id semantic drift')

    const wrongProfileType = createD1State()
    applyHistoricalAiSchemaFixture(wrongProfileType)
    queryD1(wrongProfileType, 'ALTER TABLE ai_actions ADD COLUMN profile_id TEXT')
    expectHistoricalBaselineRejected(
      wrongProfileType,
      'historical ai_actions.profile_id semantic drift',
    )

    const wrongLegacyDefault = createD1State()
    applyCurrentSchemaVariant(wrongLegacyDefault, [[
      '  max_tokens INTEGER NOT NULL DEFAULT 2000,\n',
      '  max_tokens INTEGER NOT NULL DEFAULT 999,\n',
    ]])
    expectHistoricalBaselineRejected(
      wrongLegacyDefault,
      'historical ai_provider_profiles.max_tokens semantic drift',
    )

    const canonicalOrderWithHistoricalDefault = createD1State()
    applyCurrentSchemaVariant(canonicalOrderWithHistoricalDefault, [[
      '  max_tokens INTEGER NOT NULL DEFAULT 2000,\n',
      '  max_tokens INTEGER NOT NULL DEFAULT 1200,\n',
    ]])
    expectHistoricalBaselineRejected(
      canonicalOrderWithHistoricalDefault,
      'historical text AI base column order drift',
    )

    const uniqueProfileReference = createD1State()
    applyHistoricalAiSchemaFixture(uniqueProfileReference)
    queryD1(uniqueProfileReference, `
ALTER TABLE ai_actions ADD COLUMN profile_id INTEGER;
CREATE UNIQUE INDEX author_unique_profile_reference ON ai_actions(profile_id);
`)
    expectHistoricalBaselineRejected(uniqueProfileReference, 'historical ai_actions index drift')

    const checkedProfileReference = createD1State()
    applyHistoricalAiSchemaFixture(checkedProfileReference)
    queryD1(checkedProfileReference, 'ALTER TABLE ai_actions ADD COLUMN profile_id INTEGER CHECK (profile_id > 0)')
    expectHistoricalBaselineRejected(checkedProfileReference, 'historical text AI table constraint drift')

    const foreignProfileReference = createD1State()
    applyHistoricalAiSchemaFixture(foreignProfileReference)
    queryD1(
      foreignProfileReference,
      'ALTER TABLE ai_actions ADD COLUMN profile_id INTEGER REFERENCES ai_provider_profiles(id)',
    )
    expectHistoricalBaselineRejected(foreignProfileReference, 'historical text AI foreign key drift')

    const uniqueProviderTokens = createD1State()
    applyHistoricalAiSchemaFixture(uniqueProviderTokens)
    queryD1(
      uniqueProviderTokens,
      'CREATE UNIQUE INDEX author_unique_max_tokens ON ai_provider_profiles(max_tokens)',
    )
    expectHistoricalBaselineRejected(
      uniqueProviderTokens,
      'historical ai_provider_profiles index drift',
    )
  })

  it('audits canonical text AI constraints before baseline registration', { timeout: 1_200_000 }, () => {
    const uniqueIndex = createD1State()
    applyCurrentSchemaFixture(uniqueIndex)
    queryD1(uniqueIndex, 'CREATE UNIQUE INDEX author_unique_profile_id ON ai_actions(profile_id)')
    expectHistoricalBaselineRejected(uniqueIndex, 'historical ai_actions index drift')

    const ordinaryIndex = createD1State()
    applyCurrentSchemaFixture(ordinaryIndex)
    queryD1(ordinaryIndex, 'CREATE INDEX author_profile_id ON ai_actions(profile_id)')
    expectHistoricalBaselineRejected(ordinaryIndex, 'historical ai_actions index drift')

    const trigger = createD1State()
    applyCurrentSchemaFixture(trigger)
    queryD1(trigger, `
CREATE TRIGGER author_profile_guard BEFORE UPDATE ON ai_provider_profiles
BEGIN SELECT 1; END;
`)
    expectHistoricalBaselineRejected(trigger, 'historical text AI trigger drift')

    const checkedColumn = createD1State()
    applyCurrentSchemaFixture(checkedColumn)
    queryD1(checkedColumn, 'ALTER TABLE ai_actions ADD COLUMN author_score INTEGER CHECK (author_score >= 0)')
    expectHistoricalBaselineRejected(checkedColumn, 'historical text AI table constraint drift')

    const foreignColumn = createD1State()
    applyCurrentSchemaFixture(foreignColumn)
    queryD1(
      foreignColumn,
      'ALTER TABLE ai_actions ADD COLUMN author_profile INTEGER REFERENCES ai_provider_profiles(id)',
    )
    expectHistoricalBaselineRejected(foreignColumn, 'historical text AI foreign key drift')

    const collatedColumn = createD1State()
    applyCurrentSchemaFixture(collatedColumn)
    queryD1(
      collatedColumn,
      'ALTER TABLE ai_provider_profiles ADD COLUMN author_note TEXT COLLATE NOCASE',
    )
    expectHistoricalBaselineRejected(collatedColumn, 'historical text AI table constraint drift')
  })

  it('rejects additional canonical text AI table and column identity drift', { timeout: 720_000 }, () => {
    const collatedActionKey = createD1State()
    applyCurrentSchemaVariant(collatedActionKey, [[
      '  action_key TEXT UNIQUE NOT NULL,\n',
      '  action_key TEXT COLLATE NOCASE UNIQUE NOT NULL,\n',
    ]])
    expectHistoricalBaselineRejected(
      collatedActionKey,
      'constraint table ai_actions drift',
    )

    const onConflictColumn = createD1State()
    applyCurrentSchemaFixture(onConflictColumn)
    queryD1(
      onConflictColumn,
      "ALTER TABLE ai_provider_profiles ADD COLUMN author_slug TEXT NOT NULL ON CONFLICT FAIL DEFAULT ''",
    )
    expectHistoricalBaselineRejected(onConflictColumn, 'historical text AI table constraint drift')

    const requiredExtraWithoutDefault = createD1State()
    applyCurrentSchemaFixture(requiredExtraWithoutDefault)
    queryD1(
      requiredExtraWithoutDefault,
      'ALTER TABLE ai_provider_profiles ADD COLUMN author_required TEXT NOT NULL',
    )
    expectHistoricalBaselineRejected(
      requiredExtraWithoutDefault,
      'historical text AI extra column drift',
    )

    const generatedColumn = createD1State()
    applyCurrentSchemaFixture(generatedColumn)
    queryD1(
      generatedColumn,
      'ALTER TABLE ai_provider_profiles ADD COLUMN author_name TEXT GENERATED ALWAYS AS (name) VIRTUAL',
    )
    expectHistoricalBaselineRejected(generatedColumn, 'historical text AI hidden column drift')

    const withoutRowidTable = createD1State()
    applyCurrentSchemaVariant(withoutRowidTable, [
      [
        'CREATE TABLE ai_provider_profiles (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        'CREATE TABLE ai_provider_profiles (\n  id INTEGER PRIMARY KEY,',
      ],
      [
        "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n);\n\n-- 文章元数据生成器配置",
        "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n) WITHOUT ROWID;\n\n-- 文章元数据生成器配置",
      ],
    ])
    expectHistoricalBaselineRejected(
      withoutRowidTable,
      'column ai_provider_profiles.id semantic drift',
      'constraint table ai_provider_profiles drift',
    )

    const strictTable = createD1State()
    applyCurrentSchemaVariant(strictTable, [[
      "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n);\n\n-- 文章元数据生成器配置",
      "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n) STRICT;\n\n-- 文章元数据生成器配置",
    ]])
    expectHistoricalBaselineRejected(strictTable, 'historical text AI table mode drift')
  })

  it('does not create the ledger when an existing schema fails baseline validation', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    queryD1(stateDirectory, 'CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
    const userSchemaBefore = queryD1(
      stateDirectory,
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
    )

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'invalid-baseline',
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Existing schema does not match 001_initial_schema')
    expect(
      queryD1(
        stateDirectory,
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
      ),
    ).toEqual(userSchemaBefore)
    expect(
      queryD1<{ count: number }>(
        stateDirectory,
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_ledger'",
      ),
    ).toEqual([{ count: 0 }])
  })

  it('rejects baseline when a critical column type or constraint has drifted', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaVariant(stateDirectory, [
      ['slug TEXT UNIQUE NOT NULL', 'slug INTEGER UNIQUE'],
    ])

    expectBaselineRejected(stateDirectory, ['column posts.slug'])
  })

  it('rejects baseline when AUTOINCREMENT semantics have drifted', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaVariant(stateDirectory, [
      ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'id INTEGER PRIMARY KEY'],
    ])

    expectBaselineRejected(stateDirectory, ['constraint table posts'])
  })

  it('rejects baseline when a critical index, trigger, or FTS definition has drifted', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaVariant(stateDirectory, [
      ["tokenize='unicode61'", "tokenize='porter'"],
    ])
    queryD1(
      stateDirectory,
      'DROP INDEX idx_posts_published; CREATE INDEX idx_posts_published ON posts(published_at ASC);',
    )
    queryD1(
      stateDirectory,
      'DROP TRIGGER posts_au; CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN DELETE FROM posts_fts WHERE rowid = old.id; END;',
    )

    expectBaselineRejected(
      stateDirectory,
      [
        'definition index idx_posts_published',
        'definition trigger posts_au',
        'definition table posts_fts',
      ],
    )
  })

  it('baselines customized mutable seed data without restoring or overwriting it', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(
      stateDirectory,
      "UPDATE ai_actions SET prompt = 'custom prompt' WHERE action_key = 'improve'; DELETE FROM categories WHERE slug = 'ai'; DELETE FROM ai_post_generators WHERE target_key = 'cover'; INSERT INTO site_settings (key, value) VALUES ('custom', 'kept');",
    )
    const mutableDataBefore = queryD1(
      stateDirectory,
      "SELECT 'category' AS kind, slug AS key, name AS value FROM categories UNION ALL SELECT 'action', action_key, prompt FROM ai_actions UNION ALL SELECT 'generator', target_key, label FROM ai_post_generators UNION ALL SELECT 'setting', key, value FROM site_settings ORDER BY kind, key",
    )

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'mutable-data-baseline',
    )

    expect(result.status).toBe(0)
    expect(
      queryD1(
        stateDirectory,
        "SELECT 'category' AS kind, slug AS key, name AS value FROM categories UNION ALL SELECT 'action', action_key, prompt FROM ai_actions UNION ALL SELECT 'generator', target_key, label FROM ai_post_generators UNION ALL SELECT 'setting', key, value FROM site_settings ORDER BY kind, key",
      ),
    ).toEqual(mutableDataBefore)
    expect(
      queryD1(stateDirectory, 'SELECT number, candidate_id FROM migration_ledger'),
    ).toEqual([
      { number: 1, candidate_id: 'mutable-data-baseline' },
      { number: 2, candidate_id: 'mutable-data-baseline' },
      { number: 3, candidate_id: 'mutable-data-baseline' },
      { number: 4, candidate_id: 'mutable-data-baseline' },
      { number: 5, candidate_id: 'mutable-data-baseline' },
      { number: 6, candidate_id: 'mutable-data-baseline' },
      { number: 7, candidate_id: 'mutable-data-baseline' },
    ])
  })

  it('converges legacy image configuration columns without replacing author data', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
CREATE TABLE ai_image_provider_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom',
  provider_name TEXT NOT NULL DEFAULT '',
  provider_type TEXT NOT NULL DEFAULT 'openai_images',
  provider_category TEXT NOT NULL DEFAULT '',
  api_key_url TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL DEFAULT '',
  api_key_masked TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE TABLE ai_image_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT 'auto',
  quality TEXT NOT NULL DEFAULT 'auto',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
INSERT INTO ai_image_actions (
  action_key, label, description, prompt, size, quality, sort_order, is_builtin
) VALUES
  (
    'author_action', '作者操作', '保留作者配置', 'custom prompt',
    '1536x1024', 'high', 77, 0
  ),
  (
    'mondo_landscape', '作者横图', '同名 builtin 的作者配置', 'author builtin prompt',
    '1024x1536', 'low', 88, 1
  ),
  (
    'mondo_portrait', '作者兜底图', '无法映射时按 builtin key', 'fallback prompt',
    'auto', 'auto', 89, 1
  ),
  (
    'author_unknown', '作者未知图', '未知自定义值保持 canonical auto', 'unknown prompt',
    'panoramic', 'ultra', 90, 0
  );
`)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-image-configuration',
    )

    expect(result.status).toBe(0)
    expect(
      queryD1(stateDirectory, `
SELECT action_key, label, description, prompt, aspect_ratio, resolution,
       size, quality, profile_id, sort_order, is_builtin
FROM ai_image_actions
ORDER BY action_key
`),
    ).toEqual([
      {
        action_key: 'author_action',
        label: '作者操作',
        description: '保留作者配置',
        prompt: 'custom prompt',
        aspect_ratio: '3:2',
        resolution: '4k',
        size: '1536x1024',
        quality: 'high',
        profile_id: null,
        sort_order: 77,
        is_builtin: 0,
      },
      {
        action_key: 'author_unknown',
        label: '作者未知图',
        description: '未知自定义值保持 canonical auto',
        prompt: 'unknown prompt',
        aspect_ratio: 'auto',
        resolution: 'auto',
        size: 'panoramic',
        quality: 'ultra',
        profile_id: null,
        sort_order: 90,
        is_builtin: 0,
      },
      {
        action_key: 'mondo_landscape',
        label: '作者横图',
        description: '同名 builtin 的作者配置',
        prompt: 'author builtin prompt',
        aspect_ratio: '2:3',
        resolution: '1k',
        size: '1024x1536',
        quality: 'low',
        profile_id: null,
        sort_order: 88,
        is_builtin: 1,
      },
      {
        action_key: 'mondo_portrait',
        label: '作者兜底图',
        description: '无法映射时按 builtin key',
        prompt: 'fallback prompt',
        aspect_ratio: '9:16',
        resolution: '2k',
        size: 'auto',
        quality: 'auto',
        profile_id: null,
        sort_order: 89,
        is_builtin: 1,
      },
    ])
    expect(
      queryD1(stateDirectory, 'SELECT number, name FROM migration_ledger ORDER BY number'),
    ).toEqual([
      { number: 1, name: '001_initial_schema' },
      { number: 2, name: '002_add_ai_image_configuration' },
      { number: 3, name: '003_migrate_runtime_ai_configuration' },
      { number: 4, name: '004_complete_historical_text_ai_schema' },
      { number: 5, name: '005_fix_posts_fts_sync' },
      { number: 6, name: '006_add_rollout_safety_controls' },
      { number: 7, name: '007_seed_rollout_executor' },
    ])
  })

  it('accepts a current-full image schema without changing its schema or author rows', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
CREATE TABLE ai_image_provider_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom', provider_name TEXT NOT NULL DEFAULT '',
  provider_type TEXT NOT NULL DEFAULT 'openai_images', provider_category TEXT NOT NULL DEFAULT '',
  api_key_url TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, model TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL DEFAULT '', api_key_masked TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE TABLE ai_image_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT 'auto', resolution TEXT NOT NULL DEFAULT 'auto',
  size TEXT NOT NULL DEFAULT 'auto', quality TEXT NOT NULL DEFAULT 'auto', profile_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0, is_enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
INSERT INTO ai_image_provider_profiles (
  name, base_url, model, is_default, created_at, updated_at
) VALUES ('作者图像配置', 'https://image.example.com/v1', 'author-image', 1, 111, 222);
INSERT INTO ai_image_actions (
  action_key, label, description, prompt, aspect_ratio, resolution,
  size, quality, profile_id, sort_order, is_builtin, created_at, updated_at
) VALUES (
  'mondo_landscape', '作者横图', '作者描述', 'author prompt', '2:3', '1k',
  '1024x1536', 'low', 1, 88, 1, 333, 444
);
`)
    const schemaBefore = queryD1(stateDirectory, `
SELECT type, name, sql FROM sqlite_schema
WHERE name IN ('ai_image_provider_profiles', 'ai_image_actions')
ORDER BY type, name
`)
    const rowsBefore = queryD1(stateDirectory, `
SELECT 'profile' AS kind, json_object('id', id, 'name', name, 'base_url', base_url, 'model', model, 'is_default', is_default, 'created_at', created_at, 'updated_at', updated_at) AS value FROM ai_image_provider_profiles
UNION ALL SELECT 'action', json_object('id', id, 'action_key', action_key, 'label', label, 'description', description, 'prompt', prompt, 'aspect_ratio', aspect_ratio, 'resolution', resolution, 'size', size, 'quality', quality, 'profile_id', profile_id, 'sort_order', sort_order, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_image_actions
ORDER BY kind
`)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'current-full-image',
    )

    expect(result.status).toBe(0)
    expect(queryD1(stateDirectory, `
SELECT type, name, sql FROM sqlite_schema
WHERE name IN ('ai_image_provider_profiles', 'ai_image_actions')
ORDER BY type, name
`)).toEqual(schemaBefore)
    expect(queryD1(stateDirectory, `
SELECT 'profile' AS kind, json_object('id', id, 'name', name, 'base_url', base_url, 'model', model, 'is_default', is_default, 'created_at', created_at, 'updated_at', updated_at) AS value FROM ai_image_provider_profiles
UNION ALL SELECT 'action', json_object('id', id, 'action_key', action_key, 'label', label, 'description', description, 'prompt', prompt, 'aspect_ratio', aspect_ratio, 'resolution', resolution, 'size', size, 'quality', quality, 'profile_id', profile_id, 'sort_order', sort_order, 'is_builtin', is_builtin, 'created_at', created_at, 'updated_at', updated_at) FROM ai_image_actions
ORDER BY kind
`)).toEqual(rowsBefore)
  })

  it('rejects an incompatible image schema before 002 writes or registration', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
CREATE TABLE ai_image_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL, description TEXT NOT NULL, prompt INTEGER NOT NULL,
  size TEXT NOT NULL DEFAULT 'auto', quality TEXT NOT NULL DEFAULT 'auto',
  sort_order INTEGER NOT NULL DEFAULT 0, is_enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`)
    queryD1(stateDirectory, `
UPDATE ai_actions SET prompt = 'author-owned prompt' WHERE action_key = 'improve';
INSERT INTO posts (slug, title, content, html, status)
VALUES ('author-owned', 'Author title', 'Author body', '<p>Author body</p>', 'draft');
`)
    const schemaBefore = queryD1(
      stateDirectory,
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
    )
    const authorRowsBefore = queryD1(stateDirectory, `
SELECT 'action' AS kind, action_key AS row_key, prompt AS value
FROM ai_actions WHERE action_key = 'improve'
UNION ALL
SELECT 'post', slug, json_object('title', title, 'content', content, 'status', status)
FROM posts WHERE slug = 'author-owned'
ORDER BY kind, row_key
`)

    const plan = runMigrationCommand(stateDirectory, 'plan')

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'bad-image-schema',
    )

    expect(plan.status).toBe(1)
    expect(result.status).toBe(1)
    expect(plan.stderr).toBe(result.stderr)
    expect(plan.stderr).toContain('Migration preflight failed for 002_add_ai_image_configuration')
    expect(plan.stderr).toContain('column ai_image_actions.prompt incompatible')
    expect(queryD1(
      stateDirectory,
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
    ))
      .toEqual(schemaBefore)
    expect(queryD1(stateDirectory, `
SELECT 'action' AS kind, action_key AS row_key, prompt AS value
FROM ai_actions WHERE action_key = 'improve'
UNION ALL
SELECT 'post', slug, json_object('title', title, 'content', content, 'status', status)
FROM posts WHERE slug = 'author-owned'
ORDER BY kind, row_key
`)).toEqual(authorRowsBefore)
    expect(queryD1(
      stateDirectory,
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'migration_ledger%'",
    )).toEqual([{ count: 0 }])
  })

  it('migrates legacy AI provider settings once with an explicit encryption secret', { timeout: 300_000 }, async () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
INSERT INTO site_settings (key, value) VALUES
  ('ai_provider_config', '{"provider":"custom","provider_name":"Author AI","provider_type":"openai_compatible","base_url":"https://ai.example.com/v1/","model":"author-model","temperature":0.55,"max_tokens":4096}'),
  ('ai_provider_api_key', 'sk-author-legacy-secret');
`)
    const encryptionSecret = '0123456789abcdef0123456789abcdef'
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', encryptionSecret)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-ai-provider',
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const profiles = queryD1<{
      name: string
      provider_name: string
      base_url: string
      model: string
      temperature: number
      max_tokens: number
      api_key_encrypted: string
      is_default: number
    }>(stateDirectory, `
SELECT name, provider_name, base_url, model, temperature, max_tokens,
       api_key_encrypted, is_default
FROM ai_provider_profiles
`)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      name: '默认配置',
      provider_name: 'Author AI',
      base_url: 'https://ai.example.com/v1',
      model: 'author-model',
      temperature: 0.55,
      max_tokens: 4096,
      is_default: 1,
    })
    expect(profiles[0].api_key_encrypted).toMatch(/^enc:v1:/)
    expect(profiles[0].api_key_encrypted).not.toContain('sk-author-legacy-secret')
    await expect(decryptApiKey(profiles[0].api_key_encrypted, encryptionSecret))
      .resolves.toBe('sk-author-legacy-secret')
    expect(
      queryD1(stateDirectory, `
SELECT key, value FROM site_settings
WHERE key IN ('ai_provider_config', 'ai_provider_api_key')
ORDER BY key
`),
    ).toEqual([
      { key: 'ai_provider_api_key', value: 'sk-author-legacy-secret' },
      {
        key: 'ai_provider_config',
        value: '{"provider":"custom","provider_name":"Author AI","provider_type":"openai_compatible","base_url":"https://ai.example.com/v1/","model":"author-model","temperature":0.55,"max_tokens":4096}',
      },
    ])
    expect(
      queryD1(stateDirectory, 'SELECT number, name FROM migration_ledger ORDER BY number'),
    ).toEqual([
      { number: 1, name: '001_initial_schema' },
      { number: 2, name: '002_add_ai_image_configuration' },
      { number: 3, name: '003_migrate_runtime_ai_configuration' },
      { number: 4, name: '004_complete_historical_text_ai_schema' },
      { number: 5, name: '005_fix_posts_fts_sync' },
      { number: 6, name: '006_add_rollout_safety_controls' },
      { number: 7, name: '007_seed_rollout_executor' },
    ])
  })

  it('rejects legacy AI settings mutated after data preparation without registering stale ledger data', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    applyCurrentSchemaFixture(stateDirectory)
    copyCanonicalMigrationSet(migrationsDirectory)
    queryD1(stateDirectory, `
INSERT INTO site_settings (key, value) VALUES
  ('ai_provider_config', '{"base_url":"https://generation-a.example.com/v1","model":"generation-a"}'),
  ('ai_provider_api_key', 'sk-generation-a');
`)
    const canonicalDataUrl = pathToFileURL(
      join(canonicalMigrationsPath, '003_migrate_runtime_ai_configuration.data.mjs'),
    ).href
    writeFileSync(
      join(migrationsDirectory, '003_migrate_runtime_ai_configuration.data.mjs'),
      `import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepare as prepareCanonical } from ${JSON.stringify(canonicalDataUrl)}

export async function prepare(context) {
  const sql = await prepareCanonical(context)
  const d1Directory = join(${JSON.stringify(stateDirectory)}, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const databaseName = readdirSync(d1Directory).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  if (!databaseName) throw new Error('Local D1 SQLite file not found')
  const result = spawnSync('sqlite3', [
    join(d1Directory, databaseName),
    ${JSON.stringify(`UPDATE site_settings
SET value = CASE key
  WHEN 'ai_provider_config' THEN '{"base_url":"https://generation-b.example.com/v1","model":"generation-b"}'
  WHEN 'ai_provider_api_key' THEN 'sk-generation-b'
END
WHERE key IN ('ai_provider_config', 'ai_provider_api_key');`)},
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
  return sql
}
`,
    )
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', '0123456789abcdef0123456789abcdef')

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-ai-provider-cas',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Legacy AI provider settings changed after migration preparation')
    expect(result.stderr).not.toContain('sk-generation-a')
    expect(result.stderr).not.toContain('sk-generation-b')
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM ai_provider_profiles'))
      .toEqual([{ count: 0 }])
    expect(queryD1(stateDirectory, 'SELECT number FROM migration_ledger ORDER BY number'))
      .toEqual([{ number: 1 }, { number: 2 }])
    expect(queryD1(stateDirectory, `
SELECT key, value FROM site_settings
WHERE key IN ('ai_provider_config', 'ai_provider_api_key')
ORDER BY key
`)).toEqual([
      { key: 'ai_provider_api_key', value: 'sk-generation-b' },
      {
        key: 'ai_provider_config',
        value: '{"base_url":"https://generation-b.example.com/v1","model":"generation-b"}',
      },
    ])
  })

  it.each([
    {
      name: 'missing encryption secret',
      config: '{"base_url":"https://ai.example.com/v1","model":"author-model"}',
      aiSecret: '',
      adminSalt: '',
      error: 'AI_CONFIG_ENCRYPTION_SECRET or ADMIN_TOKEN_SALT must contain at least 32 characters',
    },
    {
      name: 'short AI encryption secret',
      config: '{"base_url":"https://ai.example.com/v1","model":"author-model"}',
      aiSecret: 'too-short-ai-secret',
      adminSalt: 'admin-token-salt-0123456789abcdef',
      error: 'AI_CONFIG_ENCRYPTION_SECRET or ADMIN_TOKEN_SALT must contain at least 32 characters',
    },
    {
      name: 'short ADMIN_TOKEN_SALT fallback',
      config: '{"base_url":"https://ai.example.com/v1","model":"author-model"}',
      aiSecret: '',
      adminSalt: 'too-short-admin-salt',
      error: 'AI_CONFIG_ENCRYPTION_SECRET or ADMIN_TOKEN_SALT must contain at least 32 characters',
    },
    {
      name: 'invalid legacy JSON',
      config: '{not-json',
      aiSecret: '',
      adminSalt: '',
      error: 'Legacy AI provider config is invalid JSON',
    },
  ])('fails closed for $name, then applies 003 exactly once after correction', { timeout: 300_000 }, ({ config, aiSecret, adminSalt, error }) => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
INSERT INTO site_settings (key, value) VALUES
  ('ai_provider_config', '${config.replaceAll("'", "''")}'),
  ('ai_provider_api_key', 'sk-never-print-this-key');
`)
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', aiSecret)
    vi.stubEnv('ADMIN_TOKEN_SALT', adminSalt)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-ai-provider-invalid',
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
    expect(result.stderr).not.toContain('sk-never-print-this-key')
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM ai_provider_profiles')).toEqual([{ count: 0 }])
    expect(queryD1(stateDirectory, 'SELECT number FROM migration_ledger ORDER BY number')).toEqual([
      { number: 1 },
      { number: 2 },
    ])
    expect(queryD1(stateDirectory, "SELECT value FROM site_settings WHERE key = 'ai_provider_api_key'"))
      .toEqual([{ value: 'sk-never-print-this-key' }])

    queryD1(stateDirectory, `
UPDATE site_settings
SET value = '{"base_url":"https://retry.example.com/v1","model":"retry-model"}'
WHERE key = 'ai_provider_config';
`)
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', 'retry-secret-0123456789abcdef012345')
    const retry = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-ai-provider-retry',
    )
    expect(retry.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT number FROM migration_ledger ORDER BY number')).toEqual([
      { number: 1 },
      { number: 2 },
      { number: 3 },
      { number: 4 },
      { number: 5 },
      { number: 6 },
      { number: 7 },
    ])
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM ai_provider_profiles')).toEqual([{ count: 1 }])

    const repeated = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-ai-provider-noop',
    )
    expect(repeated.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM ai_provider_profiles')).toEqual([{ count: 1 }])
  })

  it('uses a sufficiently long ADMIN_TOKEN_SALT for legacy deployments without an AI-specific secret', { timeout: 300_000 }, async () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
INSERT INTO site_settings (key, value) VALUES
  ('ai_provider_config', '{"base_url":"https://salt.example.com/v1","model":"salt-model"}'),
  ('ai_provider_api_key', 'sk-admin-salt-legacy');
`)
    const adminSalt = 'admin-token-salt-0123456789abcdef'
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', '')
    vi.stubEnv('ADMIN_TOKEN_SALT', adminSalt)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'legacy-admin-salt',
    )

    expect(result.status).toBe(0)
    const profile = queryD1<{ api_key_encrypted: string }>(
      stateDirectory,
      'SELECT api_key_encrypted FROM ai_provider_profiles',
    )[0]
    await expect(decryptApiKey(profile.api_key_encrypted, adminSalt)).resolves.toBe('sk-admin-salt-legacy')
  })

  it('rolls back 003 data and ledger registration together when its batch fails, then retries cleanly', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    for (const name of [
      '001_initial_schema.sql',
      '001_initial_schema.baseline.sql',
      '002_add_ai_image_configuration.sql',
      '002_add_ai_image_configuration.preflight.sql',
    ]) {
      writeFileSync(
        join(migrationsDirectory, name),
        readFileSync(join(canonicalMigrationsPath, name), 'utf8'),
      )
    }
    applyCurrentSchemaFixture(stateDirectory)
    const baseline = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'batch-failure-baseline',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(baseline.status).toBe(0)
    for (const name of [
      '003_migrate_runtime_ai_configuration.sql',
      '003_migrate_runtime_ai_configuration.data.mjs',
      '004_complete_historical_text_ai_schema.sql',
      '004_complete_historical_text_ai_schema.baseline.sql',
    ]) {
      writeFileSync(
        join(migrationsDirectory, name),
        readFileSync(join(canonicalMigrationsPath, name), 'utf8'),
      )
    }
    queryD1(stateDirectory, `
INSERT INTO site_settings (key, value) VALUES
  ('ai_provider_config', '{"base_url":"https://batch.example.com/v1","model":"batch-model"}'),
  ('ai_provider_api_key', 'sk-batch-rollback');
CREATE TRIGGER reject_legacy_profile
BEFORE INSERT ON ai_provider_profiles BEGIN
  SELECT RAISE(ABORT, 'intentional 003 batch failure');
END;
`)
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', 'batch-secret-0123456789abcdef012345')
    const generatorsBefore = queryD1(stateDirectory, 'SELECT * FROM ai_post_generators ORDER BY target_key')

    const failed = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'batch-failure',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('intentional 003 batch failure')
    expect(failed.stderr).not.toContain('sk-batch-rollback')
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM ai_provider_profiles')).toEqual([{ count: 0 }])
    expect(queryD1(stateDirectory, 'SELECT * FROM ai_post_generators ORDER BY target_key')).toEqual(generatorsBefore)
    expect(queryD1(stateDirectory, 'SELECT number FROM migration_ledger ORDER BY number')).toEqual([
      { number: 1 },
      { number: 2 },
    ])

    queryD1(stateDirectory, 'DROP TRIGGER reject_legacy_profile')
    const retry = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'batch-retry',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(retry.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT COUNT(*) AS count FROM ai_provider_profiles')).toEqual([{ count: 1 }])
    expect(queryD1(stateDirectory, 'SELECT number FROM migration_ledger ORDER BY number')).toEqual([
      { number: 1 },
      { number: 2 },
      { number: 3 },
      { number: 4 },
    ])
  })

  it('never parses legacy settings or overwrites an existing provider profile', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
INSERT INTO ai_provider_profiles (
  name, provider, provider_name, provider_type, provider_category, api_key_url,
  base_url, model, temperature, max_tokens, api_key_encrypted, api_key_masked,
  is_default, created_at, updated_at
) VALUES (
  '作者保留配置', 'custom', 'Author', 'openai_compatible', 'text', 'https://keys.example.com',
  'https://kept.example.com/v1', 'kept-model', 0.33, 1234, 'enc:v1:kept', 'kept-mask',
  1, 111, 222
);
INSERT INTO site_settings (key, value) VALUES
  ('ai_provider_config', '{invalid-json'),
  ('ai_provider_api_key', 'sk-legacy-must-remain');
`)
    vi.stubEnv('AI_CONFIG_ENCRYPTION_SECRET', 'wrong-but-long-enough-000000000000')
    const before = queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles')

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'existing-profile-wins',
    )

    expect(result.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT * FROM ai_provider_profiles')).toEqual(before)
    expect(queryD1(stateDirectory, "SELECT key, value FROM site_settings WHERE key LIKE 'ai_provider_%' ORDER BY key"))
      .toEqual([
        { key: 'ai_provider_api_key', value: 'sk-legacy-must-remain' },
        { key: 'ai_provider_config', value: '{invalid-json' },
      ])
  })

  it('preserves custom generator prompts and does not restore deleted generators', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
UPDATE ai_post_generators
SET label = '作者摘要', description = '作者描述', prompt = 'author custom prompt',
    temperature = 0, max_tokens = 1, updated_at = 123456
WHERE target_key = 'summary';
UPDATE ai_post_generators
SET label = '作者标签', description = '作者标签描述', prompt = 'author tags prompt',
    temperature = 2, max_tokens = 32768, updated_at = 234567
WHERE target_key = 'tags';
DELETE FROM ai_post_generators WHERE target_key = 'cover';
`)
    const before = queryD1(
      stateDirectory,
      "SELECT * FROM ai_post_generators WHERE target_key IN ('summary', 'tags') ORDER BY target_key",
    )

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'generator-compatibility',
    )

    expect(result.status).toBe(0)
    expect(queryD1(
      stateDirectory,
      "SELECT * FROM ai_post_generators WHERE target_key IN ('summary', 'tags') ORDER BY target_key",
    ))
      .toEqual(before)
    expect(queryD1(stateDirectory, "SELECT COUNT(*) AS count FROM ai_post_generators WHERE target_key = 'cover'"))
      .toEqual([{ count: 0 }])
  })

  it('fills blank built-in defaults for all four generator targets', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    queryD1(stateDirectory, `
UPDATE ai_post_generators
SET label = '', description = '', prompt = '', workers_model = '',
    provider_mode = '', aspect_ratio = '', resolution = '', temperature = -1, max_tokens = 0
WHERE target_key IN ('summary', 'tags', 'slug', 'cover');
`)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'generator-blank-and-legacy',
    )

    expect(result.status).toBe(0)
    const rows = queryD1<{
      target_key: string
      label: string
      description: string
      prompt: string
      workers_model: string
      provider_mode: string
      aspect_ratio: string
      resolution: string
      temperature: number
      max_tokens: number
    }>(stateDirectory, `
SELECT target_key, label, description, prompt, workers_model, provider_mode,
       aspect_ratio, resolution, temperature, max_tokens
FROM ai_post_generators
ORDER BY target_key
`)
    const byTarget = new Map(rows.map((row) => [row.target_key, row]))
    for (const target of ['summary', 'tags', 'slug', 'cover'] as const) {
      const expected = DEFAULT_GENERATORS.find((item) => item.target_key === target)
      expect(byTarget.get(target)).toMatchObject({
        label: expected?.label,
        description: expected?.description,
        prompt: expected?.prompt,
        workers_model: expected?.workers_model,
        provider_mode: expected?.provider_mode,
        aspect_ratio: expected?.aspect_ratio,
        resolution: expected?.resolution,
        temperature: expected?.temperature,
        max_tokens: expected?.max_tokens,
      })
    }
  })

  it('upgrades a known legacy prompt without replacing non-empty author labels or descriptions', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaFixture(stateDirectory)
    const legacySummaryPrompt = LEGACY_PROMPT_VARIANTS.summary?.[0]
    expect(legacySummaryPrompt).toBeTruthy()
    queryD1(stateDirectory, `
UPDATE ai_post_generators
SET label = '作者摘要标签', description = '作者摘要描述',
    prompt = '${legacySummaryPrompt?.replaceAll("'", "''")}', updated_at = 123456
WHERE target_key = 'summary';
`)

    const result = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'generator-legacy-author-labels',
    )

    expect(result.status).toBe(0)
    expect(queryD1(stateDirectory, `
SELECT label, description, prompt
FROM ai_post_generators WHERE target_key = 'summary'
`)).toEqual([{
      label: '作者摘要标签',
      description: '作者摘要描述',
      prompt: DEFAULT_GENERATORS.find((item) => item.target_key === 'summary')?.prompt,
    }])
  })

  it('keeps plan and status read-only, verifies completeness, and makes repeated apply a no-op', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()

    const plan = runMigrationCommand(stateDirectory, 'plan')
    const status = runMigrationCommand(stateDirectory, 'status')
    const verifyBeforeApply = runMigrationCommand(stateDirectory, 'verify')

    expect(plan.status).toBe(0)
    expect(readCommandOutput<{ state: string; pending: unknown[] }>(plan)).toMatchObject({
      state: 'pending',
      pending: [
        { number: 1, name: '001_initial_schema' },
        { number: 2, name: '002_add_ai_image_configuration' },
        { number: 3, name: '003_migrate_runtime_ai_configuration' },
        { number: 4, name: '004_complete_historical_text_ai_schema' },
        { number: 5, name: '005_fix_posts_fts_sync' },
        { number: 6, name: '006_add_rollout_safety_controls' },
        { number: 7, name: '007_seed_rollout_executor' },
      ],
    })
    expect(status.status).toBe(0)
    expect(readCommandOutput<{ state: string }>(status).state).toBe('uninitialized')
    expect(verifyBeforeApply.status).toBe(1)
    expect(verifyBeforeApply.stderr).toContain('Pending migrations: 001_initial_schema')
    expect(
      queryD1<{ count: number }>(
        stateDirectory,
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_ledger'",
      ),
    ).toEqual([{ count: 0 }])

    const firstApply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'test-candidate-first',
    )
    const ledgerAfterFirstApply = queryD1(
      stateDirectory,
      'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
    )
    const businessStateAfterFirstApply = queryD1(
      stateDirectory,
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
    )
    expect(
      queryD1(
        stateDirectory,
        'SELECT (SELECT COUNT(*) FROM categories) AS categories, (SELECT COUNT(*) FROM ai_actions) AS ai_actions, (SELECT COUNT(*) FROM ai_post_generators) AS ai_post_generators, (SELECT COUNT(*) FROM site_settings) AS site_settings',
      ),
    ).toEqual([{ categories: 3, ai_actions: 6, ai_post_generators: 4, site_settings: 3 }])
    queryD1(
      stateDirectory,
      "UPDATE ai_actions SET prompt = 'kept on rerun' WHERE action_key = 'improve'; DELETE FROM categories WHERE slug = 'ai'; UPDATE site_settings SET value = 'custom-theme' WHERE key = 'default_theme';",
    )
    const mutableDataBeforeSecondApply = queryD1(
      stateDirectory,
      "SELECT 'category' AS kind, slug AS key, name AS value FROM categories UNION ALL SELECT 'action', action_key, prompt FROM ai_actions UNION ALL SELECT 'setting', key, value FROM site_settings ORDER BY kind, key",
    )

    const secondApply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'test-candidate-second',
    )
    const verifyAfterApply = runMigrationCommand(stateDirectory, 'verify')

    expect(firstApply.status).toBe(0)
    expect(secondApply.status).toBe(0)
    expect(readCommandOutput<{ state: string; pending: unknown[] }>(secondApply)).toMatchObject({
      state: 'current',
      pending: [],
    })
    expect(verifyAfterApply.status).toBe(0)
    expect(readCommandOutput<{ state: string }>(verifyAfterApply).state).toBe('verified')
    expect(
      queryD1(
        stateDirectory,
        'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
      ),
    ).toEqual(ledgerAfterFirstApply)
    expect(
      queryD1(
        stateDirectory,
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
      ),
    ).toEqual(businessStateAfterFirstApply)
    expect(
      queryD1(
        stateDirectory,
        "SELECT 'category' AS kind, slug AS key, name AS value FROM categories UNION ALL SELECT 'action', action_key, prompt FROM ai_actions UNION ALL SELECT 'setting', key, value FROM site_settings ORDER BY kind, key",
      ),
    ).toEqual(mutableDataBeforeSecondApply)
  })

  it('rejects direct updates and deletes from the immutable migration ledger', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const apply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'immutable-original',
    )
    expect(apply.status).toBe(0)
    const originalLedger = queryD1(
      stateDirectory,
      'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger',
    )

    const update = runD1Sql(
      stateDirectory,
      "UPDATE migration_ledger SET candidate_id = 'mutated' WHERE number = 1",
    )
    const deletion = runD1Sql(stateDirectory, 'DELETE FROM migration_ledger WHERE number = 1')

    expect(update.status).toBe(1)
    expect(update.stdout).toContain('migration ledger rows are immutable')
    expect(deletion.status).toBe(1)
    expect(deletion.stdout).toContain('migration ledger rows are immutable')
    expect(
      queryD1(
        stateDirectory,
        'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger',
      ),
    ).toEqual(originalLedger)
  })

  it('rejects INSERT OR REPLACE when recursive delete triggers are disabled', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const apply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'replace-original',
    )
    expect(apply.status).toBe(0)
    const originalLedger = queryD1(
      stateDirectory,
      'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger',
    )

    const replacement = runD1Sql(
      stateDirectory,
      `
PRAGMA recursive_triggers = OFF;
INSERT OR REPLACE INTO migration_ledger (number, name, checksum, candidate_id)
SELECT number, name, checksum, 'replace-tampered'
FROM migration_ledger WHERE number = 1;
`,
    )

    expect(replacement.status).toBe(1)
    expect(replacement.stdout).toContain('migration ledger rows are immutable')
    expect(
      queryD1(
        stateDirectory,
        'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger',
      ),
    ).toEqual(originalLedger)
  })

  it('fails verify and apply when the update guard trigger is replaced', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const initialApply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'guard-original',
    )
    expect(initialApply.status).toBe(0)
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    copyCanonicalBaseline(migrationsDirectory)
    writeMigration(
      migrationsDirectory,
      2,
      'must_not_run',
      'CREATE TABLE must_not_run (id INTEGER PRIMARY KEY);',
    )
    queryD1(
      stateDirectory,
      "DROP TRIGGER migration_ledger_no_update; CREATE TRIGGER migration_ledger_no_update BEFORE UPDATE ON migration_ledger BEGIN SELECT 1; END;",
    )

    const verify = runMigrationCommand(
      stateDirectory,
      'verify',
      '--migrations-dir',
      migrationsDirectory,
    )
    const apply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'guard-tampered',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(verify.status).toBe(1)
    expect(verify.stderr).toContain('Migration ledger contract drift: trigger migration_ledger_no_update')
    expect(apply.status).toBe(1)
    expect(apply.stderr).toContain('Migration ledger contract drift: trigger migration_ledger_no_update')
    expect(
      queryD1<{ count: number }>(
        stateDirectory,
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'must_not_run'",
      ),
    ).toEqual([{ count: 0 }])
    expect(queryD1(stateDirectory, 'SELECT number, candidate_id FROM migration_ledger')).toEqual([
      { number: 1, candidate_id: 'guard-original' },
      { number: 2, candidate_id: 'guard-original' },
      { number: 3, candidate_id: 'guard-original' },
      { number: 4, candidate_id: 'guard-original' },
      { number: 5, candidate_id: 'guard-original' },
      { number: 6, candidate_id: 'guard-original' },
      { number: 7, candidate_id: 'guard-original' },
    ])
  })

  it('fails plan and status when a ledger guard trigger is missing', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const initialApply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'missing-guard',
    )
    expect(initialApply.status).toBe(0)
    queryD1(stateDirectory, 'DROP TRIGGER migration_ledger_no_delete')

    const plan = runMigrationCommand(stateDirectory, 'plan')
    const status = runMigrationCommand(stateDirectory, 'status')

    expect(plan.status).toBe(1)
    expect(plan.stderr).toContain('Migration ledger contract drift: trigger migration_ledger_no_delete')
    expect(status.status).toBe(1)
    expect(status.stderr).toContain('Migration ledger contract drift: trigger migration_ledger_no_delete')
  })

  it('fails closed when the migration ledger table contract has drifted', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    createLedgerContractFixture(
      stateDirectory,
      `
CREATE TABLE migration_ledger (
  number INTEGER PRIMARY KEY CHECK(number > 0),
  name TEXT UNIQUE NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0)
)`,
    )

    const verify = runMigrationCommand(stateDirectory, 'verify')

    expect(verify.status).toBe(1)
    expect(verify.stderr).toContain('Migration ledger contract drift: table migration_ledger')
  })

  it('fails closed when a ledger default string literal has drifted', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    createLedgerContractFixture(
      stateDirectory,
      `
CREATE TABLE migration_ledger (
  number INTEGER PRIMARY KEY CHECK(number > 0),
  name TEXT UNIQUE NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dt%H:%M:%fZ', 'now')),
  candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0)
) STRICT`,
    )

    const verify = runMigrationCommand(stateDirectory, 'verify')

    expect(verify.status).toBe(1)
    expect(verify.stderr).toContain('Migration ledger contract drift: table migration_ledger')
  })

  it('fails plan and status when a same-name ledger view is present', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    queryD1(
      stateDirectory,
      'CREATE VIEW migration_ledger AS SELECT 1 AS number, \'view\' AS name, \'checksum\' AS checksum, \'now\' AS applied_at, \'candidate\' AS candidate_id',
    )

    const schemaBefore = queryD1(
      stateDirectory,
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    const plan = runMigrationCommand(stateDirectory, 'plan')
    const status = runMigrationCommand(stateDirectory, 'status')
    const apply = runMigrationCommand(stateDirectory, 'apply', '--candidate', 'same-name-view')

    expect(plan.status).toBe(1)
    expect(plan.stderr).toContain('Migration ledger contract drift: table migration_ledger')
    expect(status.status).toBe(1)
    expect(status.stderr).toBe(plan.stderr)
    expect(apply.status).toBe(1)
    expect(apply.stderr).toBe(plan.stderr)
    expect(queryD1(
      stateDirectory,
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )).toEqual(schemaBefore)
  })

  it('fails closed for a case-variant ledger artifact name', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    queryD1(
      stateDirectory,
      'CREATE VIEW MIGRATION_LEDGER AS SELECT 1 AS number, \'view\' AS name, \'checksum\' AS checksum, \'now\' AS applied_at, \'candidate\' AS candidate_id',
    )

    const status = runMigrationCommand(stateDirectory, 'status')

    expect(status.status).toBe(1)
    expect(status.stderr).toContain('Migration ledger contract drift: table migration_ledger')
  })

  it('plans and applies only migrations after the applied ledger prefix', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    writeMigration(migrationsDirectory, 1, 'create_alpha', 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);')

    const firstApply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'partial-first',
      '--migrations-dir',
      migrationsDirectory,
    )
    writeMigration(migrationsDirectory, 2, 'create_beta', 'CREATE TABLE beta (id INTEGER PRIMARY KEY);')

    const plan = runMigrationCommand(
      stateDirectory,
      'plan',
      '--migrations-dir',
      migrationsDirectory,
    )
    const secondApply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'partial-second',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(firstApply.status).toBe(0)
    expect(plan.status).toBe(0)
    expect(readCommandOutput<{ pending: Array<{ number: number }> }>(plan).pending).toEqual([
      expect.objectContaining({ number: 2 }),
    ])
    expect(secondApply.status).toBe(0)
    expect(
      queryD1(
        stateDirectory,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('alpha', 'beta') ORDER BY name",
      ),
    ).toEqual([{ name: 'alpha' }, { name: 'beta' }])
    expect(
      queryD1(stateDirectory, 'SELECT number, candidate_id FROM migration_ledger ORDER BY number'),
    ).toEqual([
      { number: 1, candidate_id: 'partial-first' },
      { number: 2, candidate_id: 'partial-second' },
    ])
  })

  it('rejects missing and out-of-order migration declarations before touching D1', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    writeMigration(migrationsDirectory, 1, 'first', 'SELECT 1;')
    writeMigration(migrationsDirectory, 3, 'third', 'SELECT 3;')

    const missingNumber = runMigrationCommand(
      stateDirectory,
      'plan',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(missingNumber.status).toBe(1)
    expect(missingNumber.stderr).toContain('expected 002, found 003')

    rmSync(migrationsDirectory, { recursive: true })
    mkdirSync(migrationsDirectory)
    writeFileSync(
      join(migrationsDirectory, '001_declared_second.sql'),
      '-- migration-number: 002\nSELECT 1;\n',
    )
    const outOfOrder = runMigrationCommand(
      stateDirectory,
      'plan',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(outOfOrder.status).toBe(1)
    expect(outOfOrder.stderr).toContain('declaration does not match filename')
    expect(
      queryD1<{ count: number }>(
        stateDirectory,
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_ledger'",
      ),
    ).toEqual([{ count: 0 }])
  })

  it('rejects checksum drift without rewriting the applied ledger', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    writeMigration(migrationsDirectory, 1, 'stable', 'CREATE TABLE stable (id INTEGER PRIMARY KEY);')
    const apply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'checksum-original',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(apply.status).toBe(0)
    const originalLedger = queryD1(
      stateDirectory,
      'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger',
    )

    writeMigration(
      migrationsDirectory,
      1,
      'stable',
      'CREATE TABLE stable (id INTEGER PRIMARY KEY, changed TEXT);',
    )
    const verify = runMigrationCommand(
      stateDirectory,
      'verify',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(verify.status).toBe(1)
    expect(verify.stderr).toContain('Checksum drift detected for migration 001_stable')
    expect(
      queryD1(
        stateDirectory,
        'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger',
      ),
    ).toEqual(originalLedger)
  })

  it('includes conditional preflight and data sidecars in the immutable checksum', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const applied = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'sidecar-checksum-original',
    )
    expect(applied.stderr).toBe('')
    expect(applied.status).toBe(0)
    const originalLedger = queryD1(
      stateDirectory,
      'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
    )
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    copyCanonicalMigrationSet(migrationsDirectory)

    const preflightPath = join(migrationsDirectory, '002_add_ai_image_configuration.preflight.sql')
    const originalPreflight = readFileSync(preflightPath, 'utf8')
    writeFileSync(preflightPath, `${originalPreflight}\n-- drift\n`)
    const preflightVerify = runMigrationCommand(
      stateDirectory,
      'verify',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(preflightVerify.status).toBe(1)
    expect(preflightVerify.stderr).toContain('Checksum drift detected for migration 002_add_ai_image_configuration')

    writeFileSync(preflightPath, originalPreflight)
    const dataPath = join(migrationsDirectory, '003_migrate_runtime_ai_configuration.data.mjs')
    const originalData = readFileSync(dataPath, 'utf8')
    writeFileSync(dataPath, `${originalData}\n// drift\n`)
    const dataVerify = runMigrationCommand(
      stateDirectory,
      'verify',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(dataVerify.status).toBe(1)
    expect(dataVerify.stderr).toContain('Checksum drift detected for migration 003_migrate_runtime_ai_configuration')

    writeFileSync(dataPath, originalData)
    const compatibilityBaselinePath = join(
      migrationsDirectory,
      '004_complete_historical_text_ai_schema.baseline.sql',
    )
    writeFileSync(
      compatibilityBaselinePath,
      `${readFileSync(compatibilityBaselinePath, 'utf8')}\n-- drift\n`,
    )
    const compatibilityBaselineVerify = runMigrationCommand(
      stateDirectory,
      'verify',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(compatibilityBaselineVerify.status).toBe(1)
    expect(compatibilityBaselineVerify.stderr)
      .toContain('Checksum drift detected for migration 004_complete_historical_text_ai_schema')
    expect(queryD1(
      stateDirectory,
      'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
    )).toEqual(originalLedger)
  })

  it('executes the exact data sidecar bytes covered by the ledger checksum', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    const secondDataPath = join(migrationsDirectory, '002_data.data.mjs')
    const tamperedSource = `export async function prepare() { return "INSERT INTO sidecar_result(value) VALUES ('tampered');" }\n`

    writeMigration(
      migrationsDirectory,
      1,
      'bootstrap',
      'CREATE TABLE sidecar_result (value TEXT NOT NULL);',
    )
    writeFileSync(
      join(migrationsDirectory, '001_bootstrap.data.mjs'),
      `import { writeFileSync } from 'node:fs'\nexport async function prepare() { writeFileSync(${JSON.stringify(secondDataPath)}, ${JSON.stringify(tamperedSource)}); return '' }\n`,
    )
    writeMigration(migrationsDirectory, 2, 'data', 'SELECT 1;')
    writeFileSync(
      secondDataPath,
      `export async function prepare() { return "INSERT INTO sidecar_result(value) VALUES ('original');" }\n`,
    )

    const applied = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'sidecar-source-binding',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(applied.stderr).toBe('')
    expect(applied.status).toBe(0)
    expect(queryD1(stateDirectory, 'SELECT value FROM sidecar_result')).toEqual([{ value: 'original' }])
    expect(readFileSync(secondDataPath, 'utf8')).toBe(tamperedSource)
    const verify = runMigrationCommand(
      stateDirectory,
      'verify',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(verify.status).toBe(1)
    expect(verify.stderr).toContain('Checksum drift detected for migration 002_data')
  })

  it('rejects mutating preflight and data sidecar queries without changing database state', { timeout: 300_000 }, () => {
    const cases = [
      {
        name: 'preflight-with-update',
        companion: 'preflight.sql',
        source: `
WITH target AS (SELECT id FROM business_state)
UPDATE business_state SET value = 'preflight-tampered'
WHERE id IN (SELECT id FROM target);
`,
      },
      {
        name: 'data-with-update',
        companion: 'data.mjs',
        source: `
export async function prepare({ query }) {
  query("WITH target AS (SELECT id FROM business_state) UPDATE business_state SET value = 'data-tampered' WHERE id IN (SELECT id FROM target)")
  return ''
}
`,
      },
      {
        name: 'data-write-pragma',
        companion: 'data.mjs',
        source: `
export async function prepare({ query }) {
  query('PRAGMA foreign_keys = OFF')
  return ''
}
`,
      },
      {
        name: 'data-multiple-statements',
        companion: 'data.mjs',
        source: `
export async function prepare({ query }) {
  query("SELECT value FROM business_state; UPDATE business_state SET value = 'multi-tampered'")
  return ''
}
`,
      },
    ]

    for (const attack of cases) {
      const stateDirectory = createD1State()
      const migrationsDirectory = createMigrationsDirectory(stateDirectory)
      writeMigration(
        migrationsDirectory,
        1,
        'bootstrap',
        "CREATE TABLE business_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO business_state VALUES (1, 'original');",
      )
      const bootstrap = runMigrationCommand(
        stateDirectory,
        'apply',
        '--candidate',
        `${attack.name}-bootstrap`,
        '--migrations-dir',
        migrationsDirectory,
      )
      expect(bootstrap.status).toBe(0)

      const schemaBefore = queryD1(
        stateDirectory,
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      const rowsBefore = queryD1(stateDirectory, 'SELECT * FROM business_state ORDER BY id')
      const pragmaBefore = queryD1(stateDirectory, 'SELECT foreign_keys FROM pragma_foreign_keys()')
      const ledgerBefore = queryD1(
        stateDirectory,
        'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
      )

      writeMigration(
        migrationsDirectory,
        2,
        'protected',
        'CREATE TABLE sidecar_should_not_exist (id INTEGER PRIMARY KEY);',
      )
      writeFileSync(
        join(migrationsDirectory, `002_protected.${attack.companion}`),
        attack.source,
      )

      const apply = runMigrationCommand(
        stateDirectory,
        'apply',
        '--candidate',
        attack.name,
        '--migrations-dir',
        migrationsDirectory,
      )

      expect(apply.status).toBe(1)
      expect(apply.stderr).toContain('read-only')
      expect(queryD1(
        stateDirectory,
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )).toEqual(schemaBefore)
      expect(queryD1(stateDirectory, 'SELECT * FROM business_state ORDER BY id')).toEqual(rowsBefore)
      expect(queryD1(stateDirectory, 'SELECT foreign_keys FROM pragma_foreign_keys()')).toEqual(pragmaBefore)
      expect(queryD1(
        stateDirectory,
        'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
      )).toEqual(ledgerBefore)
    }
  })

  it('captures the schema guard before the final per-migration preflight', () => {
    const runnerSource = readFileSync(runnerPath, 'utf8')
    const applyStart = runnerSource.indexOf('async function applyMigrations')
    const applyEnd = runnerSource.indexOf('\nasync function main()', applyStart)
    const applySource = runnerSource.slice(applyStart, applyEnd)

    expect(applySource.indexOf('let fingerprint = readSchemaFingerprint(client)'))
      .toBeLessThan(applySource.indexOf('validateMigrationPreflight(client, migration)'))
  })

  it('atomically rejects affected-schema drift between preflight and migration writes', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    writeMigration(
      migrationsDirectory,
      1,
      'guarded_object',
      'CREATE TABLE IF NOT EXISTS guarded_object (id INTEGER PRIMARY KEY);',
    )
    writeFileSync(
      join(migrationsDirectory, '001_guarded_object.preflight.sql'),
      `SELECT 'guarded_object has incompatible identity' AS issue
FROM sqlite_schema
WHERE lower(name) = 'guarded_object' AND type <> 'table';
`,
    )
    writeFileSync(
      join(migrationsDirectory, '001_guarded_object.data.mjs'),
      `import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
export async function prepare() {
  const d1Directory = join(${JSON.stringify(stateDirectory)}, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const databaseName = readdirSync(d1Directory).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  if (!databaseName) throw new Error('Local D1 SQLite file not found')
  const result = spawnSync('sqlite3', [
    join(d1Directory, databaseName),
    'CREATE VIEW guarded_object AS SELECT 1 AS id',
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
  return ''
}
`,
    )

    const apply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'schema-drift',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(apply.status).toBe(1)
    expect(apply.stderr).toContain('Database schema changed after migration preflight')
    expect(queryD1(
      stateDirectory,
      "SELECT type, name FROM sqlite_schema WHERE name IN ('guarded_object', 'migration_ledger') ORDER BY name",
    )).toEqual([{ type: 'view', name: 'guarded_object' }])
  })

  it('rolls back an intentionally failed migration, leaves it unregistered, and stops later migrations', { timeout: 300_000 }, () => {
    const stateDirectory = createD1State()
    const migrationsDirectory = createMigrationsDirectory(stateDirectory)
    writeMigration(migrationsDirectory, 1, 'first', 'CREATE TABLE first_marker (id INTEGER PRIMARY KEY);')
    writeMigration(
      migrationsDirectory,
      2,
      'intentional_failure',
      `
CREATE TABLE failed_marker (id INTEGER PRIMARY KEY);
INSERT INTO table_that_does_not_exist (id) VALUES (1);
`,
    )
    writeMigration(migrationsDirectory, 3, 'later', 'CREATE TABLE later_marker (id INTEGER PRIMARY KEY);')

    const apply = runMigrationCommand(
      stateDirectory,
      'apply',
      '--candidate',
      'intentional-failure',
      '--migrations-dir',
      migrationsDirectory,
    )

    expect(apply.status).toBe(1)
    expect(apply.stderr).toContain('no such table: table_that_does_not_exist')
    expect(
      queryD1(
        stateDirectory,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('first_marker', 'failed_marker', 'later_marker') ORDER BY name",
      ),
    ).toEqual([{ name: 'first_marker' }])
    expect(
      queryD1(stateDirectory, 'SELECT number, name FROM migration_ledger ORDER BY number'),
    ).toEqual([{ number: 1, name: '001_first' }])

    const status = runMigrationCommand(
      stateDirectory,
      'status',
      '--migrations-dir',
      migrationsDirectory,
    )
    expect(status.status).toBe(0)
    expect(readCommandOutput<{ state: string; pending: Array<{ number: number }> }>(status)).toMatchObject({
      state: 'pending',
      pending: [{ number: 2 }, { number: 3 }],
    })
  })
})
