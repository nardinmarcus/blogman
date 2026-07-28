import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

type JsonSchema = {
  const?: unknown
  type?: 'object' | 'string' | 'integer' | 'array'
  properties?: Record<string, JsonSchema>
  required?: string[]
  pattern?: string
  minimum?: number
  prefixItems?: JsonSchema[]
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type CleanStartRequestFixture = {
  produced_at: string
  candidate: { commit: string; tree: string }
  repository: {
    lockfile: { sha256: string }
    runbook: { sha256: string }
    migrations: { set_sha256: string }
  }
  build: { archive_sha256: string; worker_sha256: string; tree_manifest_sha256: string }
  github_evidence: { quick: { head_sha: string; head_tree: string; raw_job_log_sha256: string } }
  expected_production_baseline: {
    deployment_id: string
    version_id: string
    d1_database_id: string
  }
  clean_start: {
    decision: string
    database_strategy: string
    reset_sql: { sha256: string }
    historical_data_export: string
    double_restore: string
    historical_baseline_queries: string
  }
}

function materializeSchema(schema: JsonSchema): unknown {
  if (Object.hasOwn(schema, 'const')) return schema.const
  if (schema.type === 'object') {
    return Object.fromEntries(
      (schema.required ?? []).map((key) => [key, materializeSchema(schema.properties![key])]),
    )
  }
  if (schema.type === 'array') return (schema.prefixItems ?? []).map(materializeSchema)
  if (schema.type === 'integer') return schema.minimum ?? 1
  if (schema.type === 'string') {
    if (schema.pattern?.includes('{64}')) return '1'.repeat(64)
    if (schema.pattern?.includes('{40}')) return 'a'.repeat(40)
    if (schema.pattern?.includes('\\d{4}-')) return '2026-07-26T00:00:00.000Z'
    return 'fixture'
  }
  throw new Error('Unsupported test schema fixture')
}

function orderBySchema(value: JsonValue, schema: JsonSchema): JsonValue {
  if (schema.type === 'object') {
    const objectValue = value as { [key: string]: JsonValue }
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key]) => Object.hasOwn(objectValue, key))
        .map(([key, child]) => [key, orderBySchema(objectValue[key], child)]),
    )
  }
  if (schema.type === 'array') {
    return (value as JsonValue[]).map((item, index) => (
      orderBySchema(item, schema.prefixItems?.[index] ?? {})
    ))
  }
  return value
}

