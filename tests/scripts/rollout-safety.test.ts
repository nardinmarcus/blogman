import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

function canonicalHash(value: unknown) {
  return sha256(JSON.stringify(value))
}

function migrationSetSha256() {
  const directory = join(repoRoot, 'db', 'ledger-migrations')
  return sha256(JSON.stringify(
    readdirSync(directory)
      .filter((name) => /^\d{3}_.+\.(?:sql|data\.mjs)$/.test(name))
      .sort()
      .map((name) => ({ name, sha256: sha256(readFileSync(join(directory, name))) })),
  ))
}

function migrationCatalog() {
  const result = spawnSync(process.execPath, [migrationRunnerPath, 'catalog'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return JSON.parse(result.stdout).migrations as Array<{
    number: number
    name: string
    checksum: string
  }>
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

function createCandidateEvidence({ historical = false } = {}) {
  const directory = temporaryDirectory('blogman-rollout-candidate-')
  const buildPath = join(directory, 'worker-bundle.js')
  writeFileSync(buildPath, 'immutable worker bundle\n')
  const candidateId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const deploymentId = 'deployment-22'
  const versionId = '11111111-2222-4333-8444-555555555555'
  const d1DatabaseId = '22222222-3333-4444-8555-666666666666'
  const buildSha256 = sha256(readFileSync(buildPath))
  const lockfileSha256 = sha256(readFileSync(join(repoRoot, 'package-lock.json')))
  const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const backupReportPath = join(directory, 'backup-verify-report.json')
  const restoreReportPath = join(directory, 'backup-restore-report.json')
  const migrationReportPath = join(directory, 'migration-report.json')
  const migrationVerificationReportPath = join(directory, 'migration-verification-report.json')
  const rolloutReportPath = join(directory, 'rollout-report.json')
  const testReportPath = join(directory, 'test-report.json')
  const observationReportPath = join(directory, 'observation-report.json')
  const t0ReportPath = join(directory, 't0-report.json')
  const observationStartSmokeReportPath = join(directory, 'observation-start-smoke-report.json')
  const observationStartReconciliationReportPath = join(directory, 'observation-start-reconciliation-report.json')
  const anomalyReportPath = join(directory, 'anomaly-report.json')
  const reconciliationReportPath = join(directory, 'reconciliation-report.json')
  const smokeReportPath = join(directory, 'smoke-report.json')
  const smokeRuntimeReportPath = join(directory, 'smoke-runtime-report.json')
  writeFileSync(backupReportPath, `${JSON.stringify({
    state: 'verified',
    backup_id: `sha256:${'b'.repeat(64)}`,
    artifact_count: 1,
  })}\n`)
  writeFileSync(restoreReportPath, `${JSON.stringify({
    state: 'restored',
    backup_id: `sha256:${'b'.repeat(64)}`,
    target: { mode: 'local', isolated: true },
  })}\n`)
  writeFileSync(migrationReportPath, `${JSON.stringify({
    format: 'blogman-migration-evidence/v1',
    state: 'verified',
    candidate_id: candidateId,
    migration_set_sha256: migrationSetSha256(),
  })}\n`)
  const migrations = migrationCatalog()
  writeFileSync(migrationVerificationReportPath, `${JSON.stringify({
    state: 'verified',
    applied: migrations.map((migration) => ({
      ...migration,
      applied_at: '2026-07-25 00:00:00',
      candidate_id: candidateId,
    })),
    pending: [],
  })}\n`)
  writeFileSync(rolloutReportPath, `${JSON.stringify({
    format: 'blogman-rollout-state/v1',
    state: 'captured',
    controls: { producer: 'disabled', authority: 'disabled', executors: {} },
  })}\n`)
  writeFileSync(testReportPath, `${JSON.stringify({
    format: 'blogman-test-report/v1',
    state: 'passed',
    exit_code: 0,
    passed: 12,
    failed: 0,
  })}\n`)
  writeFileSync(observationReportPath, `${JSON.stringify({
    format: 'blogman-observation-window/v1',
    state: 'pending',
    required_hours: 24,
    started_at: null,
    ended_at: null,
    start: null,
    end: null,
    anomaly_audit: null,
  })}\n`)
  const reconciliationReport = {
    ...(historical ? {} : {
      format: 'blogman-d1-reconciliation-check/v2',
      checked_at: '2026-07-26T01:00:00.000Z',
      d1_database_id: d1DatabaseId,
    }),
    state: 'matched',
    checks: { schema: 'matched', migration_ledger: 'matched', post_count: 'matched', post_status: 'matched', post_content: 'matched' },
  }
  writeFileSync(reconciliationReportPath, `${JSON.stringify(reconciliationReport)}\n`)
  writeFileSync(observationStartReconciliationReportPath, `${JSON.stringify(reconciliationReport)}\n`)
  const smokeReport = {
    ...(historical ? {} : {
      format: 'blogman-production-smoke/v2',
      checked_at: '2026-07-26T01:00:00.000Z',
      d1_database_id: d1DatabaseId,
      checks: {
        search: 200,
        appearance: 200,
        admin_article: 200,
        tokens: 200,
        ai_provider: 200,
        ai_generators: 200,
      },
    }),
    state: 'passed',
    candidate_id: candidateId,
    build_sha256: buildSha256,
    deployment_id: deploymentId,
    version_id: versionId,
  }
  writeFileSync(smokeReportPath, `${JSON.stringify(smokeReport)}\n`)
  const smokeRuntimeReport = {
    state: 'passed',
    target: 'external-local-d1-persist',
    runtime: 'workerd',
    requests: [{ name: 'search', status: 200 }, { name: 'appearance', status: 200 }],
    reconciliation: 'matched',
  }
  writeFileSync(smokeRuntimeReportPath, `${JSON.stringify({
    ...smokeRuntimeReport,
    report_sha256: canonicalHash(smokeRuntimeReport),
  })}\n`)
  writeFileSync(observationStartSmokeReportPath, `${JSON.stringify(smokeReport)}\n`)
  writeFileSync(anomalyReportPath, `${JSON.stringify({
    format: 'blogman-anomaly-audit/v1',
    state: 'clear',
    checked_at: '2026-07-26T01:00:00.000Z',
    high_priority_open: 0,
  })}\n`)
  writeFileSync(t0ReportPath, `${JSON.stringify({
    format: 'blogman-t0-acceptance/v1',
    state: 'passed',
    accepted_at: '2026-07-26T01:00:00.000Z',
    candidate_id: candidateId,
    build_sha256: buildSha256,
    deployment_id: deploymentId,
    version_id: versionId,
    d1_database_id: d1DatabaseId,
    migration_numbers: [1, 2, 3, 4, 5, 6],
    migration_report_sha256: sha256(readFileSync(migrationReportPath)),
    migration_verification_report_sha256: sha256(readFileSync(migrationVerificationReportPath)),
    smoke_report_sha256: sha256(readFileSync(smokeReportPath)),
    final_reconciliation_report_sha256: sha256(readFileSync(reconciliationReportPath)),
    anomaly_report_sha256: sha256(readFileSync(anomalyReportPath)),
  })}\n`)
  const evidence = {
    format: historical ? 'blogman-rollout-candidate/v1' : 'blogman-rollout-candidate/v2',
    candidate_id: candidateId,
    lockfile: {
      sha256: lockfileSha256,
      wrangler: lockfile.packages['node_modules/wrangler'].version,
      opennextjs_cloudflare: lockfile.packages['node_modules/@opennextjs/cloudflare'].version,
    },
    build: { sha256: buildSha256 },
    cloudflare: { deployment_id: deploymentId, version_id: versionId },
    ...(historical ? {} : { d1: { database_id: d1DatabaseId } }),
    migration: {
      state: 'verified',
      candidate_id: candidateId,
      set_sha256: migrationSetSha256(),
      report_sha256: sha256(readFileSync(migrationReportPath)),
      verification_report_sha256: sha256(readFileSync(migrationVerificationReportPath)),
    },
    backup: {
      backup_id: `sha256:${'b'.repeat(64)}`,
      verify_report_sha256: sha256(readFileSync(backupReportPath)),
      restore_report_sha256: sha256(readFileSync(restoreReportPath)),
    },
    reconciliation: { report_sha256: sha256(readFileSync(reconciliationReportPath)) },
    smoke: {
      report_sha256: sha256(readFileSync(smokeReportPath)),
      runtime_report_sha256: sha256(readFileSync(smokeRuntimeReportPath)),
    },
    rollout: { report_sha256: sha256(readFileSync(rolloutReportPath)) },
    tests: { report_sha256: sha256(readFileSync(testReportPath)) },
    ...(historical
      ? { observation: { report_sha256: sha256(readFileSync(observationReportPath)) } }
      : { t0: { report_sha256: sha256(readFileSync(t0ReportPath)) } }),
  }
  const evidencePath = join(directory, 'candidate.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  return {
    anomalyReportPath,
    backupReportPath,
    buildPath,
    candidateId,
    deploymentId,
    d1DatabaseId,
    evidencePath,
    migrationReportPath,
    migrationVerificationReportPath,
    observationReportPath,
    observationStartReconciliationReportPath,
    observationStartSmokeReportPath,
    reconciliationReportPath,
    restoreReportPath,
    rolloutReportPath,
    smokeReportPath,
    smokeRuntimeReportPath,
    testReportPath,
    t0ReportPath,
    versionId,
  }
}

function candidateVerificationOptions(candidate: ReturnType<typeof createCandidateEvidence>) {
  const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
  return [
    '--evidence', candidate.evidencePath,
    '--candidate', candidate.candidateId,
    '--lockfile', join(repoRoot, 'package-lock.json'),
    '--build', candidate.buildPath,
    '--deployment', candidate.deploymentId,
    '--version', candidate.versionId,
    ...(evidence.format === 'blogman-rollout-candidate/v2'
      ? ['--d1-database', candidate.d1DatabaseId]
      : []),
    '--backup-report', candidate.backupReportPath,
    '--restore-report', candidate.restoreReportPath,
    '--migration-report', candidate.migrationReportPath,
    '--migration-verification-report', candidate.migrationVerificationReportPath,
    '--reconciliation-report', candidate.reconciliationReportPath,
    '--smoke-report', candidate.smokeReportPath,
    '--smoke-runtime-report', candidate.smokeRuntimeReportPath,
    '--rollout-report', candidate.rolloutReportPath,
    '--test-report', candidate.testReportPath,
    ...(evidence.format === 'blogman-rollout-candidate/v2'
      ? ['--t0-report', candidate.t0ReportPath]
      : [
          '--observation-report', candidate.observationReportPath,
          '--observation-start-smoke-report', candidate.observationStartSmokeReportPath,
          '--observation-start-reconciliation-report', candidate.observationStartReconciliationReportPath,
        ]),
    '--anomaly-report', candidate.anomalyReportPath,
  ]
}

function createPreMigrationEvidence() {
  const candidate = createCandidateEvidence({ historical: true })
  const lockfileBytes = readFileSync(join(repoRoot, 'package-lock.json'))
  const lockfile = JSON.parse(lockfileBytes.toString('utf8'))
  const evidencePath = join(temporaryDirectory('blogman-pre-migration-candidate-'), 'candidate.json')
  writeFileSync(evidencePath, `${JSON.stringify({
    format: 'blogman-pre-migration-candidate/v1',
    candidate_id: candidate.candidateId,
    lockfile: {
      sha256: sha256(lockfileBytes),
      wrangler: lockfile.packages['node_modules/wrangler'].version,
      opennextjs_cloudflare: lockfile.packages['node_modules/@opennextjs/cloudflare'].version,
    },
    build: { sha256: sha256(readFileSync(candidate.buildPath)) },
    cloudflare: { uploaded_version_id: candidate.versionId },
    migration: {
      set_sha256: migrationSetSha256(),
      verification_report_sha256: sha256(readFileSync(candidate.migrationVerificationReportPath)),
    },
    backup: {
      backup_id: `sha256:${'b'.repeat(64)}`,
      verify_report_sha256: sha256(readFileSync(candidate.backupReportPath)),
      restore_report_sha256: sha256(readFileSync(candidate.restoreReportPath)),
    },
    reconciliation: { report_sha256: sha256(readFileSync(candidate.reconciliationReportPath)) },
    smoke: { runtime_report_sha256: sha256(readFileSync(candidate.smokeRuntimeReportPath)) },
    tests: { report_sha256: sha256(readFileSync(candidate.testReportPath)) },
  }, null, 2)}\n`)
  return { candidate, evidencePath }
}

function preMigrationVerificationOptions(value: ReturnType<typeof createPreMigrationEvidence>) {
  const { candidate } = value
  return [
    '--evidence', value.evidencePath,
    '--candidate', candidate.candidateId,
    '--lockfile', join(repoRoot, 'package-lock.json'),
    '--build', candidate.buildPath,
    '--version', candidate.versionId,
    '--backup-report', candidate.backupReportPath,
    '--restore-report', candidate.restoreReportPath,
    '--migration-verification-report', candidate.migrationVerificationReportPath,
    '--reconciliation-report', candidate.reconciliationReportPath,
    '--smoke-runtime-report', candidate.smokeRuntimeReportPath,
    '--test-report', candidate.testReportPath,
  ]
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('rollout safety CLI', () => {
  it('verifies a dedicated pre-migration packet that cannot satisfy the production candidate contract', () => {
    const value = createPreMigrationEvidence()
    const verified = runRolloutSafety([
      'candidate', 'verify-pre-migration', ...preMigrationVerificationOptions(value),
    ])
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({
      state: 'verified',
      phase: 'pre-migration',
      candidate_id: value.candidate.candidateId,
    })

    const finalCandidateAttempt = runRolloutSafety([
      'candidate', 'verify',
      ...candidateVerificationOptions(value.candidate).map((option) => (
        option === value.candidate.evidencePath ? value.evidencePath : option
      )),
    ])
    expect(finalCandidateAttempt.status).toBe(1)
    expect(finalCandidateAttempt.stderr).toContain('Unsupported candidate evidence format')
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

  it('binds candidate, lockfile toolchain, build, deployment, version, and smoke to one evidence identity', () => {
    const candidate = createCandidateEvidence()
    const common = candidateVerificationOptions(candidate)
    const verified = runRolloutSafety(['candidate', 'verify', ...common])
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toEqual({
      state: 'verified',
      phase: 'batch-1-t0',
      candidate_id: candidate.candidateId,
      d1_database_id: candidate.d1DatabaseId,
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const mismatches: Array<[string, string, string[]]> = [
      ['--candidate', 'dddddddddddddddddddddddddddddddddddddddd', ['candidate_identity', 'migration_report_state', 'migration_verification_state', 'smoke_candidate_identity', 't0_state']],
      ['--deployment', 'deployment-other', ['deployment_identity', 'smoke_deployment_identity', 't0_state']],
      ['--version', '99999999-2222-4333-8444-555555555555', ['version_identity', 'smoke_version_identity', 't0_state']],
      ['--d1-database', '77777777-8888-4999-8aaa-bbbbbbbbbbbb', ['d1_identity', 'reconciliation_state', 'smoke_critical_paths', 't0_state']],
    ]
    for (const [flag, value, failures] of mismatches) {
      const args = [
        'candidate', 'verify', ...common,
      ]
      args[args.indexOf(flag) + 1] = value
      const result = runRolloutSafety(args)
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ state: 'invalid', failures })
    }

    writeFileSync(candidate.buildPath, 'different worker bundle\n')
    const buildMismatch = runRolloutSafety(['candidate', 'verify', ...common])
    expect(buildMismatch.status).toBe(1)
    expect(JSON.parse(buildMismatch.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['build_identity', 'smoke_build_identity', 't0_state'],
    })
    expect(`${verified.stdout}${buildMismatch.stdout}`).not.toMatch(/private|password|token|secret/)
  })

  it('accepts T0 immediately and fails closed on incomplete migrations or high-priority anomalies', () => {
    const incompleteMigrations = createCandidateEvidence()
    const migrationT0 = JSON.parse(readFileSync(incompleteMigrations.t0ReportPath, 'utf8'))
    migrationT0.migration_numbers = [1, 2, 3, 4, 5]
    writeFileSync(incompleteMigrations.t0ReportPath, `${JSON.stringify(migrationT0)}\n`)
    const migrationEvidence = JSON.parse(readFileSync(incompleteMigrations.evidencePath, 'utf8'))
    migrationEvidence.t0.report_sha256 = sha256(readFileSync(incompleteMigrations.t0ReportPath))
    writeFileSync(incompleteMigrations.evidencePath, `${JSON.stringify(migrationEvidence)}\n`)

    const incomplete = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(incompleteMigrations),
    ])
    expect(incomplete.status).toBe(1)
    expect(JSON.parse(incomplete.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['t0_state'],
    })

    const anomaly = createCandidateEvidence()
    writeFileSync(anomaly.anomalyReportPath, `${JSON.stringify({
      format: 'blogman-anomaly-audit/v1',
      state: 'blocked',
      checked_at: '2026-07-26T01:00:00.000Z',
      high_priority_open: 1,
    })}\n`)
    const anomalyT0 = JSON.parse(readFileSync(anomaly.t0ReportPath, 'utf8'))
    anomalyT0.anomaly_report_sha256 = sha256(readFileSync(anomaly.anomalyReportPath))
    writeFileSync(anomaly.t0ReportPath, `${JSON.stringify(anomalyT0)}\n`)
    const anomalyEvidence = JSON.parse(readFileSync(anomaly.evidencePath, 'utf8'))
    anomalyEvidence.t0.report_sha256 = sha256(readFileSync(anomaly.t0ReportPath))
    writeFileSync(anomaly.evidencePath, `${JSON.stringify(anomalyEvidence)}\n`)

    const blocked = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(anomaly),
    ])
    expect(blocked.status).toBe(1)
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['t0_anomaly_state'],
    })
  })

  it('rejects elapsed-time fields and incomplete critical-path smoke at T0', () => {
    const timed = createCandidateEvidence()
    const timedT0 = JSON.parse(readFileSync(timed.t0ReportPath, 'utf8'))
    timedT0.required_hours = 1
    writeFileSync(timed.t0ReportPath, `${JSON.stringify(timedT0)}\n`)
    const timedResult = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(timed),
    ])
    expect(timedResult.status).toBe(1)
    expect(timedResult.stdout).toBe('')
    expect(timedResult.stderr).toContain('unsupported evidence field contract')

    const incompleteSmoke = createCandidateEvidence()
    const smoke = JSON.parse(readFileSync(incompleteSmoke.smokeReportPath, 'utf8'))
    delete smoke.checks.ai_generators
    writeFileSync(incompleteSmoke.smokeReportPath, `${JSON.stringify(smoke)}\n`)
    const smokeResult = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(incompleteSmoke),
    ])
    expect(smokeResult.status).toBe(1)
    expect(smokeResult.stdout).toBe('')
    expect(smokeResult.stderr).toContain('unsupported evidence field contract')

    const enabled = createCandidateEvidence()
    const rollout = JSON.parse(readFileSync(enabled.rolloutReportPath, 'utf8'))
    rollout.controls.producer = 'enabled'
    writeFileSync(enabled.rolloutReportPath, `${JSON.stringify(rollout)}\n`)
    const enabledEvidence = JSON.parse(readFileSync(enabled.evidencePath, 'utf8'))
    enabledEvidence.rollout.report_sha256 = sha256(readFileSync(enabled.rolloutReportPath))
    writeFileSync(enabled.evidencePath, `${JSON.stringify(enabledEvidence)}\n`)
    const enabledResult = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(enabled),
    ])
    expect(enabledResult.status).toBe(1)
    expect(JSON.parse(enabledResult.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['rollout_report_state'],
    })
  })

  it('invalidates a candidate when a bound backup, reconciliation, or smoke report changes', () => {
    const candidate = createCandidateEvidence()
    const common = candidateVerificationOptions(candidate)
    expect(runRolloutSafety(['candidate', 'verify', ...common]).status).toBe(0)

    writeFileSync(candidate.reconciliationReportPath, `${JSON.stringify({
      format: 'blogman-d1-reconciliation-check/v2',
      checked_at: '2026-07-26T01:00:00.000Z',
      d1_database_id: candidate.d1DatabaseId,
      state: 'drift',
      checks: {
        schema: 'drift',
        migration_ledger: 'matched',
        post_count: 'matched',
        post_status: 'matched',
        post_content: 'matched',
      },
    })}\n`)
    const changed = runRolloutSafety(['candidate', 'verify', ...common])
    expect(changed.status).toBe(1)
    expect(JSON.parse(changed.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['reconciliation_report_identity', 'reconciliation_state', 't0_state'],
    })

    const restore = createCandidateEvidence()
    const restoreCommon = candidateVerificationOptions(restore)
    writeFileSync(restore.restoreReportPath, `${JSON.stringify({
      state: 'verified',
      backup_id: `sha256:${'b'.repeat(64)}`,
      target: { mode: 'local', isolated: true },
    })}\n`)
    const unrestored = runRolloutSafety(['candidate', 'verify', ...restoreCommon])
    expect(unrestored.status).toBe(1)
    expect(JSON.parse(unrestored.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['restore_report_identity', 'restore_state'],
    })

    const changedSources = createCandidateEvidence()
    const sourceCommon = candidateVerificationOptions(changedSources)
    const migrationVerification = JSON.parse(
      readFileSync(changedSources.migrationVerificationReportPath, 'utf8'),
    )
    migrationVerification.state = 'pending'
    writeFileSync(
      changedSources.migrationVerificationReportPath,
      `${JSON.stringify(migrationVerification)}\n`,
    )
    const changedMigrationVerification = runRolloutSafety([
      'candidate', 'verify', ...sourceCommon,
    ])
    expect(changedMigrationVerification.status).toBe(1)
    expect(JSON.parse(changedMigrationVerification.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['migration_verification_identity', 'migration_verification_state', 't0_state'],
    })

    const staleMigration = createCandidateEvidence()
    const staleEvidence = JSON.parse(readFileSync(staleMigration.evidencePath, 'utf8'))
    const staleVerification = JSON.parse(
      readFileSync(staleMigration.migrationVerificationReportPath, 'utf8'),
    )
    staleVerification.applied[0].checksum = sha256('stale migration bytes')
    writeFileSync(
      staleMigration.migrationVerificationReportPath,
      `${JSON.stringify(staleVerification)}\n`,
    )
    staleEvidence.migration.verification_report_sha256 = sha256(
      readFileSync(staleMigration.migrationVerificationReportPath),
    )
    writeFileSync(staleMigration.evidencePath, `${JSON.stringify(staleEvidence)}\n`)
    const staleMigrationResult = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(staleMigration),
    ])
    expect(staleMigrationResult.status).toBe(1)
    expect(JSON.parse(staleMigrationResult.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['migration_verification_state', 't0_state'],
    })

    const changedRuntime = createCandidateEvidence()
    const runtimeCommon = candidateVerificationOptions(changedRuntime)
    const runtimeReport = JSON.parse(readFileSync(changedRuntime.smokeRuntimeReportPath, 'utf8'))
    runtimeReport.requests[0].status = 500
    writeFileSync(changedRuntime.smokeRuntimeReportPath, `${JSON.stringify(runtimeReport)}\n`)
    const changedSmokeRuntime = runRolloutSafety(['candidate', 'verify', ...runtimeCommon])
    expect(changedSmokeRuntime.status).toBe(1)
    expect(JSON.parse(changedSmokeRuntime.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['smoke_runtime_identity', 'smoke_runtime_state'],
    })

    const incomplete = createCandidateEvidence()
    const incompleteEvidence = JSON.parse(readFileSync(incomplete.evidencePath, 'utf8'))
    writeFileSync(incomplete.reconciliationReportPath, `${JSON.stringify({
      state: 'matched',
      checks: {},
    })}\n`)
    incompleteEvidence.reconciliation.report_sha256 = sha256(
      readFileSync(incomplete.reconciliationReportPath),
    )
    writeFileSync(incomplete.evidencePath, `${JSON.stringify(incompleteEvidence)}\n`)
    const incompleteResult = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(incomplete),
    ])
    expect(incompleteResult.status).toBe(1)
    expect(incompleteResult.stdout).toBe('')
    expect(incompleteResult.stderr).toContain('unsupported evidence field contract')

    const invalidObservation = createCandidateEvidence({ historical: true })
    const observationEvidence = JSON.parse(readFileSync(invalidObservation.evidencePath, 'utf8'))
    writeFileSync(invalidObservation.observationReportPath, `${JSON.stringify({
      format: 'blogman-observation-window/v1',
      state: 'pending',
      required_hours: 24,
      started_at: 'ordinary private body must not be evidence',
      ended_at: null,
      start: null,
      end: null,
      anomaly_audit: null,
    })}\n`)
    observationEvidence.observation.report_sha256 = sha256(
      readFileSync(invalidObservation.observationReportPath),
    )
    writeFileSync(invalidObservation.evidencePath, `${JSON.stringify(observationEvidence)}\n`)
    const observationResult = runRolloutSafety([
      'candidate', 'verify-historical', ...candidateVerificationOptions(invalidObservation),
    ])
    expect(observationResult.status).toBe(1)
    expect(JSON.parse(observationResult.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['observation_report_state'],
    })
  })

  it('keeps v1 observation evidence read-only compatible but stale for current authorization', () => {
    const candidate = createCandidateEvidence({ historical: true })
    const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
    writeFileSync(candidate.observationReportPath, `${JSON.stringify({
      format: 'blogman-observation-window/v1',
      state: 'complete',
      required_hours: 24,
      started_at: '2026-07-25T00:00:00.000Z',
      ended_at: '2026-07-26T01:00:00.000Z',
      start: {
        observed_at: '2026-07-25T00:00:00.000Z',
        smoke_report_sha256: sha256(readFileSync(candidate.observationStartSmokeReportPath)),
        reconciliation_report_sha256: sha256(readFileSync(candidate.observationStartReconciliationReportPath)),
      },
      end: {
        observed_at: '2026-07-26T00:30:00.000Z',
        smoke_report_sha256: sha256(readFileSync(candidate.smokeReportPath)),
        reconciliation_report_sha256: sha256(readFileSync(candidate.reconciliationReportPath)),
      },
      anomaly_audit: {
        report_sha256: sha256(readFileSync(candidate.anomalyReportPath)),
      },
    })}\n`)
    evidence.observation.report_sha256 = sha256(readFileSync(candidate.observationReportPath))
    writeFileSync(candidate.evidencePath, `${JSON.stringify(evidence)}\n`)

    const stale = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(candidate),
    ])
    expect(stale.status).toBe(1)
    expect(JSON.parse(stale.stdout)).toMatchObject({
      state: 'stale',
      candidate_id: candidate.candidateId,
      acceptance_authority: false,
    })

    const complete = runRolloutSafety([
      'candidate', 'verify-historical', ...candidateVerificationOptions(candidate),
    ])
    expect(complete.status, complete.stderr).toBe(0)
    expect(JSON.parse(complete.stdout)).toMatchObject({
      state: 'verified-historical',
      candidate_id: candidate.candidateId,
      acceptance_authority: false,
    })

    writeFileSync(candidate.observationStartSmokeReportPath, `${JSON.stringify({
      state: 'passed',
      candidate_id: candidate.candidateId,
      build_sha256: sha256('different build'),
      deployment_id: candidate.deploymentId,
      version_id: candidate.versionId,
    })}\n`)
    const changedStart = runRolloutSafety([
      'candidate', 'verify-historical', ...candidateVerificationOptions(candidate),
    ])
    expect(changedStart.status).toBe(1)
    expect(JSON.parse(changedStart.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['observation_start_smoke_identity', 'observation_start_smoke_state'],
    })

    writeFileSync(candidate.observationStartSmokeReportPath, readFileSync(candidate.smokeReportPath))
    writeFileSync(candidate.anomalyReportPath, `${JSON.stringify({
      format: 'blogman-anomaly-audit/v1',
      state: 'blocked',
      checked_at: '2026-07-26T01:00:00.000Z',
      high_priority_open: 1,
    })}\n`)
    const blockedAnomaly = runRolloutSafety([
      'candidate', 'verify-historical', ...candidateVerificationOptions(candidate),
    ])
    expect(blockedAnomaly.status).toBe(1)
    expect(JSON.parse(blockedAnomaly.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['observation_anomaly_identity', 'observation_anomaly_state'],
    })

    writeFileSync(candidate.anomalyReportPath, `${JSON.stringify({
      format: 'blogman-anomaly-audit/v1',
      state: 'clear',
      checked_at: '2026-07-25T01:00:00.000Z',
      high_priority_open: 0,
    })}\n`)
    const earlyObservation = JSON.parse(readFileSync(candidate.observationReportPath, 'utf8'))
    earlyObservation.end.observed_at = '2026-07-25T01:00:00.000Z'
    earlyObservation.anomaly_audit.report_sha256 = sha256(readFileSync(candidate.anomalyReportPath))
    writeFileSync(candidate.observationReportPath, `${JSON.stringify(earlyObservation)}\n`)
    evidence.observation.report_sha256 = sha256(readFileSync(candidate.observationReportPath))
    writeFileSync(candidate.evidencePath, `${JSON.stringify(evidence)}\n`)

    const earlyEndEvidence = runRolloutSafety([
      'candidate', 'verify-historical', ...candidateVerificationOptions(candidate),
    ])
    expect(earlyEndEvidence.status).toBe(1)
    expect(JSON.parse(earlyEndEvidence.stdout)).toMatchObject({
      state: 'invalid',
      failures: ['observation_end_state'],
    })
  })

  it('adds auditable rollout controls through one additive ledger migration and keeps repeated apply idempotent', { timeout: 180_000 }, () => {
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
      .toEqual({ number: 6, name: '006_add_rollout_safety_controls' })

    const repeated = applyLedger(persistTo)
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(queryD1(persistTo, 'SELECT COUNT(*) AS count FROM migration_ledger')).toEqual([{ count: 6 }])
    expect(queryD1(persistTo, 'SELECT COUNT(*) AS count FROM rollout_control_events')).toEqual([{ count: 0 }])
  })

  it('records an idempotent rollout control change with immutable candidate-bound audit evidence', { timeout: 180_000 }, () => {
    const persistTo = temporaryDirectory('blogman-rollout-set-')
    const candidate = createCandidateEvidence()
    const migrated = applyLedger(persistTo, candidate.candidateId)
    expect(migrated.status, migrated.stderr).toBe(0)
    const args = [
      'rollout', 'set', '--control', 'producer', '--enabled', 'true',
      '--operation-id', 'enable-producer-001', '--actor', 'release-operator',
      '--reason', 'candidate evidence complete',
      ...candidateVerificationOptions(candidate),
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ]
    const updated = runRolloutSafety(args)
    expect(updated.status, updated.stderr).toBe(0)
    expect(JSON.parse(updated.stdout)).toEqual({
      state: 'updated',
      control: 'producer',
      desired: 'enabled',
      candidate_id: candidate.candidateId,
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(queryD1(persistTo, `
SELECT control_key, control_kind, desired_enabled, candidate_id
FROM rollout_controls
`)).toEqual([{
      control_key: 'producer',
      control_kind: 'producer',
      desired_enabled: 1,
      candidate_id: candidate.candidateId,
    }])
    expect(queryD1(persistTo, `
SELECT operation_id, control_key, previous_enabled, desired_enabled, candidate_id
FROM rollout_control_events
`)).toEqual([{
      operation_id: 'enable-producer-001',
      control_key: 'producer',
      previous_enabled: null,
      desired_enabled: 1,
      candidate_id: candidate.candidateId,
    }])

    const replay = runRolloutSafety(args)
    expect(replay.status, replay.stderr).toBe(0)
    expect(JSON.parse(replay.stdout)).toMatchObject({ state: 'unchanged', control: 'producer' })
    expect(queryD1(persistTo, 'SELECT COUNT(*) AS count FROM rollout_control_events')).toEqual([{ count: 1 }])

    const conflictingArgs = [...args]
    conflictingArgs[conflictingArgs.indexOf('--enabled') + 1] = 'false'
    const conflict = runRolloutSafety(conflictingArgs)
    expect(conflict.status).toBe(1)
    expect(conflict.stderr).toContain('operation identity')
    expect(queryD1(persistTo, 'SELECT desired_enabled FROM rollout_controls')).toEqual([{ desired_enabled: 1 }])
  })

  it('computes producer, authority, and executor status fail-closed without any environment enable path', { timeout: 300_000 }, () => {
    const persistTo = temporaryDirectory('blogman-rollout-status-')
    const candidate = createCandidateEvidence()
    const migrated = applyLedger(persistTo, candidate.candidateId)
    expect(migrated.status, migrated.stderr).toBe(0)
    const common = [
      ...candidateVerificationOptions(candidate),
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ]
    const setControl = (control: string, enabled: boolean, operationId: string) => runRolloutSafety([
      'rollout', 'set', '--control', control, '--enabled', String(enabled),
      '--operation-id', operationId, '--actor', 'release-operator',
      '--reason', 'status fixture', ...common,
    ])
    for (const [control, operationId] of [
      ['producer', 'producer-on'],
      ['authority', 'authority-on'],
      ['executor:publication', 'publication-on'],
    ]) {
      const result = setControl(control, true, operationId)
      expect(result.status, result.stderr).toBe(0)
    }

    const ready = runRolloutSafety(['rollout', 'status', ...common])
    expect(ready.status, ready.stderr).toBe(0)
    expect(JSON.parse(ready.stdout)).toMatchObject({
      state: 'ready',
      candidate: { state: 'verified', candidate_id: candidate.candidateId },
      controls: {
        producer: { desired: 'enabled', effective: 'enabled', blockers: [] },
        authority: { desired: 'enabled', effective: 'enabled', blockers: [] },
        executors: {
          publication: { desired: 'enabled', effective: 'enabled', blockers: [] },
        },
      },
    })

    const emergency = runRolloutSafety(['rollout', 'status', ...common], {
      BLOGMAN_DISABLE_AUTHORITY: 'true',
      BLOGMAN_DISABLE_EXECUTOR_PUBLICATION: '1',
    })
    expect(emergency.status).toBe(1)
    expect(JSON.parse(emergency.stdout)).toMatchObject({
      state: 'blocked',
      controls: {
        producer: { effective: 'enabled' },
        authority: { effective: 'disabled', blockers: ['emergency_disabled'] },
        executors: {
          publication: { effective: 'disabled', blockers: ['emergency_disabled'] },
        },
      },
    })

    const authorityOff = setControl('authority', false, 'authority-off')
    expect(authorityOff.status, authorityOff.stderr).toBe(0)
    const cannotForce = runRolloutSafety(['rollout', 'status', ...common], {
      BLOGMAN_ENABLE_AUTHORITY: 'true',
    })
    expect(cannotForce.status).toBe(1)
    expect(JSON.parse(cannotForce.stdout).controls.authority).toEqual({
      desired: 'disabled',
      effective: 'disabled',
      blockers: ['persisted_disabled'],
    })

    const invalidSwitch = runRolloutSafety(['rollout', 'status', ...common], {
      BLOGMAN_DISABLE_PRODUCER: 'sometimes',
    })
    expect(invalidSwitch.status).toBe(1)
    expect(JSON.parse(invalidSwitch.stdout).controls.producer).toEqual({
      desired: 'enabled',
      effective: 'disabled',
      blockers: ['invalid_emergency_switch'],
    })

    writeFileSync(candidate.buildPath, 'candidate identity changed after control approval\n')
    const staleCandidate = runRolloutSafety(['rollout', 'status', ...common])
    expect(staleCandidate.status).toBe(1)
    expect(JSON.parse(staleCandidate.stdout)).toMatchObject({
      state: 'blocked',
      candidate: { state: 'invalid' },
      controls: {
        producer: { effective: 'disabled', blockers: ['candidate_invalid'] },
        authority: { effective: 'disabled', blockers: ['persisted_disabled', 'candidate_invalid'] },
      },
    })

    const auditedDisable = setControl('producer', false, 'producer-off-invalid-evidence')
    expect(auditedDisable.status, auditedDisable.stderr).toBe(0)
    expect(JSON.parse(auditedDisable.stdout)).toMatchObject({
      state: 'updated',
      desired: 'disabled',
      evidence_state: 'invalid',
    })
    expect(queryD1(persistTo, `
SELECT operation_id, desired_enabled, evidence_state
FROM rollout_control_events
WHERE operation_id = 'producer-off-invalid-evidence'
`)).toEqual([{
      operation_id: 'producer-off-invalid-evidence',
      desired_enabled: 0,
      evidence_state: 'invalid',
    }])

    const unsafe = [...common]
    unsafe[unsafe.indexOf('--candidate') + 1] = 'sk-disable-must-not-leak'
    const unavailableDisable = runRolloutSafety([
      'rollout', 'set', '--control', 'authority', '--enabled', 'false',
      '--operation-id', 'authority-off-unavailable-evidence',
      '--actor', 'release-operator', '--reason', 'emergency deactivation',
      ...unsafe,
    ])
    expect(unavailableDisable.status, unavailableDisable.stderr).toBe(0)
    expect(`${unavailableDisable.stdout}${unavailableDisable.stderr}`)
      .not.toContain('sk-disable-must-not-leak')
    expect(JSON.parse(unavailableDisable.stdout)).toMatchObject({
      state: 'updated',
      desired: 'disabled',
      candidate_id: 'unavailable',
      evidence_state: 'unavailable',
    })
    expect(queryD1(persistTo, `
SELECT candidate_id, evidence_state
FROM rollout_control_events
WHERE operation_id = 'authority-off-unavailable-evidence'
`)).toEqual([{ candidate_id: 'unavailable', evidence_state: 'unavailable' }])
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

  it('rejects sensitive fields and credential-like audit values without echoing them', () => {
    const backup = createValidBackupPackage()
    const backupManifest = JSON.parse(readFileSync(backup.manifestPath, 'utf8'))
    backupManifest.raw_response = { password: 'backup-password-must-not-leak' }
    writeFileSync(backup.manifestPath, `${JSON.stringify(backupManifest)}\n`)
    const backupResult = runRolloutSafety(['backup', 'verify', '--manifest', backup.manifestPath])
    expect(backupResult.status).toBe(1)
    expect(backupResult.stderr).toContain('forbidden sensitive field')
    expect(`${backupResult.stdout}${backupResult.stderr}`).not.toContain('backup-password-must-not-leak')

    const candidate = createCandidateEvidence()
    const candidateEvidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
    candidateEvidence.credentials = { AI_API_KEY: 'sk-candidate-must-not-leak' }
    writeFileSync(candidate.evidencePath, `${JSON.stringify(candidateEvidence)}\n`)
    const common = candidateVerificationOptions(candidate)
    const candidateResult = runRolloutSafety(['candidate', 'verify', ...common])
    expect(candidateResult.status).toBe(1)
    expect(candidateResult.stderr).toContain('forbidden sensitive field')
    expect(`${candidateResult.stdout}${candidateResult.stderr}`).not.toContain('sk-candidate-must-not-leak')

    const valueCandidate = createCandidateEvidence()
    const valueEvidence = JSON.parse(readFileSync(valueCandidate.evidencePath, 'utf8'))
    valueEvidence.note = 'sk-sensitive-value-must-not-leak'
    writeFileSync(valueCandidate.evidencePath, `${JSON.stringify(valueEvidence)}\n`)
    const valueResult = runRolloutSafety([
      'candidate', 'verify', ...candidateVerificationOptions(valueCandidate),
    ])
    expect(valueResult.status).toBe(1)
    expect(valueResult.stderr).toMatch(/forbidden sensitive value|unsupported evidence field/)
    expect(`${valueResult.stdout}${valueResult.stderr}`).not.toContain('sk-sensitive-value-must-not-leak')

    const persistTo = temporaryDirectory('blogman-rollout-sensitive-audit-')
    delete candidateEvidence.credentials
    writeFileSync(candidate.evidencePath, `${JSON.stringify(candidateEvidence)}\n`)
    const auditResult = runRolloutSafety([
      'rollout', 'set', '--control', 'authority', '--enabled', 'false',
      '--operation-id', 'sensitive-audit-001', '--actor', 'release-operator',
      '--reason', 'api_key=sk-audit-must-not-leak', ...common,
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ])
    expect(auditResult.status).toBe(1)
    expect(auditResult.stderr).toContain('forbidden sensitive value')
    expect(`${auditResult.stdout}${auditResult.stderr}`).not.toContain('sk-audit-must-not-leak')
  })

  it('preserves post-switch facts and audit history when deactivated and rejects an old backup over the active D1', { timeout: 240_000 }, () => {
    const backup = createValidBackupPackage()
    const persistTo = temporaryDirectory('blogman-rollout-rollback-protection-')
    const databaseOptions = [
      '--database', 'DB', '--local', '--persist-to', persistTo,
      '--config', join(repoRoot, 'wrangler.toml'),
    ]
    const restored = runRolloutSafety([
      'backup', 'restore', '--manifest', backup.manifestPath, ...databaseOptions,
    ])
    expect(restored.status, restored.stderr).toBe(0)
    const candidate = createCandidateEvidence()
    expect(applyLedger(persistTo, candidate.candidateId).status).toBe(0)
    const common = [...candidateVerificationOptions(candidate), ...databaseOptions]
    const setProducer = (enabled: boolean, operationId: string) => runRolloutSafety([
      'rollout', 'set', '--control', 'producer', '--enabled', String(enabled),
      '--operation-id', operationId, '--actor', 'release-operator',
      '--reason', enabled ? 'switch rehearsal' : 'deactivation rehearsal', ...common,
    ])
    expect(setProducer(true, 'rollback-producer-on').status).toBe(0)
    queryD1(persistTo, `
INSERT INTO posts (slug, title, content, html, status)
VALUES ('post-switch-fact', 'Post-switch fact', 'must survive rollback drill', '<p>must survive rollback drill</p>', 'draft')
`)
    expect(setProducer(false, 'rollback-producer-off').status).toBe(0)

    const before = {
      controls: queryD1(persistTo, 'SELECT control_key, desired_enabled FROM rollout_controls ORDER BY control_key'),
      events: queryD1(persistTo, 'SELECT operation_id, desired_enabled FROM rollout_control_events ORDER BY id'),
      posts: queryD1(persistTo, 'SELECT slug FROM posts ORDER BY slug'),
    }
    const oldRestore = runRolloutSafety([
      'backup', 'restore', '--manifest', backup.manifestPath, ...databaseOptions,
    ])
    expect(oldRestore.status).toBe(1)
    expect(oldRestore.stderr).toContain('empty isolated directory')
    expect({
      controls: queryD1(persistTo, 'SELECT control_key, desired_enabled FROM rollout_controls ORDER BY control_key'),
      events: queryD1(persistTo, 'SELECT operation_id, desired_enabled FROM rollout_control_events ORDER BY id'),
      posts: queryD1(persistTo, 'SELECT slug FROM posts ORDER BY slug'),
    }).toEqual(before)
    expect(before).toMatchObject({
      controls: [{ control_key: 'producer', desired_enabled: 0 }],
      events: [
        { operation_id: 'rollback-producer-on', desired_enabled: 1 },
        { operation_id: 'rollback-producer-off', desired_enabled: 0 },
      ],
      posts: [{ slug: 'post-switch-fact' }, { slug: 'restored-post' }],
    })
  })
})
