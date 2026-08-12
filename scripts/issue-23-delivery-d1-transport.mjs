import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { D1_STAGE_TIMEOUT_MS } from './issue-23-delivery-d1-stages.mjs'

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
  NONZERO: 'nonzero',
  MALFORMED: 'malformed',
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
  'candidate_id',
  'evidence_class',
  'migrations',
])
const CANONICAL_MIGRATION_NAMES = Object.freeze([
  '001_initial_schema',
  '002_add_ai_image_configuration',
  '003_migrate_runtime_ai_configuration',
  '004_complete_historical_text_ai_schema',
  '005_fix_posts_fts_sync',
  '006_add_rollout_safety_controls',
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
const SUPERVISOR_GRACE_MS = 2_000
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/u
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/u
const EXPECTED_RECONCILIATION_FORMAT = 'blogman-d1-reconciliation/v1'
const SUPERVISOR_SOURCE = [
  "import { spawn } from 'node:child_process'",
  "const [executable, argsText, timeoutText, maxOutputText] = process.argv.slice(1)",
  'const args = JSON.parse(argsText)',
  'const timeoutMs = Number(timeoutText)',
  'const maxOutputBytes = Number(maxOutputText)',
  'let child = null',
  'let stdout = []',
  'let stderr = []',
  'let stdoutBytes = 0',
  'let stderrBytes = 0',
  'let timedOut = false',
  'let outputOverflow = false',
  'let childError = null',
  'let emitted = false',
  'let hardTimer = null',
  'const started = process.hrtime.bigint()',
  'const duration = () => Math.max(1, Math.ceil(Number(process.hrtime.bigint() - started) / 1e6))',
  "const killGroup = (signal = 'SIGKILL') => { if (!child?.pid) return; try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} } }",
  'const hasResidual = () => { if (!child?.pid) return false; try { process.kill(-child.pid, 0); return true } catch { return false } }',
  'const append = (target, chunk) => { const bytes = Buffer.byteLength(chunk); if (target === stdout) stdoutBytes += bytes; else stderrBytes += bytes; if ((target === stdout ? stdoutBytes : stderrBytes) > maxOutputBytes) { outputOverflow = true; killGroup() } else target.push(Buffer.from(chunk)) }',
  "const emit = (status, code = null, signal = null, residual = false) => { if (emitted) return; emitted = true; const value = { child_error: childError?.code || null, child_signal: signal, child_status: code, duration_ms: duration(), residual_process_group: residual, status, stderr_b64: Buffer.concat(stderr).toString('base64'), stdout_b64: Buffer.concat(stdout).toString('base64') }; process.stdout.write(JSON.stringify(value), () => process.exit(0)) }",
  'const finish = (code, signal) => { if (hardTimer) clearTimeout(hardTimer); const residualBefore = hasResidual(); if (timedOut || outputOverflow || residualBefore || code !== 0 || signal || childError) killGroup(); setTimeout(() => { const residualAfter = hasResidual(); if (residualAfter) emit(\'uncertain\', code, signal, true); else if (timedOut) emit(\'timed_out\', code, signal); else if (outputOverflow) emit(\'output_overflow\', code, signal); else if (childError || signal) emit(\'uncertain\', code, signal); else if (code !== 0) emit(\'nonzero\', code, signal); else emit(\'completed\', code, signal) }, residualBefore || timedOut || outputOverflow ? 50 : 0) }',
  'try { child = spawn(executable, args, { cwd: process.cwd(), detached: true, stdio: [\'ignore\', \'pipe\', \'pipe\'] }) } catch (error) { childError = error; emit(\'uncertain\') }',
  "if (child) { child.stdout.on('data', (chunk) => append(stdout, chunk)); child.stderr.on('data', (chunk) => append(stderr, chunk)); child.on('error', (error) => { childError = error; killGroup() }); child.on('close', finish); setTimeout(() => { timedOut = true; killGroup() }, timeoutMs); hardTimer = setTimeout(() => { killGroup(); emit('uncertain', null, null, true) }, timeoutMs + 1000) }",
  "process.once('SIGTERM', () => { timedOut = true; killGroup() })",
  "process.once('SIGINT', () => { timedOut = true; killGroup() })",
].join('\n')

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
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    fail(`${label} contains unsupported fields`)
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
  assertSafeFilesystemEntry(path, 'file', label)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hashDirectoryEntry(directory, prefix, hash) {
  const entries = readdirSync(directory).sort()
  for (const name of entries) {
    const path = join(directory, name)
    const relativePath = prefix ? `${prefix}/${name}` : name
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) fail('migration catalog contains a symlink')
    if (metadata.isDirectory()) {
      assertSafeFilesystemEntry(path, 'directory', `migration catalog directory ${relativePath}`)
      hashDirectoryEntry(path, relativePath, hash)
      continue
    }
    if (!metadata.isFile()) fail('migration catalog contains an unsupported entry')
    assertSafeFilesystemEntry(path, 'file', `migration catalog file ${relativePath}`)
    const bytes = readFileSync(path)
    hash.update(`${relativePath}\0${metadata.size}\0`).update(bytes).update('\0')
  }
}

export function hashD1ArtifactDirectory(path) {
  assertSafeFilesystemEntry(path, 'directory', 'migration catalog')
  const hash = createHash('sha256')
  hashDirectoryEntry(path, '', hash)
  return hash.digest('hex')
}

function validateExpectedReconciliation(path) {
  const bytes = readFileSync(path)
  if (bytes.length > D1_TRANSPORT_MAX_OUTPUT_BYTES) fail('expected reconciliation is too large')
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
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
  if (!['production', 'local-non-production', 'test-non-production', 'synthetic-non-production'].includes(config.evidence_class)) {
    fail('evidence_class is invalid')
  }
  if (config.mode === 'remote' && config.evidence_class !== 'production') {
    fail('remote config must be production evidence')
  }
  if (!Array.isArray(config.migrations) || config.migrations.length !== 6) {
    fail('migrations must contain exactly six entries')
  }
  for (const [index, migration] of config.migrations.entries()) {
    assertExactKeys(migration, ['checksum', 'name', 'number'], `migrations[${index}]`)
    if (migration.number !== index + 1 || migration.name !== CANONICAL_MIGRATION_NAMES[index]
      || !/^[a-f0-9]{64}$/u.test(migration.checksum)) {
      fail(`migrations[${index}] is invalid`)
    }
  }
  return Object.freeze({ ...config })
}

function validateBoundArtifactsOrThrow(config) {
  try {
    validateBoundArtifacts(config)
  } catch {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
}

function validateBoundArtifacts(config) {
  assertSafeFilesystemEntry(wranglerPath, 'file', 'Wrangler executable')
  if (sha256(readFileSync(wranglerPath)) !== config.wrangler_sha256) {
    fail('Wrangler executable hash drifted')
  }
  assertSafeFilesystemEntry(config.config_path, 'file', 'bound Wrangler config')
  if (sha256(readFileSync(config.config_path)) !== config.config_sha256) {
    fail('bound Wrangler config hash drifted')
  }
  assertCanonicalPath(config.reset_sql_path, canonicalPaths.reset, 'bound reset SQL')
  if (sha256(readFileSync(config.reset_sql_path)) !== config.reset_sql_sha256) {
    fail('bound reset SQL hash drifted')
  }
  assertCanonicalPath(config.migration_runner_path, canonicalPaths.runner, 'bound migration runner')
  if (sha256(readFileSync(config.migration_runner_path)) !== config.migration_runner_sha256) {
    fail('bound migration runner hash drifted')
  }
  assertAbsolutePath(config.migration_catalog_path, 'bound migration catalog')
  if (config.migration_catalog_path !== canonicalPaths.catalog) {
    fail('bound migration catalog must be canonical')
  }
  if (hashD1ArtifactDirectory(config.migration_catalog_path) !== config.migration_catalog_sha256) {
    fail('bound migration catalog hash drifted')
  }
  assertCanonicalPath(config.rollout_safety_path, canonicalPaths.rolloutSafety, 'bound rollout safety')
  if (sha256(readFileSync(config.rollout_safety_path)) !== config.rollout_safety_sha256) {
    fail('bound rollout safety hash drifted')
  }
  assertSafeFilesystemEntry(config.expected_reconciliation_path, 'file', 'bound expected reconciliation')
  if (sha256(readFileSync(config.expected_reconciliation_path)) !== config.expected_reconciliation_sha256) {
    fail('bound expected reconciliation hash drifted')
  }
  validateExpectedReconciliation(config.expected_reconciliation_path)
  if (config.mode === 'local') assertSafeFilesystemEntry(config.persist_path, 'directory', 'local D1 persist path')
}

function validateRequest(request) {
  assertExactKeys(request, ['elapsed_ms', 'operation', 'stage', 'timeout_ms'], 'request')
  if (!Object.hasOwn(OPERATION_STAGES, request.operation)) fail('request operation is invalid')
  if (OPERATION_STAGES[request.operation] !== request.stage) fail('request stage is invalid')
  if (request.timeout_ms !== D1_STAGE_TIMEOUT_MS[request.stage]) fail('request timeout is not frozen')
  if (!Number.isSafeInteger(request.elapsed_ms) || request.elapsed_ms < 0
    || request.elapsed_ms >= request.timeout_ms) {
    fail('request elapsed time is invalid')
  }
  return Object.freeze({
    operation: request.operation,
    stage: request.stage,
    timeout_ms: request.timeout_ms,
    elapsed_ms: request.elapsed_ms,
  })
}

function remainingTimeout(request) {
  const timeout = request.timeout_ms - request.elapsed_ms
  if (timeout <= 0) throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT)
  return timeout
}

function d1Arguments(config, suffix) {
  const args = ['d1', 'execute', config.database, config.mode === 'local' ? '--local' : '--remote']
  if (config.mode === 'local') args.push('--persist-to', config.persist_path)
  args.push('--config', config.config_path, ...suffix, '--json')
  return args
}

export function buildD1Command(config, request) {
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

function decodeUtf8(base64) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > D1_TRANSPORT_MAX_OUTPUT_BYTES) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
  return text
}

