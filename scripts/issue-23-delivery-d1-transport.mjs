import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  D1_CANONICAL_MIGRATION_NAMES,
  D1_STAGE_TIMEOUT_MS,
  d1StageBindingsSha256,
  hashD1ArtifactDirectory,
  identityDurationMs,
  parseRemoteD1InfoResponse,
  parseStrictJson,
  parseWranglerWhoamiResponse,
} from './issue-23-delivery-d1-contracts.mjs'
import { D1ChildError, runBoundedChild } from './issue-23-delivery-d1-child.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerPath = realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))

const canonicalPaths = Object.freeze({
  reset: join(repoRoot, 'db', 'issue-23-clean-start-reset.sql'),
  runner: join(repoRoot, 'scripts', 'migrations.mjs'),
  catalog: join(repoRoot, 'db', 'ledger-migrations'),
  rolloutSafety: join(repoRoot, 'scripts', 'rollout-safety.mjs'),
})

export const D1_TRANSPORT_TIMEOUT_MS = 300_000
export const D1_TRANSPORT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const D1_TRANSPORT_FAILURE_CLASSIFICATIONS = Object.freeze({
  TIMEOUT: 'timeout',
  OVERALL_TIMEOUT: 'overall_timeout',
  NONZERO: 'nonzero',
  MALFORMED: 'malformed',
  MANIFEST_DRIFT: 'manifest_drift',
  PERMISSION: 'permission_insufficient',
  UNCERTAIN: 'uncertain',
})

const TRANSPORT_CONFIG_KEYS = Object.freeze([
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
  'expected_reconciliation_path',
  'expected_reconciliation_sha256',
  'manifest_sha256',
  'authorization_sha256',
  'attempt_id',
  'candidate_id',
  'evidence_class',
  'migrations',
])
const OPERATION_STAGES = Object.freeze({
  d1_identity: 'd1_identity',
  clean_start_reset: 'clean_start_reset',
  empty_d1_proof: 'empty_d1_proof',
  migration_catalog: 'migrations_001_006',
  migration_plan: 'migrations_001_006',
  migration_apply: 'migrations_001_006',
  migration_verify: 'migrations_001_006',
  reconciliation: 'reconciliation',
})
const EMPTY_OBJECT_QUERY = `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT GLOB 'sqlite_*'
  AND NOT (
    type = 'table'
    AND (name, tbl_name) IN (('_cf_KV', '_cf_KV'), ('_cf_METADATA', '_cf_METADATA'))
  )
ORDER BY type, name, tbl_name, sql
`.trim()
const IDENTITY_QUERY = 'SELECT 1 AS __blogman_d1_identity_probe'
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/u
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/u
const EXPECTED_RECONCILIATION_FORMAT = 'blogman-d1-reconciliation/v1'
export class D1TransportError extends Error {
  constructor(classification, durationMs = 0) {
    super(`D1 transport ${classification}`)
    this.name = 'D1TransportError'
    this.classification = classification
    this.durationMs = Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0
  }
}

function fail(message) {
  throw new Error(`D1 transport: ${message}`)
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertExactKeys(value, keys, label) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`)
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

// Issue #150: Wrangler response envelopes and their meta objects may carry
// upstream-added harmless keys; only the frozen semantic keys are required.
function assertRequiredKeys(value, keys, label) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`)
  if (keys.some((key) => !Reflect.ownKeys(value).includes(key))) {
    fail(`${label} is missing required fields`)
  }
}

