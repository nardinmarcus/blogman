import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSyntheticStage } from './issue-23-delivery-synthetic-adapter.mjs'
import { createD1Transport } from './issue-23-delivery-d1-transport.mjs'
import { runD1Stages } from './issue-23-delivery-d1-stages.mjs'

export const LOCAL_ENTRY_FORMAT = 'blogman-issue-23-local-entry/v1'
export const LOCAL_SUPERVISOR_FORMAT = 'blogman-issue-23-supervisor/v1'

function fail(message) {
  throw new Error(`Issue #23 local entry: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function stableOutput(value) {
  if (Array.isArray(value)) return value.map(stableOutput)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/_at$/u.test(key))
      .map(([key, child]) => [key, stableOutput(child)]))
  }
  return value
}

function assertSafeString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    fail(`${label} must be a non-empty single-line string`)
  }
}

export function buildLocalRehearsalCommands({ runnerPath, configPath, stateToken, candidate }) {
  assertSafeString(runnerPath, 'runnerPath')
  assertSafeString(configPath, 'configPath')
  assertSafeString(stateToken, 'stateToken')
  assertSafeString(candidate, 'candidate')
  const common = [
    '--database', 'DB', '--local', '--persist-to', stateToken, '--config', configPath,
  ]
  return [
    { name: 'catalog', args: ['catalog'] },
    { name: 'apply', args: ['apply', ...common, '--candidate', candidate] },
    { name: 'verify', args: ['verify', ...common] },
  ].map((command) => ({
    ...command,
    executable: process.execPath,
    argv: [runnerPath, ...command.args],
  }))
}

export function parseLocalCommandResult(result, name) {
  if (result?.error?.code === 'ETIMEDOUT') {
    fail(`${name} command timed out`)
  }
  if (!result || typeof result.stdout !== 'string' || result.stderr !== '') {
    fail(`${name} command did not complete successfully`)
  }
  if (result.status !== 0 || result.signal) {
    fail(`${name} command did not complete successfully`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    fail(`${name} command did not return JSON`)
  }
  if (parsed?.format === LOCAL_SUPERVISOR_FORMAT) {
    if (parsed.status === 'timed_out') fail(`${name} command timed out`)
    if (parsed.status === 'output_overflow') fail(`${name} command output exceeded the bounded limit`)
    if (parsed.status === 'residual_process_group') fail(`${name} command left a residual process group`)
    if (parsed.status !== 'completed' || parsed.residual_process_group !== false) {
      fail(`${name} command did not complete successfully`)
    }
    if (typeof parsed.stdout !== 'string' || parsed.stderr !== '') {
      fail(`${name} command did not complete successfully`)
    }
    try {
      return JSON.parse(parsed.stdout)
    } catch {
      fail(`${name} command did not return JSON`)
    }
  }
  return parsed
}

export function buildLocalEntryReceipt({
  manifestDraftSha256,
  commands,
  outputs,
  runtime,
  network,
  networkEvidence,
  disposableState,
  adapterOutputs,
}) {
  if (!/^[a-f0-9]{64}$/u.test(manifestDraftSha256 || '')) fail('manifest draft identity is invalid')
  if (!Array.isArray(commands) || !Array.isArray(outputs) || commands.length !== outputs.length) {
    fail('command and output identities must have equal lengths')
  }
  if (!runtime || network !== 'disabled'
    || !['macos-sandbox-exec-loopback', 'node-guard-only'].includes(networkEvidence?.boundary)
    || networkEvidence.external_probe !== 'blocked'
    || !disposableState?.created
    || !disposableState?.cleaned
    || !disposableState?.observed_absent) {
    fail('runtime, network, and disposable-state evidence is incomplete')
  }
  const commandInputs = commands.map(({ name, args }) => ({ name, args }))
  const outputIdentities = outputs.map((output) => ({
    name: output.name,
    sha256: sha256(canonicalBytes(stableOutput(output.value))),
  }))
  const receipt = {
    format: LOCAL_ENTRY_FORMAT,
    manifest_draft_sha256: manifestDraftSha256,
    command_inputs: commandInputs,
    output_identities: outputIdentities,
    adapter_output_identities: adapterOutputs ?? [],
    runtime,
    network,
    network_evidence: networkEvidence,
    disposable_state: disposableState,
  }
  const bytes = canonicalBytes(receipt)
  return { value: receipt, bytes, sha256: sha256(bytes) }
}

const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const TERMINAL_RESULT_FORMAT = 'blogman-issue-23-terminal-result/v1'
const DELIVERY_STAGE_POLICY = Object.freeze([
  Object.freeze({ name: 'authorization_accept', timeout_seconds: 30 }),
  Object.freeze({ name: 'live_preconditions', timeout_seconds: 120 }),
  Object.freeze({ name: 'd1_identity', timeout_seconds: 120 }),
  Object.freeze({ name: 'clean_start_reset', timeout_seconds: 300 }),
  Object.freeze({ name: 'empty_d1_proof', timeout_seconds: 300 }),
  Object.freeze({ name: 'migrations_001_006', timeout_seconds: 2100 }),
  Object.freeze({ name: 'reconciliation', timeout_seconds: 300 }),
  Object.freeze({ name: 'worker_deploy', timeout_seconds: 600 }),
  Object.freeze({ name: 'version_traffic_verification', timeout_seconds: 300 }),
  Object.freeze({ name: 'smoke_control_t0', timeout_seconds: 300 }),
])
const DELIVERY_STAGES = Object.freeze(DELIVERY_STAGE_POLICY.map(({ name }) => name))
const OVERALL_TIMEOUT_SECONDS = 5400
const PRODUCTION_D1_STAGES = Object.freeze([
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
])
const PRODUCTION_D1_MIGRATION_NAMES = Object.freeze([
  '001_initial_schema',
  '002_add_ai_image_configuration',
  '003_migrate_runtime_ai_configuration',
  '004_complete_historical_text_ai_schema',
  '005_fix_posts_fts_sync',
  '006_add_rollout_safety_controls',
])
const PRODUCTION_D1_CANONICAL_PATHS = Object.freeze({
  config_path: 'wrangler.toml',
  reset_sql_path: 'db/issue-23-clean-start-reset.sql',
  migration_runner_path: 'scripts/migrations.mjs',
  migration_catalog_path: 'db/ledger-migrations',
  rollout_safety_path: 'scripts/rollout-safety.mjs',
})
const ENTRY_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_RECONCILIATION_FORMAT = 'blogman-d1-reconciliation/v1'
const PRODUCTION_SUFFIX_UNAVAILABLE = 'production_stage_adapter_unavailable'
const ADAPTER_OUTCOMES = Object.freeze(['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'])
const DEFAULT_ADAPTER_CLASSIFICATIONS = Object.freeze({
  NON_PASS: 'synthetic_adapter_non_pass',
  ERROR: 'synthetic_adapter_error',
  TIMEOUT: 'synthetic_adapter_timeout',
  UNCERTAIN: 'uncertain_adapter_outcome',
})
const SAFE_ADAPTER_CLASSIFICATIONS = Object.freeze([
  'Manifest Drift',
  'synthetic_adapter_non_pass',
  'synthetic_adapter_error',
  'synthetic_adapter_timeout',
  'stage_timeout',
  'overall_timeout',
  'uncertain_adapter_outcome',
])
const consumedAuthorizationDigests = new Set()

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertExactKeys(value, keys, label) {
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

function canonicalJsonBytes(value) {
  const json = JSON.stringify(value, null, 2)
  if (typeof json !== 'string') fail('value is not canonical JSON')
  return Buffer.from(`${json}\n`, 'utf8')
}

function isJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (isPlainRecord(value)) return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string' && isJsonValue(value[key])
  ))
  return false
}

function normalizedJsonValue(value) {
  if (Array.isArray(value)) return value.map(normalizedJsonValue)
  if (isPlainRecord(value)) {
    return Object.fromEntries(Reflect.ownKeys(value).sort().map((key) => [key, normalizedJsonValue(value[key])]))
  }
  return value
}

function sameJsonValue(left, right) {
  return JSON.stringify(normalizedJsonValue(left)) === JSON.stringify(normalizedJsonValue(right))
}

const CANONICAL_MANIFEST_FORMAT = 'blogman-issue-23-canonical-frozen-manifest/v1'
const CANONICAL_MANIFEST_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u
const CANONICAL_MANIFEST_SHA256_PATTERN = /^[a-f0-9]{64}$/u
const CANONICAL_MANIFEST_SHA40_PATTERN = /^[a-f0-9]{40}$/u
const CANONICAL_MANIFEST_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,2}(?:[-+][A-Za-z0-9._-]+)?$/u
const CANONICAL_MANIFEST_NAME_PATTERN = /^[a-z][a-z0-9_:-]*$/u
const CANONICAL_MANIFEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u
const CANONICAL_MANIFEST_WORKER_PATTERN = /^[A-Za-z0-9._-]+$/u
const CANONICAL_MANIFEST_ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9._/-]+$/u
const CANONICAL_MANIFEST_ROOT_KEYS = [
  'format',
  'preparation',
  'repository',
  'ci',
  'toolchain',
  'artifact',
  'migration',
  'd1',
  'target',
  'policy',
  'rehearsal',
]
const CANONICAL_MANIFEST_FROZEN_PRECONDITIONS = Object.freeze([
  'repository.commit',
  'repository.tree',
  'ci.head_sha',
  'ci.tree',
  'artifact.file_tree.sha256',
  'migration.catalog.sha256',
  'target.baseline',
])
const CANONICAL_MANIFEST_OBSERVATIONS = Object.freeze([
  'target.deployment_id',
  'target.version_id',
  'target.traffic',
  'rehearsal.receipt_sha256',
])
const CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS = Object.freeze([
  'secret_values',
  'raw_private_adapter_output',
  'sql_bodies',
  'private_operator_paths',
])

function assertSchemaKeys(value, keys, label) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`)
  const actual = Reflect.ownKeys(value)
  const missing = keys.filter((key) => !actual.includes(key))
  if (missing.length > 0) fail(`${label} is missing required field ${missing[0]}`)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

function schemaRecord(value, keys, label) {
  if (keys) assertSchemaKeys(value, keys, label)
  else if (!isPlainRecord(value)) fail(`${label} must be an object`)
  return value
}

function schemaString(value, label, pattern = null) {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`)
  }
  return value
}

function schemaSha256(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_SHA256_PATTERN)
}

function schemaPath(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_PATH_PATTERN)
}

function schemaVersion(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_VERSION_PATTERN)
}

function schemaNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`)
  return value
}

function schemaPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`)
  return value
}

function validateManifestReference(value, label, includeBytes = false) {
  const keys = includeBytes ? ['path', 'sha256', 'bytes'] : ['path', 'sha256']
  schemaRecord(value, keys, label)
  schemaPath(value.path, `${label}.path`)
  schemaSha256(value.sha256, `${label}.sha256`)
  if (includeBytes) schemaNonNegativeInteger(value.bytes, `${label}.bytes`)
}

function validateToolchainEntry(value, label) {
  schemaRecord(value, ['version', 'identity_sha256'], label)
  schemaVersion(value.version, `${label}.version`)
  schemaSha256(value.identity_sha256, `${label}.identity_sha256`)
}

function validateCanonicalManifestSchema(value) {
  schemaRecord(value, CANONICAL_MANIFEST_ROOT_KEYS, 'canonical manifest')
  if (value.format !== CANONICAL_MANIFEST_FORMAT) fail('canonical manifest format is invalid')

  schemaRecord(value.preparation, ['prepare_entry', 'execute_entry', 'manifest_schema'], 'manifest preparation')
  validateManifestReference(value.preparation.prepare_entry, 'manifest preparation.prepare_entry')
  validateManifestReference(value.preparation.execute_entry, 'manifest preparation.execute_entry')
  validateManifestReference(value.preparation.manifest_schema, 'manifest preparation.manifest_schema')

  schemaRecord(value.repository, ['canonical', 'remote', 'commit', 'tree', 'clean'], 'manifest repository')
  if (value.repository.canonical !== 'nardinmarcus/blogman') {
    fail('manifest repository.canonical is invalid')
  }
  if (value.repository.remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('manifest repository.remote is invalid')
  }
  schemaString(value.repository.commit, 'manifest repository.commit', CANONICAL_MANIFEST_SHA40_PATTERN)
  schemaString(value.repository.tree, 'manifest repository.tree', CANONICAL_MANIFEST_SHA40_PATTERN)
  if (value.repository.clean !== true) fail('manifest repository.clean is invalid')

  schemaRecord(
    value.ci,
    ['provider', 'workflow', 'run_id', 'attempt', 'event', 'head_sha', 'tree', 'conclusion'],
    'manifest ci',
  )
  if (value.ci.provider !== 'github-actions') fail('manifest ci.provider is invalid')
  schemaPath(value.ci.workflow, 'manifest ci.workflow')
  schemaPositiveInteger(value.ci.run_id, 'manifest ci.run_id')
  if (value.ci.attempt !== 1) fail('manifest ci.attempt is invalid')
  if (!['push', 'pull_request'].includes(value.ci.event)) fail('manifest ci.event is invalid')
  schemaString(value.ci.head_sha, 'manifest ci.head_sha', CANONICAL_MANIFEST_SHA40_PATTERN)
  schemaString(value.ci.tree, 'manifest ci.tree', CANONICAL_MANIFEST_SHA40_PATTERN)
  if (value.ci.conclusion !== 'success') fail('manifest ci.conclusion is invalid')

  schemaRecord(
    value.toolchain,
    ['node', 'npm', 'wrangler', 'opennextjs_cloudflare', 'package_json_sha256', 'lockfile_sha256'],
    'manifest toolchain',
  )
  validateToolchainEntry(value.toolchain.node, 'manifest toolchain.node')
  validateToolchainEntry(value.toolchain.npm, 'manifest toolchain.npm')
  validateToolchainEntry(value.toolchain.wrangler, 'manifest toolchain.wrangler')
  validateToolchainEntry(value.toolchain.opennextjs_cloudflare, 'manifest toolchain.opennextjs_cloudflare')
  schemaSha256(value.toolchain.package_json_sha256, 'manifest toolchain.package_json_sha256')
  schemaSha256(value.toolchain.lockfile_sha256, 'manifest toolchain.lockfile_sha256')

  schemaRecord(value.artifact, ['archive', 'worker', 'file_tree'], 'manifest artifact')
  validateManifestReference(value.artifact.archive, 'manifest artifact.archive', true)
  validateManifestReference(value.artifact.worker, 'manifest artifact.worker', true)
  schemaRecord(value.artifact.file_tree, ['sha256', 'complete', 'files'], 'manifest artifact.file_tree')
  schemaSha256(value.artifact.file_tree.sha256, 'manifest artifact.file_tree.sha256')
  if (value.artifact.file_tree.complete !== true) fail('manifest artifact.file_tree.complete is invalid')
  if (!Array.isArray(value.artifact.file_tree.files) || value.artifact.file_tree.files.length < 1) {
    fail('manifest artifact.file_tree.files is invalid')
  }
  value.artifact.file_tree.files.forEach((file, index) => {
    validateManifestReference(file, `manifest artifact.file_tree.files[${index}]`, true)
  })

  schemaRecord(
    value.migration,
    ['delivery_mode', 'reset_sql', 'runner', 'catalog', 'historical_data_disposition'],
    'manifest migration',
  )
  if (value.migration.delivery_mode !== 'clean-start') fail('manifest migration.delivery_mode is invalid')
  validateManifestReference(value.migration.reset_sql, 'manifest migration.reset_sql')
  validateManifestReference(value.migration.runner, 'manifest migration.runner')
  schemaRecord(value.migration.catalog, ['path', 'sha256', 'migrations'], 'manifest migration.catalog')
  schemaPath(value.migration.catalog.path, 'manifest migration.catalog.path')
  schemaSha256(value.migration.catalog.sha256, 'manifest migration.catalog.sha256')
  if (!Array.isArray(value.migration.catalog.migrations)
    || value.migration.catalog.migrations.length < 6
    || value.migration.catalog.migrations.length > 6) {
    fail('manifest migration.catalog.migrations is invalid')
  }
  value.migration.catalog.migrations.forEach((migration, index) => {
    schemaRecord(migration, ['id', 'path', 'sha256'], `manifest migration.catalog.migrations[${index}]`)
    schemaString(migration.id, `manifest migration.catalog.migrations[${index}].id`, /^00[1-6]$/u)
    schemaPath(migration.path, `manifest migration.catalog.migrations[${index}].path`)
    schemaSha256(migration.sha256, `manifest migration.catalog.migrations[${index}].sha256`)
  })
  schemaRecord(
    value.migration.historical_data_disposition,
    ['production_export', 'double_restore', 'historical_baseline_queries'],
    'manifest migration.historical_data_disposition',
  )
  for (const field of ['production_export', 'double_restore', 'historical_baseline_queries']) {
    if (value.migration.historical_data_disposition[field] !== 'NOT_APPLICABLE') {
      fail(`manifest migration.historical_data_disposition.${field} is invalid`)
    }
  }

  schemaRecord(
    value.target,
    ['account_id', 'd1_database_id', 'worker_name', 'origin', 'baseline'],
    'manifest target',
  )
  schemaString(value.target.account_id, 'manifest target.account_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(value.target.d1_database_id, 'manifest target.d1_database_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(value.target.worker_name, 'manifest target.worker_name', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaString(value.target.origin, 'manifest target.origin', CANONICAL_MANIFEST_ORIGIN_PATTERN)
  schemaRecord(
    value.target.baseline,
    ['deployment_id', 'version_id', 'd1_database_id', 'traffic'],
    'manifest target.baseline',
  )
  schemaString(value.target.baseline.deployment_id, 'manifest target.baseline.deployment_id', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaString(value.target.baseline.version_id, 'manifest target.baseline.version_id', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaString(value.target.baseline.d1_database_id, 'manifest target.baseline.d1_database_id', CANONICAL_MANIFEST_ID_PATTERN)
  if (!Array.isArray(value.target.baseline.traffic) || value.target.baseline.traffic.length < 1) {
    fail('manifest target.baseline.traffic is invalid')
  }
  value.target.baseline.traffic.forEach((traffic, index) => {
    schemaRecord(traffic, ['version_id', 'percentage'], `manifest target.baseline.traffic[${index}]`)
    schemaString(traffic.version_id, `manifest target.baseline.traffic[${index}].version_id`, CANONICAL_MANIFEST_WORKER_PATTERN)
    schemaNonNegativeInteger(traffic.percentage, `manifest target.baseline.traffic[${index}].percentage`)
  })

  schemaRecord(
    value.policy,
    ['authorization', 'stages', 'overall_timeout_seconds', 'drift', 'evidence'],
    'manifest policy',
  )
  schemaRecord(
    value.policy.authorization,
    ['manifest_binding', 'one_shot', 'credential_slots'],
    'manifest policy.authorization',
  )
  if (value.policy.authorization.manifest_binding !== 'manifest_sha256'
    || value.policy.authorization.one_shot !== true) {
    fail('manifest policy.authorization is invalid')
  }
  if (!Array.isArray(value.policy.authorization.credential_slots)
    || value.policy.authorization.credential_slots.length < 1) {
    fail('manifest policy.authorization.credential_slots is invalid')
  }
  value.policy.authorization.credential_slots.forEach((slot, index) => {
    schemaRecord(slot, ['name', 'scopes'], `manifest policy.authorization.credential_slots[${index}]`)
    schemaString(slot.name, `manifest policy.authorization.credential_slots[${index}].name`, CANONICAL_MANIFEST_NAME_PATTERN)
    if (!Array.isArray(slot.scopes) || slot.scopes.length < 1) {
      fail(`manifest policy.authorization.credential_slots[${index}].scopes is invalid`)
    }
    slot.scopes.forEach((scope, scopeIndex) => {
      schemaString(
        scope,
        `manifest policy.authorization.credential_slots[${index}].scopes[${scopeIndex}]`,
        CANONICAL_MANIFEST_NAME_PATTERN,
      )
    })
  })
  if (!Array.isArray(value.policy.stages) || value.policy.stages.length !== DELIVERY_STAGE_POLICY.length) {
    fail('manifest policy.stages is invalid')
  }
  value.policy.stages.forEach((stage, index) => {
    schemaRecord(stage, ['name', 'timeout_seconds'], `manifest policy.stages[${index}]`)
    schemaString(stage.name, `manifest policy.stages[${index}].name`, CANONICAL_MANIFEST_NAME_PATTERN)
    schemaPositiveInteger(stage.timeout_seconds, `manifest policy.stages[${index}].timeout_seconds`)
  })
  if (value.policy.overall_timeout_seconds !== OVERALL_TIMEOUT_SECONDS) {
    fail('manifest policy.overall_timeout_seconds is invalid')
  }
  schemaRecord(
    value.policy.drift,
    ['frozen_preconditions', 'observations', 'mismatch_classification'],
    'manifest policy.drift',
  )
  if (!Array.isArray(value.policy.drift.frozen_preconditions)
    || value.policy.drift.frozen_preconditions.length < 1
    || value.policy.drift.frozen_preconditions.some((item) => typeof item !== 'string')) {
    fail('manifest policy.drift.frozen_preconditions is invalid')
  }
  if (!Array.isArray(value.policy.drift.observations)
    || value.policy.drift.observations.length < 1
    || value.policy.drift.observations.some((item) => typeof item !== 'string')) {
    fail('manifest policy.drift.observations is invalid')
  }
  if (value.policy.drift.mismatch_classification !== 'Manifest Drift') {
    fail('manifest policy.drift.mismatch_classification is invalid')
  }
  schemaRecord(
    value.policy.evidence,
    ['allowed_hash_algorithm', 'excluded', 'production_evidence', 'local_rehearsal_evidence'],
    'manifest policy.evidence',
  )
  if (value.policy.evidence.allowed_hash_algorithm !== 'sha256'
    || value.policy.evidence.production_evidence !== 'real_adapters_only'
    || value.policy.evidence.local_rehearsal_evidence !== 'test_only') {
    fail('manifest policy.evidence is invalid')
  }
  if (!Array.isArray(value.policy.evidence.excluded)
    || value.policy.evidence.excluded.length !== CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS.length
    || value.policy.evidence.excluded.some((item) => !CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS.includes(item))) {
    fail('manifest policy.evidence.excluded is invalid')
  }

  schemaRecord(
    value.rehearsal,
    ['runtime', 'network', 'status', 'receipt_sha256', 'production_write_adapter_calls'],
    'manifest rehearsal',
  )
  schemaRecord(value.rehearsal.runtime, ['os', 'architecture', 'node_version'], 'manifest rehearsal.runtime')
  if (value.rehearsal.runtime.os !== 'macos') fail('manifest rehearsal.runtime.os is invalid')
  schemaString(value.rehearsal.runtime.architecture, 'manifest rehearsal.runtime.architecture', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaVersion(value.rehearsal.runtime.node_version, 'manifest rehearsal.runtime.node_version')
  if (value.rehearsal.network !== 'disabled' || value.rehearsal.status !== 'PASS') {
    fail('manifest rehearsal state is invalid')
  }
  schemaSha256(value.rehearsal.receipt_sha256, 'manifest rehearsal.receipt_sha256')
  if (value.rehearsal.production_write_adapter_calls !== 0) {
    fail('manifest rehearsal.production_write_adapter_calls is invalid')
  }

  return value
}

function assertCanonicalManifestRelationships(manifest) {
  if (manifest.repository.canonical !== 'nardinmarcus/blogman'
    || manifest.repository.remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('manifest repository identity is not canonical')
  }
  if (manifest.ci.head_sha !== manifest.repository.commit) {
    fail('manifest ci.head_sha must equal repository.commit')
  }
  if (manifest.ci.tree !== manifest.repository.tree) {
    fail('manifest ci.tree must equal repository.tree')
  }
  if (manifest.ci.conclusion !== 'success') fail('manifest ci.conclusion must be success')

  const publicPaths = [
    ['preparation.prepare_entry.path', manifest.preparation.prepare_entry.path],
    ['preparation.execute_entry.path', manifest.preparation.execute_entry.path],
    ['preparation.manifest_schema.path', manifest.preparation.manifest_schema.path],
    ['ci.workflow', manifest.ci.workflow],
    ['artifact.archive.path', manifest.artifact.archive.path],
    ['artifact.worker.path', manifest.artifact.worker.path],
    ['migration.reset_sql.path', manifest.migration.reset_sql.path],
    ['migration.runner.path', manifest.migration.runner.path],
    ['migration.catalog.path', manifest.migration.catalog.path],
    ...manifest.artifact.file_tree.files.map((file, index) => [
      `artifact.file_tree.files[${index}].path`,
      file.path,
    ]),
    ...manifest.migration.catalog.migrations.map((migration, index) => [
      `migration.catalog.migrations[${index}].path`,
      migration.path,
    ]),
  ]
  for (const [label, path] of publicPaths) {
    if (/(^|\/)(?:private|operator|secret|credential|tmp)(?:\/|$)/iu.test(path)) {
      fail(`${label} contains a private operator path`)
    }
  }

  const filePaths = manifest.artifact.file_tree.files.map((file) => file.path)
  if (new Set(filePaths).size !== filePaths.length) {
    fail('artifact.file_tree.files must not contain duplicate paths')
  }
  if (!sameJsonValue(filePaths, [...filePaths].sort())) {
    fail('artifact.file_tree.files must be ordered by public path')
  }

  const migrationIds = manifest.migration.catalog.migrations.map((migration) => migration.id)
  if (!sameJsonValue(migrationIds, ['001', '002', '003', '004', '005', '006'])) {
    fail('manifest migration.catalog.migrations must contain 001 through 006 in order')
  }

  if (manifest.d1.mode !== 'remote' || manifest.d1.evidence_class !== 'production') {
    fail('manifest d1 must be the canonical remote production binding')
  }
  if (manifest.d1.database !== 'DB'
    || manifest.d1.config_path !== PRODUCTION_D1_CANONICAL_PATHS.config_path
    || manifest.d1.reset_sql_path !== PRODUCTION_D1_CANONICAL_PATHS.reset_sql_path
    || manifest.d1.migration_runner_path !== PRODUCTION_D1_CANONICAL_PATHS.migration_runner_path
    || manifest.d1.migration_catalog_path !== PRODUCTION_D1_CANONICAL_PATHS.migration_catalog_path
    || manifest.d1.rollout_safety_path !== PRODUCTION_D1_CANONICAL_PATHS.rollout_safety_path) {
    fail('manifest d1 paths must identify the canonical production artifacts')
  }
  if (manifest.d1.account_id !== manifest.target.account_id
    || manifest.d1.d1_database_id !== manifest.target.d1_database_id
    || manifest.d1.candidate_id !== manifest.repository.commit
    || manifest.d1.wrangler_sha256 !== manifest.toolchain.wrangler.identity_sha256) {
    fail('manifest d1 identities do not match the frozen production facts')
  }
  if (manifest.d1.expected_reconciliation_format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('manifest d1 expected reconciliation format is not canonical')
  }
  if (sha256(canonicalD1ExpectedReconciliationBytes(manifest.d1.expected_reconciliation))
    !== manifest.d1.expected_reconciliation_sha256) {
    fail('manifest d1 expected reconciliation hash does not match its frozen bytes')
  }
  if (!manifest.d1.migrations.every((migration, index) => (
    migration.number === index + 1
      && migration.name === PRODUCTION_D1_MIGRATION_NAMES[index]
  ))) {
    fail('manifest d1 migrations must be the canonical checksum set')
  }

  if (manifest.target.baseline.d1_database_id !== manifest.target.d1_database_id) {
    fail('manifest target.baseline.d1_database_id must equal target.d1_database_id')
  }
  if (manifest.target.baseline.traffic.length !== 1
    || manifest.target.baseline.traffic[0].version_id !== manifest.target.baseline.version_id
    || manifest.target.baseline.traffic[0].percentage !== 100) {
    fail('manifest target.baseline.traffic must bind one 100% baseline version')
  }

  if (!sameJsonValue(manifest.policy.stages, DELIVERY_STAGE_POLICY)) {
    fail('manifest policy.stages must use the fixed Issue #23 order and timeouts')
  }
  if (!sameJsonValue(manifest.policy.drift.frozen_preconditions, CANONICAL_MANIFEST_FROZEN_PRECONDITIONS)) {
    fail('manifest policy.drift.frozen_preconditions are not canonical')
  }
  if (!sameJsonValue(manifest.policy.drift.observations, CANONICAL_MANIFEST_OBSERVATIONS)) {
    fail('manifest policy.drift.observations are not canonical')
  }
  if (!sameJsonValue(manifest.policy.evidence.excluded, CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS)) {
    fail('manifest policy.evidence.excluded is not canonical')
  }
  if (manifest.rehearsal.runtime.node_version !== manifest.toolchain.node.version) {
    fail('manifest rehearsal.runtime.node_version must equal toolchain.node.version')
  }

  return manifest
}

const CANONICAL_MANIFEST_ORDER = {
  format: null,
  preparation: {
    prepare_entry: { path: null, sha256: null },
    execute_entry: { path: null, sha256: null },
    manifest_schema: { path: null, sha256: null },
  },
  repository: { canonical: null, remote: null, commit: null, tree: null, clean: null },
  ci: {
    provider: null,
    workflow: null,
    run_id: null,
    attempt: null,
    event: null,
    head_sha: null,
    tree: null,
    conclusion: null,
  },
  toolchain: {
    node: { version: null, identity_sha256: null },
    npm: { version: null, identity_sha256: null },
    wrangler: { version: null, identity_sha256: null },
    opennextjs_cloudflare: { version: null, identity_sha256: null },
    package_json_sha256: null,
    lockfile_sha256: null,
  },
  artifact: {
    archive: { path: null, sha256: null, bytes: null },
    worker: { path: null, sha256: null, bytes: null },
    file_tree: {
      sha256: null,
      complete: null,
      files: { path: null, sha256: null, bytes: null },
    },
  },
  migration: {
    delivery_mode: null,
    reset_sql: { path: null, sha256: null },
    runner: { path: null, sha256: null },
    catalog: {
      path: null,
      sha256: null,
      migrations: { id: null, path: null, sha256: null },
    },
    historical_data_disposition: {
      production_export: null,
      double_restore: null,
      historical_baseline_queries: null,
    },
  },
  d1: {
    mode: null,
    database: null,
    config_path: null,
    config_sha256: null,
    wrangler_sha256: null,
    account_id: null,
    d1_database_id: null,
    reset_sql_path: null,
    reset_sql_sha256: null,
    migration_runner_path: null,
    migration_runner_sha256: null,
    migration_catalog_path: null,
    migration_catalog_sha256: null,
    rollout_safety_path: null,
    rollout_safety_sha256: null,
    expected_reconciliation_format: null,
    expected_reconciliation_sha256: null,
    expected_reconciliation: {
      format: null,
      schema: { sha256: null },
      migration_ledger: { state: null, row_count: null, sha256: null },
      posts: { count: null, status: 'sorted', content_sha256: null },
    },
    candidate_id: null,
    evidence_class: null,
    migrations: { number: null, name: null, checksum: null },
  },
  target: {
    account_id: null,
    d1_database_id: null,
    worker_name: null,
    origin: null,
    baseline: {
      deployment_id: null,
      version_id: null,
      d1_database_id: null,
      traffic: { version_id: null, percentage: null },
    },
  },
  policy: {
    authorization: {
      manifest_binding: null,
      one_shot: null,
      credential_slots: { name: null, scopes: 'sorted' },
    },
    stages: { name: null, timeout_seconds: null },
    overall_timeout_seconds: null,
    drift: {
      frozen_preconditions: 'sorted',
      observations: 'sorted',
      mismatch_classification: null,
    },
    evidence: {
      allowed_hash_algorithm: null,
      excluded: 'sorted',
      production_evidence: null,
      local_rehearsal_evidence: null,
    },
  },
  rehearsal: {
    runtime: { os: null, architecture: null, node_version: null },
    network: null,
    status: null,
    receipt_sha256: null,
    production_write_adapter_calls: null,
  },
}

function orderCanonicalManifestValue(value, order) {
  if (Array.isArray(value)) return value.map((item) => orderCanonicalManifestValue(item, order))
  if (!isPlainRecord(value)) return value
  if (order === 'sorted') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
  }
  const keys = isPlainRecord(order) ? Object.keys(order) : Object.keys(value)
  return Object.fromEntries(keys.map((key) => [
    key,
    orderCanonicalManifestValue(value[key], isPlainRecord(order) ? order[key] : undefined),
  ]))
}

function canonicalManifestBytes(value) {
  return canonicalJsonBytes(orderCanonicalManifestValue(value, CANONICAL_MANIFEST_ORDER))
}

function validateCanonicalManifest(value, manifestBytes) {
  validateCanonicalManifestSchema(value)
  const d1 = validateProductionD1(value)
  schemaString(d1.account_id, 'manifest d1.account_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(d1.d1_database_id, 'manifest d1.d1_database_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(d1.candidate_id, 'manifest d1.candidate_id', CANONICAL_MANIFEST_SHA40_PATTERN)
  assertCanonicalManifestRelationships(value)
  if (!Buffer.from(manifestBytes).equals(canonicalManifestBytes(value))) {
    fail('manifest bytes are not schema-canonical JSON')
  }
  return d1
}

function validateExecutionPolicy(policy) {
  if (!isPlainRecord(policy) || !sameJsonValue(policy, {
    stages: DELIVERY_STAGE_POLICY,
    overall_timeout_seconds: OVERALL_TIMEOUT_SECONDS,
  })) {
    fail('manifest policy is not canonical')
  }
  return {
    stageTimeouts: new Map(policy.stages.map(({ name, timeout_seconds }) => [
      name,
      timeout_seconds * 1000,
    ])),
    overallTimeoutMs: policy.overall_timeout_seconds * 1000,
  }
}

function isSafeClassification(value) {
  return typeof value === 'string' && SAFE_ADAPTER_CLASSIFICATIONS.includes(value)
}

function uncertainAdapterResult() {
  return {
    outcome: 'UNCERTAIN',
    classification: DEFAULT_ADAPTER_CLASSIFICATIONS.UNCERTAIN,
    duration_ms: 0,
  }
}

function normalizeSyntheticResult(result) {
  if (!isPlainRecord(result)) return uncertainAdapterResult()
  const allowedKeys = ['outcome', 'classification', 'duration_ms', 'synthetic_elapsed_ms']
  if (Reflect.ownKeys(result).some((key) => (
    typeof key !== 'string' || !allowedKeys.includes(key)
  ))) return uncertainAdapterResult()
  const outcome = Object.hasOwn(result, 'outcome') ? result.outcome : undefined
  const classification = Object.hasOwn(result, 'classification') ? result.classification : undefined
  const durationMs = Object.hasOwn(result, 'duration_ms') ? result.duration_ms : undefined
  const syntheticElapsedMs = Object.hasOwn(result, 'synthetic_elapsed_ms')
    ? result.synthetic_elapsed_ms
    : undefined
  if (!ADAPTER_OUTCOMES.includes(outcome)
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
    || (classification !== undefined && !isSafeClassification(classification))
    || (syntheticElapsedMs !== undefined
      && (!Number.isSafeInteger(syntheticElapsedMs) || syntheticElapsedMs < 0))) {
    return uncertainAdapterResult()
  }
  const normalized = {
    outcome,
    duration_ms: durationMs,
    ...(syntheticElapsedMs === undefined ? {} : { synthetic_elapsed_ms: syntheticElapsedMs }),
  }
  if (outcome === 'PASS') {
    return normalized
  }
  return {
    ...normalized,
    classification: classification ?? DEFAULT_ADAPTER_CLASSIFICATIONS[outcome],
  }
}

function validatePreparedManifest(manifest) {
  if (!isPlainRecord(manifest)) fail('manifest must be a plain record')
  assertExactKeys(manifest, ['value', 'bytes', 'sha256'], 'manifest')
  if (!isJsonValue(manifest.value) || !isPlainRecord(manifest.value)) {
    fail('manifest value must be a JSON record')
  }
  if (!(manifest.bytes instanceof Uint8Array)) fail('manifest bytes must be bytes')
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    fail('manifest identity is invalid')
  }

  const bytes = Buffer.from(manifest.bytes)
  const text = bytes.toString('utf8')
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail('manifest bytes must use canonical JSON with one LF')
  }
  let parsed
  try {
    parsed = JSON.parse(text.slice(0, -1))
  } catch {
    fail('manifest bytes must contain JSON')
  }
  if (!isPlainRecord(parsed) || !bytes.equals(canonicalJsonBytes(parsed))) {
    fail('manifest bytes are not canonical JSON')
  }
  if (!sameJsonValue(parsed, manifest.value)) fail('manifest value does not match bytes')
  if (sha256(bytes) !== manifest.sha256) fail('manifest identity does not match bytes')
  return bytes
}

function acceptAuthorization(manifestSha256, authorization) {
  if (!isPlainRecord(authorization)) fail('authorization must be a plain record')
  assertExactKeys(
    authorization,
    ['format', 'authorization_id', 'manifest_sha256', 'decision'],
    'authorization',
  )
  if (authorization.format !== AUTHORIZATION_FORMAT) fail('authorization format is invalid')
  assertSafeString(authorization.authorization_id, 'authorization_id')
  if (authorization.manifest_sha256 !== manifestSha256) fail('authorization manifest does not match')
  if (authorization.decision !== 'approve') fail('authorization decision must be approve')

  const canonicalAuthorization = {
    format: authorization.format,
    authorization_id: authorization.authorization_id,
    manifest_sha256: authorization.manifest_sha256,
    decision: authorization.decision,
  }
  const authorizationDigest = sha256(canonicalJsonBytes(canonicalAuthorization))
  if (consumedAuthorizationDigests.has(authorizationDigest)) {
    fail('authorization has already been consumed')
  }
  consumedAuthorizationDigests.add(authorizationDigest)
  return authorizationDigest
}

function stageCounts(trace) {
  const counts = Object.fromEntries(DELIVERY_STAGES.map((stage) => [stage, 0]))
  counts.authorization_accept = 1
  for (const entry of trace) counts[entry.stage] += 1
  return counts
}

function stageDurations(trace) {
  const durations = Object.fromEntries(DELIVERY_STAGES.map((stage) => [stage, 0]))
  for (const entry of trace) durations[entry.stage] += entry.duration_ms
  return durations
}

function executeLegacy(manifest, authorization) {
  if (arguments.length !== 2) fail('execute accepts exactly two arguments')
  const manifestBytes = validatePreparedManifest(manifest)
  const executionPolicy = validateExecutionPolicy(manifest.value.policy)
  const authorizationDigest = acceptAuthorization(sha256(manifestBytes), authorization)
  const identities = {
    manifest_sha256: sha256(manifestBytes),
    authorization_sha256: authorizationDigest,
  }
  const attemptId = sha256(canonicalJsonBytes({
    format: 'blogman-issue-23-attempt/v1',
    ...identities,
  }))
  const trace = []
  let elapsedMs = 0
  for (const stage of DELIVERY_STAGES.slice(1)) {
    let adapterResult
    try {
      adapterResult = runSyntheticStage(stage, manifest.value)
    } catch {
      adapterResult = { outcome: 'ERROR', classification: 'synthetic_adapter_error', duration_ms: 0 }
    }
    const result = normalizeSyntheticResult(adapterResult)
    const stageElapsedMs = elapsedMs + result.duration_ms
    let nextElapsedMs = stageElapsedMs
    let outcome = result.outcome
    let classification = result.classification
    const stageTimeoutMs = executionPolicy.stageTimeouts.get(stage)
    if (stageTimeoutMs === undefined) fail(`stage ${stage} has no policy timeout`)
    if (!Number.isSafeInteger(stageElapsedMs)) {
      outcome = 'UNCERTAIN'
      classification = 'uncertain_adapter_outcome'
      nextElapsedMs = elapsedMs
    } else if (result.synthetic_elapsed_ms !== undefined
      && result.synthetic_elapsed_ms < stageElapsedMs) {
      outcome = 'UNCERTAIN'
      classification = 'uncertain_adapter_outcome'
    } else if (result.synthetic_elapsed_ms !== undefined) {
      nextElapsedMs = result.synthetic_elapsed_ms
    }
    if (outcome === 'PASS' && result.duration_ms > stageTimeoutMs) {
      outcome = 'TIMEOUT'
      classification = 'stage_timeout'
    } else if (outcome === 'PASS' && nextElapsedMs > executionPolicy.overallTimeoutMs) {
      outcome = 'TIMEOUT'
      classification = 'overall_timeout'
    }
    elapsedMs = nextElapsedMs
    const entry = {
      stage,
      outcome,
      ...(classification ? { classification } : {}),
      duration_ms: result.duration_ms,
    }
    trace.push(entry)
    if (outcome !== 'PASS') break
  }
  const terminal = trace.at(-1)
  if (!terminal) fail('synthetic state machine did not run')
  const value = {
    format: TERMINAL_RESULT_FORMAT,
    identities,
    attempt_id: attemptId,
    authorization_consumed: true,
    outcome: terminal.outcome,
    first_terminal_stage: terminal.stage,
    failure: terminal.outcome === 'PASS'
      ? null
      : { classification: terminal.classification },
    stage_counts: stageCounts(trace),
    stage_durations_ms: stageDurations(trace),
    mutation_counts: { production_writes: 0 },
    evidence: { source: 'synthetic', hashes: [sha256(canonicalJsonBytes(trace))] },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  return { value, bytes, sha256: sha256(bytes) }
}

function canonicalD1ExpectedReconciliation(value) {
  if (!isPlainRecord(value)) fail('expected reconciliation must be a plain record')
  assertExactKeys(value, ['format', 'schema', 'migration_ledger', 'posts'], 'expected reconciliation')
  if (value.format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('expected reconciliation format is invalid')
  }
  assertExactKeys(value.schema, ['sha256'], 'expected reconciliation schema')
  if (typeof value.schema.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.schema.sha256)) {
    fail('expected reconciliation schema hash is invalid')
  }
  assertExactKeys(value.migration_ledger, ['state', 'row_count', 'sha256'], 'expected reconciliation migration ledger')
  if (!['absent', 'present'].includes(value.migration_ledger.state)
    || !Number.isSafeInteger(value.migration_ledger.row_count)
    || value.migration_ledger.row_count < 0
    || !/^[a-f0-9]{64}$/u.test(value.migration_ledger.sha256)) {
    fail('expected reconciliation migration ledger is invalid')
  }
  assertExactKeys(value.posts, ['count', 'status', 'content_sha256'], 'expected reconciliation posts')
  if (!Number.isSafeInteger(value.posts.count)
    || value.posts.count < 0
    || !isPlainRecord(value.posts.status)
    || !/^[a-f0-9]{64}$/u.test(value.posts.content_sha256)) {
    fail('expected reconciliation posts are invalid')
  }
  for (const count of Object.values(value.posts.status)) {
    if (!Number.isSafeInteger(count) || count < 0) fail('expected reconciliation post status is invalid')
  }
  return {
    format: value.format,
    schema: { sha256: value.schema.sha256 },
    migration_ledger: {
      state: value.migration_ledger.state,
      row_count: value.migration_ledger.row_count,
      sha256: value.migration_ledger.sha256,
    },
    posts: {
      count: value.posts.count,
      status: Object.fromEntries(Object.entries(value.posts.status).sort()),
      content_sha256: value.posts.content_sha256,
    },
  }
}

function canonicalD1ExpectedReconciliationBytes(value) {
  return canonicalJsonBytes(canonicalD1ExpectedReconciliation(value))
}

function validateProductionD1(manifestValue) {
  if (!isPlainRecord(manifestValue) || !isPlainRecord(manifestValue.d1)) {
    fail('production manifest requires a derived d1 block')
  }
  const d1 = manifestValue.d1
  assertExactKeys(d1, [
    'mode',
    'database',
    'config_path',
    'config_sha256',
    'wrangler_sha256',
    'account_id',
    'd1_database_id',
    'reset_sql_path',
    'reset_sql_sha256',
    'migration_runner_path',
    'migration_runner_sha256',
    'migration_catalog_path',
    'migration_catalog_sha256',
    'rollout_safety_path',
    'rollout_safety_sha256',
    'expected_reconciliation_format',
    'expected_reconciliation_sha256',
    'expected_reconciliation',
    'candidate_id',
    'evidence_class',
    'migrations',
  ], 'd1')
  if (d1.mode !== 'remote' || d1.evidence_class !== 'production') {
    fail('production execute requires remote production d1 facts')
  }
  if (d1.database !== 'DB') fail('production d1 database is not canonical')
  for (const [field, expected] of Object.entries(PRODUCTION_D1_CANONICAL_PATHS)) {
    if (d1[field] !== expected) fail(`production d1 ${field} is not canonical`)
  }
  for (const field of ['config_path', 'reset_sql_path', 'migration_runner_path', 'migration_catalog_path', 'rollout_safety_path']) {
    assertSafeString(d1[field], `d1.${field}`)
  }
  for (const field of [
    'config_sha256',
    'wrangler_sha256',
    'reset_sql_sha256',
    'migration_runner_sha256',
    'migration_catalog_sha256',
    'rollout_safety_sha256',
    'expected_reconciliation_sha256',
  ]) {
    if (typeof d1[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(d1[field])) {
      fail(`d1.${field} is not a SHA-256 identity`)
    }
  }
  for (const field of ['account_id', 'd1_database_id', 'candidate_id']) {
    assertSafeString(d1[field], `d1.${field}`)
  }
  if (!/^[a-f0-9]{40}$/u.test(d1.candidate_id)) fail('d1.candidate_id is invalid')
  if (d1.expected_reconciliation_format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('expected reconciliation format is invalid')
  }
  const expectedReconciliation = canonicalD1ExpectedReconciliation(d1.expected_reconciliation)
  if (sha256(canonicalD1ExpectedReconciliationBytes(expectedReconciliation)) !== d1.expected_reconciliation_sha256) {
    fail('expected reconciliation hash does not match frozen bytes')
  }
  if (!Array.isArray(d1.migrations) || d1.migrations.length !== PRODUCTION_D1_MIGRATION_NAMES.length) {
    fail('d1 migrations are invalid')
  }
  for (const [index, migration] of d1.migrations.entries()) {
    assertExactKeys(migration, ['number', 'name', 'checksum'], `d1 migration ${index + 1}`)
    if (migration.number !== index + 1
      || migration.name !== PRODUCTION_D1_MIGRATION_NAMES[index]
      || typeof migration.checksum !== 'string'
      || !/^[a-f0-9]{64}$/u.test(migration.checksum)) {
      fail(`d1 migration ${index + 1} is not canonical`)
    }
  }
  if (isPlainRecord(manifestValue.repository)
    && Object.hasOwn(manifestValue.repository, 'commit')
    && manifestValue.repository.commit !== d1.candidate_id) {
    fail('d1 candidate does not match repository commit')
  }
  if (isPlainRecord(manifestValue.target)
    && (manifestValue.target.account_id !== d1.account_id
      || manifestValue.target.d1_database_id !== d1.d1_database_id)) {
    fail('d1 identities do not match target facts')
  }
  return { ...d1, expected_reconciliation: expectedReconciliation }
}

function materializeExpectedReconciliation(d1) {
  const bytes = canonicalD1ExpectedReconciliationBytes(d1.expected_reconciliation)
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-23-execute-expected-')))
  chmodSync(directory, 0o700)
  const path = join(directory, 'expected-reconciliation.json')
  try {
    writeFileSync(path, bytes, { mode: 0o600 })
    chmodSync(path, 0o600)
    return { directory, path }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function disposeExpectedReconciliation(materialized) {
  if (!materialized) return { created: false, cleaned: true, observed_absent: true }
  let cleaned = false
  let observedAbsent = false
  try {
    rmSync(materialized.directory, { recursive: true, force: true })
    cleaned = !existsSync(materialized.directory)
    observedAbsent = cleaned && !existsSync(materialized.path)
  } catch {
    cleaned = false
    observedAbsent = false
  }
  return { created: true, cleaned, observed_absent: observedAbsent }
}

function deriveProductionD1Bindings(d1, expectedPath) {
  const bindings = { ...d1 }
  delete bindings.expected_reconciliation_format
  delete bindings.expected_reconciliation
  bindings.config_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.config_path))
  bindings.reset_sql_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.reset_sql_path))
  bindings.migration_runner_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.migration_runner_path))
  bindings.migration_catalog_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.migration_catalog_path))
  bindings.rollout_safety_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.rollout_safety_path))
  bindings.expected_reconciliation_path = expectedPath
  return bindings
}

function sanitizedD1Error(classification) {
  const stageCounts = Object.fromEntries(PRODUCTION_D1_STAGES.map((stage) => [stage, 0]))
  const stageDurations = Object.fromEntries(PRODUCTION_D1_STAGES.map((stage) => [stage, 0]))
  stageCounts.d1_identity = 1
  const value = {
    format: 'blogman-issue-23-d1-stages/v1',
    outcome: 'ERROR',
    first_terminal_stage: 'd1_identity',
    failure: { classification },
    stage_counts: stageCounts,
    stage_durations_ms: stageDurations,
    evidence: { source: 'production', production: true, promotable: false },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  return { value, bytes, sha256: sha256(bytes) }
}

function normalizeProductionD1Result(result) {
  if (!isPlainRecord(result) || !isPlainRecord(result.value)
    || !(result.bytes instanceof Uint8Array)
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)
    || sha256(Buffer.from(result.bytes)) !== result.sha256) {
    return sanitizedD1Error('production_d1_result_malformed')
  }
  const value = result.value
  if (value.format !== 'blogman-issue-23-d1-stages/v1'
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || !isPlainRecord(value.stage_counts)
    || !isPlainRecord(value.stage_durations_ms)
    || !isPlainRecord(value.evidence)
    || value.evidence.source !== 'production'
    || value.evidence.production !== true) {
    return sanitizedD1Error('production_d1_result_malformed')
  }
  const countKeys = Reflect.ownKeys(value.stage_counts)
  const durationKeys = Reflect.ownKeys(value.stage_durations_ms)
  if (countKeys.length !== PRODUCTION_D1_STAGES.length
    || durationKeys.length !== PRODUCTION_D1_STAGES.length
    || PRODUCTION_D1_STAGES.some((stage) => !countKeys.includes(stage) || !durationKeys.includes(stage))) {
    return sanitizedD1Error('production_d1_result_malformed')
  }
  for (const stage of PRODUCTION_D1_STAGES) {
    if (!Number.isSafeInteger(value.stage_counts[stage])
      || ![0, 1].includes(value.stage_counts[stage])
      || !Number.isSafeInteger(value.stage_durations_ms[stage])
      || value.stage_durations_ms[stage] < 0) {
      return sanitizedD1Error('production_d1_result_malformed')
    }
  }
  if (value.outcome === 'PASS') {
    if (value.first_terminal_stage !== null
      || value.failure !== null
      || PRODUCTION_D1_STAGES.some((stage) => value.stage_counts[stage] !== 1)) {
      return sanitizedD1Error('production_d1_result_malformed')
    }
    return {
      outcome: 'PASS',
      first_terminal_stage: null,
      failure: null,
      stage_counts: { ...value.stage_counts },
      stage_durations_ms: { ...value.stage_durations_ms },
      sha256: result.sha256,
    }
  }
  if (typeof value.first_terminal_stage !== 'string'
    || !PRODUCTION_D1_STAGES.includes(value.first_terminal_stage)
    || !isPlainRecord(value.failure)
    || typeof value.failure.classification !== 'string'
    || !PRODUCTION_D1_STAGES.every((stage, index) => (
      value.stage_counts[stage] === (index <= PRODUCTION_D1_STAGES.indexOf(value.first_terminal_stage) ? 1 : 0)
    ))) {
    return sanitizedD1Error('production_d1_result_malformed')
  }
  return {
    outcome: value.outcome,
    first_terminal_stage: value.first_terminal_stage,
    failure: { classification: value.failure.classification },
    stage_counts: { ...value.stage_counts },
    stage_durations_ms: { ...value.stage_durations_ms },
    sha256: result.sha256,
  }
}

function productionTrace(d1Result) {
  const trace = [{ stage: 'live_preconditions', outcome: 'PASS', duration_ms: 0 }]
  for (const stage of PRODUCTION_D1_STAGES) {
    if (d1Result.stage_counts[stage] === 0) break
    const terminal = d1Result.outcome !== 'PASS' && stage === d1Result.first_terminal_stage
    trace.push({
      stage,
      outcome: terminal ? d1Result.outcome : 'PASS',
      ...(terminal ? { classification: d1Result.failure.classification } : {}),
      duration_ms: d1Result.stage_durations_ms[stage],
    })
    if (terminal) break
  }
  if (d1Result.outcome === 'PASS') {
    trace.push({
      stage: 'worker_deploy',
      outcome: 'ERROR',
      classification: PRODUCTION_SUFFIX_UNAVAILABLE,
      duration_ms: 0,
    })
  }
  return trace
}

function executeProduction(manifest, authorization) {
  const manifestBytes = validatePreparedManifest(manifest)
  const d1 = validateCanonicalManifest(manifest.value, manifestBytes)
  const authorizationDigest = acceptAuthorization(sha256(manifestBytes), authorization)
  const identities = {
    manifest_sha256: sha256(manifestBytes),
    authorization_sha256: authorizationDigest,
  }
  const attemptId = sha256(canonicalJsonBytes({
    format: 'blogman-issue-23-attempt/v1',
    ...identities,
  }))
  let materialized
  let d1Result
  let cleanup = { created: false, cleaned: true, observed_absent: true }
  try {
    materialized = materializeExpectedReconciliation(d1)
    const bindings = deriveProductionD1Bindings(d1, materialized.path)
    try {
      const transport = createD1Transport(bindings)
      d1Result = normalizeProductionD1Result(runD1Stages({ bindings, transport }))
    } catch {
      d1Result = sanitizedD1Error('production_d1_adapter_error')
    }
  } finally {
    cleanup = disposeExpectedReconciliation(materialized)
  }
  if (!d1Result) d1Result = sanitizedD1Error('production_d1_adapter_error')
  const trace = productionTrace(d1Result)
  const terminal = trace.at(-1)
  if (!terminal) fail('production state machine did not run')
  const value = {
    format: TERMINAL_RESULT_FORMAT,
    identities,
    attempt_id: attemptId,
    authorization_consumed: true,
    outcome: terminal.outcome,
    first_terminal_stage: terminal.stage,
    failure: terminal.outcome === 'PASS' ? null : { classification: terminal.classification },
    stage_counts: stageCounts(trace),
    stage_durations_ms: stageDurations(trace),
    mutation_counts: { production_writes: 0 },
    evidence: {
      source: 'production',
      production: true,
      promotable: false,
      hashes: [d1Result.sha256],
      cleanup,
    },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  return { value, bytes, sha256: sha256(bytes) }
}

export function execute(manifest, authorization) {
  if (arguments.length !== 2) fail('execute accepts exactly two arguments')
  return executeProduction(manifest, authorization)
}

export function executeSyntheticForTest(manifest, authorization) {
  if (arguments.length !== 2) fail('executeSyntheticForTest accepts exactly two arguments')
  return executeLegacy(manifest, authorization)
}
