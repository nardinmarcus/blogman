import { createHash } from 'node:crypto'
import {
  D1_CANONICAL_MIGRATION_NAMES,
  D1_STAGE_TIMEOUT_MS,
  d1StageBindingsSha256,
  parseStrictJson,
} from './issue-23-delivery-d1-contracts.mjs'

export { D1_STAGE_TIMEOUT_MS }

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


const D1_OVERALL_TIMEOUT_MS = 5_400_000
const MAX_STAGE_OUTPUT_BYTES = 64 * 1024
const RESET_RESPONSE_PREFIX = '\u251c Checking if file needs uploading\n\u2502\n'
const RESET_LOCAL_STATEMENT_COUNT = 15
const BINDING_KEYS = Object.freeze([
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
const TRANSPORT_FAILURE_OUTCOMES = Object.freeze({
  formal_failure: ['NON_PASS', 'formal_rehearsal_forced_failure'],
  formal_drift: ['NON_PASS', 'Manifest Drift'],
  timeout: ['TIMEOUT', 'timeout'],
  overall_timeout: ['TIMEOUT', 'overall_timeout'],
  nonzero: ['ERROR', 'nonzero'],
  malformed: ['ERROR', 'malformed'],
  manifest_drift: ['NON_PASS', 'Manifest Drift'],
  permission_insufficient: ['NON_PASS', 'cloudflare_permission_insufficient'],
  uncertain: ['UNCERTAIN', 'uncertain'],
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

function assertSafePath(value, label) {
  assertSafeString(value, label)
  if (!value.startsWith('/') || value !== value.replace(/\/+/gu, '/')
    || /(^|\/)\.\.?($|\/)/u.test(value)) {
    fail(`${label} must be an absolute normalized path`)
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 identity`)
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

function parseJson(stdout, classification = 'malformed') {
  try {
    return parseStrictJson(stdout)
  } catch {
    throw stageFailure('ERROR', classification)
  }
}

function normalizeMigration(entry, index, label) {
  if (!isRecord(entry)) fail(`${label}[${index}] must be an object`)
  assertExactKeys(entry, ['checksum', 'name', 'number'], `${label}[${index}]`)
  if (!Number.isSafeInteger(entry.number) || entry.number !== index + 1) {
    fail(`${label}[${index}] number is invalid`)
  }
  if (entry.name !== D1_CANONICAL_MIGRATION_NAMES[index]) {
    fail(`${label}[${index}] name is invalid`)
  }
  assertHash(entry.checksum, `${label}[${index}].checksum`)
  return { number: entry.number, name: entry.name, checksum: entry.checksum }
}

function normalizeBindings(value) {
  if (!isRecord(value)) fail('bindings must be an object')
  const actual = Reflect.ownKeys(value)
  const expectedKeys = value.mode === 'local'
    ? [...BINDING_KEYS, 'persist_path']
    : BINDING_KEYS
  if (actual.length !== expectedKeys.length
    || expectedKeys.some((key) => !actual.includes(key))) {
    fail('bindings contains unsupported fields')
  }
  if (value.mode !== 'local' && value.mode !== 'remote') fail('bindings.mode is invalid')
  if (value.mode === 'local') assertSafePath(value.persist_path, 'bindings.persist_path')
  else if (value.persist_path !== undefined) fail('remote bindings cannot include persist_path')
  for (const field of [
    'database',
    'config_path',
    'account_id',
    'd1_database_id',
    'reset_sql_path',
    'migration_runner_path',
    'migration_catalog_path',
    'rollout_safety_path',
    'expected_reconciliation_path',
    'candidate_id',
  ]) assertSafeString(value[field], `bindings.${field}`)
  for (const field of [
    'config_sha256',
    'wrangler_sha256',
    'reset_sql_sha256',
    'migration_runner_sha256',
    'migration_catalog_sha256',
    'rollout_safety_sha256',
    'expected_reconciliation_sha256',
  ]) assertHash(value[field], `bindings.${field}`)
  if (!/^[a-f0-9]{40}$/u.test(value.candidate_id)) {
    fail('bindings.candidate_id is invalid')
  }
  for (const [field, suffix] of [
    ['reset_sql_path', 'db/issue-23-clean-start-reset.sql'],
    ['migration_runner_path', 'scripts/migrations.mjs'],
    ['migration_catalog_path', 'db/ledger-migrations'],
    ['rollout_safety_path', 'scripts/rollout-safety.mjs'],
  ]) {
    if (!value[field].endsWith(`/${suffix}`) && value[field] !== suffix) {
      fail(`bindings.${field} must identify the canonical ${suffix}`)
    }
  }
  if (!['production', 'local-non-production', 'test-non-production', 'synthetic-non-production', 'formal-rehearsal-test-evidence']
    .includes(value.evidence_class)) {
    fail('bindings.evidence_class is invalid')
  }
  const attemptBound = ['production', 'formal-rehearsal-test-evidence'].includes(value.evidence_class)
  for (const field of ['manifest_sha256', 'authorization_sha256', 'attempt_id']) {
    if (attemptBound || value[field] !== null) assertHash(value[field], `bindings.${field}`)
  }
  if (!Array.isArray(value.migrations) || value.migrations.length !== 6) {
    fail('bindings.migrations must contain exactly six entries')
  }
  const migrations = value.migrations.map((entry, index) => (
    normalizeMigration(entry, index, 'bindings.migrations')
  ))
  return Object.freeze({
    ...value,
    migrations: Object.freeze(migrations),
  })
}

function validateTransport(transport) {
  if (!isRecord(transport) || typeof transport.execute !== 'function') {
    fail('transport must expose execute(request)')
  }
}

function requestFor(bindings, stage, operation, elapsedMs, overallElapsedMs) {
  return Object.freeze({
    operation,
    stage,
    timeout_ms: D1_STAGE_TIMEOUT_MS[stage],
    elapsed_ms: elapsedMs,
    overall_elapsed_ms: overallElapsedMs,
  })
}

function transportFailure(error, durationMs) {
  const classification = error?.name === 'D1TransportError'
    ? error.classification
    : undefined
  const mapped = TRANSPORT_FAILURE_OUTCOMES[classification] ?? ['ERROR', 'transport_error']
  const measured = Number.isSafeInteger(error?.durationMs) && error.durationMs >= 0
    ? durationMs + error.durationMs
    : durationMs
  throw stageFailure(mapped[0], mapped[1], measured)
}

function readTransportResponse(response, stage, elapsedMs) {
  if (!isRecord(response)) throw stageFailure('ERROR', 'malformed', elapsedMs)
  const operationDurationMs = Number.isSafeInteger(response.duration_ms) && response.duration_ms > 0
    ? response.duration_ms
    : 0
  const durationMs = elapsedMs + operationDurationMs
  const allowedKeys = ['duration_ms', 'signal', 'status', 'stderr', 'stdout', 'timed_out']
  if (Reflect.ownKeys(response).some((key) => (
    typeof key !== 'string' || !allowedKeys.includes(key)
  ))) throw stageFailure('ERROR', 'malformed', durationMs)
  if (operationDurationMs === 0) throw stageFailure('ERROR', 'malformed', durationMs)
  if (Object.hasOwn(response, 'timed_out') && typeof response.timed_out !== 'boolean') {
    throw stageFailure('ERROR', 'malformed', durationMs)
  }
  if (response.timed_out === true) throw stageFailure('TIMEOUT', 'timeout', durationMs)
  if (response.signal !== undefined && response.signal !== null) {
    throw stageFailure('UNCERTAIN', 'uncertain', durationMs)
  }
  if (!Number.isSafeInteger(response.status)) {
    throw stageFailure('ERROR', 'malformed', durationMs)
  }
  if (response.status !== 0) throw stageFailure('ERROR', 'nonzero', durationMs)
  if (typeof response.stdout !== 'string' || typeof response.stderr !== 'string') {
    throw stageFailure('ERROR', 'malformed', durationMs)
  }
  if (Buffer.byteLength(response.stdout, 'utf8') > MAX_STAGE_OUTPUT_BYTES
    || Buffer.byteLength(response.stderr, 'utf8') > MAX_STAGE_OUTPUT_BYTES) {
    throw stageFailure('UNCERTAIN', 'uncertain', durationMs)
  }
  if (response.stderr !== '') throw stageFailure('UNCERTAIN', 'uncertain', durationMs)
  if (durationMs > D1_STAGE_TIMEOUT_MS[stage]) {
    throw stageFailure('TIMEOUT', 'timeout', durationMs)
  }
  return { stdout: response.stdout, durationMs: operationDurationMs }
}

function actualElapsed(state) {
  if (state.monotonicMs === undefined) return {
    stage: state.durationMs,
    overall: state.overallElapsedMs,
  }
  const overall = state.monotonicMs()
  return { stage: overall - state.stageStartedMs, overall }
}

function assertActualDeadline(state, timeoutMs, completion = false) {
  const actual = actualElapsed(state)
  if (completion ? actual.overall > D1_OVERALL_TIMEOUT_MS : actual.overall >= D1_OVERALL_TIMEOUT_MS) {
    throw stageFailure('TIMEOUT', 'overall_timeout', Math.max(1, actual.stage))
  }
  if (completion ? actual.stage > timeoutMs : actual.stage >= timeoutMs) {
    throw stageFailure('TIMEOUT', 'timeout', Math.max(1, actual.stage))
  }
  return actual
}

function callOperation({ bindings, transport, stage, operation }, state) {
  const timeoutMs = D1_STAGE_TIMEOUT_MS[stage]
  const actual = assertActualDeadline(state, timeoutMs)
  let response
  try {
    response = transport.execute(requestFor(
      bindings,
      stage,
      operation,
      actual.stage,
      actual.overall,
    ))
  } catch (error) {
    if (error instanceof StageFailure) throw error
    transportFailure(error, state.durationMs)
  }

  let result
  try {
    result = readTransportResponse(response, stage, state.durationMs)
  } catch (error) {
    if (error instanceof StageFailure) throw error
    throw stageFailure('ERROR', 'malformed', state.durationMs)
  }
  state.durationMs += result.durationMs
  state.overallElapsedMs += result.durationMs
  const after = actualElapsed(state)
  state.durationMs = Math.max(state.durationMs, after.stage)
  state.overallElapsedMs = Math.max(state.overallElapsedMs, after.overall)
  assertActualDeadline(state, timeoutMs, true)
  return result.stdout
}

function parseOperationOutput(stdout, state, parser, classification) {
  try {
    const value = parser(stdout)
    assertActualDeadline(state, state.timeoutMs, true)
    return value
  } catch (error) {
    if (error instanceof StageFailure) {
      error.durationMs = state.durationMs
      throw error
    }
    throw stageFailure('ERROR', classification, state.durationMs)
  }
}

function parseIdentity(stdout, bindings) {
  const value = parseJson(stdout, 'd1_identity_response_invalid')
  assertExactKeys(value, ['account_id', 'config_sha256', 'd1_database_id'], 'D1 identity response')
  assertSafeString(value.account_id, 'D1 account identity')
  assertHash(value.config_sha256, 'D1 config identity')
  assertSafeString(value.d1_database_id, 'D1 database identity')
  if (value.account_id !== bindings.account_id
    || value.config_sha256 !== bindings.config_sha256
    || value.d1_database_id !== bindings.d1_database_id) {
    throw stageFailure('NON_PASS', 'Manifest Drift')
  }
}

function parseQueryEnvelope(stdout, label) {
  const value = parseJson(stdout)
  if (!Array.isArray(value) || value.length !== 1) {
    throw stageFailure('ERROR', 'malformed')
  }
  const envelope = value[0]
  assertExactKeys(envelope, ['meta', 'results', 'success'], `${label} response`)
  if (envelope.success !== true || !Array.isArray(envelope.results)) {
    throw stageFailure('ERROR', 'malformed')
  }
  assertExactKeys(envelope.meta, ['duration'], `${label} metadata`)
  assertNonNegativeInteger(envelope.meta.duration, `${label} duration`)
  return envelope.results
}

function parseResetEnvelope(envelope) {
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

function parseResetResponse(stdout, mode) {
  const json = stdout.startsWith(RESET_RESPONSE_PREFIX)
    ? stdout.slice(RESET_RESPONSE_PREFIX.length)
    : stdout
  const value = parseJson(json, 'reset_response_invalid')
  if (!Array.isArray(value)) throw stageFailure('ERROR', 'reset_response_invalid')
  if (mode === 'remote') {
    if (value.length !== 1) throw stageFailure('ERROR', 'reset_response_invalid')
    parseResetEnvelope(value[0])
    return
  }
  if (value.length !== RESET_LOCAL_STATEMENT_COUNT) {
    throw stageFailure('ERROR', 'reset_response_invalid')
  }
  for (const envelope of value) {
    const results = parseQueryEnvelope(JSON.stringify([envelope]), 'local reset')
    if (results.length !== 0) throw stageFailure('ERROR', 'reset_response_invalid')
  }
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
    const normalized = normalizeMigration({
      checksum: migration.checksum,
      name: migration.name,
      number: migration.number,
    }, index, 'migration plan')
    if (normalized.number !== bindings.migrations[index].number
      || normalized.name !== bindings.migrations[index].name
      || normalized.checksum !== bindings.migrations[index].checksum) {
      throw stageFailure('NON_PASS', 'empty_only_plan_invalid')
    }
  }
}

function parseAppliedEntry(entry, expected, candidate, label) {
  assertExactKeys(entry, ['applied_at', 'candidate_id', 'checksum', 'name', 'number'], `${label} entry`)
  const normalized = normalizeMigration({
    checksum: entry.checksum,
    name: entry.name,
    number: entry.number,
  }, expected.number - 1, label)
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
  const value = parseJson(stdout, 'reconciliation_response_invalid')
  if (!isRecord(value)) throw stageFailure('ERROR', 'reconciliation_response_invalid')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string'
    || !['checks', 'drift_dimensions', 'state'].includes(key))) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  if (!Object.hasOwn(value, 'state') || !Object.hasOwn(value, 'checks')
    || !isRecord(value.checks)) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  const actualDimensions = Reflect.ownKeys(value.checks)
  if (actualDimensions.length !== D1_RECONCILIATION_DIMENSIONS.length
    || D1_RECONCILIATION_DIMENSIONS.some((dimension) => !actualDimensions.includes(dimension))) {
    throw stageFailure('NON_PASS', 'reconciliation_contract_invalid')
  }
  const driftDimensions = D1_RECONCILIATION_DIMENSIONS.filter((dimension) => (
    value.checks[dimension] !== 'matched'
  ))
  if (driftDimensions.some((dimension) => value.checks[dimension] !== 'drift')) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  if (Object.hasOwn(value, 'drift_dimensions')) {
    if (!Array.isArray(value.drift_dimensions)
      || JSON.stringify(value.drift_dimensions) !== JSON.stringify(driftDimensions)) {
      throw stageFailure('ERROR', 'reconciliation_response_invalid')
    }
  } else if (driftDimensions.length > 0) {
    throw stageFailure('ERROR', 'reconciliation_response_invalid')
  }
  if (value.state === 'matched' && driftDimensions.length === 0) return
  if (value.state !== 'drift' || driftDimensions.length === 0) {
    throw stageFailure('NON_PASS', 'reconciliation_drift')
  }
  throw stageFailure('NON_PASS', 'reconciliation_drift')
}

function runD1Identity(bindings, transport, overallElapsedMs, clock = {}) {
  const state = { durationMs: 0, overallElapsedMs, ...clock }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'd1_identity',
    operation: 'd1_identity',
  }, state)
  parseOperationOutput(stdout, state, (value) => parseIdentity(value, bindings), 'd1_identity_response_invalid')
  return state.durationMs
}

function runReset(bindings, transport, overallElapsedMs, clock = {}) {
  const state = { durationMs: 0, overallElapsedMs, ...clock }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'clean_start_reset',
    operation: 'clean_start_reset',
  }, state)
  parseOperationOutput(stdout, state, (value) => parseResetResponse(value, bindings.mode), 'reset_response_invalid')
  return state.durationMs
}

function runEmptyProof(bindings, transport, overallElapsedMs, clock = {}) {
  const state = { durationMs: 0, overallElapsedMs, ...clock }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'empty_d1_proof',
    operation: 'empty_d1_proof',
  }, state)
  parseOperationOutput(stdout, state, parseEmptyObjects, 'empty_d1_proof_invalid')
  return state.durationMs
}

function runMigrations(bindings, transport, overallElapsedMs, clock = {}) {
  const state = { durationMs: 0, overallElapsedMs, ...clock }
  const catalog = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_catalog',
  }, state)
  parseOperationOutput(catalog, state, (value) => parseCatalog(value, bindings), 'migration_contract_invalid')
  const plan = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_plan',
  }, state)
  parseOperationOutput(plan, state, (value) => parsePlan(value, bindings), 'empty_only_plan_invalid')
  const applied = callOperation({
    bindings,
    transport,
    stage: 'migrations_001_006',
    operation: 'migration_apply',
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
  }, state)
  parseOperationOutput(
    verified,
    state,
    (value) => parseMigrationState(value, bindings, 'verified', 'migration verify'),
    'migration_ledger_invalid',
  )
  return state.durationMs
}

function runReconciliation(bindings, transport, overallElapsedMs, clock = {}) {
  const state = { durationMs: 0, overallElapsedMs, ...clock }
  const stdout = callOperation({
    bindings,
    transport,
    stage: 'reconciliation',
    operation: 'reconciliation',
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

export function runD1Stages({ bindings: rawBindings, transport, elapsed_ms = 0, monotonic_ms }) {
  if (!Number.isSafeInteger(elapsed_ms) || elapsed_ms < 0 || elapsed_ms > D1_OVERALL_TIMEOUT_MS) {
    fail('elapsed_ms is invalid')
  }
  if (monotonic_ms !== undefined && typeof monotonic_ms !== 'function') fail('monotonic_ms is invalid')
  const bindings = normalizeBindings(rawBindings)
  validateTransport(transport)
  const bindingSha256 = d1StageBindingsSha256(bindings)
  const bindingMismatch = transport.bindings_sha256 !== undefined
    && transport.bindings_sha256 !== bindingSha256
  const stageCounts = Object.fromEntries(D1_STAGE_ORDER.map((stage) => [stage, 0]))
  const stageDurations = Object.fromEntries(D1_STAGE_ORDER.map((stage) => [stage, 0]))
  const trace = []
  let elapsedMs = elapsed_ms

  for (const stage of D1_STAGE_ORDER) {
    const stageStarted = monotonic_ms?.() ?? elapsedMs
    if (stageStarted >= D1_OVERALL_TIMEOUT_MS) {
      stageCounts[stage] += 1
      trace.push({ stage, outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: 1 })
      break
    }
    stageCounts[stage] += 1
    let outcome = 'PASS'
    let classification
    let durationMs = 0
    try {
      if (bindingMismatch) throw stageFailure('ERROR', 'transport_binding_mismatch')
      if (elapsedMs >= D1_OVERALL_TIMEOUT_MS) {
        throw stageFailure('TIMEOUT', 'overall_timeout')
      }
      durationMs = STAGE_RUNNERS[stage](bindings, transport, stageStarted, {
        monotonicMs: monotonic_ms,
        stageStartedMs: stageStarted,
        timeoutMs: D1_STAGE_TIMEOUT_MS[stage],
      })
      const measuredDuration = monotonic_ms === undefined ? durationMs : monotonic_ms() - stageStarted
      durationMs = Math.max(durationMs, measuredDuration)
      assertNonNegativeInteger(durationMs, `${stage} duration`)
      if ((monotonic_ms?.() ?? elapsedMs + durationMs) >= D1_OVERALL_TIMEOUT_MS) {
        throw stageFailure('TIMEOUT', 'overall_timeout', durationMs)
      }
      if (durationMs > D1_STAGE_TIMEOUT_MS[stage]) {
        throw stageFailure('TIMEOUT', 'timeout', durationMs)
      }
      elapsedMs += durationMs
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
  // Public/test-facing stage runners can only emit non-production evidence.
  // Production promotion belongs exclusively to execute's private real-adapter path.
  const evidenceSource = bindings.evidence_class === 'production'
    ? 'stage-runner-non-production'
    : bindings.evidence_class
  const production = false
  const traceSha256 = sha256(canonicalBytes(trace))
  const value = {
    format: 'blogman-issue-23-d1-stages/v1',
    outcome: terminal.outcome,
    first_terminal_stage: terminal.outcome === 'PASS' ? null : terminal.stage,
    failure: terminal.outcome === 'PASS' ? null : { classification: terminal.classification },
    stage_counts: stageCounts,
    stage_durations_ms: stageDurations,
    evidence: {
      source: evidenceSource,
      production,
      promotable: production && terminal.outcome === 'PASS',
      bindings_sha256: bindingSha256,
      wrangler_sha256: bindings.wrangler_sha256,
      manifest_sha256: bindings.manifest_sha256,
      authorization_sha256: bindings.authorization_sha256,
      attempt_id: bindings.attempt_id,
      account_id: bindings.account_id,
      d1_database_id: bindings.d1_database_id,
      config_sha256: bindings.config_sha256,
      candidate_id: bindings.candidate_id,
      reset_sql_sha256: bindings.reset_sql_sha256,
      migration_runner_sha256: bindings.migration_runner_sha256,
      migration_catalog_sha256: bindings.migration_catalog_sha256,
      rollout_safety_sha256: bindings.rollout_safety_sha256,
      expected_reconciliation_sha256: bindings.expected_reconciliation_sha256,
      trace_sha256: traceSha256,
    },
    finalized: true,
  }
  return serialize(value)
}
