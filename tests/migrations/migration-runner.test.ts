import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const currentSchemaPath = join(repoRoot, 'db', 'schema.sql')
const canonicalMigrationsPath = join(repoRoot, 'db', 'ledger-migrations')
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
}

function expectBaselineRejected(stateDirectory: string, ...issues: string[]): void {
  const result = runMigrationCommand(
    stateDirectory,
    'apply',
    '--candidate',
    'drifted-baseline',
  )

  expect(result.status).toBe(1)
  for (const issue of issues) expect(result.stderr).toContain(issue)
  expect(
    queryD1<{ count: number }>(
      stateDirectory,
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_ledger'",
    ),
  ).toEqual([{ count: 0 }])
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
  for (const directory of stateDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('D1 migration runner', () => {
  it('applies the canonical baseline to an empty D1 database', { timeout: 30_000 }, () => {
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
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('posts', 'migration_ledger') ORDER BY name",
      ),
    ).toEqual([{ name: 'migration_ledger' }, { name: 'posts' }])
    expect(
      queryD1<{ number: number; candidate_id: string }>(
        stateDirectory,
        'SELECT number, candidate_id FROM migration_ledger ORDER BY number',
      ),
    ).toEqual([{ number: 1, candidate_id: 'test-candidate-empty' }])
  })

  it('baselines an existing current schema without changing business schema, seed, or data', { timeout: 60_000 }, () => {
    const stateDirectory = createD1State()
    applySqlFile(stateDirectory, currentSchemaPath)
    queryD1(
      stateDirectory,
      "INSERT INTO posts (slug, title, content, html, status) VALUES ('kept', 'Kept', 'body', '<p>body</p>', 'draft') RETURNING id",
    )
    const schemaBefore = queryD1(
      stateDirectory,
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    const seedBefore = queryD1(
      stateDirectory,
      'SELECT action_key, prompt FROM ai_actions ORDER BY action_key',
    )

    const plan = runMigrationCommand(stateDirectory, 'plan')
    expect(plan.status).toBe(0)
    expect(readCommandOutput<{ pending: Array<{ number: number; action: string }> }>(plan).pending).toEqual([
      expect.objectContaining({ number: 1, action: 'baseline' }),
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
    expect(
      queryD1(
        stateDirectory,
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'migration_ledger%' ORDER BY type, name",
      ),
    ).toEqual(schemaBefore)
    expect(
      queryD1<{ number: number; candidate_id: string }>(
        stateDirectory,
        'SELECT number, candidate_id FROM migration_ledger',
      ),
    ).toEqual([{ number: 1, candidate_id: 'test-candidate-current' }])
  })

  it('does not create the ledger when an existing schema fails baseline validation', { timeout: 30_000 }, () => {
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

  it('rejects baseline when a critical column type or constraint has drifted', { timeout: 45_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaVariant(stateDirectory, [
      ['slug TEXT UNIQUE NOT NULL', 'slug INTEGER UNIQUE'],
    ])

    expectBaselineRejected(stateDirectory, 'column posts.slug')
  })

  it('rejects baseline when AUTOINCREMENT semantics have drifted', { timeout: 45_000 }, () => {
    const stateDirectory = createD1State()
    applyCurrentSchemaVariant(stateDirectory, [
      ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'id INTEGER PRIMARY KEY'],
    ])

    expectBaselineRejected(stateDirectory, 'constraint table posts')
  })

  it('rejects baseline when a critical index, trigger, or FTS definition has drifted', { timeout: 45_000 }, () => {
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
      'definition index idx_posts_published',
      'definition trigger posts_au',
      'definition table posts_fts',
    )
  })

  it('baselines customized mutable seed data without restoring or overwriting it', { timeout: 60_000 }, () => {
    const stateDirectory = createD1State()
    applySqlFile(stateDirectory, currentSchemaPath)
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
    ).toEqual([{ number: 1, candidate_id: 'mutable-data-baseline' }])
  })

  it('keeps plan and status read-only, verifies completeness, and makes repeated apply a no-op', { timeout: 90_000 }, () => {
    const stateDirectory = createD1State()

    const plan = runMigrationCommand(stateDirectory, 'plan')
    const status = runMigrationCommand(stateDirectory, 'status')
    const verifyBeforeApply = runMigrationCommand(stateDirectory, 'verify')

    expect(plan.status).toBe(0)
    expect(readCommandOutput<{ state: string; pending: unknown[] }>(plan)).toMatchObject({
      state: 'pending',
      pending: [{ number: 1, name: '001_initial_schema' }],
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

  it('rejects direct updates and deletes from the immutable migration ledger', { timeout: 30_000 }, () => {
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

  it('rejects INSERT OR REPLACE when recursive delete triggers are disabled', { timeout: 45_000 }, () => {
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

  it('fails verify and apply when the update guard trigger is replaced', { timeout: 90_000 }, () => {
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
    ])
  })

  it('fails plan and status when a ledger guard trigger is missing', { timeout: 60_000 }, () => {
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

  it('fails closed when the migration ledger table contract has drifted', { timeout: 45_000 }, () => {
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

  it('fails closed when a ledger default string literal has drifted', { timeout: 45_000 }, () => {
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

  it('fails plan and status when a same-name ledger view is present', { timeout: 30_000 }, () => {
    const stateDirectory = createD1State()
    queryD1(
      stateDirectory,
      'CREATE VIEW migration_ledger AS SELECT 1 AS number, \'view\' AS name, \'checksum\' AS checksum, \'now\' AS applied_at, \'candidate\' AS candidate_id',
    )

    const plan = runMigrationCommand(stateDirectory, 'plan')
    const status = runMigrationCommand(stateDirectory, 'status')

    expect(plan.status).toBe(1)
    expect(plan.stderr).toContain('Migration ledger contract drift: table migration_ledger')
    expect(status.status).toBe(1)
    expect(status.stderr).toContain('Migration ledger contract drift: table migration_ledger')
  })

  it('fails closed for a case-variant ledger artifact name', { timeout: 30_000 }, () => {
    const stateDirectory = createD1State()
    queryD1(
      stateDirectory,
      'CREATE VIEW MIGRATION_LEDGER AS SELECT 1 AS number, \'view\' AS name, \'checksum\' AS checksum, \'now\' AS applied_at, \'candidate\' AS candidate_id',
    )

    const status = runMigrationCommand(stateDirectory, 'status')

    expect(status.status).toBe(1)
    expect(status.stderr).toContain('Migration ledger contract drift: table migration_ledger')
  })

  it('plans and applies only migrations after the applied ledger prefix', { timeout: 60_000 }, () => {
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

  it('rejects missing and out-of-order migration declarations before touching D1', () => {
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

  it('rejects checksum drift without rewriting the applied ledger', { timeout: 45_000 }, () => {
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

  it('rolls back an intentionally failed migration, leaves it unregistered, and stops later migrations', { timeout: 60_000 }, () => {
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