function parseSupervisorOutput(output) {
  try {
    const value = JSON.parse(output)
    assertExactKeys(value, [
      'child_error',
      'child_signal',
      'child_status',
      'duration_ms',
      'residual_process_group',
      'status',
      'stderr_b64',
      'stdout_b64',
    ], 'supervisor response')
    if (!Number.isSafeInteger(value.duration_ms) || value.duration_ms <= 0
      || typeof value.residual_process_group !== 'boolean'
      || typeof value.stdout_b64 !== 'string'
      || typeof value.stderr_b64 !== 'string'
      || !['completed', 'nonzero', 'timed_out', 'output_overflow', 'uncertain'].includes(value.status)) {
      throw new Error('invalid supervisor response')
    }
    return value
  } catch {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
}

function runBounded(executable, args, timeoutMs) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      SUPERVISOR_SOURCE,
      executable,
      JSON.stringify(args),
      String(timeoutMs),
      String(D1_TRANSPORT_MAX_OUTPUT_BYTES),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: D1_TRANSPORT_MAX_OUTPUT_BYTES * 2 + 64 * 1024,
      timeout: timeoutMs + SUPERVISOR_GRACE_MS,
      killSignal: 'SIGTERM',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.error?.code === 'ETIMEDOUT') {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  const supervisor = parseSupervisorOutput(result.stdout)
  if (supervisor.residual_process_group || supervisor.status === 'uncertain'
    || supervisor.status === 'output_overflow') {
    throw new D1TransportError(
      D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN,
      supervisor.duration_ms,
    )
  }
  if (supervisor.status === 'timed_out') {
    throw new D1TransportError(
      D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT,
      supervisor.duration_ms,
    )
  }
  if (supervisor.status === 'nonzero') {
    throw new D1TransportError(
      D1_TRANSPORT_FAILURE_CLASSIFICATIONS.NONZERO,
      supervisor.duration_ms,
    )
  }
  const stdout = decodeUtf8(supervisor.stdout_b64)
  const stderr = decodeUtf8(supervisor.stderr_b64)
  return {
    status: 0,
    stdout,
    stderr,
    duration_ms: supervisor.duration_ms,
  }
}

