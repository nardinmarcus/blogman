import { createHash } from 'node:crypto'

export const D1_STAGE_ORDER = Object.freeze([
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
])

export const D1_RECONCILIATION_DIMENSIONS = Object.freeze([
  'schema',
  'migration_ledger',
  'post_count',
  'post_status',
  'post_content',
])

export const D1_STAGE_TIMEOUT_MS = Object.freeze({
  d1_identity: 120_000,
  clean_start_reset: 300_000,
  empty_d1_proof: 300_000,
  migrations_001_006: 2_100_000,
  reconciliation: 300_000,
})

const D1_OVERALL_TIMEOUT_MS = 5_400_000
const MAX_TRANSPORT_OUTPUT_BYTES = 64 * 1024
const RESET_RESPONSE_PREFIX = '\u251c Checking if file needs uploading\n\u2502\n'
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
const CANONICAL_MIGRATION_NAMES = Object.freeze([
  '001_initial_schema',
  '002_add_ai_image_configuration',
  '003_migrate_runtime_ai_configuration',
  '004_complete_historical_text_ai_schema',
  '005_fix_posts_fts_sync',
  '006_add_rollout_safety_controls',
])
const DEFAULT_BINDINGS = Object.freeze({
  database: 'DB',
  config_path: 'wrangler.toml',
  reset_sql_path: 'db/issue-23-clean-start-reset.sql',
  migration_runner_path: 'scripts/migrations.mjs',
  migration_catalog_path: 'db/ledger-migrations',
})