function writeSchemaDocument(path: string, value: unknown, schemaName: string) {
  const schema = JSON.parse(readFileSync(
    join(repoRoot, 'schemas', 'issue-23-reseal', schemaName),
    'utf8',
  ))
  writeFileSync(path, `${JSON.stringify(orderBySchema(value, schema), null, 2)}\n`)
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

function createLegacyCandidateEvidence({ historical = false } = {}) {
  const directory = temporaryDirectory('blogman-rollout-candidate-')
  const buildPath = join(directory, 'worker-bundle.js')
  writeFileSync(buildPath, 'immutable worker bundle\n')
  const candidateId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const deploymentId = 'deployment-22'
  const versionId = '11111111-2222-4333-8444-555555555555'
  const d1DatabaseId = '5d1cadcf-e10e-4245-b07d-16c64754f00d'
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

function createCleanStartAuthorityPackage(candidate: ReturnType<typeof createLegacyCandidateEvidence>) {
  const directory = dirname(candidate.evidencePath)
  const packagePath = join(directory, 'sealed-package')
  mkdirSync(packagePath)
  const requestSchemaName = 'blogman-issue-23-local-reseal-request-v3.schema.json'
  const requestSchema = JSON.parse(readFileSync(
    join(repoRoot, 'schemas', 'issue-23-reseal', requestSchemaName),
    'utf8',
  ))
  const request = materializeSchema(requestSchema) as CleanStartRequestFixture
  const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
  const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const resetSqlSha256 = sha256(readFileSync(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')))
  request.candidate.commit = candidate.candidateId
  request.candidate.tree = 'b'.repeat(40)
  request.repository.lockfile.sha256 = evidence.lockfile.sha256
  request.build.archive_sha256 = evidence.build.sha256
  request.build.worker_sha256 = '3'.repeat(64)
  request.build.tree_manifest_sha256 = '4'.repeat(64)
  request.github_evidence.quick.head_sha = candidate.candidateId
  request.github_evidence.quick.head_tree = request.candidate.tree
  request.clean_start.reset_sql.sha256 = resetSqlSha256
  const requestPath = join(directory, 'reseal-request.json')
  writeSchemaDocument(requestPath, request, requestSchemaName)

  const preflight = {
    format: 'blogman-local-preflight-candidate/v2',
    state: 'sealed-local-only',
    produced_at: request.produced_at,
    candidate_id: candidate.candidateId,
    lockfile: {
      sha256: evidence.lockfile.sha256,
      wrangler: lockfile.packages['node_modules/wrangler'].version,
      opennextjs_cloudflare: lockfile.packages['node_modules/@opennextjs/cloudflare'].version,
    },
    migration_set_sha256: request.repository.migrations.set_sha256,
    runbook_sha256: request.repository.runbook.sha256,
    build: {
      archive_sha256: evidence.build.sha256,
      worker_sha256: request.build.worker_sha256,
      tree_manifest_sha256: request.build.tree_manifest_sha256,
    },
    tests: {
      affected_phase_b: { state: 'passed', passed: 1, failed: 0 },
      static_gates: 'passed',
      open_next_build: { state: 'passed', static_pages: 1 },
      canonical_long_migration_runner: { state: 'passed', passed: 46, failed: 0 },
    },
    reviews: {
      standards: { state: 'passed', blockers: 0 },
      spec: { state: 'passed', blockers: 0 },
    },
    production_counters_all_zero: true,
  }
  const preflightPath = join(packagePath, 'preflight-candidate.json')
  writeSchemaDocument(
    preflightPath,
    preflight,
    'blogman-local-preflight-candidate-v2.schema.json',
  )
  const approval = {
    format: 'blogman-issue-23-approval-packet/v4',
    state: 'ready-for-fresh-production-authorization',
    produced_at: request.produced_at,
    delivery_mode: 'clean-start',
    clean_start: {
      decision: request.clean_start.decision,
      database_strategy: request.clean_start.database_strategy,
      reset_sql_sha256: resetSqlSha256,
      historical_data_export: request.clean_start.historical_data_export,
      double_restore: request.clean_start.double_restore,
      historical_baseline_queries: request.clean_start.historical_baseline_queries,
    },
    candidate_id: candidate.candidateId,
    local_preflight_candidate_sha256: sha256(readFileSync(preflightPath)),
    lockfile_sha256: evidence.lockfile.sha256,
    migration_set_sha256: request.repository.migrations.set_sha256,
    runbook_sha256: request.repository.runbook.sha256,
    build_archive_sha256: evidence.build.sha256,
    worker_sha256: request.build.worker_sha256,
    tree_manifest_sha256: request.build.tree_manifest_sha256,
    expected_baseline: request.expected_production_baseline,
    scope: [
      'one candidate-bound in-place D1 reset',
      'one empty D1 proof and plan',
      'one version upload',
      'migrations 001-006',
      'one 100% traffic deployment',
      'status-only smoke and reconciliation',
      'rollback and controls proof',
      'T0 event acceptance',
    ],
    old_lineages_invalid: true,
  }
  const approvalPacketPath = join(packagePath, 'approval-packet.json')
  writeSchemaDocument(
    approvalPacketPath,
    approval,
    'blogman-issue-23-approval-packet-v4.schema.json',
  )
  const dispositions = {
    production_export: 'NOT_APPLICABLE',
    double_restore: 'NOT_APPLICABLE',
    historical_baseline_queries: 'NOT_APPLICABLE',
  }
  const preCas = {
    format: 'blogman-issue-23-pre-cas-bindings/v4',
    state: 'sealed-local-only',
    produced_at: request.produced_at,
    executor_started: false,
    production_authorization_granted: false,
    formal_pre_migration_candidate_created: false,
    immutable_phase_b_bindings: {
      candidateId: candidate.candidateId,
      approvalPacketSha256: sha256(readFileSync(approvalPacketPath)),
      buildArchiveSha256: evidence.build.sha256,
      baselineDeploymentId: request.expected_production_baseline.deployment_id,
      baselineVersionId: request.expected_production_baseline.version_id,
      baselineD1DatabaseId: request.expected_production_baseline.d1_database_id,
      deliveryMode: 'clean-start',
      cleanStartResetSqlSha256: resetSqlSha256,
      historicalDataDisposition: {
        productionExport: 'NOT_APPLICABLE',
        doubleRestore: 'NOT_APPLICABLE',
        historicalBaselineQueries: 'NOT_APPLICABLE',
      },
    },
    migration_set_sha256: request.repository.migrations.set_sha256,
    historical_data_disposition: dispositions,
    stage_counts: {
      pre_cas_local_gates: 0,
      cas1: 0,
      d1_identity: 0,
      upload: 0,
      clean_start_reset: 0,
      clean_start_empty_verify: 0,
      remote_migration_plan: 0,
      migrations_001_006: 0,
      cas2: 0,
      traffic: 0,
      smoke_reconcile: 0,
      t0: 0,
    },
    start_conditions: {
      fresh_candidate_bound_authorization_required: true,
      no_prior_lineage_reuse: true,
    },
  }
  const preCasPath = join(packagePath, 'pre-cas-bindings.json')
  writeSchemaDocument(
    preCasPath,
    preCas,
    'blogman-issue-23-pre-cas-bindings-v4.schema.json',
  )
  const manifest = {
    format: 'blogman-issue-23-package-manifest/v4',
    state: 'sealed-local-only',
    produced_at: request.produced_at,
    delivery_mode: 'clean-start',
    clean_start_reset_sql_sha256: resetSqlSha256,
    historical_data_disposition: dispositions,
    candidate_id: candidate.candidateId,
    local_preflight_candidate_sha256: sha256(readFileSync(preflightPath)),
    approval_packet_sha256: sha256(readFileSync(approvalPacketPath)),
    pre_cas_bindings_sha256: sha256(readFileSync(preCasPath)),
    build_archive_sha256: evidence.build.sha256,
    migration_set_sha256: request.repository.migrations.set_sha256,
    formal_pre_migration_candidate_created: false,
    production_counters_all_zero: true,
    github_ci: 'pending',
  }
  const manifestPath = join(packagePath, 'package-manifest.json')
  writeSchemaDocument(
    manifestPath,
    manifest,
    'blogman-issue-23-package-manifest-v4.schema.json',
  )
  return { approvalPacketPath, manifestPath, packagePath, requestPath }
}

function candidateVerificationOptions(candidate: ReturnType<typeof createCleanStartCandidateEvidence> | ReturnType<typeof createLegacyCandidateEvidence>) {
  const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
  return [
    '--evidence', candidate.evidencePath,
    '--candidate', candidate.candidateId,
    '--lockfile', join(repoRoot, 'package-lock.json'),
    '--build', candidate.buildPath,
    '--deployment', candidate.deploymentId,
    '--version', candidate.versionId,
    ...(['blogman-rollout-candidate/v2', 'blogman-rollout-candidate/v3'].includes(evidence.format)
      ? ['--d1-database', candidate.d1DatabaseId]
      : []),
    ...(evidence.format === 'blogman-rollout-candidate/v3'
      ? [
          '--reseal-request', candidate.requestPath,
          '--sealed-package', candidate.packagePath,
          '--build-directory-proof', candidate.buildDirectoryProofPath,
          '--clean-start-upload-report', candidate.uploadReportPath,
          '--clean-start-reset-report', candidate.resetReportPath,
          '--clean-start-empty-report', candidate.emptyReportPath,
          '--clean-start-empty-plan-report', candidate.emptyPlanReportPath,
          '--rollback-control-proof', candidate.rollbackControlProofPath,
        ]
      : [
          '--backup-report', candidate.backupReportPath,
          '--restore-report', candidate.restoreReportPath,
        ]),
    '--migration-report', candidate.migrationReportPath,
    '--migration-verification-report', candidate.migrationVerificationReportPath,
    '--reconciliation-report', candidate.reconciliationReportPath,
    '--smoke-report', candidate.smokeReportPath,
    '--smoke-runtime-report', candidate.smokeRuntimeReportPath,
    '--rollout-report', candidate.rolloutReportPath,
    '--test-report', candidate.testReportPath,
    ...(['blogman-rollout-candidate/v2', 'blogman-rollout-candidate/v3'].includes(evidence.format)
      ? ['--t0-report', candidate.t0ReportPath]
      : [
          '--observation-report', candidate.observationReportPath,
          '--observation-start-smoke-report', candidate.observationStartSmokeReportPath,
          '--observation-start-reconciliation-report', candidate.observationStartReconciliationReportPath,
        ]),
    '--anomaly-report', candidate.anomalyReportPath,
  ]
}

function createCleanStartCandidateEvidence() {
  const candidate = createLegacyCandidateEvidence()
  const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
  const directory = dirname(candidate.evidencePath)
  const resetSqlSha256 = sha256(readFileSync(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')))
  const authority = createCleanStartAuthorityPackage(candidate)
  const { approvalPacketPath } = authority
  const approvalPacketSha256 = sha256(readFileSync(approvalPacketPath))
  const request = JSON.parse(readFileSync(authority.requestPath, 'utf8'))
  const buildDirectoryProofPath = join(directory, 'build-directory-proof.json')
  writeFileSync(buildDirectoryProofPath, `${JSON.stringify({
    format: 'blogman-build-directory-proof/v1',
    state: 'matched',
    archive_sha256: evidence.build.sha256,
    file_count: 1,
  })}\n`)
  const uploadReportPath = join(directory, 'clean-start-upload-report.json')
  writeFileSync(uploadReportPath, `${JSON.stringify({
    format: 'blogman-clean-start-upload/v1',
    state: 'captured',
    uploaded_at: '2026-07-26T00:05:00.000Z',
    candidate_id: candidate.candidateId,
    build_archive_sha256: evidence.build.sha256,
    build_directory_proof_sha256: sha256(readFileSync(buildDirectoryProofPath)),
    wrangler_output_sha256: '5'.repeat(64),
    upload_operation_id: `issue-23-${candidate.candidateId}-upload-1`,
    version_id: candidate.versionId,
    attempt_count: 1,
  })}\n`)
  const resetReportPath = join(directory, 'clean-start-reset-report.json')
  writeFileSync(resetReportPath, `${JSON.stringify({
    format: 'blogman-clean-start-reset/v1',
    state: 'reset',
    completed_at: '2026-07-26T00:10:00.000Z',
    candidate_id: candidate.candidateId,
    approval_packet_sha256: approvalPacketSha256,
    reset_sql_sha256: resetSqlSha256,
    d1_database_id: candidate.d1DatabaseId,
    attempt_count: 1,
  })}\n`)
  const emptyReportPath = join(directory, 'clean-start-empty-report.json')
  writeFileSync(emptyReportPath, `${JSON.stringify({
    format: 'blogman-clean-start-empty/v1',
    state: 'verified-empty',
    checked_at: '2026-07-26T00:10:01.000Z',
    candidate_id: candidate.candidateId,
    approval_packet_sha256: approvalPacketSha256,
    reset_sql_sha256: resetSqlSha256,
    d1_database_id: candidate.d1DatabaseId,
    application_object_count: 0,
    migration_ledger_state: 'absent',
  })}\n`)
  const emptyPlanReportPath = join(directory, 'clean-start-empty-plan-report.json')
  writeFileSync(emptyPlanReportPath, `${JSON.stringify({
    format: 'blogman-clean-start-empty-plan/v1',
    state: 'verified-empty-plan',
    checked_at: '2026-07-26T00:10:02.000Z',
    candidate_id: candidate.candidateId,
    d1_database_id: candidate.d1DatabaseId,
    reset_report_sha256: sha256(readFileSync(resetReportPath)),
    empty_report_sha256: sha256(readFileSync(emptyReportPath)),
    migrations: migrationCatalog().map((migration) => ({ ...migration, action: 'apply' })),
  })}\n`)

  const rollbackControlProofPath = join(directory, 'rollback-control-proof-report.json')
  writeFileSync(rollbackControlProofPath, `${JSON.stringify({
    format: 'blogman-clean-start-rollback-control-proof/v1',
    state: 'proved',
    checked_at: '2026-07-26T00:59:00.000Z',
    candidate_id: candidate.candidateId,
    baseline_version_id: request.expected_production_baseline.version_id,
    candidate_version_id: candidate.versionId,
    d1_database_id: candidate.d1DatabaseId,
    traffic_restore_scope: 'baseline-worker-version-only',
    d1_recovery: 'forward-only',
    discarded_data_recoverable: false,
    rollout_report_sha256: sha256(readFileSync(candidate.rolloutReportPath)),
  })}\n`)

  const smoke = JSON.parse(readFileSync(candidate.smokeReportPath, 'utf8'))
  smoke.checks.admin_article = 404
  writeFileSync(candidate.smokeReportPath, `${JSON.stringify(smoke)}\n`)

  const t0 = JSON.parse(readFileSync(candidate.t0ReportPath, 'utf8'))
  t0.format = 'blogman-t0-acceptance/v2'
  t0.delivery_mode = 'clean-start'
  t0.clean_start_reset_report_sha256 = sha256(readFileSync(resetReportPath))
  t0.clean_start_empty_report_sha256 = sha256(readFileSync(emptyReportPath))
  t0.clean_start_upload_report_sha256 = sha256(readFileSync(uploadReportPath))
  t0.clean_start_empty_plan_report_sha256 = sha256(readFileSync(emptyPlanReportPath))
  t0.rollback_control_proof_sha256 = sha256(readFileSync(rollbackControlProofPath))
  t0.smoke_report_sha256 = sha256(readFileSync(candidate.smokeReportPath))
  writeFileSync(candidate.t0ReportPath, `${JSON.stringify(t0)}\n`)

  evidence.format = 'blogman-rollout-candidate/v3'
  evidence.delivery_mode = 'clean-start'
  evidence.cloudflare.upload_report_sha256 = sha256(readFileSync(uploadReportPath))
  delete evidence.backup
  evidence.clean_start = {
    reseal_request_sha256: sha256(readFileSync(authority.requestPath)),
    package_manifest_sha256: sha256(readFileSync(authority.manifestPath)),
    approval_packet_sha256: approvalPacketSha256,
    reset_sql_sha256: resetSqlSha256,
    reset_report_sha256: sha256(readFileSync(resetReportPath)),
    empty_report_sha256: sha256(readFileSync(emptyReportPath)),
    empty_plan_report_sha256: sha256(readFileSync(emptyPlanReportPath)),
    rollback_control_proof_sha256: sha256(readFileSync(rollbackControlProofPath)),
    historical_data_export: 'NOT_APPLICABLE',
    double_restore: 'NOT_APPLICABLE',
    historical_baseline_queries: 'NOT_APPLICABLE',
  }
  evidence.smoke.report_sha256 = sha256(readFileSync(candidate.smokeReportPath))
  evidence.t0.report_sha256 = sha256(readFileSync(candidate.t0ReportPath))
  writeFileSync(candidate.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  return {
    ...candidate,
    ...authority,
    approvalPacketPath,
    buildDirectoryProofPath,
    emptyReportPath,
    emptyPlanReportPath,
    resetReportPath,
    rollbackControlProofPath,
    uploadReportPath,
  }
}

function cleanStartCandidateVerificationOptions(
  candidate: ReturnType<typeof createCleanStartCandidateEvidence>,
) {
  return candidateVerificationOptions(candidate)
}

function createCandidateEvidence() {
  return createCleanStartCandidateEvidence()
}

function createPreMigrationEvidence() {
  const candidate = createCleanStartCandidateEvidence()
  const finalEvidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
  writeFileSync(candidate.reconciliationReportPath, `${JSON.stringify({
    state: 'matched',
    checks: {
      schema: 'matched',
      migration_ledger: 'matched',
      post_count: 'matched',
      post_status: 'matched',
      post_content: 'matched',
    },
  })}\n`)
  const lockfileBytes = readFileSync(join(repoRoot, 'package-lock.json'))
  const lockfile = JSON.parse(lockfileBytes.toString('utf8'))
  const preMigrationCleanStart = { ...finalEvidence.clean_start }
  delete preMigrationCleanStart.rollback_control_proof_sha256
  const evidencePath = join(temporaryDirectory('blogman-pre-migration-candidate-'), 'candidate.json')
  writeFileSync(evidencePath, `${JSON.stringify({
    format: 'blogman-pre-migration-candidate/v2',
    delivery_mode: 'clean-start',
    candidate_id: candidate.candidateId,
    lockfile: {
      sha256: sha256(lockfileBytes),
      wrangler: lockfile.packages['node_modules/wrangler'].version,
      opennextjs_cloudflare: lockfile.packages['node_modules/@opennextjs/cloudflare'].version,
    },
    build: { sha256: sha256(readFileSync(candidate.buildPath)) },
    cloudflare: {
      uploaded_version_id: candidate.versionId,
      upload_report_sha256: sha256(readFileSync(candidate.uploadReportPath)),
    },
    migration: {
      set_sha256: migrationSetSha256(),
      verification_report_sha256: sha256(readFileSync(candidate.migrationVerificationReportPath)),
    },
    clean_start: preMigrationCleanStart,
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
    '--d1-database', candidate.d1DatabaseId,
    '--reseal-request', candidate.requestPath,
    '--sealed-package', candidate.packagePath,
    '--build-directory-proof', candidate.buildDirectoryProofPath,
    '--clean-start-upload-report', candidate.uploadReportPath,
    '--clean-start-reset-report', candidate.resetReportPath,
    '--clean-start-empty-report', candidate.emptyReportPath,
    '--clean-start-empty-plan-report', candidate.emptyPlanReportPath,
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
  it('verifies only a candidate-bound clean-start T0 contract', () => {
    const candidate = createCleanStartCandidateEvidence()
    const options = cleanStartCandidateVerificationOptions(candidate)
    const verified = runRolloutSafety(['candidate', 'verify', ...options])

    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({
      state: 'verified',
      phase: 'batch-1-t0',
      candidate_id: candidate.candidateId,
      d1_database_id: candidate.d1DatabaseId,
    })

    const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
    evidence.clean_start.historical_data_export = 'SKIPPED'
    writeFileSync(candidate.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    const bypass = runRolloutSafety(['candidate', 'verify', ...options])
    expect(bypass.status).toBe(1)
    expect(bypass.stderr).toContain('clean-start disposition')
  })

  it('rejects a current candidate when the sealed quartet drifts', () => {
    const candidate = createCleanStartCandidateEvidence()
    const manifest = JSON.parse(readFileSync(candidate.manifestPath, 'utf8'))
    manifest.historical_data_disposition.production_export = 'SKIPPED'
    writeFileSync(candidate.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runRolloutSafety([
      'candidate',
      'verify',
      ...cleanStartCandidateVerificationOptions(candidate),
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('historical_data_disposition')
  })

  it('rejects a schema-valid request mutation outside the approval projection', () => {
    const candidate = createCleanStartCandidateEvidence()
    const request = JSON.parse(readFileSync(candidate.requestPath, 'utf8'))
    request.github_evidence.quick.raw_job_log_sha256 = '8'.repeat(64)
    writeSchemaDocument(
      candidate.requestPath,
      request,
      'blogman-issue-23-local-reseal-request-v3.schema.json',
    )

    const result = runRolloutSafety([
      'candidate',
      'verify',
      ...cleanStartCandidateVerificationOptions(candidate),
    ])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).failures).toContain('clean_start_request_identity')
  })

  it('rejects an internally coherent v4 quartet whose build hash is a placeholder', () => {
    const candidate = createCleanStartCandidateEvidence()
    const placeholder = '9'.repeat(64)
    const request = JSON.parse(readFileSync(candidate.requestPath, 'utf8'))
    request.build.archive_sha256 = placeholder
    writeSchemaDocument(
      candidate.requestPath,
      request,
      'blogman-issue-23-local-reseal-request-v3.schema.json',
    )

    const preflightPath = join(candidate.packagePath, 'preflight-candidate.json')
    const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'))
    preflight.build.archive_sha256 = placeholder
    writeSchemaDocument(preflightPath, preflight, 'blogman-local-preflight-candidate-v2.schema.json')

    const approval = JSON.parse(readFileSync(candidate.approvalPacketPath, 'utf8'))
    approval.build_archive_sha256 = placeholder
    approval.local_preflight_candidate_sha256 = sha256(readFileSync(preflightPath))
    writeSchemaDocument(
      candidate.approvalPacketPath,
      approval,
      'blogman-issue-23-approval-packet-v4.schema.json',
    )

    const preCasPath = join(candidate.packagePath, 'pre-cas-bindings.json')
    const preCas = JSON.parse(readFileSync(preCasPath, 'utf8'))
    preCas.immutable_phase_b_bindings.buildArchiveSha256 = placeholder
    preCas.immutable_phase_b_bindings.approvalPacketSha256 = sha256(
      readFileSync(candidate.approvalPacketPath),
    )
    writeSchemaDocument(
      preCasPath,
      preCas,
      'blogman-issue-23-pre-cas-bindings-v4.schema.json',
    )

    const manifest = JSON.parse(readFileSync(candidate.manifestPath, 'utf8'))
    manifest.build_archive_sha256 = placeholder
    manifest.local_preflight_candidate_sha256 = sha256(readFileSync(preflightPath))
    manifest.approval_packet_sha256 = sha256(readFileSync(candidate.approvalPacketPath))
    manifest.pre_cas_bindings_sha256 = sha256(readFileSync(preCasPath))
    writeSchemaDocument(
      candidate.manifestPath,
      manifest,
      'blogman-issue-23-package-manifest-v4.schema.json',
    )

    const packageValidation = spawnSync(process.execPath, [
      rolloutSafetyPath.replace('rollout-safety.mjs', 'issue-23-reseal.mjs'),
      'validate', '--package', candidate.packagePath,
    ], { cwd: repoRoot, encoding: 'utf8' })
    expect(packageValidation.status, packageValidation.stderr).toBe(0)

    const result = runRolloutSafety([
      'candidate', 'verify', ...cleanStartCandidateVerificationOptions(candidate),
    ])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).failures).toContain('clean_start_approval_state')
  })

  it('keeps the former v2 T0 candidate read-only but stale for current authorization', () => {
    const candidate = createLegacyCandidateEvidence()
    const options = candidateVerificationOptions(candidate)

    const current = runRolloutSafety(['candidate', 'verify', ...options])
    expect(current.status).toBe(1)
    expect(JSON.parse(current.stdout)).toMatchObject({
      state: 'stale',
      acceptance_authority: false,
    })

    const historical = runRolloutSafety(['candidate', 'verify-historical', ...options])
    expect(historical.status, historical.stderr).toBe(0)
    expect(JSON.parse(historical.stdout)).toMatchObject({
      state: 'verified-historical',
      acceptance_authority: false,
    })
  })

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

  it('rejects a rehashed empty plan whose exact 001-006 apply content drifts', () => {
    const value = createPreMigrationEvidence()
    const plan = JSON.parse(readFileSync(value.candidate.emptyPlanReportPath, 'utf8'))
    plan.migrations[0].action = 'baseline'
    writeFileSync(value.candidate.emptyPlanReportPath, `${JSON.stringify(plan)}\n`)
    const evidence = JSON.parse(readFileSync(value.evidencePath, 'utf8'))
    evidence.clean_start.empty_plan_report_sha256 = sha256(
      readFileSync(value.candidate.emptyPlanReportPath),
    )
    writeFileSync(value.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

    const result = runRolloutSafety([
      'candidate', 'verify-pre-migration', ...preMigrationVerificationOptions(value),
    ])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).failures).toContain('clean_start_empty_plan_state')
  })

  it.each([
    ['upload', 'clean_start_upload_state'],
    ['rollback', 'rollback_control_proof_state'],
  ])('rejects a rehashed %s proof with a wrong bound identity', (proof, failure) => {
    const candidate = createCleanStartCandidateEvidence()
    const evidence = JSON.parse(readFileSync(candidate.evidencePath, 'utf8'))
    const t0 = JSON.parse(readFileSync(candidate.t0ReportPath, 'utf8'))
    if (proof === 'upload') {
      const upload = JSON.parse(readFileSync(candidate.uploadReportPath, 'utf8'))
      upload.version_id = '99999999-2222-4333-8444-555555555555'
      writeFileSync(candidate.uploadReportPath, `${JSON.stringify(upload)}\n`)
      const digest = sha256(readFileSync(candidate.uploadReportPath))
      evidence.cloudflare.upload_report_sha256 = digest
      t0.clean_start_upload_report_sha256 = digest
    } else {
      const rollback = JSON.parse(readFileSync(candidate.rollbackControlProofPath, 'utf8'))
      rollback.baseline_version_id = '99999999-996f-496d-a090-4c779ad57c3a'
      writeFileSync(candidate.rollbackControlProofPath, `${JSON.stringify(rollback)}\n`)
      const digest = sha256(readFileSync(candidate.rollbackControlProofPath))
      evidence.clean_start.rollback_control_proof_sha256 = digest
      t0.rollback_control_proof_sha256 = digest
    }
    writeFileSync(candidate.t0ReportPath, `${JSON.stringify(t0)}\n`)
    evidence.t0.report_sha256 = sha256(readFileSync(candidate.t0ReportPath))
    writeFileSync(candidate.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

    const result = runRolloutSafety([
      'candidate', 'verify', ...cleanStartCandidateVerificationOptions(candidate),
    ])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).failures).toContain(failure)
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
      ['--candidate', 'dddddddddddddddddddddddddddddddddddddddd', ['candidate_identity', 'clean_start_upload_state', 'migration_report_state', 'migration_verification_state', 'clean_start_approval_state', 'clean_start_reset_state', 'clean_start_empty_state', 'clean_start_empty_plan_state', 'smoke_candidate_identity', 'rollback_control_proof_state', 't0_state']],
      ['--deployment', 'deployment-other', ['deployment_identity', 'smoke_deployment_identity', 't0_state']],
      ['--version', '99999999-2222-4333-8444-555555555555', ['version_identity', 'clean_start_upload_state', 'smoke_version_identity', 'rollback_control_proof_state', 't0_state']],
      ['--d1-database', '77777777-8888-4999-8aaa-bbbbbbbbbbbb', ['d1_identity', 'clean_start_approval_state', 'clean_start_reset_state', 'clean_start_empty_state', 'clean_start_empty_plan_state', 'reconciliation_state', 'smoke_critical_paths', 'rollback_control_proof_state', 't0_state']],
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
      failures: [
        'build_identity',
        'build_directory_proof_state',
        'clean_start_upload_state',
        'clean_start_approval_state',
        'smoke_build_identity',
        't0_state',
      ],
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
      failures: ['rollout_report_state', 'rollback_control_proof_state'],
    })
  })

  it('invalidates a candidate when a bound clean-start, reconciliation, or smoke report changes', () => {
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

    const empty = createCandidateEvidence()
    const emptyCommon = candidateVerificationOptions(empty)
    writeFileSync(empty.emptyReportPath, `${JSON.stringify({
      format: 'blogman-clean-start-empty/v1',
      state: 'verified-empty',
      checked_at: '2026-07-26T00:10:01.000Z',
      candidate_id: empty.candidateId,
      approval_packet_sha256: '0'.repeat(64),
      reset_sql_sha256: sha256(readFileSync(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql'))),
      d1_database_id: empty.d1DatabaseId,
      application_object_count: 0,
      migration_ledger_state: 'absent',
    })}\n`)
    const changedEmpty = runRolloutSafety(['candidate', 'verify', ...emptyCommon])
    expect(changedEmpty.status).toBe(1)
    expect(JSON.parse(changedEmpty.stdout)).toMatchObject({
      state: 'invalid',
      failures: [
        'clean_start_empty_report_identity',
        'clean_start_empty_state',
        'clean_start_empty_plan_state',
        't0_clean_start_state',
      ],
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

    const invalidObservation = createLegacyCandidateEvidence({ historical: true })
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
    const candidate = createLegacyCandidateEvidence({ historical: true })
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