function assertSafeToken(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !SAFE_TOKEN.test(value)) {
    fail(`${label} is invalid`)
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string'
    || !isAbsolute(value)
    || resolve(value) !== value
    || !SAFE_ABSOLUTE_PATH.test(value)
    || /(^|\/)\.\.?($|\/)/u.test(value)) {
    fail(`${label} must be an absolute normalized path`)
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} is invalid`)
}

function effectiveUid() {
  if (typeof process.geteuid !== 'function') fail('cannot verify artifact owner')
  return process.geteuid()
}

function assertSafeFilesystemEntry(path, type, label) {
  assertAbsolutePath(path, label)
  let metadata
  try {
    metadata = lstatSync(path)
  } catch {
    fail(`${label} is missing`)
  }
  if (metadata.isSymbolicLink()) fail(`${label} must not be a symlink`)
  if (type === 'file' && !metadata.isFile()) fail(`${label} must be a regular file`)
  if (type === 'directory' && !metadata.isDirectory()) fail(`${label} must be a directory`)
  if (metadata.uid !== effectiveUid()) fail(`${label} has an unsafe owner`)
  if ((metadata.mode & 0o022) !== 0) fail(`${label} has unsafe write permissions`)
  if (type === 'file' && metadata.nlink !== 1) fail(`${label} has unsafe link count`)
  try {
    if (realpathSync(path) !== path) fail(`${label} must have a canonical realpath`)
  } catch {
    fail(`${label} has no canonical realpath`)
  }
  return metadata
}

function assertCanonicalPath(path, canonicalPath, label) {
  assertAbsolutePath(path, label)
  if (path !== canonicalPath) fail(`${label} must be the canonical path`)
  return assertSafeFilesystemEntry(path, 'file', label)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}


function validateExpectedReconciliation(path) {
  const bytes = readFileSync(path)
  if (bytes.length > D1_TRANSPORT_MAX_OUTPUT_BYTES) fail('expected reconciliation is too large')
  let value
  try {
    value = parseStrictJson(bytes.toString('utf8'))
  } catch {
    fail('expected reconciliation is not JSON')
  }
  assertExactKeys(value, ['format', 'migration_ledger', 'posts', 'schema'], 'expected reconciliation')
  if (value.format !== EXPECTED_RECONCILIATION_FORMAT) fail('expected reconciliation format is invalid')
  assertExactKeys(value.schema, ['sha256'], 'expected reconciliation schema')
  assertHash(value.schema.sha256, 'expected reconciliation schema hash')
  assertExactKeys(value.migration_ledger, ['row_count', 'sha256', 'state'], 'expected migration ledger')
  if (!Number.isSafeInteger(value.migration_ledger.row_count) || value.migration_ledger.row_count < 0
    || !['absent', 'present'].includes(value.migration_ledger.state)) {
    fail('expected migration ledger is invalid')
  }
  assertHash(value.migration_ledger.sha256, 'expected migration ledger hash')
  assertExactKeys(value.posts, ['content_sha256', 'count', 'status'], 'expected posts')
  if (!Number.isSafeInteger(value.posts.count) || value.posts.count < 0 || !isPlainRecord(value.posts.status)) {
    fail('expected posts are invalid')
  }
  assertHash(value.posts.content_sha256, 'expected post content hash')
  for (const count of Object.values(value.posts.status)) {
    if (!Number.isSafeInteger(count) || count < 0) fail('expected post status is invalid')
  }
}

function validateConfig(config) {
  if (!isPlainRecord(config)) fail('config must be an object')
  const expectedKeys = config.mode === 'local'
    ? [...TRANSPORT_CONFIG_KEYS, 'persist_path']
    : TRANSPORT_CONFIG_KEYS
  assertExactKeys(config, expectedKeys, 'config')
  if (config.mode !== 'local' && config.mode !== 'remote') fail('config mode must be local or remote')
  assertSafeToken(config.database, 'database')
  assertAbsolutePath(config.config_path, 'config_path')
  if (config.mode === 'local') assertAbsolutePath(config.persist_path, 'persist_path')
  for (const field of ['account_id', 'd1_database_id', 'candidate_id']) {
    assertSafeToken(config[field], field)
  }
  for (const field of [
    'config_sha256',
    'wrangler_sha256',
    'reset_sql_sha256',
    'migration_runner_sha256',
    'migration_catalog_sha256',
    'rollout_safety_sha256',
    'expected_reconciliation_sha256',
  ]) assertHash(config[field], field)
  if (![
    'production',
    'local-non-production',
    'test-non-production',
    'synthetic-non-production',
    'formal-rehearsal-test-evidence',
  ].includes(config.evidence_class)) {
    fail('evidence_class is invalid')
  }
  const attemptBound = ['production', 'formal-rehearsal-test-evidence'].includes(config.evidence_class)
  for (const field of ['manifest_sha256', 'authorization_sha256', 'attempt_id']) {
    if (attemptBound || config[field] !== null) assertHash(config[field], field)
  }
  if (config.mode === 'remote'
    && !attemptBound) {
    fail('remote transport requires production evidence')
  }
  if (!Array.isArray(config.migrations) || config.migrations.length !== 6) {
    fail('migrations must contain exactly six entries')
  }
  for (const [index, migration] of config.migrations.entries()) {
    assertExactKeys(migration, ['checksum', 'name', 'number'], `migrations[${index}]`)
    if (migration.number !== index + 1 || migration.name !== D1_CANONICAL_MIGRATION_NAMES[index]
      || !/^[a-f0-9]{64}$/u.test(migration.checksum)) {
      fail(`migrations[${index}] is invalid`)
    }
  }
  return Object.freeze({ ...config })
}

function assertOutsideRepository(path, label) {
  const pathFromRepository = relative(repoRoot, path)
  if (pathFromRepository === ''
    || (pathFromRepository !== '..' && !pathFromRepository.startsWith('../'))) {
    fail(`${label} must be outside the repository`)
  }
}

function assertPrivatePersistDirectory(path) {
  const metadata = assertSafeFilesystemEntry(path, 'directory', 'local D1 persist path')
  if ((metadata.mode & 0o777) !== 0o700) {
    fail('local D1 persist path must have mode 0700')
  }
  assertOutsideRepository(path, 'local D1 persist path')
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    realpath: realpathSync(path),
  })
}

function assertPersistIdentity(path, expectedIdentity) {
  const actualIdentity = assertPrivatePersistDirectory(path)
  if (actualIdentity.dev !== expectedIdentity.dev
    || actualIdentity.ino !== expectedIdentity.ino
    || actualIdentity.realpath !== expectedIdentity.realpath) {
    fail('local D1 persist path identity drifted')
  }
  return actualIdentity
}

function validateBoundArtifactsOrThrow(config, expectedIdentity = null, classification = D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED) {
  try {
    return validateBoundArtifacts(config, expectedIdentity)
  } catch {
    throw new D1TransportError(classification)
  }
}

function boundIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o777,
    size: metadata.size,
  })
}

function validateBoundArtifacts(config, expectedIdentity = null) {
  const artifacts = {}
  artifacts.wrangler = boundIdentity(assertSafeFilesystemEntry(wranglerPath, 'file', 'Wrangler executable'))
  if (sha256(readFileSync(wranglerPath)) !== config.wrangler_sha256) {
    fail('Wrangler executable hash drifted')
  }
  artifacts.config = boundIdentity(assertSafeFilesystemEntry(config.config_path, 'file', 'bound Wrangler config'))
  if (sha256(readFileSync(config.config_path)) !== config.config_sha256) {
    fail('bound Wrangler config hash drifted')
  }
  artifacts.reset = boundIdentity(assertCanonicalPath(config.reset_sql_path, canonicalPaths.reset, 'bound reset SQL'))
  if (sha256(readFileSync(config.reset_sql_path)) !== config.reset_sql_sha256) {
    fail('bound reset SQL hash drifted')
  }
  artifacts.runner = boundIdentity(assertCanonicalPath(config.migration_runner_path, canonicalPaths.runner, 'bound migration runner'))
  if (sha256(readFileSync(config.migration_runner_path)) !== config.migration_runner_sha256) {
    fail('bound migration runner hash drifted')
  }
  assertAbsolutePath(config.migration_catalog_path, 'bound migration catalog')
  if (config.migration_catalog_path !== canonicalPaths.catalog) {
    fail('bound migration catalog must be canonical')
  }
  artifacts.catalog = boundIdentity(assertSafeFilesystemEntry(
    config.migration_catalog_path,
    'directory',
    'bound migration catalog',
  ))
  if (hashD1ArtifactDirectory(config.migration_catalog_path) !== config.migration_catalog_sha256) {
    fail('bound migration catalog hash drifted')
  }
  artifacts.rolloutSafety = boundIdentity(assertCanonicalPath(config.rollout_safety_path, canonicalPaths.rolloutSafety, 'bound rollout safety'))
  if (sha256(readFileSync(config.rollout_safety_path)) !== config.rollout_safety_sha256) {
    fail('bound rollout safety hash drifted')
  }
  artifacts.expectedReconciliation = boundIdentity(assertSafeFilesystemEntry(
    config.expected_reconciliation_path,
    'file',
    'bound expected reconciliation',
  ))
  if (sha256(readFileSync(config.expected_reconciliation_path)) !== config.expected_reconciliation_sha256) {
    fail('bound expected reconciliation hash drifted')
  }
  validateExpectedReconciliation(config.expected_reconciliation_path)
  const persist = config.mode === 'local'
    ? expectedIdentity === null
      ? assertPrivatePersistDirectory(config.persist_path)
      : assertPersistIdentity(config.persist_path, expectedIdentity.persist)
    : null
  if (expectedIdentity !== null
    && JSON.stringify(artifacts) !== JSON.stringify(expectedIdentity.artifacts)) {
    fail('bound artifact identity drifted')
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts), persist })
}

function validateRequest(request) {
  assertExactKeys(request, ['elapsed_ms', 'overall_elapsed_ms', 'operation', 'stage', 'timeout_ms'], 'request')
  if (!Object.hasOwn(OPERATION_STAGES, request.operation)) fail('request operation is invalid')
  if (OPERATION_STAGES[request.operation] !== request.stage) fail('request stage is invalid')
  if (request.timeout_ms !== D1_STAGE_TIMEOUT_MS[request.stage]) fail('request timeout is not frozen')
  if (!Number.isSafeInteger(request.elapsed_ms) || request.elapsed_ms < 0
    || request.elapsed_ms >= request.timeout_ms
    || !Number.isSafeInteger(request.overall_elapsed_ms) || request.overall_elapsed_ms < 0
    || request.overall_elapsed_ms >= 5_400_000) {
    fail('request elapsed time is invalid')
  }
  return Object.freeze({
    operation: request.operation,
    stage: request.stage,
    timeout_ms: request.timeout_ms,
    elapsed_ms: request.elapsed_ms,
    overall_elapsed_ms: request.overall_elapsed_ms,
  })
}

function deadlineBudget(request, spentMs = 0, actualOverallElapsedMs = request.overall_elapsed_ms + spentMs) {
  const overallElapsedMs = Math.max(request.overall_elapsed_ms + spentMs, actualOverallElapsedMs)
  const stageStartedMs = request.overall_elapsed_ms - request.elapsed_ms
  const stageElapsedMs = overallElapsedMs - stageStartedMs
  const overallRemainingMs = 5_400_000 - overallElapsedMs
  const stageRemainingMs = request.timeout_ms - stageElapsedMs
  if (overallRemainingMs <= 0) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.OVERALL_TIMEOUT, stageElapsedMs)
  }
  if (stageRemainingMs <= 0) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT, stageElapsedMs)
  }
  return Object.freeze({
    timeout_ms: Math.min(stageRemainingMs, overallRemainingMs),
    timeout_classification: overallRemainingMs <= stageRemainingMs
      ? D1_TRANSPORT_FAILURE_CLASSIFICATIONS.OVERALL_TIMEOUT
      : D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT,
  })
}

function remainingTimeout(request, spentMs = 0) {
  return deadlineBudget(request, spentMs).timeout_ms
}

function d1Arguments(config, suffix) {
  const args = ['d1', 'execute', config.database, config.mode === 'local' ? '--local' : '--remote']
  if (config.mode === 'local') args.push('--persist-to', config.persist_path)
  args.push('--config', config.config_path, ...suffix, '--json')
  return args
}

function buildD1Command(config, request) {
  const normalized = validateConfig(config)
  const normalizedRequest = validateRequest(request)
  const timeoutMs = remainingTimeout(normalizedRequest)
  let args
  if (normalizedRequest.operation === 'd1_identity') {
    args = normalized.mode === 'local'
      ? d1Arguments(normalized, ['--command', IDENTITY_QUERY])
      : ['d1', 'info', normalized.database, '--config', normalized.config_path, '--json']
  } else if (normalizedRequest.operation === 'empty_d1_proof') {
    args = d1Arguments(normalized, ['--command', EMPTY_OBJECT_QUERY])
  } else if (normalizedRequest.operation === 'clean_start_reset') {
    args = d1Arguments(normalized, ['--file', normalized.reset_sql_path])
  } else {
    fail(`operation ${normalizedRequest.operation} is not a Wrangler D1 operation`)
  }
  return Object.freeze({
    executable: wranglerPath,
    args: Object.freeze(args),
    timeout_ms: timeoutMs,
    options: Object.freeze({
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      stdio: Object.freeze(['ignore', 'pipe', 'pipe']),
    }),
  })
}

function runBounded(
  executable,
  args,
  timeoutMs,
  environment = process.env,
  timeoutClassification = D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT,
) {
  try {
    return runBoundedChild(executable, args, timeoutMs, D1_TRANSPORT_MAX_OUTPUT_BYTES, repoRoot, environment)
  } catch (error) {
    if (error instanceof D1ChildError) {
      throw new D1TransportError(
        error.classification === D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT
          ? timeoutClassification
          : error.classification,
        error.durationMs,
      )
    }
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
}

function parseLocalIdentity(stdout) {
  try {
    const response = parseStrictJson(stdout)
    if (!Array.isArray(response) || response.length !== 1 || !isPlainRecord(response[0])) {
      throw new Error('invalid identity response')
    }
    const envelope = response[0]
    // Issue #150: the envelope and its meta tolerate upstream-added keys; the
    // local duration statistic may also be fractional.
    assertRequiredKeys(envelope, ['meta', 'results', 'success'], 'D1 identity response')
    assertRequiredKeys(envelope.meta, ['duration'], 'D1 identity metadata')
    if (envelope.success !== true
      || typeof envelope.meta.duration !== 'number' || !Number.isFinite(envelope.meta.duration)
      || envelope.meta.duration < 0
      || !Array.isArray(envelope.results) || envelope.results.length !== 1) {
      throw new Error('invalid identity response')
    }
    const row = envelope.results[0]
    assertExactKeys(row, ['__blogman_d1_identity_probe'], 'D1 identity probe')
    if (row.__blogman_d1_identity_probe !== 1) throw new Error('invalid identity probe')
  } catch {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
}

function parseRemoteIdentity(stdout, expectedDatabaseId) {
  try {
    parseRemoteD1InfoResponse(stdout, expectedDatabaseId)
  } catch (error) {
    throw new D1TransportError(error?.code === 'DELIVERY_DATABASE_MISMATCH'
      ? D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT
      : D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
}

function parseRemoteWhoami(stdout, expectedAccountId) {
  try {
    parseWranglerWhoamiResponse(stdout, expectedAccountId)
  } catch (error) {
    const classification = error?.code === 'DELIVERY_PERMISSION_INSUFFICIENT'
      ? D1_TRANSPORT_FAILURE_CLASSIFICATIONS.PERMISSION
      : error?.code === 'DELIVERY_ACCOUNT_MISMATCH'
        ? D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT
        : D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED
    throw new D1TransportError(classification)
  }
}

function identityResponse(config, infoCommand, whoamiCommand = null) {
  let durationMs
  try {
    durationMs = identityDurationMs(infoCommand, whoamiCommand, config.mode === 'remote')
  } catch (error) {
    throw new D1TransportError(
      error.classification ?? D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN,
      error.durationMs,
    )
  }
  try {
    if (config.mode === 'local') parseLocalIdentity(infoCommand.stdout)
    else {
      parseRemoteIdentity(infoCommand.stdout, config.d1_database_id)
      parseRemoteWhoami(whoamiCommand.stdout, config.account_id)
    }
  } catch (error) {
    if (error instanceof D1TransportError) {
      throw new D1TransportError(error.classification, durationMs)
    }
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED, durationMs)
  }
  return {
    status: 0,
    stdout: JSON.stringify({
      account_id: config.account_id,
      config_sha256: config.config_sha256,
      d1_database_id: config.d1_database_id,
    }),
    stderr: '',
    duration_ms: durationMs,
  }
}

function canonicalRunnerCommand(config, operation) {
  const args = [config.migration_runner_path, operation]
  if (operation === 'catalog') {
    args.push('--migrations-dir', config.migration_catalog_path)
  } else {
    args.push('--database', config.database, config.mode === 'local' ? '--local' : '--remote')
    if (config.mode === 'local') args.push('--persist-to', config.persist_path)
    args.push('--config', config.config_path, '--migrations-dir', config.migration_catalog_path)
    if (operation === 'apply') args.push('--candidate', config.candidate_id)
  }
  return args
}

function buildRemoteWhoamiCommand(config) {
  return [
    'whoami',
    '--account',
    config.account_id,
    '--config',
    config.config_path,
    '--json',
  ]
}

function rolloutSafetyCommand(config) {
  const args = [
    config.rollout_safety_path,
    'reconcile',
    'compare',
    '--expected',
    config.expected_reconciliation_path,
    '--database',
    config.database,
    config.mode === 'local' ? '--local' : '--remote',
  ]
  if (config.mode === 'local') args.push('--persist-to', config.persist_path)
  args.push('--config', config.config_path)
  return args
}

export { hashD1ArtifactDirectory }

export const D1_COMMAND_CONTRACT = Object.freeze({
  repoRoot,
  wranglerPath,
  fail,
  validateConfig,
  validateBoundArtifactsOrThrow,
  deadlineBudget,
  validateRequest,
  buildD1Command,
  buildRemoteWhoamiCommand,
  identityResponse,
  canonicalRunnerCommand,
  rolloutSafetyCommand,
})

function createLocalD1TransportImplementation(config, childEnvironment, monotonicMs) {
  if (arguments.length < 1 || arguments.length > 3
    || (childEnvironment !== undefined && Object.getPrototypeOf(childEnvironment) !== null)
    || (monotonicMs !== undefined && typeof monotonicMs !== 'function')) {
    fail('local transport rejects unsupported adapter overrides')
  }
  const privateEnvironment = childEnvironment ?? process.env
  const normalizedConfig = validateConfig(config)
  const frozenBoundIdentity = validateBoundArtifactsOrThrow(normalizedConfig)
  const bindingsSha256 = d1StageBindingsSha256(normalizedConfig)

  function budgetFor(request, spentMs = 0) {
    let actualOverallElapsedMs = request.overall_elapsed_ms + spentMs
    if (monotonicMs !== undefined) {
      const measured = monotonicMs()
      if (!Number.isSafeInteger(measured) || measured < 0) fail('internal monotonic clock is invalid')
      actualOverallElapsedMs = Math.max(actualOverallElapsedMs, measured)
    }
    return deadlineBudget(request, spentMs, actualOverallElapsedMs)
  }

  function runRequestBounded(executable, args, request, spentMs = 0) {
    const budget = budgetFor(request, spentMs)
    return runBounded(
      executable,
      args,
      budget.timeout_ms,
      privateEnvironment,
      budget.timeout_classification,
    )
  }

  function execute(request) {
    if (arguments.length !== 1) fail('execute accepts exactly one request argument')
    const normalizedRequest = validateRequest(request)
    validateBoundArtifactsOrThrow(
      normalizedConfig,
      frozenBoundIdentity,
      D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT,
    )
    if (normalizedRequest.operation === 'd1_identity'
      || normalizedRequest.operation === 'clean_start_reset'
      || normalizedRequest.operation === 'empty_d1_proof') {
      const command = buildD1Command(normalizedConfig, normalizedRequest)
      if (normalizedRequest.operation !== 'd1_identity') {
        return runRequestBounded(command.executable, command.args, normalizedRequest)
      }
      const infoCommand = runRequestBounded(command.executable, command.args, normalizedRequest)
      if (infoCommand.stderr !== '') return identityResponse(normalizedConfig, infoCommand)
      if (normalizedConfig.mode === 'local') return identityResponse(normalizedConfig, infoCommand)
      let whoamiCommand
      try {
        whoamiCommand = runRequestBounded(
          wranglerPath,
          buildRemoteWhoamiCommand(normalizedConfig),
          normalizedRequest,
          infoCommand.duration_ms,
        )
      } catch (error) {
        if (error instanceof D1TransportError) {
          throw new D1TransportError(
            error.classification,
            infoCommand.duration_ms + error.durationMs,
          )
        }
        throw error
      }
      return identityResponse(normalizedConfig, infoCommand, whoamiCommand)
    }
    if (normalizedRequest.operation === 'migration_catalog') {
      return runRequestBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'catalog'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'migration_plan') {
      return runRequestBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'plan'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'migration_apply') {
      return runRequestBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'apply'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'migration_verify') {
      return runRequestBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'verify'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'reconciliation') {
      return runRequestBounded(process.execPath, rolloutSafetyCommand(normalizedConfig), normalizedRequest)
    }
    fail('operation is not supported')
  }

  return Object.freeze({
    execute,
    bindings_sha256: bindingsSha256,
  })
}

export function createLocalD1Transport(config, childEnvironment, monotonicMs) {
  if (config?.mode !== 'local'
    || !['local-non-production', 'test-non-production', 'synthetic-non-production'].includes(config.evidence_class)) {
    fail('local transport requires structurally nonproduction local evidence')
  }
  return createLocalD1TransportImplementation(config, childEnvironment, monotonicMs)
}

const REHEARSAL_D1_STAGE_BY_OPERATION = Object.freeze({
  d1_identity: 'd1_identity',
  clean_start_reset: 'clean_start_reset',
  empty_d1_proof: 'empty_d1_proof',
  migration_catalog: 'migrations_001_006',
  migration_plan: 'migrations_001_006',
  migration_apply: 'migrations_001_006',
  migration_verify: 'migrations_001_006',
  reconciliation: 'reconciliation',
})

function rehearsalD1Stdout(operation, bindings) {
  if (operation === 'd1_identity') {
    return JSON.stringify({
      account_id: bindings.account_id,
      config_sha256: bindings.config_sha256,
      d1_database_id: bindings.d1_database_id,
    })
  }
  if (operation === 'clean_start_reset') {
    return JSON.stringify([{
      finalBookmark: `blogman-rehearsal-reset-${bindings.candidate_id}`,
      // Issue #150: mirrors the live 4.86.0 remote import meta, which carries
      // duration (float) alongside the frozen numerics.
      meta: {
        duration: 0.25,
        changes: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: 0,
        size_after: 1_000_000,
      },
      results: [{
        'Database size (MB)': '1.00',
        'Rows read': 0,
        'Rows written': 0,
        'Total queries executed': 1,
      }],
      success: true,
    }])
  }
  if (operation === 'empty_d1_proof') {
    // Issue #150: mirrors the live-captured remote query meta (13 keys, float
    // duration) so formal rehearsal exercises the production parser shape.
    return JSON.stringify([{
      meta: {
        served_by: 'blogman-rehearsal-primary',
        served_by_region: 'REHEARSAL',
        served_by_colo: 'REH',
        served_by_primary: true,
        timings: { sql_duration_ms: 0.05 },
        duration: 0.05,
        changes: 0,
        last_row_id: 0,
        changed_db: false,
        size_after: 16_384,
        rows_read: 0,
        rows_written: 0,
        total_attempts: 1,
      },
      results: [],
      success: true,
    }])
  }
  if (operation === 'migration_catalog') {
    return JSON.stringify({
      format: 'blogman-migration-catalog/v1',
      migrations: bindings.migrations.map(({ number, name, checksum }) => ({ number, name, checksum })),
    })
  }
  if (operation === 'migration_plan') {
    return JSON.stringify({
      applied: [],
      pending: bindings.migrations.map(({ number, name, checksum }) => ({ action: 'apply', checksum, name, number })),
      state: 'pending',
    })
  }
  const ledger = bindings.migrations.map(({ number, name, checksum }) => ({
    applied_at: `blogman-rehearsal-${number}`,
    candidate_id: bindings.candidate_id,
    checksum,
    name,
    number,
  }))
  if (operation === 'migration_apply') {
    return JSON.stringify({ applied: ledger, pending: [], state: 'current' })
  }
  if (operation === 'migration_verify') {
    return JSON.stringify({ applied: ledger, pending: [], state: 'verified' })
  }
  if (operation === 'reconciliation') {
    return JSON.stringify({
      state: 'matched',
      checks: {
        schema: 'matched',
        migration_ledger: 'matched',
        post_count: 'matched',
        post_status: 'matched',
        post_content: 'matched',
      },
    })
  }
  fail(`rehearsal D1 operation ${operation} is not synthesizable`)
}

/** Source-level test-evidence provenance for formal no-network rehearsal transports. */
export const FORMAL_REHEARSAL_D1_EVIDENCE_SOURCE = 'formal-rehearsal-test-evidence'

/**
 * No-network rehearsal adapter. It synthesizes the exact production contract
 * shapes only after exercising the real command constructors and stage parsers.
 * It replaces command I/O only: it never starts a process, opens a network
 * connection, or writes outside the disposable local preparation rehearsal.
 */
export function createRehearsalD1Transport(bindings, sink, fault = null, childEnvironment = {}) {
  const normalizedBindings = validateConfig(bindings)
  const bindingsSha256 = d1StageBindingsSha256(normalizedBindings)
  function commandFor(request) {
    const normalizedRequest = validateRequest(request)
    if (['d1_identity', 'clean_start_reset', 'empty_d1_proof'].includes(normalizedRequest.operation)) {
      return buildD1Command(normalizedBindings, normalizedRequest)
    }
    if (['migration_catalog', 'migration_plan', 'migration_apply', 'migration_verify'].includes(normalizedRequest.operation)) {
      return Object.freeze({ executable: process.execPath, args: Object.freeze(canonicalRunnerCommand(
        normalizedBindings,
        normalizedRequest.operation.replace('migration_', ''),
      )) })
    }
    if (normalizedRequest.operation === 'reconciliation') {
      return Object.freeze({ executable: process.execPath, args: Object.freeze(rolloutSafetyCommand(normalizedBindings)) })
    }
    fail(`rehearsal D1 operation ${normalizedRequest.operation} is not supported`)
  }
  function execute(request) {
    const command = commandFor(request)
    const stage = REHEARSAL_D1_STAGE_BY_OPERATION[request.operation]
    if (sink) sink.push({
      adapter: 'd1', operation: request.operation, stage, command: command.args,
      env_keys: Object.keys(childEnvironment).sort(),
    })
    if (fault?.stage === stage) {
      if (fault.kind === 'failure') throw new D1TransportError('formal_failure', 1)
      if (fault.kind === 'drift') throw new D1TransportError('formal_drift', 1)
      if (fault.kind === 'timeout') {
        return { status: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: true }
      }
      if (fault.kind === 'malformed') {
        return { status: 0, stdout: '{', stderr: '', duration_ms: 1 }
      }
      return { status: 0, stdout: '', stderr: '', duration_ms: 1, signal: 'SIGKILL' }
    }
    return { status: 0, stdout: rehearsalD1Stdout(request.operation, normalizedBindings), stderr: '', duration_ms: 1 }
  }
  return Object.freeze({
    execute,
    bindings_sha256: bindingsSha256,
  })
}