function fail(message) {
  throw new Error(`Issue #23 D1 stages: ${message}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`)
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

function assertSafeString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    fail(`${label} must be a non-empty single-line string`)
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 identity`)
  }
}

function assertCanonicalPath(value, suffix, label) {
  if (value !== suffix && !value.endsWith(`/${suffix}`)) {
    fail(`${label} must identify the canonical ${suffix}`)
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function serialize(value) {
  const bytes = canonicalBytes(value)
  const identity = sha256(bytes)
  deepFreeze(value)
  return Object.freeze({
    value,
    get bytes() {
      return Buffer.from(bytes)
    },
    sha256: identity,
  })
}

class StageFailure extends Error {
  constructor(outcome, classification, durationMs = 0) {
    super('stage failed')
    this.outcome = outcome
    this.classification = classification
    this.durationMs = durationMs
  }
}

function stageFailure(outcome, classification, durationMs = 0) {
  return new StageFailure(outcome, classification, durationMs)
}

function assertUniqueJsonObjectKeys(json) {
  let index = 0

  function skipWhitespace() {
    while (index < json.length && /[ \t\n\r]/u.test(json[index])) index += 1
  }

  function scanString() {
    const start = index
    if (json[index] !== '"') throw new SyntaxError()
    index += 1
    while (index < json.length) {
      if (json[index] === '"') {
        index += 1
        return JSON.parse(json.slice(start, index))
      }
      if (json[index] === '\\') index += 1
      index += 1
    }
    throw new SyntaxError()
  }

  function scanPrimitive() {
    const start = index
    while (index < json.length && !',]} \t\n\r'.includes(json[index])) index += 1
    if (start === index) throw new SyntaxError()
  }

  function scanArray() {
    index += 1
    skipWhitespace()
    if (json[index] === ']') {
      index += 1
      return
    }
    while (index < json.length) {
      scanValue()
      skipWhitespace()
      if (json[index] === ']') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError()
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError()
  }

  function scanObject() {
    index += 1
    skipWhitespace()
    if (json[index] === '}') {
      index += 1
      return
    }
    const keys = new Set()
    while (index < json.length) {
      const key = scanString()
      if (keys.has(key)) throw new SyntaxError()
      keys.add(key)
      skipWhitespace()
      if (json[index] !== ':') throw new SyntaxError()
      index += 1
      scanValue()
      skipWhitespace()
      if (json[index] === '}') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError()
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError()
  }

  function scanValue() {
    skipWhitespace()
    if (json[index] === '{') scanObject()
    else if (json[index] === '[') scanArray()
    else if (json[index] === '"') scanString()
    else scanPrimitive()
  }

  scanValue()
  skipWhitespace()
  if (index !== json.length) throw new SyntaxError()
}

function parseJson(stdout, classification = 'malformed_response') {
  try {
    assertUniqueJsonObjectKeys(stdout)
    return JSON.parse(stdout)
  } catch {
    throw stageFailure('ERROR', classification)
  }
}

function normalizeMigration(entry, index, label) {
  if (!isRecord(entry)) fail(`${label}[${index}] must be an object`)
  const number = Object.hasOwn(entry, 'number')
    ? entry.number
    : Object.hasOwn(entry, 'id') && /^\d{3}$/u.test(String(entry.id))
      ? Number(entry.id)
      : undefined
  const name = Object.hasOwn(entry, 'name')
    ? entry.name
    : Object.hasOwn(entry, 'path') && typeof entry.path === 'string'
      ? entry.path.split('/').at(-1)?.replace(/\.sql$/u, '')
      : undefined
  const checksum = Object.hasOwn(entry, 'checksum') ? entry.checksum : entry.sha256
  if (!Number.isSafeInteger(number) || number !== index + 1) fail(`${label}[${index}] number is invalid`)
  if (name !== CANONICAL_MIGRATION_NAMES[index]) fail(`${label}[${index}] name is invalid`)
  assertHash(checksum, `${label}[${index}].checksum`)
  return { number, name, checksum }
}

function normalizeBindings(value) {
  if (!isRecord(value)) fail('bindings must be an object')
  const allowedKeys = new Set([
    ...Object.keys(DEFAULT_BINDINGS),
    'account_id',
    'config_sha256',
    'd1_database_id',
    'reset_sql_sha256',
    'candidate_id',
    'migrations',
  ])
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    fail('bindings contains unsupported fields')
  }
  const bindings = {
    ...DEFAULT_BINDINGS,
    ...value,
  }
  for (const field of [
    'database',
    'config_path',
    'account_id',
    'd1_database_id',
    'reset_sql_path',
    'migration_runner_path',
    'migration_catalog_path',
    'candidate_id',
  ]) assertSafeString(bindings[field], `bindings.${field}`)
  assertHash(bindings.config_sha256, 'bindings.config_sha256')
  assertHash(bindings.reset_sql_sha256, 'bindings.reset_sql_sha256')
  assertCanonicalPath(bindings.reset_sql_path, 'db/issue-23-clean-start-reset.sql', 'bindings.reset_sql_path')
  assertCanonicalPath(bindings.migration_runner_path, 'scripts/migrations.mjs', 'bindings.migration_runner_path')
  assertCanonicalPath(bindings.migration_catalog_path, 'db/ledger-migrations', 'bindings.migration_catalog_path')
  if (!Array.isArray(bindings.migrations) || bindings.migrations.length !== 6) {
    fail('bindings.migrations must contain exactly six entries')
  }
  const migrations = bindings.migrations.map((entry, index) => (
    normalizeMigration(entry, index, 'bindings.migrations')
  ))
  return Object.freeze({ ...bindings, migrations: Object.freeze(migrations) })
}

function validateTransport(transport) {
  if (!isRecord(transport) || typeof transport.execute !== 'function') {
    fail('transport must expose execute(request)')
  }
}

function requestFor(bindings, stage, operation, extra = {}) {
  return Object.freeze({
    operation,
    stage,
    timeout_ms: D1_STAGE_TIMEOUT_MS[stage],
    database: bindings.database,
    config_path: bindings.config_path,
    config_sha256: bindings.config_sha256,
    account_id: bindings.account_id,
    d1_database_id: bindings.d1_database_id,
    ...extra,
  })
}

function readTransportResponse(response, stage) {
  if (!isRecord(response)) throw stageFailure('ERROR', 'invalid_transport_response')
  const allowedKeys = ['duration_ms', 'signal', 'status', 'stderr', 'stdout', 'timed_out']
  if (Reflect.ownKeys(response).some((key) => (
    typeof key !== 'string' || !allowedKeys.includes(key)
  ))) throw stageFailure('ERROR', 'invalid_transport_response')

  const durationMs = response.duration_ms ?? 0
  assertNonNegativeInteger(durationMs, 'transport duration')
  const timeoutMs = D1_STAGE_TIMEOUT_MS[stage]
  if (durationMs > timeoutMs) throw stageFailure('TIMEOUT', 'stage_timeout', durationMs)
  if (response.timed_out === true) throw stageFailure('TIMEOUT', 'stage_timeout', durationMs)
  if (response.signal !== undefined && response.signal !== null) {
    throw stageFailure('ERROR', 'transport_failure', durationMs)
  }
  if (response.status !== 0) throw stageFailure('ERROR', 'transport_failure', durationMs)
  const stdout = response.stdout ?? ''
  const stderr = response.stderr ?? ''
  if (typeof stdout !== 'string' || typeof stderr !== 'string') {
    throw stageFailure('ERROR', 'invalid_transport_response', durationMs)
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_TRANSPORT_OUTPUT_BYTES
    || Buffer.byteLength(stderr, 'utf8') > MAX_TRANSPORT_OUTPUT_BYTES) {
    throw stageFailure('ERROR', 'output_overflow', durationMs)
  }
  if (stderr !== '') throw stageFailure('ERROR', 'transport_failure', durationMs)
  return { stdout, durationMs }
}

function callOperation({ bindings, transport, stage, operation, extra }, state) {
  let response
  try {
    response = transport.execute(requestFor(bindings, stage, operation, extra))
  } catch {
    throw stageFailure('ERROR', 'transport_error', state.durationMs)
  }

  let result
  try {
    result = readTransportResponse(response, stage)
  } catch (error) {
    if (error instanceof StageFailure) {
      error.durationMs += state.durationMs
      throw error
    }
    throw stageFailure('ERROR', 'invalid_transport_response', state.durationMs)
  }
  state.durationMs += result.durationMs
  if (state.durationMs > D1_STAGE_TIMEOUT_MS[stage]) {
    throw stageFailure('TIMEOUT', 'stage_timeout', state.durationMs)
  }
  return result.stdout
}

function parseOperationOutput(stdout, state, parser, classification) {
  try {
    return parser(stdout)
  } catch (error) {
    if (error instanceof StageFailure) {
      error.durationMs += state.durationMs
      throw error
    }
    throw stageFailure('ERROR', classification, state.durationMs)
  }
}

function parseIdentity(stdout, bindings) {
  const value = parseJson(stdout)
  assertExactKeys(value, ['account_id', 'config_sha256', 'd1_database_id'], 'D1 identity response')
  assertSafeString(value.account_id, 'D1 account identity')
  assertHash(value.config_sha256, 'D1 config identity')
  assertSafeString(value.d1_database_id, 'D1 database identity')
  const mismatches = []
  if (value.account_id !== bindings.account_id) mismatches.push('account')
  if (value.config_sha256 !== bindings.config_sha256) mismatches.push('config')
  if (value.d1_database_id !== bindings.d1_database_id) mismatches.push('d1')
  if (mismatches.length > 0) throw stageFailure('NON_PASS', 'Manifest Drift')
}

function parseResetResponse(stdout) {
  const json = stdout.startsWith(RESET_RESPONSE_PREFIX)
    ? stdout.slice(RESET_RESPONSE_PREFIX.length)
    : stdout
  const value = parseJson(json, 'reset_response_invalid')
  if (!Array.isArray(value) || value.length !== 1) {
    throw stageFailure('ERROR', 'reset_response_invalid')
  }
  const envelope = value[0]
  assertExactKeys(envelope, ['finalBookmark', 'meta', 'results', 'success'], 'reset response')
  if (envelope.success !== true || typeof envelope.finalBookmark !== 'string'
    || envelope.finalBookmark.length === 0 || envelope.finalBookmark.trim() !== envelope.finalBookmark) {
    throw stageFailure('ERROR', 'reset_response_invalid')
  }
  assertExactKeys(envelope.meta, ['rows_read', 'rows_written', 'size_after'], 'reset response metadata')
  assertNonNegativeInteger(envelope.meta.rows_read, 'reset rows read')
  assertNonNegativeInteger(envelope.meta.rows_written, 'reset rows written')
  assertNonNegativeInteger(envelope.meta.size_after, 'reset size')
  if (!Array.isArray(envelope.results) || envelope.results.length !== 1) {
    throw stageFailure('ERROR', 'reset_response_invalid')
  }
  const row = envelope.results[0]
  assertExactKeys(row, [
    'Database size (MB)',
    'Rows read',
    'Rows written',
    'Total queries executed',
  ], 'reset response result')
  if (!Number.isSafeInteger(row['Total queries executed']) || row['Total queries executed'] <= 0
    || !Number.isSafeInteger(row['Rows read']) || row['Rows read'] < 0
    || !Number.isSafeInteger(row['Rows written']) || row['Rows written'] < 0
    || typeof row['Database size (MB)'] !== 'string'
    || !/^\d+\.\d{2}$/u.test(row['Database size (MB)'])
    || row['Rows read'] !== envelope.meta.rows_read
    || row['Rows written'] !== envelope.meta.rows_written
    || row['Database size (MB)'] !== (envelope.meta.size_after / 1e6).toFixed(2)) {
    throw stageFailure('ERROR', 'reset_response_invalid')
  }
}

function parseQueryEnvelope(stdout, label) {
  const value = parseJson(stdout)
  if (!Array.isArray(value) || value.length !== 1) {
    throw stageFailure('ERROR', 'malformed_response')
  }
  const envelope = value[0]
  assertExactKeys(envelope, ['results', 'success'], `${label} response`)
  if (envelope.success !== true || !Array.isArray(envelope.results)) {
    throw stageFailure('ERROR', 'malformed_response')
  }
  return envelope.results
}

function parseEmptyObjects(stdout) {
  const rows = parseQueryEnvelope(stdout, 'empty D1 proof')
  for (const row of rows) {
    assertExactKeys(row, ['name', 'sql', 'tbl_name', 'type'], 'empty D1 proof row')
    assertSafeString(row.name, 'empty D1 proof object name')
    assertSafeString(row.tbl_name, 'empty D1 proof table name')
    assertSafeString(row.type, 'empty D1 proof object type')
    if (row.sql !== null) assertSafeString(row.sql, 'empty D1 proof object SQL')
  }
  if (rows.length !== 0) throw stageFailure('NON_PASS', 'd1_not_empty')
}

function compareMigrations(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw stageFailure('NON_PASS', 'migration_contract_invalid')
  }
  for (const [index, migration] of actual.entries()) {
    const normalized = normalizeMigration(migration, index, `${label}.migrations`)
    if (normalized.number !== expected[index].number
      || normalized.name !== expected[index].name
      || normalized.checksum !== expected[index].checksum) {
      throw stageFailure('NON_PASS', 'migration_contract_invalid')
    }
  }
}

function parseCatalog(stdout, bindings) {
  const value = parseJson(stdout)
  assertExactKeys(value, ['format', 'migrations'], 'migration catalog')
  if (value.format !== 'blogman-migration-catalog/v1') {
    throw stageFailure('NON_PASS', 'migration_contract_invalid')
  }
  compareMigrations(value.migrations, bindings.migrations, 'migration catalog')
}

function parsePlan(stdout, bindings) {
  const value = parseJson(stdout)
  assertExactKeys(value, ['applied', 'pending', 'state'], 'migration plan')
  if (value.state !== 'pending' || !Array.isArray(value.applied) || value.applied.length !== 0
    || !Array.isArray(value.pending) || value.pending.length !== bindings.migrations.length) {
    throw stageFailure('NON_PASS', 'empty_only_plan_invalid')
  }
  for (const [index, migration] of value.pending.entries()) {
    assertExactKeys(migration, ['action', 'checksum', 'name', 'number'], 'migration plan entry')
    if (migration.action !== 'apply') throw stageFailure('NON_PASS', 'empty_only_plan_invalid')
    const normalized = normalizeMigration(migration, index, 'migration plan')
    if (normalized.number !== bindings.migrations[index].number
      || normalized.name !== bindings.migrations[index].name
      || normalized.checksum !== bindings.migrations[index].checksum) {
      throw stageFailure('NON_PASS', 'empty_only_plan_invalid')
    }
  }
}

function parseAppliedEntry(entry, expected, candidate, label) {
  assertExactKeys(entry, ['applied_at', 'candidate_id', 'checksum', 'name', 'number'], `${label} entry`)
  const normalized = normalizeMigration(entry, expected.number - 1, label)
  if (normalized.number !== expected.number
    || normalized.name !== expected.name
    || normalized.checksum !== expected.checksum
    || entry.candidate_id !== candidate
    || typeof entry.applied_at !== 'string'
    || entry.applied_at.length === 0) {
    throw stageFailure('NON_PASS', 'migration_ledger_invalid')
  }
}

function parseMigrationState(stdout, bindings, expectedState, label) {
  const value = parseJson(stdout)
  assertExactKeys(value, ['applied', 'pending', 'state'], label)
  if (value.state !== expectedState || !Array.isArray(value.pending) || value.pending.length !== 0
    || !Array.isArray(value.applied) || value.applied.length !== bindings.migrations.length) {
    throw stageFailure('NON_PASS', 'migration_ledger_invalid')
  }
  for (const [index, entry] of value.applied.entries()) {
    parseAppliedEntry(entry, bindings.migrations[index], bindings.candidate_id, label)
  }
}

function parseReconciliation(stdout) {
  const value = parseJson(stdout)
  if (!isRecord(value)) throw stageFailure('ERROR', 'reconciliation_response_invalid')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !['checks', 'drift_dimensions', 'state'].includes(key))) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  if (!Object.hasOwn(value, 'state') || !Object.hasOwn(value, 'checks')
    || !isRecord(value.checks)) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  if (Object.hasOwn(value, 'drift_dimensions')
    && (!Array.isArray(value.drift_dimensions)
      || value.drift_dimensions.some((dimension) => typeof dimension !== 'string'))) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  const actualDimensions = Reflect.ownKeys(value.checks)
  if (actualDimensions.length !== D1_RECONCILIATION_DIMENSIONS.length
    || D1_RECONCILIATION_DIMENSIONS.some((dimension) => !actualDimensions.includes(dimension))) {
    throw stageFailure('NON_PASS', 'reconciliation_contract_invalid')
  }
  const drift = D1_RECONCILIATION_DIMENSIONS.filter((dimension) => value.checks[dimension] !== 'matched')
  if (value.state !== 'matched' || drift.length > 0) {
    throw stageFailure('NON_PASS', 'reconciliation_drift')
  }
}

function runD1Identity(bindings, transport) {
  const state = { durationMs: 0 }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'd1_identity',
    operation: 'd1_identity',
    extra: {
      expected_account_id: bindings.account_id,
      expected_config_sha256: bindings.config_sha256,
    },
  }, state)
  parseOperationOutput(stdout, state, (value) => parseIdentity(value, bindings), 'd1_identity_response_invalid')
  return state.durationMs
}

function runReset(bindings, transport) {
  const state = { durationMs: 0 }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'clean_start_reset',
    operation: 'clean_start_reset',
    extra: {
      reset_sql_path: bindings.reset_sql_path,
      reset_sql_sha256: bindings.reset_sql_sha256,
    },
  }, state)
  parseOperationOutput(stdout, state, parseResetResponse, 'reset_response_invalid')
  return state.durationMs
}

function runEmptyProof(bindings, transport) {
  const state = { durationMs: 0 }
  const emptyObjects = callOperation({
    bindings,
    transport,
    stage: 'empty_d1_proof',
    operation: 'empty_d1_objects',
    extra: { query: EMPTY_OBJECT_QUERY },
  }, state)
  parseOperationOutput(emptyObjects, state, parseEmptyObjects, 'empty_d1_proof_invalid')
  return state.durationMs
}

function runMigrations(bindings, transport) {
  const state = { durationMs: 0 }
  const common = {
    migration_runner_path: bindings.migration_runner_path,
    migration_catalog_path: bindings.migration_catalog_path,
  }
  const catalog = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_catalog',
    extra: common,
  }, state)
  parseOperationOutput(catalog, state, (value) => parseCatalog(value, bindings), 'migration_contract_invalid')
  const plan = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_plan',
    extra: common,
  }, state)
  parseOperationOutput(plan, state, (value) => parsePlan(value, bindings), 'empty_only_plan_invalid')
  const applied = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_apply',
    extra: { ...common, candidate_id: bindings.candidate_id },
  }, state)
  parseOperationOutput(
    applied,
    state,
    (value) => parseMigrationState(value, bindings, 'current', 'migration apply'),
    'migration_ledger_invalid',
  )
  const verified = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_verify',
    extra: { ...common, candidate_id: bindings.candidate_id },
  }, state)
  parseOperationOutput(
    verified,
    state,
    (value) => parseMigrationState(value, bindings, 'verified', 'migration verify'),
    'migration_ledger_invalid',
  )
  return state.durationMs
}

function runReconciliation(bindings, transport) {
  const state = { durationMs: 0 }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'reconciliation',
    operation: 'reconciliation',
    extra: { dimensions: D1_RECONCILIATION_DIMENSIONS },
  }, state)
  parseOperationOutput(stdout, state, parseReconciliation, 'reconciliation_response_invalid')
  return state.durationMs
}

const STAGE_RUNNERS = Object.freeze({
  d1_identity: runD1Identity,
  clean_start_reset: runReset,
  empty_d1_proof: runEmptyProof,
  migrations_001_006: runMigrations,
  reconciliation: runReconciliation,
})

export function runD1Stages({ bindings: rawBindings, transport }) {
  const bindings = normalizeBindings(rawBindings)
  validateTransport(transport)
  const stageCounts = Object.fromEntries(D1_STAGE_ORDER.map((stage) => [stage, 0]))
  const stageDurations = Object.fromEntries(D1_STAGE_ORDER.map((stage) => [stage, 0]))
  const trace = []
  let elapsedMs = 0

  for (const stage of D1_STAGE_ORDER) {
    stageCounts[stage] += 1
    let outcome = 'PASS'
    let classification
    let durationMs = 0
    try {
      durationMs = STAGE_RUNNERS[stage](bindings, transport, trace)
      assertNonNegativeInteger(durationMs, `${stage} duration`)
      if (durationMs > D1_STAGE_TIMEOUT_MS[stage]) {
        throw stageFailure('TIMEOUT', 'stage_timeout', durationMs)
      }
      elapsedMs += durationMs
      if (elapsedMs > D1_OVERALL_TIMEOUT_MS) {
        throw stageFailure('TIMEOUT', 'overall_timeout', elapsedMs)
      }
    } catch (error) {
      if (error instanceof StageFailure) {
        outcome = error.outcome
        classification = error.classification
        durationMs = error.durationMs
        elapsedMs += durationMs
      } else {
        outcome = 'ERROR'
        classification = 'stage_error'
      }
    }
    stageDurations[stage] = durationMs
    trace.push({
      stage,
      outcome,
      ...(classification ? { classification } : {}),
      duration_ms: durationMs,
    })
    if (outcome !== 'PASS') break
  }

  const terminal = trace.at(-1)
  if (!terminal) fail('D1 stage contract did not execute')
  const value = {
    format: 'blogman-issue-23-d1-stages/v1',
    outcome: terminal.outcome,
    first_terminal_stage: terminal.outcome === 'PASS' ? null : terminal.stage,
    failure: terminal.outcome === 'PASS' ? null : { classification: terminal.classification },
    stage_counts: stageCounts,
    stage_durations_ms: stageDurations,
    evidence: {
      source: 'internal-transport',
      trace_sha256: sha256(canonicalBytes(trace)),
    },
    finalized: true,
  }
  return serialize(value)
}