function parseLocalIdentity(stdout) {
  try {
    const response = JSON.parse(stdout)
    if (!Array.isArray(response) || response.length !== 1 || !isPlainRecord(response[0])) {
      throw new Error('invalid identity response')
    }
    const envelope = response[0]
    assertExactKeys(envelope, ['meta', 'results', 'success'], 'D1 identity response')
    assertExactKeys(envelope.meta, ['duration'], 'D1 identity metadata')
    if (envelope.success !== true || envelope.meta.duration < 0
      || !Number.isSafeInteger(envelope.meta.duration)
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
    const response = JSON.parse(stdout)
    if (!isPlainRecord(response)) throw new Error('invalid D1 info response')
    const expectedKeys = [
      'created_at',
      'database_size',
      'jurisdiction',
      'name',
      'num_tables',
      'read_queries_24h',
      'read_replication',
      'rows_read_24h',
      'rows_written_24h',
      'running_in_region',
      'uuid',
    ]
    if (JSON.stringify(Reflect.ownKeys(response).sort()) !== JSON.stringify(expectedKeys.sort())
      || typeof response.uuid !== 'string'
      || response.uuid !== expectedDatabaseId) {
      throw new Error('invalid D1 info response')
    }
    for (const field of [
      'database_size',
      'num_tables',
      'read_queries_24h',
      'rows_read_24h',
      'rows_written_24h',
    ]) {
      if (!Number.isSafeInteger(response[field]) || response[field] < 0) {
        throw new Error('invalid D1 info response')
      }
    }
    for (const field of ['created_at', 'name', 'running_in_region']) {
      if (typeof response[field] !== 'string') throw new Error('invalid D1 info response')
    }
    if (response.jurisdiction !== null && typeof response.jurisdiction !== 'string') {
      throw new Error('invalid D1 info response')
    }
    assertExactKeys(response.read_replication, ['mode'], 'D1 info replication')
    if (typeof response.read_replication.mode !== 'string') {
      throw new Error('invalid D1 info response')
    }
  } catch {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
}

function parseRemoteWhoami(stdout, expectedAccountId) {
  try {
    const response = JSON.parse(stdout)
    if (!isPlainRecord(response)) throw new Error('invalid Wrangler identity response')
    const keys = Object.keys(response).sort()
    const withEmail = ['accounts', 'authType', 'email', 'loggedIn', 'tokenPermissions']
    const withoutEmail = ['accounts', 'authType', 'loggedIn', 'tokenPermissions']
    if (JSON.stringify(keys) !== JSON.stringify(withEmail)
      && JSON.stringify(keys) !== JSON.stringify(withoutEmail)) {
      throw new Error('invalid Wrangler identity response')
    }
    if (response.loggedIn !== true
      || !['Account API Token', 'Global API Key', 'OAuth Token', 'User API Token'].includes(response.authType)
      || (Object.hasOwn(response, 'email') && typeof response.email !== 'string')
      || !Array.isArray(response.accounts)
      || !Array.isArray(response.tokenPermissions)
      || response.tokenPermissions.some((permission) => typeof permission !== 'string')) {
      throw new Error('invalid Wrangler identity response')
    }
    for (const account of response.accounts) {
      assertExactKeys(account, [
        'created_on',
        'id',
        'legacy_flags',
        'name',
        'settings',
        'type',
      ], 'Wrangler account')
      if (typeof account.created_on !== 'string'
        || typeof account.id !== 'string'
        || typeof account.name !== 'string'
        || account.type !== 'standard') {
        throw new Error('invalid Wrangler account')
      }
      assertExactKeys(account.settings, [
        'abuse_contact_email',
        'access_approval_expiry',
        'api_access_enabled',
        'enforce_twofactor',
        'oauth_app_access_enabled',
      ], 'Wrangler account settings')
      assertExactKeys(account.legacy_flags, ['enterprise_zone_quota'], 'Wrangler account legacy flags')
      assertExactKeys(
        account.legacy_flags.enterprise_zone_quota,
        ['available', 'current', 'maximum'],
        'Wrangler account quota',
      )
      for (const value of Object.values(account.legacy_flags.enterprise_zone_quota)) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid Wrangler account quota')
      }
    }
    if (response.accounts.filter((account) => account.id === expectedAccountId).length !== 1) {
      throw new Error('Wrangler account identity drift')
    }
  } catch {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
}

function identityResponse(config, infoCommand, whoamiCommand = null) {
  if (config.mode === 'local') parseLocalIdentity(infoCommand.stdout)
  else {
    parseRemoteIdentity(infoCommand.stdout, config.d1_database_id)
    parseRemoteWhoami(whoamiCommand.stdout, config.account_id)
  }
  return {
    status: 0,
    stdout: JSON.stringify({
      account_id: config.account_id,
      config_sha256: config.config_sha256,
      d1_database_id: config.d1_database_id,
    }),
    stderr: '',
    duration_ms: infoCommand.duration_ms + (whoamiCommand?.duration_ms ?? 0),
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

export function createD1Transport(config) {
  if (arguments.length !== 1) fail('createD1Transport accepts exactly one config argument')
  const normalizedConfig = validateConfig(config)
  validateBoundArtifactsOrThrow(normalizedConfig)

  function execute(request) {
    if (arguments.length !== 1) fail('execute accepts exactly one request argument')
    const normalizedRequest = validateRequest(request)
    validateBoundArtifactsOrThrow(normalizedConfig)
    const timeoutMs = remainingTimeout(normalizedRequest)
    if (normalizedRequest.operation === 'd1_identity'
      || normalizedRequest.operation === 'clean_start_reset'
      || normalizedRequest.operation === 'empty_d1_proof') {
      const command = buildD1Command(normalizedConfig, normalizedRequest)
      if (normalizedRequest.operation !== 'd1_identity') {
        return runBounded(command.executable, command.args, timeoutMs)
      }
      const infoCommand = runBounded(command.executable, command.args, timeoutMs)
      if (normalizedConfig.mode === 'local') return identityResponse(normalizedConfig, infoCommand)
      const whoamiTimeout = timeoutMs - infoCommand.duration_ms
      if (whoamiTimeout <= 0) {
        throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT, infoCommand.duration_ms)
      }
      const whoamiCommand = runBounded(
        wranglerPath,
        buildRemoteWhoamiCommand(normalizedConfig),
        whoamiTimeout,
      )
      return identityResponse(normalizedConfig, infoCommand, whoamiCommand)
    }
    if (normalizedRequest.operation === 'migration_catalog') {
      return runBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'catalog'), timeoutMs)
    }
    if (normalizedRequest.operation === 'migration_plan') {
      return runBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'plan'), timeoutMs)
    }
    if (normalizedRequest.operation === 'migration_apply') {
      return runBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'apply'), timeoutMs)
    }
    if (normalizedRequest.operation === 'migration_verify') {
      return runBounded(process.execPath, canonicalRunnerCommand(normalizedConfig, 'verify'), timeoutMs)
    }
    if (normalizedRequest.operation === 'reconciliation') {
      return runBounded(process.execPath, rolloutSafetyCommand(normalizedConfig), timeoutMs)
    }
    fail('operation is not supported')
  }

  return Object.freeze({ execute })
}
