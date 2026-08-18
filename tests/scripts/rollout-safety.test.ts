import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureReadOnlyControls } from '../../scripts/rollout-safety.mjs'

const repoRoot = process.cwd()
const rolloutSafetyPath = join(repoRoot, 'scripts', 'rollout-safety.mjs')
const migrationRunnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function runRolloutSafety(args: string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [rolloutSafetyPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
}

function queryD1<T>(persistTo: string, sql: string): T[] {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', persistTo,
    '--config', join(repoRoot, 'wrangler.toml'), '--command', sql, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return (JSON.parse(result.stdout).at(-1)?.results || []) as T[]
}

function applyLedger(persistTo: string, candidate = 'rollout-safety-fixture') {
  return spawnSync(process.execPath, [
    migrationRunnerPath, 'apply', '--candidate', candidate,
    '--database', 'DB', '--local', '--persist-to', persistTo,
    '--config', join(repoRoot, 'wrangler.toml'),
  ], { cwd: repoRoot, encoding: 'utf8' })
}

function createValidBackupPackage() {
  const backupDirectory = temporaryDirectory('blogman-rollout-backup-')
  const schema = readFileSync(
    join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.sql'),
    'utf8',
  )
  const sql = `${schema}\n
INSERT INTO posts (slug, title, content, html, status, password)
VALUES ('restored-post', 'Restored title', 'restored private body', '<p>restored private body</p>', 'draft', 'restore-password');
`
  const sqlPath = join(backupDirectory, 'backup.sql')
  writeFileSync(sqlPath, sql)
  const digest = sha256(sql)
  const manifest = {
    format: 'blogman-d1-backup/v1',
    backup_id: `sha256:${digest}`,
    source: {
      database_id: 'local-fixture',
      captured_at: '2026-07-25T00:00:00.000Z',
    },
    required_tables: [
      'posts',
      'categories',
      'site_settings',
      'ai_actions',
      'ai_provider_profiles',
      'ai_post_generators',
      'api_tokens',
    ],
    artifacts: [{
      path: 'backup.sql',
      bytes: Buffer.byteLength(sql),
      sha256: digest,
    }],
  }
  const manifestPath = join(backupDirectory, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifestPath, sqlPath }
}

function createLargeStatementBackupPackage() {
  const backupDirectory = temporaryDirectory('blogman-rollout-large-backup-')
  const privatePayload = `large-private-${'x'.repeat(2_000_000)}`
  const sql = `
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL
);
INSERT INTO posts VALUES (1, 'large-post', 'Large post', '${privatePayload}', '<p>large</p>', 'draft');
`
  const digest = sha256(sql)
  const sqlPath = join(backupDirectory, 'large-backup.sql')
  const manifestPath = join(backupDirectory, 'manifest.json')
  writeFileSync(sqlPath, sql)
  writeFileSync(manifestPath, `${JSON.stringify({
    format: 'blogman-d1-backup/v1',
    backup_id: `sha256:${digest}`,
    source: { database_id: 'large-local-fixture', captured_at: '2026-07-25T00:00:00.000Z' },
    required_tables: ['posts'],
    artifacts: [{ path: 'large-backup.sql', bytes: Buffer.byteLength(sql), sha256: digest }],
  })}\n`)
  return { manifestPath, privatePayload }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('rollout safety CLI', () => {
  it('captures only disabled control states without candidate evidence or writes', () => {
    const query = vi.fn((sql: string) => sql.startsWith('SELECT name')
      ? [{ name: 'migration_ledger' }, { name: 'rollout_controls' }]
      : [{ control_key: 'executor:publication', control_kind: 'executor', desired_enabled: 0, candidate_id: 'candidate', evidence_sha256: 'a'.repeat(64) }])

    expect(captureReadOnlyControls({ query })).toEqual({
      state: 'captured', producer: 'disabled', authority: 'disabled', executors: { publication: 'disabled' },
    })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('fails closed on duplicate rows or an invalid emergency switch', () => {
    const duplicate = () => captureReadOnlyControls({ query: (sql: string) => sql.startsWith('SELECT name')
      ? [{ name: 'rollout_controls' }]
      : [
        { control_key: 'producer', control_kind: 'producer', desired_enabled: 0, candidate_id: 'candidate', evidence_sha256: 'a'.repeat(64) },
        { control_key: 'producer', control_kind: 'producer', desired_enabled: 0, candidate_id: 'candidate', evidence_sha256: 'a'.repeat(64) },
      ] })
    expect(duplicate).toThrow(/Invalid rollout control row/)
    expect(() => captureReadOnlyControls({ query: () => [], emergency: { BLOGMAN_DISABLE_PRODUCER: 'perhaps' } }))
      .toThrow(/Invalid rollout emergency switch/)
  })
  it('verifies a stable backup identity and restores it into an explicit isolated local D1 target', { timeout: 120_000 }, () => {
    const { manifestPath } = createValidBackupPackage()
    const persistTo = temporaryDirectory('blogman-rollout-restored-')

    const verify = runRolloutSafety(['backup', 'verify', '--manifest', manifestPath])
    expect(verify.status, verify.stderr).toBe(0)
    expect(JSON.parse(verify.stdout)).toMatchObject({
      state: 'verified',
      backup_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      artifact_count: 1,
    })

    const restore = runRolloutSafety([
      'backup', 'restore', '--manifest', manifestPath,
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ])
    expect(restore.status, restore.stderr).toBe(0)
    expect(JSON.parse(restore.stdout)).toMatchObject({
      state: 'restored',
      backup_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      target: { mode: 'local', isolated: true },
    })
    expect(`${verify.stdout}${verify.stderr}${restore.stdout}${restore.stderr}`)
      .not.toMatch(/restored private body|restore-password/)
    expect(queryD1(persistTo, 'SELECT COUNT(*) AS count FROM posts')).toEqual([{ count: 1 }])
  })

  it('restores a production-sized single SQL statement into Wrangler-initialized local D1', { timeout: 120_000 }, () => {
    const { manifestPath, privatePayload } = createLargeStatementBackupPackage()
    const persistTo = temporaryDirectory('blogman-rollout-large-restored-')
    const restore = runRolloutSafety([
      'backup', 'restore', '--manifest', manifestPath,
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ])

    expect(restore.status, restore.stderr).toBe(0)
    expect(JSON.parse(restore.stdout)).toMatchObject({
      state: 'restored',
      target: { mode: 'local', isolated: true },
    })
    expect(`${restore.stdout}${restore.stderr}`).not.toContain(privatePayload)
    expect(queryD1(persistTo, 'SELECT length(content) AS length FROM posts'))
      .toEqual([{ length: privatePayload.length }])
  })

  it('fails closed for corrupted bytes and hash-valid backups missing a required table', { timeout: 120_000 }, () => {
    const valid = createValidBackupPackage()
    writeFileSync(valid.sqlPath, `${readFileSync(valid.sqlPath, 'utf8')}\n-- corrupted`)
    const corrupted = runRolloutSafety(['backup', 'verify', '--manifest', valid.manifestPath])
    expect(corrupted.status).toBe(1)
    expect(corrupted.stderr).toContain('integrity verification')
    expect(`${corrupted.stdout}${corrupted.stderr}`).not.toContain('restored private body')

    const backupDirectory = temporaryDirectory('blogman-rollout-incomplete-')
    const sql = `
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL
);
INSERT INTO posts VALUES (1, 'only-post', 'Only post', 'private incomplete body', '<p>private incomplete body</p>', 'draft');
`
    const digest = sha256(sql)
    const sqlPath = join(backupDirectory, 'backup.sql')
    const manifestPath = join(backupDirectory, 'manifest.json')
    writeFileSync(sqlPath, sql)
    writeFileSync(manifestPath, `${JSON.stringify({
      format: 'blogman-d1-backup/v1',
      backup_id: `sha256:${digest}`,
      source: { database_id: 'local-incomplete', captured_at: '2026-07-25T00:00:00.000Z' },
      required_tables: ['posts', 'categories'],
      artifacts: [{ path: 'backup.sql', bytes: Buffer.byteLength(sql), sha256: digest }],
    })}\n`)
    const persistTo = temporaryDirectory('blogman-rollout-incomplete-target-')
    const incomplete = runRolloutSafety([
      'backup', 'restore', '--manifest', manifestPath,
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ])
    expect(incomplete.status).toBe(1)
    expect(incomplete.stderr).toContain('required tables')
    expect(`${incomplete.stdout}${incomplete.stderr}`).not.toContain('private incomplete body')
  })

  it('captures and reconciles redacted schema, ledger, article count, status, and content evidence', { timeout: 120_000 }, () => {
    const { manifestPath } = createValidBackupPackage()
    const persistTo = temporaryDirectory('blogman-rollout-reconcile-')
    const restore = runRolloutSafety([
      'backup', 'restore', '--manifest', manifestPath,
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ])
    expect(restore.status, restore.stderr).toBe(0)

    const databaseOptions = [
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ]
    const capture = runRolloutSafety(['reconcile', 'capture', ...databaseOptions])
    expect(capture.status, capture.stderr).toBe(0)
    const snapshot = JSON.parse(capture.stdout)
    expect(snapshot).toMatchObject({
      format: 'blogman-d1-reconciliation/v1',
      schema: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      migration_ledger: { state: 'absent', row_count: 0, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      posts: {
        count: 1,
        status: { draft: 1 },
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(capture.stdout).not.toMatch(/restored private body|restore-password|api_tokens|token/)

    const expectedPath = join(temporaryDirectory('blogman-rollout-expected-'), 'snapshot.json')
    writeFileSync(expectedPath, capture.stdout)
    const compare = runRolloutSafety([
      'reconcile', 'compare', '--expected', expectedPath, ...databaseOptions,
    ])
    expect(compare.status, compare.stderr).toBe(0)
    expect(JSON.parse(compare.stdout)).toEqual({
      state: 'matched',
      checks: {
        schema: 'matched',
        migration_ledger: 'matched',
        post_count: 'matched',
        post_status: 'matched',
        post_content: 'matched',
      },
    })
    expect(compare.stdout).not.toMatch(/restored private body|restore-password|api_tokens|token/)
  })

  it('reports each schema, ledger, count, status, and content drift dimension and exits non-zero', { timeout: 300_000 }, () => {
    const { manifestPath } = createValidBackupPackage()
    const persistTo = temporaryDirectory('blogman-rollout-drift-')
    const databaseOptions = [
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ]
    expect(runRolloutSafety([
      'backup', 'restore', '--manifest', manifestPath, ...databaseOptions,
    ]).status).toBe(0)
    queryD1(persistTo, `
DROP TRIGGER posts_au;
DROP TRIGGER posts_ad;
CREATE TABLE migration_ledger (
  number INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  candidate_id TEXT NOT NULL
) STRICT;
INSERT INTO migration_ledger (number, name, checksum, candidate_id)
VALUES (1, 'fixture', 'checksum', 'candidate-a');
`)
    const capture = runRolloutSafety(['reconcile', 'capture', ...databaseOptions])
    expect(capture.status, capture.stderr).toBe(0)
    const expectedPath = join(temporaryDirectory('blogman-rollout-drift-expected-'), 'snapshot.json')
    writeFileSync(expectedPath, capture.stdout)
    const compare = () => runRolloutSafety([
      'reconcile', 'compare', '--expected', expectedPath, ...databaseOptions,
    ])
    const expectDrift = (result: ReturnType<typeof compare>, dimensions: string[]) => {
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).drift_dimensions).toEqual(dimensions)
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/restored private body|restore-password/)
    }

    queryD1(persistTo, 'CREATE TABLE schema_drift_probe (id INTEGER PRIMARY KEY)')
    expectDrift(compare(), ['schema'])
    queryD1(persistTo, 'DROP TABLE schema_drift_probe')

    queryD1(persistTo, "UPDATE migration_ledger SET candidate_id = 'candidate-b' WHERE number = 1")
    expectDrift(compare(), ['migration_ledger'])
    queryD1(persistTo, "UPDATE migration_ledger SET candidate_id = 'candidate-a' WHERE number = 1")

    queryD1(persistTo, `
INSERT INTO posts (slug, title, content, html, status)
VALUES ('extra-post', 'Extra', 'extra private content', '<p>extra private content</p>', 'published')
`)
    expectDrift(compare(), ['post_count', 'post_status', 'post_content'])
    queryD1(persistTo, "DELETE FROM posts WHERE slug = 'extra-post'")

    queryD1(persistTo, "UPDATE posts SET status = 'published' WHERE slug = 'restored-post'")
    expectDrift(compare(), ['post_status'])
    queryD1(persistTo, "UPDATE posts SET status = 'draft' WHERE slug = 'restored-post'")

    queryD1(persistTo, "UPDATE posts SET description = 'changed private description' WHERE slug = 'restored-post'")
    expectDrift(compare(), ['post_content'])
  })

  it('seeds the scheduled executor and keeps repeated apply idempotent across ledger migrations', { timeout: 180_000 }, () => {
    const persistTo = temporaryDirectory('blogman-rollout-controls-')
    const first = applyLedger(persistTo)
    expect(first.status, first.stderr).toBe(0)
    expect(queryD1(persistTo, `
SELECT name, type FROM sqlite_schema
WHERE name IN (
  'rollout_controls',
  'rollout_control_events',
  'rollout_control_events_no_update',
  'rollout_control_events_no_delete'
)
ORDER BY name
`)).toEqual([
      { name: 'rollout_control_events', type: 'table' },
      { name: 'rollout_control_events_no_delete', type: 'trigger' },
      { name: 'rollout_control_events_no_update', type: 'trigger' },
      { name: 'rollout_controls', type: 'table' },
    ])
    expect(queryD1(persistTo, 'SELECT number, name FROM migration_ledger ORDER BY number').at(-1))
      .toEqual({ number: 7, name: '007_seed_rollout_executor' })
    expect(queryD1(persistTo, `
SELECT control_key, control_kind, desired_enabled, candidate_id, evidence_sha256, evidence_state, actor, reason
FROM rollout_controls
ORDER BY control_key
`)).toEqual([
      {
        control_key: 'executor:scheduled',
        control_kind: 'executor',
        desired_enabled: 0,
        candidate_id: '0000000000000000000000000000000000000000',
        evidence_sha256: 'ebdb386f8d60260232e81a4c130ea53c8e190aab4ade87d8ef9dc9221fe9f61c',
        evidence_state: 'verified',
        actor: 'migrations:seed',
        reason: 'Seed executor:scheduled disabled for clean-start rollouts',
      },
    ])
    // controls-status shape: captureReadOnlyControls is the exact code path the
    // rollout controls-status command uses, just backed by this local persist D1.
    expect(captureReadOnlyControls({
      query: (sql: string, evidenceName: string) => queryD1(persistTo, sql),
    })).toEqual({
      state: 'captured',
      producer: 'disabled',
      authority: 'disabled',
      executors: { scheduled: 'disabled' },
    })

    const repeated = applyLedger(persistTo)
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(queryD1(persistTo, 'SELECT COUNT(*) AS count FROM migration_ledger')).toEqual([{ count: 7 }])
    expect(queryD1(persistTo, 'SELECT COUNT(*) AS count FROM rollout_control_events')).toEqual([{ count: 0 }])
  })

  it('runs repeatable representative request smoke against an external restored local-D1 persist directory', { timeout: 180_000 }, () => {
    const { manifestPath } = createValidBackupPackage()
    const persistTo = temporaryDirectory('blogman-rollout-request-smoke-')
    const databaseOptions = [
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ]
    const restored = runRolloutSafety([
      'backup', 'restore', '--manifest', manifestPath, ...databaseOptions,
    ])
    expect(restored.status, restored.stderr).toBe(0)

    const first = runRolloutSafety(['request', 'smoke', ...databaseOptions])
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({
      state: 'passed',
      target: 'external-local-d1-persist',
      runtime: 'workerd',
      requests: [
        { name: 'search', status: 200 },
        { name: 'appearance', status: 200 },
      ],
      reconciliation: 'matched',
      report_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(`${first.stdout}${first.stderr}`).not.toMatch(/restored private body|restore-password/)

    const second = runRolloutSafety(['request', 'smoke', ...databaseOptions])
    expect(second.status, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout))
  })

    })
