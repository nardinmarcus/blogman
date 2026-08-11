import { createHash } from 'node:crypto'
import { runSyntheticStage } from './issue-23-delivery-synthetic-adapter.mjs'

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

export function execute(manifest, authorization) {
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
