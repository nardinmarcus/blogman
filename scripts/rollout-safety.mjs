#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCurrentResealPackage,
  loadCurrentResealRequest,
} from './issue-23-reseal.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const migrationRunnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
// The measured production response was 1,554,995 bytes; 4 MiB keeps headroom bounded.
export const D1_EVIDENCE_MAX_BUFFER_BYTES = 4 * 1024 * 1024
export const D1_PRIVATE_EXPORT_TIMEOUT_MS = 300_000
export const D1_PRIVATE_EXPORT_TABLES = [
  'posts',
  'categories',
  'site_settings',
  'ai_actions',
  'ai_provider_profiles',
  'ai_post_generators',
  'api_tokens',
]

function fail(message) {
  throw new Error(message)
}

function parseOptions(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (!name.startsWith('--')) fail(`Unexpected argument: ${name}`)
    if (name === '--local' || name === '--remote') {
      options.set(name.slice(2), true)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) fail(`Missing value for ${name}`)
    options.set(name.slice(2), value)
    index += 1
  }
  return options
}

function required(options, name) {
  const value = options.get(name)
  if (!value) fail(`Missing required option --${name}`)
  return value
}

function assertOnlyOptions(options, allowedNames) {
  for (const name of options.keys()) {
    if (!allowedNames.includes(name)) fail(`Unsupported option --${name}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value) {
  return sha256(JSON.stringify(value))
}

const forbiddenEvidenceFields = new Set([
  'body',
  'content',
  'html',
  'token',
  'password',
  'credential',
  'credentials',
  'bridgecredential',
  'bridgecredentials',
  'apikey',
  'aiapikey',
  'secret',
  'rawresponse',
  'responsebody',
])

const credentialPattern = /(?:sk-[a-z0-9_-]{4,}|nm_[a-z0-9_-]{4,}|(?:token|password|api[_ -]?key|credential|secret)\s*[:=]\s*\S+)/i

function assertExactKeys(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Evidence has an unsupported shape')
  }
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== allowedKeys.length
    || actualKeys.some((key) => !allowedKeys.includes(key))
    || allowedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail('Evidence contains an unsupported evidence field contract')
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isCandidateId(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function assertNoSensitiveFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item)
    return
  }
  if (typeof value === 'string') {
    if (credentialPattern.test(value)) fail('Evidence contains a forbidden sensitive value')
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
    if (forbiddenEvidenceFields.has(normalized)) {
      fail('Evidence contains a forbidden sensitive field')
    }
    assertNoSensitiveFields(child)
  }
}

function assertNoSensitiveAuditValue(...values) {
  if (values.some((value) => credentialPattern.test(String(value)))) {
    fail('Rollout audit contains a forbidden sensitive value')
  }
}

function assertCandidateEvidenceShape(evidence) {
  const cleanStart = evidence.format === 'blogman-rollout-candidate/v3'
  const t0 = ['blogman-rollout-candidate/v2', 'blogman-rollout-candidate/v3']
    .includes(evidence.format)
  assertExactKeys(evidence, [
    'format', 'candidate_id', 'lockfile', 'build', 'cloudflare', 'migration',
    cleanStart ? 'clean_start' : 'backup',
    'reconciliation', 'smoke', 'rollout', 'tests',
    ...(cleanStart ? ['delivery_mode'] : []),
    ...(t0 ? ['d1', 't0'] : ['observation']),
  ])
  assertExactKeys(evidence.lockfile, ['sha256', 'wrangler', 'opennextjs_cloudflare'])
  assertExactKeys(evidence.build, ['sha256'])
  assertExactKeys(evidence.cloudflare, cleanStart
    ? ['deployment_id', 'version_id', 'upload_report_sha256']
    : ['deployment_id', 'version_id'])
  if (t0) {
    assertExactKeys(evidence.d1, ['database_id'])
  }
  assertExactKeys(evidence.migration, [
    'state', 'candidate_id', 'set_sha256', 'report_sha256', 'verification_report_sha256',
  ])
  if (cleanStart) {
    assertExactKeys(evidence.clean_start, [
      'reseal_request_sha256', 'package_manifest_sha256',
      'approval_packet_sha256', 'reset_sql_sha256', 'reset_report_sha256',
      'empty_report_sha256', 'empty_plan_report_sha256',
      'rollback_control_proof_sha256', 'historical_data_export',
      'double_restore', 'historical_baseline_queries',
    ])
  } else {
    assertExactKeys(evidence.backup, [
      'backup_id', 'verify_report_sha256', 'restore_report_sha256',
    ])
  }
  for (const name of [
    'reconciliation', 'rollout', 'tests',
    t0 ? 't0' : 'observation',
  ]) {
    assertExactKeys(evidence[name], ['report_sha256'])
  }
  assertExactKeys(evidence.smoke, ['report_sha256', 'runtime_report_sha256'])
}

function assertPreMigrationEvidenceShape(evidence) {
  const cleanStart = evidence.format === 'blogman-pre-migration-candidate/v2'
  assertExactKeys(evidence, [
    'format', 'candidate_id', 'lockfile', 'build', 'cloudflare', 'migration',
    cleanStart ? 'clean_start' : 'backup',
    'reconciliation', 'smoke', 'tests',
    ...(cleanStart ? ['delivery_mode'] : []),
  ])
  assertExactKeys(evidence.lockfile, ['sha256', 'wrangler', 'opennextjs_cloudflare'])
  assertExactKeys(evidence.build, ['sha256'])
  assertExactKeys(evidence.cloudflare, cleanStart
    ? ['uploaded_version_id', 'upload_report_sha256']
    : ['uploaded_version_id'])
  assertExactKeys(evidence.migration, ['set_sha256', 'verification_report_sha256'])
  if (cleanStart) {
    assertExactKeys(evidence.clean_start, [
      'reseal_request_sha256', 'package_manifest_sha256',
      'approval_packet_sha256', 'reset_sql_sha256', 'reset_report_sha256',
      'empty_report_sha256', 'empty_plan_report_sha256',
      'historical_data_export', 'double_restore', 'historical_baseline_queries',
    ])
  } else {
    assertExactKeys(evidence.backup, [
      'backup_id', 'verify_report_sha256', 'restore_report_sha256',
    ])
  }
  assertExactKeys(evidence.reconciliation, ['report_sha256'])
  assertExactKeys(evidence.smoke, ['runtime_report_sha256'])
  assertExactKeys(evidence.tests, ['report_sha256'])
}

function assertReportShape(name, report, candidateFormat = 'blogman-rollout-candidate/v1') {
  const t0Contract = ['blogman-rollout-candidate/v2', 'blogman-rollout-candidate/v3']
    .includes(candidateFormat)
  if (name === 'backup-report') {
    assertExactKeys(report, ['state', 'backup_id', 'artifact_count'])
  } else if (name === 'restore-report') {
    assertExactKeys(report, ['state', 'backup_id', 'target'])
    assertExactKeys(report.target, ['mode', 'isolated'])
  } else if (name === 'migration-report') {
    assertExactKeys(report, ['format', 'state', 'candidate_id', 'migration_set_sha256'])
  } else if (name === 'migration-verification-report') {
    assertExactKeys(report, ['state', 'applied', 'pending'])
    if (!Array.isArray(report.applied) || !Array.isArray(report.pending)) {
      fail('Evidence has an unsupported shape')
    }
    for (const applied of report.applied) {
      assertExactKeys(applied, ['number', 'name', 'checksum', 'applied_at', 'candidate_id'])
    }
  } else if (name === 'reconciliation-report' || name === 'observation-start-reconciliation-report') {
    assertExactKeys(report, t0Contract
      ? ['format', 'checked_at', 'd1_database_id', 'state', 'checks']
      : ['state', 'checks'])
    assertExactKeys(report.checks, [
      'schema', 'migration_ledger', 'post_count', 'post_status', 'post_content',
    ])
  } else if (name === 'smoke-report' || name === 'observation-start-smoke-report') {
    assertExactKeys(report, t0Contract
      ? [
          'format', 'checked_at', 'd1_database_id', 'checks', 'state',
          'candidate_id', 'build_sha256', 'deployment_id', 'version_id',
        ]
      : ['state', 'candidate_id', 'build_sha256', 'deployment_id', 'version_id'])
    if (t0Contract) {
      assertExactKeys(report.checks, [
        'search', 'appearance', 'admin_article', 'tokens', 'ai_provider', 'ai_generators',
      ])
    }
  } else if (name === 'smoke-runtime-report') {
    assertExactKeys(report, [
      'state', 'target', 'runtime', 'requests', 'reconciliation', 'report_sha256',
    ])
    if (!Array.isArray(report.requests)) fail('Evidence has an unsupported shape')
    for (const request of report.requests) assertExactKeys(request, ['name', 'status'])
  } else if (name === 'rollout-report') {
    assertExactKeys(report, ['format', 'state', 'controls'])
    assertExactKeys(report.controls, ['producer', 'authority', 'executors'])
    assertExactKeys(report.controls.executors, Object.keys(report.controls.executors || {}))
  } else if (name === 'test-report') {
    assertExactKeys(report, ['format', 'state', 'exit_code', 'passed', 'failed'])
  } else if (name === 'observation-report') {
    assertExactKeys(report, [
      'format', 'state', 'required_hours', 'started_at', 'ended_at',
      'start', 'end', 'anomaly_audit',
    ])
    if (report.start !== null) {
      assertExactKeys(report.start, [
        'observed_at', 'smoke_report_sha256', 'reconciliation_report_sha256',
      ])
    }
    if (report.end !== null) {
      assertExactKeys(report.end, [
        'observed_at', 'smoke_report_sha256', 'reconciliation_report_sha256',
      ])
    }
    if (report.anomaly_audit !== null) {
      assertExactKeys(report.anomaly_audit, ['report_sha256'])
    }
  } else if (name === 'anomaly-report') {
    assertExactKeys(report, [
      'format', 'state', 'checked_at', 'high_priority_open',
    ])
  } else if (name === 't0-report') {
    assertExactKeys(report, [
      'format', 'state', 'accepted_at', 'candidate_id', 'build_sha256',
      'deployment_id', 'version_id', 'd1_database_id', 'migration_numbers',
      'migration_report_sha256', 'migration_verification_report_sha256',
      'smoke_report_sha256', 'final_reconciliation_report_sha256',
      'anomaly_report_sha256',
      ...(candidateFormat === 'blogman-rollout-candidate/v3'
        ? [
            'delivery_mode', 'clean_start_reset_report_sha256',
            'clean_start_empty_report_sha256', 'clean_start_upload_report_sha256',
            'clean_start_empty_plan_report_sha256', 'rollback_control_proof_sha256',
          ]
        : []),
    ])
  } else if (name === 'clean-start-reset-report') {
    assertExactKeys(report, [
      'format', 'state', 'completed_at', 'candidate_id',
      'approval_packet_sha256', 'reset_sql_sha256', 'd1_database_id',
      'attempt_count',
    ])
  } else if (name === 'clean-start-empty-report') {
    assertExactKeys(report, [
      'format', 'state', 'checked_at', 'candidate_id',
      'approval_packet_sha256', 'reset_sql_sha256', 'd1_database_id',
      'application_object_count', 'migration_ledger_state',
    ])
  } else if (name === 'clean-start-upload-report') {
    assertExactKeys(report, [
      'format', 'state', 'uploaded_at', 'candidate_id', 'build_archive_sha256',
      'build_directory_proof_sha256', 'wrangler_output_sha256',
      'upload_operation_id', 'version_id', 'attempt_count',
    ])
  } else if (name === 'build-directory-proof') {
    assertExactKeys(report, [
      'format', 'state', 'archive_sha256', 'file_count',
    ])
  } else if (name === 'clean-start-empty-plan-report') {
    assertExactKeys(report, [
      'format', 'state', 'checked_at', 'candidate_id', 'd1_database_id',
      'reset_report_sha256', 'empty_report_sha256', 'migrations',
    ])
    if (!Array.isArray(report.migrations)) fail('Evidence has an unsupported shape')
    for (const migration of report.migrations) {
      assertExactKeys(migration, ['number', 'name', 'checksum', 'action'])
    }
  } else if (name === 'rollback-control-proof') {
    assertExactKeys(report, [
      'format', 'state', 'checked_at', 'candidate_id', 'baseline_version_id',
      'candidate_version_id', 'd1_database_id', 'traffic_restore_scope',
      'd1_recovery', 'discarded_data_recoverable', 'rollout_report_sha256',
    ])
  }
}

function assertCleanStartApproval(approval) {
  assertExactKeys(approval, [
    'format', 'state', 'produced_at', 'delivery_mode', 'clean_start',
    'candidate_id', 'local_preflight_candidate_sha256', 'lockfile_sha256',
    'migration_set_sha256', 'runbook_sha256', 'build_archive_sha256',
    'worker_sha256', 'tree_manifest_sha256', 'expected_baseline', 'scope',
    'old_lineages_invalid',
  ])
  assertExactKeys(approval.clean_start, [
    'decision', 'database_strategy', 'reset_sql_sha256',
    'historical_data_export', 'double_restore', 'historical_baseline_queries',
  ])
  assertExactKeys(approval.expected_baseline, [
    'deployment_id', 'version_id', 'd1_database_id',
  ])
  if (
    approval.format !== 'blogman-issue-23-approval-packet/v4'
    || approval.state !== 'ready-for-fresh-production-authorization'
    || approval.delivery_mode !== 'clean-start'
    || approval.clean_start?.decision !== 'discard-existing-blogman-data'
    || approval.clean_start?.database_strategy !== 'reset-bound-d1-in-place'
    || approval.clean_start?.historical_data_export !== 'NOT_APPLICABLE'
    || approval.clean_start?.double_restore !== 'NOT_APPLICABLE'
    || approval.clean_start?.historical_baseline_queries !== 'NOT_APPLICABLE'
    || approval.old_lineages_invalid !== true
    || JSON.stringify(approval.scope) !== JSON.stringify([
      'one candidate-bound in-place D1 reset',
      'one empty D1 proof and plan',
      'one version upload',
      'migrations 001-006',
      'one 100% traffic deployment',
      'status-only smoke and reconciliation',
      'rollback and controls proof',
      'T0 event acceptance',
    ])
  ) {
    fail('Candidate clean-start approval is invalid')
  }
}

function loadCleanStartAuthority(options) {
  const request = loadCurrentResealRequest(resolve(required(options, 'reseal-request')))
  const sealedPackage = loadCurrentResealPackage(resolve(required(options, 'sealed-package')))
  const approval = sealedPackage.documents.get('approval-packet.json')
  const preCas = sealedPackage.documents.get('pre-cas-bindings.json')
  const manifest = sealedPackage.documents.get('package-manifest.json')
  const preflight = sealedPackage.documents.get('preflight-candidate.json')
  for (const document of [request, approval, preCas, manifest, preflight]) {
    assertNoSensitiveFields(document.value)
  }
  assertCleanStartApproval(approval.value)
  const r = request.value
  const a = approval.value
  const c = preCas.value
  const m = manifest.value
  const disposition = {
    production_export: r.clean_start.historical_data_export,
    double_restore: r.clean_start.double_restore,
    historical_baseline_queries: r.clean_start.historical_baseline_queries,
  }
  if (
    r.candidate.commit !== a.candidate_id
    || r.produced_at !== a.produced_at
    || r.repository.lockfile.sha256 !== a.lockfile_sha256
    || r.repository.runbook.sha256 !== a.runbook_sha256
    || r.repository.migrations.set_sha256 !== a.migration_set_sha256
    || r.build.archive_sha256 !== a.build_archive_sha256
    || r.build.worker_sha256 !== a.worker_sha256
    || r.build.tree_manifest_sha256 !== a.tree_manifest_sha256
    || r.clean_start.reset_sql.sha256 !== a.clean_start.reset_sql_sha256
    || JSON.stringify(r.expected_production_baseline) !== JSON.stringify(a.expected_baseline)
    || JSON.stringify(disposition) !== JSON.stringify(c.historical_data_disposition)
    || JSON.stringify(disposition) !== JSON.stringify(m.historical_data_disposition)
    || m.approval_packet_sha256 !== approval.sha256
    || m.pre_cas_bindings_sha256 !== preCas.sha256
    || m.local_preflight_candidate_sha256 !== preflight.sha256
  ) {
    fail('Candidate clean-start authority package is not bound to the current request')
  }
  return {
    approval: { bytes: approval.raw, sha256: approval.sha256, value: approval.value },
    manifest: { bytes: manifest.raw, sha256: manifest.sha256, value: manifest.value },
    request: { bytes: request.raw, sha256: request.sha256, value: request.value },
  }
}

function migrationSetSha256() {
  const directory = join(repoRoot, 'db', 'ledger-migrations')
  return canonicalHash(
    readdirSync(directory)
      .filter((name) => /^\d{3}_.+\.(?:sql|data\.mjs)$/.test(name))
      .sort()
      .map((name) => ({ name, sha256: sha256(readFileSync(join(directory, name))) })),
  )
}

function migrationCatalog() {
  const result = spawnSync(process.execPath, [migrationRunnerPath, 'catalog'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) fail('Unable to load canonical migration catalog')
  try {
    const report = JSON.parse(result.stdout)
    if (
      report?.format !== 'blogman-migration-catalog/v1'
      || !Array.isArray(report?.migrations)
    ) {
      fail('Invalid canonical migration catalog')
    }
    return report.migrations
  } catch {
    fail('Invalid canonical migration catalog')
  }
}

function migrationVerificationPassed(report, candidateId) {
  const migrations = migrationCatalog()
  return report?.state === 'verified'
    && Array.isArray(report?.applied)
    && report.applied.length === migrations.length
    && report.applied.every((row, index) => (
      row?.number === migrations[index]?.number
      && row?.name === migrations[index]?.name
      && row?.checksum === migrations[index]?.checksum
      && typeof row?.applied_at === 'string'
      && row.applied_at.length > 0
      && row?.candidate_id === candidateId
    ))
    && Array.isArray(report?.pending)
    && report.pending.length === 0
}

function cleanStartUploadPassed(
  report,
  candidateId,
  buildSha256,
  versionId,
  buildDirectoryProofSha256,
) {
  return report?.format === 'blogman-clean-start-upload/v1'
    && report?.state === 'captured'
    && isIsoTimestamp(report?.uploaded_at)
    && report?.candidate_id === candidateId
    && report?.build_archive_sha256 === buildSha256
    && report?.build_directory_proof_sha256 === buildDirectoryProofSha256
    && isSha256(report?.wrangler_output_sha256)
    && report?.version_id === versionId
    && report?.upload_operation_id === `issue-23-${candidateId}-upload-1`
    && report?.attempt_count === 1
}

function cleanStartEmptyPlanPassed(
  report,
  candidateId,
  d1DatabaseId,
  resetReportSha256,
  emptyReportSha256,
  emptyCheckedAt,
) {
  return report?.format === 'blogman-clean-start-empty-plan/v1'
    && report?.state === 'verified-empty-plan'
    && isIsoTimestamp(report?.checked_at)
    && Date.parse(report.checked_at) >= Date.parse(emptyCheckedAt)
    && report?.candidate_id === candidateId
    && report?.d1_database_id === d1DatabaseId
    && report?.reset_report_sha256 === resetReportSha256
    && report?.empty_report_sha256 === emptyReportSha256
    && JSON.stringify(report?.migrations) === JSON.stringify(
      migrationCatalog().map((migration) => ({ ...migration, action: 'apply' })),
    )
}

function smokeRuntimePassed(report) {
  if (!report || typeof report !== 'object') return false
  const { report_sha256: reportSha256, ...payload } = report
  return report.state === 'passed'
    && report.target === 'external-local-d1-persist'
    && report.runtime === 'workerd'
    && report.reconciliation === 'matched'
    && JSON.stringify(report.requests) === JSON.stringify([
      { name: 'search', status: 200 },
      { name: 'appearance', status: 200 },
    ])
    && reportSha256 === canonicalHash(payload)
}

function testReportPassed(report) {
  return report?.format === 'blogman-test-report/v1'
    && report?.state === 'passed'
    && report?.exit_code === 0
    && report?.failed === 0
    && Number.isInteger(report?.passed)
    && report.passed > 0
}

function d1CommandArgs(options) {
  const database = required(options, 'database')
  const config = resolve(required(options, 'config'))
  const local = Boolean(options.get('local'))
  const remote = Boolean(options.get('remote'))
  if (local === remote) fail('D1 evidence requires exactly one of --local or --remote')
  if (local) {
    const persistToValue = required(options, 'persist-to')
    if (!isAbsolute(persistToValue)) fail('Local D1 evidence requires an absolute --persist-to directory')
    return [database, '--local', '--persist-to', resolve(persistToValue), '--config', config]
  }
  if (options.get('persist-to')) fail('Remote D1 evidence cannot use --persist-to')
  return [database, '--remote', '--config', config]
}

function queryD1(options, sql, evidenceName) {
  return runD1EvidenceQuery(wranglerPath, [
    'd1', 'execute', ...d1CommandArgs(options), '--command', sql, '--json',
  ], evidenceName)
}

export function runD1EvidenceQuery(command, args, evidenceName) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: D1_EVIDENCE_MAX_BUFFER_BYTES,
  })
  if (result.status !== 0) fail(`Unable to capture ${evidenceName} evidence`)
  return parseD1QueryResponse(result.stdout, evidenceName)
}

export function parseD1QueryResponse(stdout, evidenceName) {
  let response
  try {
    response = JSON.parse(stdout)
  } catch {
    fail(`Invalid ${evidenceName} evidence response`)
  }
  const queryResult = Array.isArray(response) ? response.at(-1) : response
  if (
    !queryResult
    || typeof queryResult !== 'object'
    || Array.isArray(queryResult)
    || queryResult.success !== true
    || !Array.isArray(queryResult.results)
  ) {
    fail(`Invalid ${evidenceName} evidence response`)
  }
  return queryResult.results
}

function executeD1Batch(options, sql, evidenceName) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'blogman-rollout-command-'))
  const path = join(temporaryDirectory, 'command.sql')
  try {
    writeFileSync(path, sql, { mode: 0o600 })
    const result = spawnSync(wranglerPath, [
      'd1', 'execute', ...d1CommandArgs(options), '--file', path, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' })
    if (result.status !== 0) fail(`Unable to persist ${evidenceName}`)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function verifyMigrationState(options) {
  const database = required(options, 'database')
  const config = resolve(required(options, 'config'))
  const args = [migrationRunnerPath, 'verify', '--database', database, '--config', config]
  if (options.get('local')) {
    args.push('--local', '--persist-to', resolve(required(options, 'persist-to')))
  } else if (options.get('remote')) {
    args.push('--remote')
  } else {
    fail('Migration verification requires --local or --remote')
  }
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })
  return result.status === 0
}

function verifiedBackup(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath)
  const manifestDirectory = realpathSync(dirname(absoluteManifestPath))
  let manifest
  try {
    manifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8'))
  } catch {
    fail('Backup manifest is not valid JSON')
  }
  assertNoSensitiveFields(manifest)
  if (manifest?.format !== 'blogman-d1-backup/v1') {
    fail('Unsupported backup manifest format')
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('Backup manifest must contain at least one artifact')
  }
  if (!Array.isArray(manifest.required_tables) || manifest.required_tables.length === 0) {
    fail('Backup manifest must declare required tables')
  }
  const requiredTables = [...new Set(manifest.required_tables)]
  if (
    requiredTables.length !== manifest.required_tables.length
    || requiredTables.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name))
  ) {
    fail('Backup manifest contains invalid required tables')
  }

  const identity = createHash('sha256')
  const seenPaths = new Set()
  const artifacts = manifest.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact.path !== 'string' || !artifact.path.endsWith('.sql')) {
      fail(`Backup artifact ${index + 1} must be a relative SQL file`)
    }
    if (isAbsolute(artifact.path) || seenPaths.has(artifact.path)) {
      fail(`Backup artifact ${index + 1} has an invalid path`)
    }
    seenPaths.add(artifact.path)
    const artifactPath = realpathSync(resolve(manifestDirectory, artifact.path))
    if (relative(manifestDirectory, artifactPath).startsWith(`..${sep}`)) {
      fail(`Backup artifact ${index + 1} escapes its package directory`)
    }
    const bytes = readFileSync(artifactPath)
    const digest = sha256(bytes)
    if (statSync(artifactPath).size !== artifact.bytes || digest !== artifact.sha256) {
      fail(`Backup artifact ${index + 1} failed integrity verification`)
    }
    identity.update(bytes)
    return { path: artifactPath }
  })

  const backupId = `sha256:${identity.digest('hex')}`
  if (manifest.backup_id !== backupId) fail('Backup identity does not match its artifacts')
  return { backupId, artifacts, requiredTables }
}

function verifyBackup(options) {
  const backup = verifiedBackup(required(options, 'manifest'))
  return {
    state: 'verified',
    backup_id: backup.backupId,
    artifact_count: backup.artifacts.length,
  }
}

function assertPrivateRunRoot(runRootValue) {
  if (!isAbsolute(runRootValue)) fail('Private D1 export requires an absolute --run-root')
  const runRoot = resolve(runRootValue)
  const relativeToRepo = relative(repoRoot, runRoot)
  if (relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    fail('Private D1 export run root must be outside the repository')
  }
  return runRoot
}

function secureDeleteFile(path) {
  if (!existsSync(path)) return
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!entry.isFile()) fail('Private D1 export cleanup found a non-file entry')
  const size = statSync(path).size
  const descriptor = openSync(path, 'r+')
  try {
    const zeroes = Buffer.alloc(Math.min(Math.max(size, 1), 64 * 1024))
    for (let offset = 0; offset < size; offset += zeroes.length) {
      writeSync(descriptor, zeroes, 0, Math.min(zeroes.length, size - offset), offset)
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  unlinkSync(path)
}

function privateFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? privateFiles(path) : [path]
  })
}

function secureDeletePrivateFiles(privateDirectory) {
  const files = privateFiles(privateDirectory)
  return secureDeleteFiles(files) && privateFiles(privateDirectory).length === 0
}

function secureDeleteFiles(paths) {
  let failed = false
  for (const path of paths) {
    try {
      secureDeleteFile(path)
    } catch {
      failed = true
    }
  }
  return !failed
}

function writeExportReport(path, report) {
  assertNoSensitiveFields(report)
  writeFileSync(path, `${JSON.stringify(report)}\n`, { flag: 'w', mode: 0o600 })
}

function classifyPrivateExportFailure(result, paths) {
  if (result.error?.code === 'ETIMEDOUT') {
    return { phase: 'wrangler_export', exit_class: 'timeout', hint: 'timeout' }
  }
  if (result.error) {
    return { phase: 'wrangler_export', exit_class: 'spawn_error', hint: 'unknown' }
  }
  if (result.signal) {
    return { phase: 'wrangler_export', exit_class: 'signal', hint: 'unknown' }
  }

  let raw = ''
  try {
    raw = paths.map((path) => readFileSync(path, 'utf8')).join('\n')
  } catch {}
  let hint = 'unknown'
  const auth = /\b(unauthorized|forbidden|authentication|api token|oauth|login)\b/i.test(raw)
  const network = /\b(fetch failed|network|econn\w*|etimedout|enotfound|dns|socket hang up)\b/i.test(raw)
  const remoteRejection = /\b(cloudflare api|api request failed|invalid request|request rejected|error code \d+|wrangler error)\b/i.test(raw)
  if ([auth, network, remoteRejection].filter(Boolean).length === 1) {
    if (auth) hint = 'auth'
    else if (network) hint = 'network'
    else hint = 'remote_api_or_cli_rejection'
  }
  return { phase: 'wrangler_export', exit_class: 'child_nonzero', hint }
}

function runPrivately(command, args, {
  stdin = 'ignore',
  stdoutPath,
  stderrPath,
  env = process.env,
  timeout,
}) {
  const stdout = openSync(stdoutPath, 'wx', 0o600)
  const stderr = openSync(stderrPath, 'wx', 0o600)
  const input = stdin === 'ignore' ? 'ignore' : openSync(stdin, 'r')
  try {
    return spawnSync(command, args, {
      cwd: repoRoot,
      env,
      ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
      stdio: [input, stdout, stderr],
    })
  } finally {
    if (typeof input === 'number') closeSync(input)
    closeSync(stdout)
    closeSync(stderr)
  }
}

function validatePrivateExport(sqlPath, privateDirectory, expectedTables) {
  const databasePath = join(privateDirectory, 'validation.sqlite')
  const referencePath = join(privateDirectory, 'reference.sqlite')
  const importStdout = join(privateDirectory, 'validation-import.stdout')
  const importStderr = join(privateDirectory, 'validation-import.stderr')
  const schemaStdout = join(privateDirectory, 'validation-schema.stdout')
  const schemaStderr = join(privateDirectory, 'validation-schema.stderr')
  writeFileSync(databasePath, '', { flag: 'wx', mode: 0o600 })
  writeFileSync(referencePath, '', { flag: 'wx', mode: 0o600 })
  const imported = runPrivately('sqlite3', ['-bail', databasePath], {
    stdin: sqlPath,
    stdoutPath: importStdout,
    stderrPath: importStderr,
  })
  if (imported.status !== 0) fail('Private D1 export SQL is malformed')
  const referenced = runPrivately('sqlite3', ['-bail', referencePath], {
    stdin: join(repoRoot, 'db', 'schema.sql'),
    stdoutPath: join(privateDirectory, 'reference-import.stdout'),
    stderrPath: join(privateDirectory, 'reference-import.stderr'),
  })
  if (referenced.status !== 0) fail('Private D1 export reference schema validation failed')
  const tableQuery = "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  const schema = runPrivately('sqlite3', ['-noheader', databasePath, tableQuery], {
    stdoutPath: schemaStdout,
    stderrPath: schemaStderr,
  })
  if (schema.status !== 0) fail('Private D1 export schema validation failed')
  const actualTables = readFileSync(schemaStdout, 'utf8').trim().split('\n').filter(Boolean)
  const requiredTables = [...expectedTables].sort()
  if (JSON.stringify(actualTables) !== JSON.stringify(requiredTables)) {
    fail('Private D1 export schema does not match the required tables')
  }

  const columnQuery = `
SELECT tables.name, columns.cid, columns.name, upper(columns.type), columns."notnull",
       coalesce(columns.dflt_value, '<NULL>'), columns.pk, columns.hidden
FROM pragma_table_list AS tables
JOIN pragma_table_xinfo(tables.name) AS columns
WHERE tables.type = 'table'
  AND tables.name IN (${expectedTables.map((table) => `'${table}'`).join(', ')})
ORDER BY tables.name, columns.cid`
  const actualColumnsPath = join(privateDirectory, 'validation-columns.stdout')
  const actualColumnsErrorPath = join(privateDirectory, 'validation-columns.stderr')
  const referenceColumnsPath = join(privateDirectory, 'reference-columns.stdout')
  const referenceColumnsErrorPath = join(privateDirectory, 'reference-columns.stderr')
  const actualColumnResult = runPrivately('sqlite3', ['-noheader', databasePath, columnQuery], {
    stdoutPath: actualColumnsPath,
    stderrPath: actualColumnsErrorPath,
  })
  const referenceColumnResult = runPrivately('sqlite3', ['-noheader', referencePath, columnQuery], {
    stdoutPath: referenceColumnsPath,
    stderrPath: referenceColumnsErrorPath,
  })
  if (actualColumnResult.status !== 0 || referenceColumnResult.status !== 0) {
    fail('Private D1 export column validation failed')
  }
  const parseColumns = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => line.split('|'))
  const actualColumns = parseColumns(actualColumnsPath)
  const referenceColumns = parseColumns(referenceColumnsPath)
  const semantic = (column) => column.slice(2)
  const referenceColumnNames = new Set(referenceColumns.map((column) => `${column[0]}\0${column[2]}`))
  for (const actual of actualColumns) {
    if (!referenceColumnNames.has(`${actual[0]}\0${actual[2]}`)) {
      fail('Private D1 export schema has an unexpected column')
    }
  }
  const actionColumnNames = actualColumns
    .filter((column) => column[0] === 'ai_actions')
    .map((column) => column[2])
  const actionVariantA = referenceColumns
    .filter((column) => column[0] === 'ai_actions')
    .map((column) => column[2])
  const actionVariantB = actionVariantA.filter((name) => name !== 'profile_id')
  const actionVariantC = [...actionVariantB, 'profile_id']
  const actionVariant = [
    ['A', actionVariantA],
    ['B', actionVariantB],
    ['C', actionVariantC],
  ].find(([, columns]) => JSON.stringify(columns) === JSON.stringify(actionColumnNames))?.[0]
  if (!actionVariant) {
    fail('Private D1 export text AI column variant is not approved')
  }
  for (const reference of referenceColumns) {
    const [table, , name] = reference
    if (table === 'ai_actions' && name === 'profile_id') continue
    const actual = actualColumns.find((column) => column[0] === table && column[2] === name)
    if (!actual) fail('Private D1 export schema is missing a required column')
    if (table === 'ai_provider_profiles' && name === 'max_tokens') {
      if (JSON.stringify(semantic(actual).toSpliced(3, 1, '<ALLOWED>'))
        !== JSON.stringify(semantic(reference).toSpliced(3, 1, '<ALLOWED>'))
        || !['1200', '2000'].includes(actual[5])) {
        fail('Private D1 export column semantics do not match the migration baseline')
      }
    } else if (JSON.stringify(semantic(actual)) !== JSON.stringify(semantic(reference))) {
      fail('Private D1 export column semantics do not match the migration baseline')
    }
  }
  const profile = actualColumns.find((column) => column[0] === 'ai_actions' && column[2] === 'profile_id')
  const maxTokens = actualColumns.find(
    (column) => column[0] === 'ai_provider_profiles' && column[2] === 'max_tokens',
  )
  const referenceProfile = referenceColumns.find(
    (column) => column[0] === 'ai_actions' && column[2] === 'profile_id',
  )
  if (profile && JSON.stringify(semantic(profile)) !== JSON.stringify(semantic(referenceProfile))) {
    fail('Private D1 export column semantics do not match the migration baseline')
  }
  const expectedMaxTokensDefault = actionVariant === 'A' ? '2000' : '1200'
  if (maxTokens?.[5] !== expectedMaxTokensDefault) {
    fail('Private D1 export text AI column variant is not approved')
  }
}

export function capturePrivateD1Export({
  runRoot: runRootValue,
  database,
  config,
  command = wranglerPath,
  commandArgsPrefix = [],
  expectedTables = D1_PRIVATE_EXPORT_TABLES,
  timeoutMs = D1_PRIVATE_EXPORT_TIMEOUT_MS,
}) {
  if (!database || typeof database !== 'string') fail('Private D1 export requires a database')
  if (!config || !isAbsolute(config)) fail('Private D1 export requires an absolute config path')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > D1_PRIVATE_EXPORT_TIMEOUT_MS) {
    fail('Private D1 export timeout must be within the fixed maximum')
  }
  const runRoot = assertPrivateRunRoot(runRootValue)
  try {
    mkdirSync(runRoot, { mode: 0o700 })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('Private D1 export run root already exists; retries are forbidden')
    }
    fail('Unable to create the private D1 export run root')
  }
  chmodSync(runRoot, 0o700)
  const backupDirectory = join(runRoot, 'backup')
  const privateDirectory = join(runRoot, 'private')
  mkdirSync(backupDirectory, { mode: 0o700 })
  mkdirSync(privateDirectory, { mode: 0o700 })
  const sqlPath = join(backupDirectory, 'regular-tables.sql')
  const stdoutPath = join(privateDirectory, 'wrangler.stdout')
  const stderrPath = join(privateDirectory, 'wrangler.stderr')
  const debugPath = join(privateDirectory, 'wrangler.debug')
  const reportPath = join(runRoot, 'export-report.json')
  writeExportReport(reportPath, {
    format: 'blogman-d1-private-export/v1',
    state: 'started',
    attempt_count: 1,
  })

  let captured = false
  let failure = null
  try {
    writeFileSync(sqlPath, '', { flag: 'wx', mode: 0o600 })
    writeFileSync(debugPath, '', { flag: 'wx', mode: 0o600 })
    const result = runPrivately(command, [
      ...commandArgsPrefix,
      'd1', 'export', database, '--remote', '--skip-confirmation',
      ...expectedTables.flatMap((table) => ['--table', table]),
      '--output', sqlPath,
      '--config', resolve(config),
    ], {
      stdoutPath,
      stderrPath,
      env: { ...process.env, WRANGLER_LOG_PATH: debugPath },
      timeout: timeoutMs,
    })
    const debug = statSync(debugPath)
    if (!debug.isFile() || (debug.mode & 0o777) !== 0o600) {
      fail('Private D1 export debug log permissions are not 0600')
    }
    if (result.error || result.signal || result.status !== 0) {
      failure = classifyPrivateExportFailure(result, [stdoutPath, stderrPath, debugPath])
      fail('Private D1 export subprocess failed')
    }
    const sql = statSync(sqlPath)
    if (!sql.isFile() || sql.size === 0) fail('Private D1 export did not create non-empty SQL')
    if ((sql.mode & 0o777) !== 0o600) fail('Private D1 export SQL permissions are not 0600')
    validatePrivateExport(sqlPath, privateDirectory, expectedTables)
    const report = {
      format: 'blogman-d1-private-export/v1',
      state: 'captured',
      attempt_count: 1,
      artifact: {
        path: 'backup/regular-tables.sql',
        bytes: sql.size,
        sha256: sha256(readFileSync(sqlPath)),
      },
      required_tables: [...expectedTables],
    }
    writeExportReport(reportPath, report)
    captured = true
    return report
  } catch (error) {
    writeExportReport(reportPath, {
      format: 'blogman-d1-private-export/v1',
      state: 'failed',
      attempt_count: 1,
      ...(failure ? { failure } : {}),
    })
    throw error
  } finally {
    const capturesDeleted = secureDeletePrivateFiles(privateDirectory)
    const sqlDeleted = captured && capturesDeleted ? true : secureDeleteFiles([sqlPath])
    if (!capturesDeleted || !sqlDeleted) fail('Private D1 export cleanup failed')
  }
}

export function disposePrivateD1Export({ runRoot: runRootValue }) {
  const runRoot = assertPrivateRunRoot(runRootValue)
  let runRootStat
  let exportReport
  try {
    runRootStat = statSync(runRoot)
    exportReport = JSON.parse(readFileSync(join(runRoot, 'export-report.json'), 'utf8'))
  } catch {
    fail('Private D1 export run root is not disposable')
  }
  if (!runRootStat.isDirectory() || (runRootStat.mode & 0o777) !== 0o700) {
    fail('Private D1 export run root is not mode 0700')
  }
  assertNoSensitiveFields(exportReport)
  if (
    exportReport?.format !== 'blogman-d1-private-export/v1'
    || exportReport?.attempt_count !== 1
    || !['captured', 'failed'].includes(exportReport?.state)
  ) {
    fail('Private D1 export report cannot be disposed')
  }
  const privateDirectory = join(runRoot, 'private')
  const privateDeleted = secureDeletePrivateFiles(privateDirectory)
  const sqlDeleted = secureDeleteFiles([join(runRoot, 'backup', 'regular-tables.sql')])
  if (!privateDeleted
    || !sqlDeleted
    || privateFiles(privateDirectory).length > 0
    || existsSync(join(runRoot, 'backup', 'regular-tables.sql'))) {
    fail('Private D1 export disposal failed')
  }
  const report = {
    format: 'blogman-d1-private-export-disposal/v1',
    state: 'disposed',
    attempt_count: 1,
    raw_artifacts_remaining: 0,
  }
  writeFileSync(join(runRoot, 'dispose-report.json'), `${JSON.stringify(report)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  return report
}

function findWranglerD1Files(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...findWranglerD1Files(path))
    } else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
      files.push(path)
    }
  }
  return files
}

