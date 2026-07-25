#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const migrationRunnerPath = join(repoRoot, 'scripts', 'migrations.mjs')

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
  assertExactKeys(evidence, [
    'format', 'candidate_id', 'lockfile', 'build', 'cloudflare', 'migration',
    'backup', 'reconciliation', 'smoke', 'rollout', 'tests', 'observation',
  ])
  assertExactKeys(evidence.lockfile, ['sha256', 'wrangler', 'opennextjs_cloudflare'])
  assertExactKeys(evidence.build, ['sha256'])
  assertExactKeys(evidence.cloudflare, ['deployment_id', 'version_id'])
  assertExactKeys(evidence.migration, [
    'state', 'candidate_id', 'set_sha256', 'report_sha256',
  ])
  assertExactKeys(evidence.backup, [
    'backup_id', 'verify_report_sha256', 'restore_report_sha256',
  ])
  for (const name of ['reconciliation', 'smoke', 'rollout', 'tests', 'observation']) {
    assertExactKeys(evidence[name], ['report_sha256'])
  }
}

function assertReportShape(name, report) {
  if (name === 'backup-report') {
    assertExactKeys(report, ['state', 'backup_id', 'artifact_count'])
  } else if (name === 'restore-report') {
    assertExactKeys(report, ['state', 'backup_id', 'target'])
    assertExactKeys(report.target, ['mode', 'isolated'])
  } else if (name === 'migration-report') {
    assertExactKeys(report, ['format', 'state', 'candidate_id', 'migration_set_sha256'])
  } else if (name === 'reconciliation-report') {
    assertExactKeys(report, ['state', 'checks'])
    assertExactKeys(report.checks, [
      'schema', 'migration_ledger', 'post_count', 'post_status', 'post_content',
    ])
  } else if (name === 'smoke-report') {
    assertExactKeys(report, [
      'state', 'candidate_id', 'build_sha256', 'deployment_id', 'version_id',
    ])
  } else if (name === 'rollout-report') {
    assertExactKeys(report, ['format', 'state', 'controls'])
    assertExactKeys(report.controls, ['producer', 'authority', 'executors'])
    assertExactKeys(report.controls.executors, Object.keys(report.controls.executors || {}))
  } else if (name === 'test-report') {
    assertExactKeys(report, ['format', 'state', 'exit_code', 'passed', 'failed'])
  } else if (name === 'observation-report') {
    assertExactKeys(report, [
      'format', 'state', 'required_hours', 'started_at', 'ended_at',
    ])
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
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', ...d1CommandArgs(options), '--command', sql, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) fail(`Unable to capture ${evidenceName} evidence`)
  try {
    return JSON.parse(result.stdout).at(-1)?.results || []
  } catch {
    fail(`Invalid ${evidenceName} evidence response`)
  }
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
  for (const [index, artifact] of backup.artifacts.entries()) {
    const result = spawnSync(wranglerPath, [
      'd1', 'execute', database, '--local', '--persist-to', persistTo,
      '--config', config, '--file', artifact.path, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' })
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
  const schemaRows = queryD1(options, `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
ORDER BY type, name
`, 'schema')
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

function verifyCandidate(options) {
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
  if (evidence?.format !== 'blogman-rollout-candidate/v1') {
    fail('Unsupported candidate evidence format')
  }
  assertNoSensitiveFields(evidence)
  assertCandidateEvidenceShape(evidence)
  const readReport = (optionName) => {
    let bytes
    let report
    try {
      bytes = readFileSync(resolve(required(options, optionName)))
      report = JSON.parse(bytes.toString('utf8'))
    } catch {
      fail(`Candidate ${optionName} is not valid JSON`)
    }
    assertNoSensitiveFields(report)
    assertReportShape(optionName, report)
    return { bytes, report }
  }
  const backupReport = readReport('backup-report')
  const restoreReport = readReport('restore-report')
  const migrationReport = readReport('migration-report')
  const reconciliationReport = readReport('reconciliation-report')
  const smokeReport = readReport('smoke-report')
  const rolloutReport = readReport('rollout-report')
  const testReport = readReport('test-report')
  const observationReport = readReport('observation-report')

  const candidateId = required(options, 'candidate')
  const deploymentId = required(options, 'deployment')
  const versionId = required(options, 'version')
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
  mismatch(evidence.smoke?.report_sha256 !== sha256(smokeReport.bytes), 'smoke_report_identity')
  mismatch(smokeReport.report?.state !== 'passed', 'smoke_state')
  mismatch(!isCandidateId(smokeReport.report?.candidate_id), 'smoke_candidate_format')
  mismatch(smokeReport.report?.candidate_id !== candidateId, 'smoke_candidate_identity')
  mismatch(smokeReport.report?.build_sha256 !== buildSha256, 'smoke_build_identity')
  mismatch(smokeReport.report?.deployment_id !== deploymentId, 'smoke_deployment_identity')
  mismatch(smokeReport.report?.version_id !== versionId, 'smoke_version_identity')
  mismatch(evidence.rollout?.report_sha256 !== sha256(rolloutReport.bytes), 'rollout_report_identity')
  mismatch(
    rolloutReport.report?.format !== 'blogman-rollout-state/v1'
      || rolloutReport.report?.state !== 'captured'
      || !['enabled', 'disabled'].includes(rolloutReport.report?.controls?.producer)
      || !['enabled', 'disabled'].includes(rolloutReport.report?.controls?.authority)
      || Object.values(rolloutReport.report?.controls?.executors || {})
        .some((value) => !['enabled', 'disabled'].includes(value))
      || Object.keys(rolloutReport.report?.controls?.executors || {})
        .some((name) => !/^[a-z0-9][a-z0-9_-]*$/.test(name)),
    'rollout_report_state',
  )
  mismatch(evidence.tests?.report_sha256 !== sha256(testReport.bytes), 'test_report_identity')
  mismatch(
    testReport.report?.format !== 'blogman-test-report/v1'
      || testReport.report?.state !== 'passed'
      || testReport.report?.exit_code !== 0
      || testReport.report?.failed !== 0
      || !Number.isInteger(testReport.report?.passed)
      || testReport.report?.passed < 1,
    'test_report_state',
  )
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
        && observationReport.report?.ended_at !== null
      )
      || (
        observationReport.report?.state === 'complete'
        && (
          !isIsoTimestamp(observationReport.report?.started_at)
          || !isIsoTimestamp(observationReport.report?.ended_at)
          || Date.parse(observationReport.report.ended_at)
            - Date.parse(observationReport.report.started_at)
              < observationReport.report.required_hours * 60 * 60 * 1000
        )
      ),
    'observation_report_state',
  )

  return failures.length === 0
    ? {
        state: 'verified',
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
    report = action === 'verify'
      ? verifyBackup(options)
      : action === 'restore'
        ? restoreBackup(options)
        : fail('Expected backup action: verify or restore')
  } else if (domain === 'reconcile') {
    report = action === 'capture'
      ? captureReconciliation(options)
      : action === 'compare'
        ? compareReconciliation(options)
        : fail('Expected reconcile action: capture or compare')
  } else if (domain === 'candidate') {
    report = action === 'verify'
      ? verifyCandidate(options)
      : fail('Expected candidate action: verify')
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
  if (report.state === 'drift' || report.state === 'invalid' || report.state === 'blocked') {
    process.exitCode = 1
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Rollout safety command failed'}\n`)
  process.exitCode = 1
}