function restoreBackup(options) {
  if (!options.get('local') || options.get('remote')) {
    fail('Backup restore requires --local and never accepts --remote')
  }
  const persistTo = resolve(required(options, 'persist-to'))
  if (!isAbsolute(required(options, 'persist-to'))) {
    fail('Backup restore requires an absolute --persist-to directory')
  }
  const relativeToRepo = relative(repoRoot, persistTo)
  if (relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    fail('Backup restore target must be outside the repository')
  }
  if (readdirSync(persistTo).length !== 0) {
    fail('Backup restore target must be an empty isolated directory')
  }

  const backup = verifiedBackup(required(options, 'manifest'))
  const database = required(options, 'database')
  const config = resolve(required(options, 'config'))
  const initialize = spawnSync(wranglerPath, [
    'd1', 'execute', database, '--local', '--persist-to', persistTo,
    '--config', config, '--command', 'SELECT 1', '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (initialize.status !== 0) fail('Backup restore could not initialize local D1')

  const databaseFiles = findWranglerD1Files(persistTo)
    .filter((path) => basename(path) !== 'metadata.sqlite')
  if (databaseFiles.length !== 1) {
    fail('Backup restore could not identify one isolated local D1 file')
  }
  for (const [index, artifact] of backup.artifacts.entries()) {
    const result = spawnSync('sqlite3', ['-bail', databaseFiles[0]], {
      cwd: repoRoot,
      input: readFileSync(artifact.path),
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      fail(`Backup restore failed for artifact ${index + 1}`)
    }
  }
  const tableResult = spawnSync(wranglerPath, [
    'd1', 'execute', database, '--local', '--persist-to', persistTo,
    '--config', config,
    '--command', "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (tableResult.status !== 0) fail('Backup restore completeness check failed')
  let restoredTables
  try {
    restoredTables = new Set(
      (JSON.parse(tableResult.stdout).at(-1)?.results || []).map((row) => row.name),
    )
  } catch {
    fail('Backup restore completeness check returned invalid output')
  }
  const missingTables = backup.requiredTables.filter((name) => !restoredTables.has(name))
  if (missingTables.length > 0) fail('Backup restore is missing required tables')
  return {
    state: 'restored',
    backup_id: backup.backupId,
    target: { mode: 'local', isolated: true },
  }
}

function captureReconciliation(options) {
  const schemaRows = filterReconciliationSchemaRows(queryD1(options, `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name
`, 'schema'))
  const tableNames = new Set(
    schemaRows.filter((row) => row.type === 'table').map((row) => row.name),
  )
  const ledgerRows = tableNames.has('migration_ledger')
    ? queryD1(options, `
SELECT number, name, checksum, candidate_id
FROM migration_ledger
ORDER BY number
`, 'migration ledger')
    : []
  const postCount = queryD1(
    options,
    'SELECT COUNT(*) AS count FROM posts',
    'post count',
  ).at(0)?.count
  const statusRows = queryD1(options, `
SELECT status, COUNT(*) AS count
FROM posts
GROUP BY status
ORDER BY status
`, 'post status')
  const postRows = queryD1(options, `
SELECT id, slug, title, content, html, description, category, tags, password,
       is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
FROM posts
ORDER BY id
`, 'post content')

  return {
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: canonicalHash(schemaRows) },
    migration_ledger: {
      state: tableNames.has('migration_ledger') ? 'present' : 'absent',
      row_count: ledgerRows.length,
      sha256: canonicalHash(ledgerRows),
    },
    posts: {
      count: postCount,
      status: Object.fromEntries(statusRows.map((row) => [row.status, row.count])),
      content_sha256: canonicalHash(postRows),
    },
  }
}

export function filterReconciliationSchemaRows(rows) {
  return rows.filter((row) => !(
    row?.type === 'table'
    && (
      (row.name === '_cf_KV' && row.tbl_name === '_cf_KV')
      || (row.name === '_cf_METADATA' && row.tbl_name === '_cf_METADATA')
    )
  ))
}

function compareReconciliation(options) {
  let expected
  try {
    expected = JSON.parse(readFileSync(resolve(required(options, 'expected')), 'utf8'))
  } catch {
    fail('Expected reconciliation snapshot is not valid JSON')
  }
  if (expected?.format !== 'blogman-d1-reconciliation/v1') {
    fail('Unsupported reconciliation snapshot format')
  }
  const actual = captureReconciliation(options)
  const checks = {
    schema: expected.schema?.sha256 === actual.schema.sha256 ? 'matched' : 'drift',
    migration_ledger: JSON.stringify(expected.migration_ledger) === JSON.stringify(actual.migration_ledger)
      ? 'matched'
      : 'drift',
    post_count: expected.posts?.count === actual.posts.count ? 'matched' : 'drift',
    post_status: JSON.stringify(expected.posts?.status) === JSON.stringify(actual.posts.status)
      ? 'matched'
      : 'drift',
    post_content: expected.posts?.content_sha256 === actual.posts.content_sha256
      ? 'matched'
      : 'drift',
  }
  const driftDimensions = Object.entries(checks)
    .filter(([, value]) => value === 'drift')
    .map(([name]) => name)
  return {
    state: driftDimensions.length === 0 ? 'matched' : 'drift',
    checks,
    ...(driftDimensions.length > 0 ? { drift_dimensions: driftDimensions } : {}),
  }
}

function verifyPreMigrationCandidate(options) {
  let evidenceBytes
  let evidence
  let lockfileBytes
  let lockfile
  try {
    evidenceBytes = readFileSync(resolve(required(options, 'evidence')))
    evidence = JSON.parse(evidenceBytes.toString('utf8'))
    lockfileBytes = readFileSync(resolve(required(options, 'lockfile')))
    lockfile = JSON.parse(lockfileBytes.toString('utf8'))
  } catch {
    fail('Pre-migration evidence or lockfile is not valid JSON')
  }
  if (evidence?.format === 'blogman-pre-migration-candidate/v1') {
    assertNoSensitiveFields(evidence)
    return {
      state: 'stale',
      candidate_id: isCandidateId(evidence.candidate_id) ? evidence.candidate_id : 'unavailable',
      evidence_sha256: sha256(evidenceBytes),
      acceptance_authority: false,
    }
  }
  if (evidence?.format !== 'blogman-pre-migration-candidate/v2') {
    fail('Unsupported pre-migration evidence format')
  }
  assertNoSensitiveFields(evidence)
  assertPreMigrationEvidenceShape(evidence)
  const readReport = (optionName) => {
    let bytes
    let report
    try {
      bytes = readFileSync(resolve(required(options, optionName)))
      report = JSON.parse(bytes.toString('utf8'))
    } catch {
      fail(`Pre-migration ${optionName} is not valid JSON`)
    }
    assertNoSensitiveFields(report)
    assertReportShape(optionName, report)
    return { bytes, report }
  }
  const buildDirectoryProof = readReport('build-directory-proof')
  const cleanStartUploadReport = readReport('clean-start-upload-report')
  const cleanStartResetReport = readReport('clean-start-reset-report')
  const cleanStartEmptyReport = readReport('clean-start-empty-report')
  const cleanStartEmptyPlanReport = readReport('clean-start-empty-plan-report')
  const authority = loadCleanStartAuthority(options)
  const approvalPacket = authority.approval
  const migrationVerificationReport = readReport('migration-verification-report')
  const reconciliationReport = readReport('reconciliation-report')
  const smokeRuntimeReport = readReport('smoke-runtime-report')
  const testReport = readReport('test-report')

  const candidateId = required(options, 'candidate')
  const versionId = required(options, 'version')
  const d1DatabaseId = required(options, 'd1-database')
  const buildSha256 = sha256(readFileSync(resolve(required(options, 'build'))))
  const wranglerVersion = lockfile?.packages?.['node_modules/wrangler']?.version
  const openNextVersion = lockfile?.packages?.['node_modules/@opennextjs/cloudflare']?.version
  const failures = []
  const mismatch = (condition, name) => {
    if (condition) failures.push(name)
  }

  mismatch(evidence.candidate_id !== candidateId, 'candidate_identity')
  mismatch(!isCandidateId(candidateId) || !isCandidateId(evidence.candidate_id), 'candidate_format')
  mismatch(evidence.lockfile?.sha256 !== sha256(lockfileBytes), 'lockfile_identity')
  mismatch(evidence.lockfile?.wrangler !== wranglerVersion, 'wrangler_toolchain')
  mismatch(evidence.lockfile?.opennextjs_cloudflare !== openNextVersion, 'opennext_toolchain')
  mismatch(evidence.build?.sha256 !== buildSha256, 'build_identity')
  mismatch(
    buildDirectoryProof.report?.format !== 'blogman-build-directory-proof/v1'
      || buildDirectoryProof.report?.state !== 'matched'
      || buildDirectoryProof.report?.archive_sha256 !== buildSha256
      || !Number.isInteger(buildDirectoryProof.report?.file_count)
      || buildDirectoryProof.report.file_count < 1,
    'build_directory_proof_state',
  )
  mismatch(evidence.cloudflare?.uploaded_version_id !== versionId, 'uploaded_version_identity')
  mismatch(
    evidence.cloudflare?.upload_report_sha256 !== sha256(cleanStartUploadReport.bytes),
    'clean_start_upload_report_identity',
  )
  mismatch(
    !cleanStartUploadPassed(
      cleanStartUploadReport.report,
      candidateId,
      buildSha256,
      versionId,
      sha256(buildDirectoryProof.bytes),
    ),
    'clean_start_upload_state',
  )
  mismatch(evidence.migration?.set_sha256 !== migrationSetSha256(), 'migration_set_identity')
  mismatch(
    evidence.migration?.verification_report_sha256
      !== sha256(migrationVerificationReport.bytes),
    'migration_verification_identity',
  )
  mismatch(
    !migrationVerificationPassed(migrationVerificationReport.report, candidateId),
    'migration_verification_state',
  )
  const approval = approvalPacket.value
  const approvalSha256 = sha256(approvalPacket.bytes)
  const resetSqlSha256 = sha256(readFileSync(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')))
  const runbookSha256 = sha256(readFileSync(join(repoRoot, 'docs', 'issue-23-phase-b-runbook.md')))
  const reset = cleanStartResetReport.report
  const empty = cleanStartEmptyReport.report
  mismatch(evidence.clean_start?.reseal_request_sha256 !== authority.request.sha256, 'clean_start_request_identity')
  mismatch(evidence.clean_start?.package_manifest_sha256 !== authority.manifest.sha256, 'clean_start_package_manifest_identity')
  if (
    evidence.delivery_mode !== 'clean-start'
    || evidence.clean_start?.historical_data_export !== 'NOT_APPLICABLE'
    || evidence.clean_start?.double_restore !== 'NOT_APPLICABLE'
    || evidence.clean_start?.historical_baseline_queries !== 'NOT_APPLICABLE'
  ) {
    fail('Pre-migration clean-start disposition is invalid')
  }
  mismatch(evidence.clean_start?.approval_packet_sha256 !== approvalSha256, 'clean_start_approval_identity')
  mismatch(evidence.clean_start?.reset_sql_sha256 !== resetSqlSha256, 'clean_start_reset_sql_identity')
  mismatch(
    approval.candidate_id !== candidateId
      || approval.lockfile_sha256 !== sha256(lockfileBytes)
      || approval.build_archive_sha256 !== buildSha256
      || approval.migration_set_sha256 !== migrationSetSha256()
      || approval.runbook_sha256 !== runbookSha256
      || approval.clean_start.reset_sql_sha256 !== resetSqlSha256
      || approval.expected_baseline.d1_database_id !== d1DatabaseId,
    'clean_start_approval_state',
  )
  mismatch(evidence.clean_start?.reset_report_sha256 !== sha256(cleanStartResetReport.bytes), 'clean_start_reset_report_identity')
  mismatch(
    reset?.format !== 'blogman-clean-start-reset/v1'
      || reset?.state !== 'reset'
      || !isIsoTimestamp(reset?.completed_at)
      || reset?.candidate_id !== candidateId
      || reset?.approval_packet_sha256 !== approvalSha256
      || reset?.reset_sql_sha256 !== resetSqlSha256
      || reset?.d1_database_id !== d1DatabaseId
      || reset?.attempt_count !== 1
      || Date.parse(reset?.completed_at)
        < Date.parse(cleanStartUploadReport.report?.uploaded_at),
    'clean_start_reset_state',
  )
  mismatch(evidence.clean_start?.empty_report_sha256 !== sha256(cleanStartEmptyReport.bytes), 'clean_start_empty_report_identity')
  mismatch(
    empty?.format !== 'blogman-clean-start-empty/v1'
      || empty?.state !== 'verified-empty'
      || !isIsoTimestamp(empty?.checked_at)
      || empty?.candidate_id !== candidateId
      || empty?.approval_packet_sha256 !== approvalSha256
      || empty?.reset_sql_sha256 !== resetSqlSha256
      || empty?.d1_database_id !== d1DatabaseId
      || empty?.application_object_count !== 0
      || empty?.migration_ledger_state !== 'absent'
      || Date.parse(empty?.checked_at) < Date.parse(reset?.completed_at),
    'clean_start_empty_state',
  )
  mismatch(
    evidence.clean_start?.empty_plan_report_sha256
      !== sha256(cleanStartEmptyPlanReport.bytes),
    'clean_start_empty_plan_report_identity',
  )
  mismatch(
    !cleanStartEmptyPlanPassed(
      cleanStartEmptyPlanReport.report,
      candidateId,
      d1DatabaseId,
      sha256(cleanStartResetReport.bytes),
      sha256(cleanStartEmptyReport.bytes),
      empty?.checked_at,
    ),
    'clean_start_empty_plan_state',
  )
  mismatch(
    evidence.reconciliation?.report_sha256 !== sha256(reconciliationReport.bytes),
    'reconciliation_report_identity',
  )
  mismatch(
    reconciliationReport.report?.state !== 'matched'
      || Object.keys(reconciliationReport.report?.checks || {}).length !== 5
      || Object.values(reconciliationReport.report?.checks || {})
        .some((value) => value !== 'matched'),
    'reconciliation_state',
  )
  mismatch(
    evidence.smoke?.runtime_report_sha256 !== sha256(smokeRuntimeReport.bytes),
    'smoke_runtime_identity',
  )
  mismatch(!smokeRuntimePassed(smokeRuntimeReport.report), 'smoke_runtime_state')
  mismatch(evidence.tests?.report_sha256 !== sha256(testReport.bytes), 'test_report_identity')
  mismatch(!testReportPassed(testReport.report), 'test_report_state')

  return failures.length === 0
    ? {
        state: 'verified',
        phase: 'pre-migration',
        candidate_id: candidateId,
        evidence_sha256: sha256(evidenceBytes),
      }
    : { state: 'invalid', failures }
}

function verifyCandidate(options, { historical = false } = {}) {
  const evidencePath = resolve(required(options, 'evidence'))
  let evidence
  let evidenceBytes
  let lockfile
  let lockfileBytes
  try {
    evidenceBytes = readFileSync(evidencePath)
    evidence = JSON.parse(evidenceBytes.toString('utf8'))
    lockfileBytes = readFileSync(resolve(required(options, 'lockfile')))
    lockfile = JSON.parse(lockfileBytes.toString('utf8'))
  } catch {
    fail('Candidate evidence or lockfile is not valid JSON')
  }
  const candidateFormat = evidence?.format
  if (
    ['blogman-rollout-candidate/v1', 'blogman-rollout-candidate/v2'].includes(candidateFormat)
    && !historical
  ) {
    assertNoSensitiveFields(evidence)
    return {
      state: 'stale',
      candidate_id: isCandidateId(evidence.candidate_id) ? evidence.candidate_id : 'unavailable',
      evidence_sha256: sha256(evidenceBytes),
      acceptance_authority: false,
    }
  }
  if (
    (historical && !['blogman-rollout-candidate/v1', 'blogman-rollout-candidate/v2'].includes(candidateFormat))
    || (!historical && candidateFormat !== 'blogman-rollout-candidate/v3')
  ) {
    fail('Unsupported candidate evidence format')
  }
  const currentT0Contract = candidateFormat !== 'blogman-rollout-candidate/v1'
  const cleanStartContract = candidateFormat === 'blogman-rollout-candidate/v3'
  assertNoSensitiveFields(evidence)
  assertCandidateEvidenceShape(evidence)
  const readReport = (optionName) => {
    let bytes
    let report
    try {
      bytes = readFileSync(resolve(required(options, optionName)))
      report = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Evidence ')) throw error
      fail(`Candidate ${optionName} is not valid JSON`)
    }
    assertNoSensitiveFields(report)
    assertReportShape(optionName, report, candidateFormat)
    return { bytes, report }
  }
  const backupReport = cleanStartContract ? null : readReport('backup-report')
  const restoreReport = cleanStartContract ? null : readReport('restore-report')
  const buildDirectoryProof = cleanStartContract
    ? readReport('build-directory-proof')
    : null
  const cleanStartUploadReport = cleanStartContract
    ? readReport('clean-start-upload-report')
    : null
  const cleanStartResetReport = cleanStartContract
    ? readReport('clean-start-reset-report')
    : null
  const cleanStartEmptyReport = cleanStartContract
    ? readReport('clean-start-empty-report')
    : null
  const cleanStartEmptyPlanReport = cleanStartContract
    ? readReport('clean-start-empty-plan-report')
    : null
  const rollbackControlProof = cleanStartContract
    ? readReport('rollback-control-proof')
    : null
  const authority = cleanStartContract ? loadCleanStartAuthority(options) : null
  const approvalPacket = authority?.approval ?? null
  const migrationReport = readReport('migration-report')
  const migrationVerificationReport = readReport('migration-verification-report')
  const reconciliationReport = readReport('reconciliation-report')
  const smokeReport = readReport('smoke-report')
  const smokeRuntimeReport = readReport('smoke-runtime-report')
  const rolloutReport = readReport('rollout-report')
  const testReport = readReport('test-report')
  const observationReport = currentT0Contract ? null : readReport('observation-report')
  const observationStartSmokeReport = currentT0Contract || observationReport.report?.start === null
    ? null
    : readReport('observation-start-smoke-report')
  const observationStartReconciliationReport = currentT0Contract
    || observationReport.report?.start === null
    ? null
    : readReport('observation-start-reconciliation-report')
  const t0Report = currentT0Contract ? readReport('t0-report') : null
  const anomalyReport = currentT0Contract
    ? readReport('anomaly-report')
    : observationReport.report?.anomaly_audit === null
      ? null
      : readReport('anomaly-report')

  const candidateId = required(options, 'candidate')
  const deploymentId = required(options, 'deployment')
  const versionId = required(options, 'version')
  const d1DatabaseId = currentT0Contract ? required(options, 'd1-database') : null
  const buildSha256 = sha256(readFileSync(resolve(required(options, 'build'))))
  const lockfileSha256 = sha256(lockfileBytes)
  const wranglerVersion = lockfile?.packages?.['node_modules/wrangler']?.version
  const openNextVersion = lockfile?.packages?.['node_modules/@opennextjs/cloudflare']?.version
  const failures = []
  const mismatch = (condition, name) => {
    if (condition) failures.push(name)
  }

  mismatch(evidence.candidate_id !== candidateId, 'candidate_identity')
  mismatch(!isCandidateId(candidateId) || !isCandidateId(evidence.candidate_id), 'candidate_format')
  mismatch(evidence.lockfile?.sha256 !== lockfileSha256, 'lockfile_identity')
  mismatch(evidence.lockfile?.wrangler !== wranglerVersion, 'wrangler_toolchain')
  mismatch(evidence.lockfile?.opennextjs_cloudflare !== openNextVersion, 'opennext_toolchain')
  mismatch(evidence.build?.sha256 !== buildSha256, 'build_identity')
  mismatch(evidence.cloudflare?.deployment_id !== deploymentId, 'deployment_identity')
  mismatch(evidence.cloudflare?.version_id !== versionId, 'version_identity')
  if (cleanStartContract) {
    mismatch(
      buildDirectoryProof.report?.format !== 'blogman-build-directory-proof/v1'
        || buildDirectoryProof.report?.state !== 'matched'
        || buildDirectoryProof.report?.archive_sha256 !== buildSha256
        || !Number.isInteger(buildDirectoryProof.report?.file_count)
        || buildDirectoryProof.report.file_count < 1,
      'build_directory_proof_state',
    )
    mismatch(
      evidence.cloudflare?.upload_report_sha256 !== sha256(cleanStartUploadReport.bytes),
      'clean_start_upload_report_identity',
    )
    mismatch(
      !cleanStartUploadPassed(
        cleanStartUploadReport.report,
        candidateId,
        buildSha256,
        versionId,
        sha256(buildDirectoryProof.bytes),
      ),
      'clean_start_upload_state',
    )
  }
  if (currentT0Contract) {
    mismatch(evidence.d1?.database_id !== d1DatabaseId, 'd1_identity')
  }
  mismatch(evidence.migration?.state !== 'verified', 'migration_state')
  mismatch(evidence.migration?.candidate_id !== evidence.candidate_id, 'migration_candidate_identity')
  mismatch(evidence.migration?.set_sha256 !== migrationSetSha256(), 'migration_set_identity')
  mismatch(
    evidence.migration?.report_sha256 !== sha256(migrationReport.bytes),
    'migration_report_identity',
  )
  mismatch(
    migrationReport.report?.format !== 'blogman-migration-evidence/v1'
      || migrationReport.report?.state !== 'verified'
      || !isCandidateId(migrationReport.report?.candidate_id)
      || migrationReport.report?.candidate_id !== candidateId
      || !isSha256(migrationReport.report?.migration_set_sha256)
      || migrationReport.report?.migration_set_sha256 !== migrationSetSha256()
      || migrationReport.report?.migration_set_sha256 !== evidence.migration?.set_sha256,
    'migration_report_state',
  )
  mismatch(
    evidence.migration?.verification_report_sha256
      !== sha256(migrationVerificationReport.bytes),
    'migration_verification_identity',
  )
  mismatch(
    !migrationVerificationPassed(migrationVerificationReport.report, candidateId),
    'migration_verification_state',
  )
  if (cleanStartContract) {
    const approval = approvalPacket.value
    const reset = cleanStartResetReport.report
    const empty = cleanStartEmptyReport.report
    const approvalSha256 = sha256(approvalPacket.bytes)
    const resetSqlSha256 = sha256(readFileSync(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')))
    const runbookSha256 = sha256(readFileSync(join(repoRoot, 'docs', 'issue-23-phase-b-runbook.md')))
    if (
      evidence.delivery_mode !== 'clean-start'
      || evidence.clean_start?.historical_data_export !== 'NOT_APPLICABLE'
      || evidence.clean_start?.double_restore !== 'NOT_APPLICABLE'
      || evidence.clean_start?.historical_baseline_queries !== 'NOT_APPLICABLE'
    ) {
      fail('Candidate clean-start disposition is invalid')
    }
    mismatch(evidence.clean_start?.reseal_request_sha256 !== authority.request.sha256, 'clean_start_request_identity')
    mismatch(evidence.clean_start?.package_manifest_sha256 !== authority.manifest.sha256, 'clean_start_package_manifest_identity')
    mismatch(evidence.clean_start?.approval_packet_sha256 !== approvalSha256, 'clean_start_approval_identity')
    mismatch(evidence.clean_start?.reset_sql_sha256 !== resetSqlSha256, 'clean_start_reset_sql_identity')
    mismatch(
      approval.candidate_id !== candidateId
        || approval.lockfile_sha256 !== lockfileSha256
        || approval.build_archive_sha256 !== buildSha256
        || approval.migration_set_sha256 !== migrationSetSha256()
        || approval.runbook_sha256 !== runbookSha256
        || approval.clean_start.reset_sql_sha256 !== resetSqlSha256
        || approval.expected_baseline.d1_database_id !== d1DatabaseId,
      'clean_start_approval_state',
    )
    mismatch(evidence.clean_start?.reset_report_sha256 !== sha256(cleanStartResetReport.bytes), 'clean_start_reset_report_identity')
    mismatch(
      reset?.format !== 'blogman-clean-start-reset/v1'
        || reset?.state !== 'reset'
        || !isIsoTimestamp(reset?.completed_at)
        || reset?.candidate_id !== candidateId
        || reset?.approval_packet_sha256 !== approvalSha256
        || reset?.reset_sql_sha256 !== resetSqlSha256
        || reset?.d1_database_id !== d1DatabaseId
        || reset?.attempt_count !== 1
        || Date.parse(reset?.completed_at)
          < Date.parse(cleanStartUploadReport.report?.uploaded_at),
      'clean_start_reset_state',
    )
    mismatch(evidence.clean_start?.empty_report_sha256 !== sha256(cleanStartEmptyReport.bytes), 'clean_start_empty_report_identity')
    mismatch(
      empty?.format !== 'blogman-clean-start-empty/v1'
        || empty?.state !== 'verified-empty'
        || !isIsoTimestamp(empty?.checked_at)
        || empty?.candidate_id !== candidateId
        || empty?.approval_packet_sha256 !== approvalSha256
        || empty?.reset_sql_sha256 !== resetSqlSha256
        || empty?.d1_database_id !== d1DatabaseId
        || empty?.application_object_count !== 0
        || empty?.migration_ledger_state !== 'absent'
        || Date.parse(empty?.checked_at) < Date.parse(reset?.completed_at),
      'clean_start_empty_state',
    )
    mismatch(
      evidence.clean_start?.empty_plan_report_sha256
        !== sha256(cleanStartEmptyPlanReport.bytes),
      'clean_start_empty_plan_report_identity',
    )
    mismatch(
      !cleanStartEmptyPlanPassed(
        cleanStartEmptyPlanReport.report,
        candidateId,
        d1DatabaseId,
        sha256(cleanStartResetReport.bytes),
        sha256(cleanStartEmptyReport.bytes),
        empty?.checked_at,
      ),
      'clean_start_empty_plan_state',
    )
  } else {
    mismatch(
      evidence.backup?.verify_report_sha256 !== sha256(backupReport.bytes),
      'backup_report_identity',
    )
    mismatch(
      backupReport.report?.state !== 'verified'
        || backupReport.report?.backup_id !== evidence.backup?.backup_id
        || !Number.isInteger(backupReport.report?.artifact_count)
        || backupReport.report?.artifact_count < 1
        || !/^sha256:[a-f0-9]{64}$/.test(evidence.backup?.backup_id || ''),
      'backup_state',
    )
    mismatch(
      evidence.backup?.restore_report_sha256 !== sha256(restoreReport.bytes),
      'restore_report_identity',
    )
    mismatch(
      restoreReport.report?.state !== 'restored'
        || restoreReport.report?.backup_id !== evidence.backup?.backup_id
        || restoreReport.report?.target?.mode !== 'local'
        || restoreReport.report?.target?.isolated !== true,
      'restore_state',
    )
  }
  mismatch(
    evidence.reconciliation?.report_sha256 !== sha256(reconciliationReport.bytes),
    'reconciliation_report_identity',
  )
  mismatch(
    reconciliationReport.report?.state !== 'matched'
      || Object.keys(reconciliationReport.report?.checks || {}).length !== 5
      || Object.values(reconciliationReport.report?.checks || {})
        .some((value) => value !== 'matched')
      || (
        currentT0Contract
        && (
          reconciliationReport.report?.format !== 'blogman-d1-reconciliation-check/v2'
          || !isIsoTimestamp(reconciliationReport.report?.checked_at)
          || reconciliationReport.report?.d1_database_id !== d1DatabaseId
        )
      ),
    'reconciliation_state',
  )
  mismatch(evidence.smoke?.report_sha256 !== sha256(smokeReport.bytes), 'smoke_report_identity')
  mismatch(smokeReport.report?.state !== 'passed', 'smoke_state')
  mismatch(!isCandidateId(smokeReport.report?.candidate_id), 'smoke_candidate_format')
  mismatch(smokeReport.report?.candidate_id !== candidateId, 'smoke_candidate_identity')
  mismatch(smokeReport.report?.build_sha256 !== buildSha256, 'smoke_build_identity')
  mismatch(smokeReport.report?.deployment_id !== deploymentId, 'smoke_deployment_identity')
  mismatch(smokeReport.report?.version_id !== versionId, 'smoke_version_identity')
  if (currentT0Contract) {
    const expectedSmokeStatus = (name) => (
      candidateFormat === 'blogman-rollout-candidate/v3' && name === 'admin_article'
        ? 404
        : 200
    )
    mismatch(
      smokeReport.report?.format !== 'blogman-production-smoke/v2'
        || !isIsoTimestamp(smokeReport.report?.checked_at)
        || smokeReport.report?.d1_database_id !== d1DatabaseId
        || Object.entries(smokeReport.report?.checks || {})
          .some(([name, status]) => status !== expectedSmokeStatus(name)),
      'smoke_critical_paths',
    )
  }
  mismatch(
    evidence.smoke?.runtime_report_sha256 !== sha256(smokeRuntimeReport.bytes),
    'smoke_runtime_identity',
  )
  mismatch(!smokeRuntimePassed(smokeRuntimeReport.report), 'smoke_runtime_state')
  mismatch(evidence.rollout?.report_sha256 !== sha256(rolloutReport.bytes), 'rollout_report_identity')
  mismatch(
    rolloutReport.report?.format !== 'blogman-rollout-state/v1'
      || rolloutReport.report?.state !== 'captured'
      || !['enabled', 'disabled'].includes(rolloutReport.report?.controls?.producer)
      || !['enabled', 'disabled'].includes(rolloutReport.report?.controls?.authority)
      || Object.values(rolloutReport.report?.controls?.executors || {})
        .some((value) => !['enabled', 'disabled'].includes(value))
      || Object.keys(rolloutReport.report?.controls?.executors || {})
        .some((name) => !/^[a-z0-9][a-z0-9_-]*$/.test(name))
      || (
        currentT0Contract
        && (
          rolloutReport.report?.controls?.producer !== 'disabled'
          || rolloutReport.report?.controls?.authority !== 'disabled'
          || Object.values(rolloutReport.report?.controls?.executors || {})
            .some((value) => value !== 'disabled')
        )
      ),
    'rollout_report_state',
  )
  if (cleanStartContract) {
    const rollback = rollbackControlProof.report
    mismatch(
      evidence.clean_start?.rollback_control_proof_sha256
        !== sha256(rollbackControlProof.bytes),
      'rollback_control_proof_identity',
    )
    mismatch(
      rollback?.format !== 'blogman-clean-start-rollback-control-proof/v1'
        || rollback?.state !== 'proved'
        || !isIsoTimestamp(rollback?.checked_at)
        || rollback?.candidate_id !== candidateId
        || rollback?.baseline_version_id
          !== authority.approval.value.expected_baseline.version_id
        || rollback?.candidate_version_id !== versionId
        || rollback?.d1_database_id !== d1DatabaseId
        || rollback?.traffic_restore_scope !== 'baseline-worker-version-only'
        || rollback?.d1_recovery !== 'forward-only'
        || rollback?.discarded_data_recoverable !== false
        || rollback?.rollout_report_sha256 !== sha256(rolloutReport.bytes),
      'rollback_control_proof_state',
    )
  }
  mismatch(evidence.tests?.report_sha256 !== sha256(testReport.bytes), 'test_report_identity')
  mismatch(
    !testReportPassed(testReport.report),
    'test_report_state',
  )
  if (currentT0Contract) {
    const t0 = t0Report.report
    mismatch(evidence.t0?.report_sha256 !== sha256(t0Report.bytes), 't0_report_identity')
    mismatch(
      t0?.format !== (cleanStartContract
        ? 'blogman-t0-acceptance/v2'
        : 'blogman-t0-acceptance/v1')
        || t0?.state !== 'passed'
        || !isIsoTimestamp(t0?.accepted_at)
        || t0?.candidate_id !== candidateId
        || t0?.build_sha256 !== buildSha256
        || t0?.deployment_id !== deploymentId
        || t0?.version_id !== versionId
        || t0?.d1_database_id !== d1DatabaseId
        || JSON.stringify(t0?.migration_numbers) !== JSON.stringify([1, 2, 3, 4, 5, 6])
        || t0?.migration_report_sha256 !== sha256(migrationReport.bytes)
        || t0?.migration_verification_report_sha256
          !== sha256(migrationVerificationReport.bytes)
        || t0?.smoke_report_sha256 !== sha256(smokeReport.bytes)
        || t0?.final_reconciliation_report_sha256 !== sha256(reconciliationReport.bytes)
        || t0?.anomaly_report_sha256 !== sha256(anomalyReport.bytes),
      't0_state',
    )
    if (cleanStartContract) {
      mismatch(
        t0?.delivery_mode !== 'clean-start'
          || t0?.clean_start_reset_report_sha256
            !== sha256(cleanStartResetReport.bytes)
          || t0?.clean_start_empty_report_sha256
            !== sha256(cleanStartEmptyReport.bytes)
          || t0?.clean_start_upload_report_sha256
            !== sha256(cleanStartUploadReport.bytes)
          || t0?.clean_start_empty_plan_report_sha256
            !== sha256(cleanStartEmptyPlanReport.bytes)
          || t0?.rollback_control_proof_sha256
            !== sha256(rollbackControlProof.bytes)
          || Date.parse(rollbackControlProof.report?.checked_at)
            > Date.parse(t0?.accepted_at),
        't0_clean_start_state',
      )
    }
    mismatch(
      anomalyReport.report?.format !== 'blogman-anomaly-audit/v1'
        || anomalyReport.report?.state !== 'clear'
        || !isIsoTimestamp(anomalyReport.report?.checked_at)
        || anomalyReport.report?.high_priority_open !== 0
        || Date.parse(anomalyReport.report?.checked_at) > Date.parse(t0?.accepted_at)
        || Date.parse(smokeReport.report?.checked_at) > Date.parse(t0?.accepted_at)
        || Date.parse(reconciliationReport.report?.checked_at) > Date.parse(t0?.accepted_at),
      't0_anomaly_state',
    )
  }
  if (!currentT0Contract) {
  mismatch(
    evidence.observation?.report_sha256 !== sha256(observationReport.bytes),
    'observation_report_identity',
  )
  mismatch(
    observationReport.report?.format !== 'blogman-observation-window/v1'
      || !['pending', 'complete'].includes(observationReport.report?.state)
      || !Number.isFinite(observationReport.report?.required_hours)
      || observationReport.report?.required_hours < 24
      || (
        observationReport.report?.started_at !== null
        && !isIsoTimestamp(observationReport.report?.started_at)
      )
      || (
        observationReport.report?.state === 'pending'
        && (
          observationReport.report?.ended_at !== null
          || observationReport.report?.end !== null
          || observationReport.report?.anomaly_audit !== null
          || (
            observationReport.report?.started_at === null
              ? observationReport.report?.start !== null
              : observationReport.report?.start === null
          )
        )
      )
      || (
        observationReport.report?.state === 'complete'
        && (
          !isIsoTimestamp(observationReport.report?.started_at)
          || !isIsoTimestamp(observationReport.report?.ended_at)
          || Date.parse(observationReport.report.ended_at)
            - Date.parse(observationReport.report.started_at)
              < observationReport.report.required_hours * 60 * 60 * 1000
          || observationReport.report?.start === null
          || observationReport.report?.end === null
          || observationReport.report?.anomaly_audit === null
        )
      ),
    'observation_report_state',
  )
  if (observationReport.report?.start !== null) {
    const start = observationReport.report.start
    mismatch(
      !isIsoTimestamp(start?.observed_at)
        || start?.observed_at !== observationReport.report?.started_at
        || !isSha256(start?.smoke_report_sha256)
        || !isSha256(start?.reconciliation_report_sha256),
      'observation_start_state',
    )
    mismatch(
      start?.smoke_report_sha256 !== sha256(observationStartSmokeReport.bytes),
      'observation_start_smoke_identity',
    )
    mismatch(
      observationStartSmokeReport.report?.state !== 'passed'
        || observationStartSmokeReport.report?.candidate_id !== candidateId
        || observationStartSmokeReport.report?.build_sha256 !== buildSha256
        || observationStartSmokeReport.report?.deployment_id !== deploymentId
        || observationStartSmokeReport.report?.version_id !== versionId,
      'observation_start_smoke_state',
    )
    mismatch(
      start?.reconciliation_report_sha256
        !== sha256(observationStartReconciliationReport.bytes),
      'observation_start_reconciliation_identity',
    )
    mismatch(
      observationStartReconciliationReport.report?.state !== 'matched'
        || Object.keys(observationStartReconciliationReport.report?.checks || {}).length !== 5
        || Object.values(observationStartReconciliationReport.report?.checks || {})
          .some((value) => value !== 'matched'),
      'observation_start_reconciliation_state',
    )
  }
  if (observationReport.report?.end !== null) {
    const end = observationReport.report.end
    mismatch(
      !isIsoTimestamp(end?.observed_at)
        || Date.parse(end?.observed_at) - Date.parse(observationReport.report?.started_at)
          < observationReport.report.required_hours * 60 * 60 * 1000
        || Date.parse(end?.observed_at) > Date.parse(observationReport.report?.ended_at)
        || end?.smoke_report_sha256 !== sha256(smokeReport.bytes)
        || end?.reconciliation_report_sha256 !== sha256(reconciliationReport.bytes),
      'observation_end_state',
    )
  }
  if (observationReport.report?.anomaly_audit !== null) {
    mismatch(
      observationReport.report.anomaly_audit?.report_sha256 !== sha256(anomalyReport.bytes),
      'observation_anomaly_identity',
    )
    mismatch(
      anomalyReport.report?.format !== 'blogman-anomaly-audit/v1'
        || anomalyReport.report?.state !== 'clear'
        || !isIsoTimestamp(anomalyReport.report?.checked_at)
        || anomalyReport.report?.high_priority_open !== 0
        || Date.parse(anomalyReport.report?.checked_at)
          < Date.parse(observationReport.report?.end?.observed_at)
        || Date.parse(anomalyReport.report?.checked_at)
          > Date.parse(observationReport.report?.ended_at),
      'observation_anomaly_state',
    )
  }
  }

  return failures.length === 0
    ? {
        state: historical ? 'verified-historical' : 'verified',
        ...(historical
          ? { acceptance_authority: false }
          : { phase: 'batch-1-t0', d1_database_id: d1DatabaseId }),
        candidate_id: candidateId,
        evidence_sha256: sha256(evidenceBytes),
      }
    : { state: 'invalid', failures }
}

function rolloutControl(value) {
  if (value === 'producer' || value === 'authority') {
    return { key: value, kind: value }
  }
  if (/^executor:[a-z0-9][a-z0-9_-]*$/.test(value || '')) {
    return { key: value, kind: 'executor' }
  }
  fail('Rollout control must be producer, authority, or executor:<name>')
}

function unverifiedCandidateBinding(options, state) {
  const providedCandidateId = options.get('candidate')
  const candidateId = isCandidateId(providedCandidateId) ? providedCandidateId : 'unavailable'
  const evidenceState = candidateId === 'unavailable' ? 'unavailable' : state
  let evidenceSha256 = sha256('unavailable rollout evidence')
  const evidencePath = options.get('evidence')
  if (evidencePath) {
    try {
      evidenceSha256 = sha256(readFileSync(resolve(evidencePath)))
    } catch {
      // Emergency disable must remain available when evidence is unreadable.
    }
  }
  return {
    state: evidenceState,
    candidate_id: candidateId,
    evidence_sha256: evidenceSha256,
  }
}

function candidateBindingForDisable(options) {
  try {
    const candidate = verifyCandidate(options)
    return candidate.state === 'verified'
      ? candidate
      : unverifiedCandidateBinding(options, 'invalid')
  } catch {
    return unverifiedCandidateBinding(options, 'unavailable')
  }
}

function rolloutSet(options) {
  const control = rolloutControl(required(options, 'control'))
  const enabledValue = required(options, 'enabled')
  if (enabledValue !== 'true' && enabledValue !== 'false') {
    fail('Rollout --enabled must be true or false')
  }
  const desiredEnabled = enabledValue === 'true' ? 1 : 0
  const operationId = required(options, 'operation-id')
  const actor = required(options, 'actor')
  const reason = required(options, 'reason')
  assertNoSensitiveAuditValue(operationId, actor, reason)
  const candidate = desiredEnabled === 1
    ? verifyCandidate(options)
    : candidateBindingForDisable(options)
  if (desiredEnabled === 1) {
    if (candidate.state !== 'verified') fail('Candidate evidence is invalid')
    if (!verifyMigrationState(options)) fail('Migration state is not verified')
  }

  const existingEvent = queryD1(options, `
SELECT control_key, desired_enabled, candidate_id, evidence_sha256, evidence_state, actor, reason
FROM rollout_control_events
WHERE operation_id = ${sqlLiteral(operationId)}
`, 'rollout operation').at(0)
  const operationPayload = {
    control_key: control.key,
    desired_enabled: desiredEnabled,
    candidate_id: candidate.candidate_id,
    evidence_sha256: candidate.evidence_sha256,
    evidence_state: candidate.state,
    actor,
    reason,
  }
  if (existingEvent) {
    if (JSON.stringify(existingEvent) !== JSON.stringify(operationPayload)) {
      fail('Rollout operation identity already used with different payload')
    }
    return {
      state: 'unchanged',
      control: control.key,
      desired: desiredEnabled ? 'enabled' : 'disabled',
      candidate_id: candidate.candidate_id,
      evidence_sha256: candidate.evidence_sha256,
      ...(candidate.state === 'verified' ? {} : { evidence_state: candidate.state }),
    }
  }

  const previous = queryD1(options, `
SELECT desired_enabled
FROM rollout_controls
WHERE control_key = ${sqlLiteral(control.key)}
`, 'rollout control').at(0)?.desired_enabled ?? null
  executeD1Batch(options, `
INSERT INTO rollout_control_events (
  operation_id, control_key, control_kind, previous_enabled, desired_enabled,
  candidate_id, evidence_sha256, evidence_state, actor, reason
) VALUES (
  ${sqlLiteral(operationId)}, ${sqlLiteral(control.key)}, ${sqlLiteral(control.kind)},
  ${sqlLiteral(previous)}, ${desiredEnabled}, ${sqlLiteral(candidate.candidate_id)},
  ${sqlLiteral(candidate.evidence_sha256)}, ${sqlLiteral(candidate.state)},
  ${sqlLiteral(actor)}, ${sqlLiteral(reason)}
);
INSERT INTO rollout_controls (
  control_key, control_kind, desired_enabled, candidate_id,
  evidence_sha256, evidence_state, actor, reason, updated_at
) VALUES (
  ${sqlLiteral(control.key)}, ${sqlLiteral(control.kind)}, ${desiredEnabled},
  ${sqlLiteral(candidate.candidate_id)}, ${sqlLiteral(candidate.evidence_sha256)},
  ${sqlLiteral(candidate.state)}, ${sqlLiteral(actor)}, ${sqlLiteral(reason)},
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(control_key) DO UPDATE SET
  control_kind = excluded.control_kind,
  desired_enabled = excluded.desired_enabled,
  candidate_id = excluded.candidate_id,
  evidence_sha256 = excluded.evidence_sha256,
  evidence_state = excluded.evidence_state,
  actor = excluded.actor,
  reason = excluded.reason,
  updated_at = excluded.updated_at;
`, 'rollout control change')

  return {
    state: 'updated',
    control: control.key,
    desired: desiredEnabled ? 'enabled' : 'disabled',
    candidate_id: candidate.candidate_id,
    evidence_sha256: candidate.evidence_sha256,
    ...(candidate.state === 'verified' ? {} : { evidence_state: candidate.state }),
  }
}

function emergencySwitch(controlKey) {
  const suffix = controlKey === 'producer' || controlKey === 'authority'
    ? controlKey.toUpperCase()
    : `EXECUTOR_${controlKey.slice('executor:'.length).toUpperCase().replaceAll('-', '_')}`
  const value = process.env[`BLOGMAN_DISABLE_${suffix}`]
  if (value === undefined || value === '' || value === '0' || value === 'false') {
    return { disabled: false, valid: true }
  }
  if (value === '1' || value === 'true') return { disabled: true, valid: true }
  return { disabled: true, valid: false }
}

function rolloutStatus(options) {
  const candidate = verifyCandidate(options)
  const migrationVerified = verifyMigrationState(options)
  const tables = new Set(queryD1(options, `
SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
`, 'rollout schema').map((row) => row.name))
  const rows = tables.has('rollout_controls')
    ? queryD1(options, `
SELECT control_key, control_kind, desired_enabled, candidate_id, evidence_sha256
FROM rollout_controls
ORDER BY control_kind, control_key
`, 'rollout controls')
    : []
  const byKey = new Map(rows.map((row) => [row.control_key, row]))

  const statusFor = (controlKey) => {
    const row = byKey.get(controlKey)
    const desired = row?.desired_enabled === 1
    const blockers = []
    if (!desired) blockers.push('persisted_disabled')
    if (candidate.state !== 'verified') {
      blockers.push('candidate_invalid')
    } else if (row) {
      if (row.candidate_id !== candidate.candidate_id) blockers.push('control_candidate_mismatch')
      if (row.evidence_sha256 !== candidate.evidence_sha256) blockers.push('control_evidence_mismatch')
    }
    if (!migrationVerified) blockers.push('migration_unverified')
    const emergency = emergencySwitch(controlKey)
    if (!emergency.valid) blockers.push('invalid_emergency_switch')
    else if (emergency.disabled) blockers.push('emergency_disabled')
    return {
      desired: desired ? 'enabled' : 'disabled',
      effective: blockers.length === 0 ? 'enabled' : 'disabled',
      blockers,
    }
  }

  const producer = statusFor('producer')
  const authority = statusFor('authority')
  const executors = Object.fromEntries(
    rows
      .filter((row) => row.control_kind === 'executor')
      .map((row) => [row.control_key.slice('executor:'.length), statusFor(row.control_key)]),
  )
  const effectiveStates = [producer, authority, ...Object.values(executors)]
  const ready = effectiveStates.every((control) => control.effective === 'enabled')
  return {
    state: ready ? 'ready' : 'blocked',
    candidate,
    migration: { state: migrationVerified ? 'verified' : 'unverified' },
    controls: { producer, authority, executors },
  }
}

async function requestSmoke(options) {
  if (!options.get('local') || options.get('remote')) {
    fail('Representative request smoke requires --local and never accepts --remote')
  }
  const persistToValue = required(options, 'persist-to')
  if (!isAbsolute(persistToValue)) {
    fail('Representative request smoke requires an absolute --persist-to directory')
  }
  const persistTo = resolve(persistToValue)
  const relativeToRepo = relative(repoRoot, persistTo)
  if (relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    fail('Representative request smoke target must be outside the repository')
  }

  const before = captureReconciliation(options)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'blogman-restored-request-smoke-'))
  const bundlePath = join(temporaryDirectory, 'request-smoke.mjs')
  const smokeConfigPath = join(temporaryDirectory, 'wrangler.toml')
  let workerd
  try {
    const { build } = await import('esbuild')
    const contextShim = join(repoRoot, 'scripts', 'request-smoke', 'cloudflare-context.mjs')
    await build({
      entryPoints: [join(repoRoot, 'scripts', 'request-smoke', 'worker.ts')],
      outfile: bundlePath,
      absWorkingDir: repoRoot,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      define: { __dirname: '"/"' },
      logLevel: 'silent',
      plugins: [{
        name: 'restored-d1-cloudflare-context',
        setup(buildContext) {
          buildContext.onResolve(
            { filter: /^@opennextjs\/cloudflare$/ },
            () => ({ path: contextShim }),
          )
        },
      }],
    })

    const sourceConfig = readFileSync(resolve(required(options, 'config')), 'utf8')
    const database = required(options, 'database')
    const d1Blocks = [...sourceConfig.matchAll(
      /\[\[d1_databases\]\]([\s\S]*?)(?=\n\[\[|\n\[[^[]|$)/g,
    )].map((match) => match[1])
    const d1Block = d1Blocks.find((block) => {
      const binding = block.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1]
      return binding === database
    })
    const databaseName = d1Block?.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1]
    const databaseId = d1Block?.match(/^\s*database_id\s*=\s*"([^"]+)"/m)?.[1]
    if (!databaseName || !databaseId) fail('Representative request smoke D1 binding is incomplete')
    writeFileSync(smokeConfigPath, `
name = "blogman-restored-request-smoke"
main = "${bundlePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"
compatibility_date = "2026-04-14"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "${database}"
database_name = "${databaseName}"
database_id = "${databaseId}"
`)

    const port = await new Promise((resolvePort, rejectPort) => {
      const server = createServer()
      server.once('error', rejectPort)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const selectedPort = typeof address === 'object' && address ? address.port : null
        server.close((error) => error ? rejectPort(error) : resolvePort(selectedPort))
      })
    })
    if (!Number.isInteger(port)) fail('Representative request smoke could not reserve a local port')
    workerd = spawn(wranglerPath, [
      'dev', bundlePath, '--local', '--persist-to', persistTo,
      '--config', smokeConfigPath, '--ip', '127.0.0.1', '--port', String(port),
      '--log-level', 'none',
    ], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (workerd.exitCode !== null) break
      try {
        const response = await fetch(`${origin}/__smoke/health`)
        if (
          response.status === 204
          && response.headers.get('x-blogman-smoke-runtime') === 'workerd'
        ) {
          ready = true
          break
        }
      } catch {
        // Wrangler is still starting the isolated Workerd runtime.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (!ready) fail('Representative restored D1 Workerd did not become ready')

    const requests = []
    for (const request of [
      { name: 'search', path: '/api/search?q=Restored' },
      { name: 'appearance', path: '/api/settings/appearance' },
    ]) {
      const response = await fetch(`${origin}${request.path}`)
      if (
        response.status !== 200
        || response.headers.get('x-blogman-smoke-runtime') !== 'workerd'
      ) {
        fail('Representative restored D1 request smoke returned a failing response')
      }
      await response.arrayBuffer()
      requests.push({ name: request.name, status: response.status })
    }

    const after = captureReconciliation(options)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail('Representative request smoke changed restored D1 facts')
    }
    const report = {
      state: 'passed',
      target: 'external-local-d1-persist',
      runtime: 'workerd',
      requests,
      reconciliation: 'matched',
    }
    return { ...report, report_sha256: canonicalHash(report) }
  } finally {
    if (workerd && workerd.exitCode === null) {
      workerd.kill('SIGTERM')
      await Promise.race([
        new Promise((resolveExit) => workerd.once('exit', resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ])
      if (workerd.exitCode === null) workerd.kill('SIGKILL')
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function main() {
  const [domain, action, ...args] = process.argv.slice(2)
  const options = parseOptions(args)
  let report
  if (domain === 'backup') {
    if (action === 'export') {
      assertOnlyOptions(options, ['run-root', 'database', 'config', 'remote'])
      if (!options.get('remote')) fail('Private D1 export requires --remote')
    } else if (action === 'dispose') {
      assertOnlyOptions(options, ['run-root'])
    }
    report = action === 'export'
      ? capturePrivateD1Export({
          runRoot: required(options, 'run-root'),
          database: required(options, 'database'),
          config: required(options, 'config'),
        })
      : action === 'dispose'
        ? disposePrivateD1Export({ runRoot: required(options, 'run-root') })
        : action === 'verify'
          ? verifyBackup(options)
          : action === 'restore'
            ? restoreBackup(options)
            : fail('Expected backup action: export, dispose, verify, or restore')
  } else if (domain === 'reconcile') {
    report = action === 'capture'
      ? captureReconciliation(options)
      : action === 'compare'
        ? compareReconciliation(options)
        : fail('Expected reconcile action: capture or compare')
  } else if (domain === 'candidate') {
    report = action === 'verify'
      ? verifyCandidate(options)
      : action === 'verify-historical'
        ? verifyCandidate(options, { historical: true })
      : action === 'verify-pre-migration'
        ? verifyPreMigrationCandidate(options)
        : fail('Expected candidate action: verify, verify-historical, or verify-pre-migration')
  } else if (domain === 'rollout') {
    report = action === 'set'
      ? rolloutSet(options)
      : action === 'status'
        ? rolloutStatus(options)
        : fail('Expected rollout action: set or status')
  } else if (domain === 'request') {
    report = action === 'smoke'
      ? await requestSmoke(options)
      : fail('Expected request action: smoke')
  } else {
    fail('Expected command domain: backup, reconcile, candidate, rollout, or request')
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (
    report.state === 'drift'
    || report.state === 'invalid'
    || report.state === 'blocked'
    || report.state === 'stale'
  ) {
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Rollout safety command failed'}\n`)
    process.exitCode = 1
  }
}
