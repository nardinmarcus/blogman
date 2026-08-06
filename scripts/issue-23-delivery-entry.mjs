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
const DELIVERY_STAGES = Object.freeze([
  'authorization_accept',
  'live_preconditions',
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
  'worker_deploy',
  'version_traffic_verification',
  'smoke_control_t0',
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
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedJsonValue(value[key])]))
  }
  return value
}

function sameJsonValue(left, right) {
  return JSON.stringify(normalizedJsonValue(left)) === JSON.stringify(normalizedJsonValue(right))
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
  for (const stage of DELIVERY_STAGES.slice(1)) {
    const result = runSyntheticStage(stage)
    const entry = {
      stage,
      outcome: result.outcome,
      ...(result.classification ? { classification: result.classification } : {}),
      duration_ms: result.duration_ms,
    }
    trace.push(entry)
    if (result.outcome !== 'PASS') break
  }
  const terminal = trace.at(-1)
  if (!terminal || terminal.outcome !== 'NON_PASS') fail('synthetic prefix did not terminate')
  const value = {
    format: TERMINAL_RESULT_FORMAT,
    identities,
    attempt_id: attemptId,
    authorization_consumed: true,
    outcome: 'NON_PASS',
    first_terminal_stage: terminal.stage,
    failure: { classification: terminal.classification },
    stage_counts: stageCounts(trace),
    stage_durations_ms: stageDurations(trace),
    mutation_counts: { production_writes: 0 },
    evidence: { source: 'synthetic', hashes: [sha256(canonicalJsonBytes(trace))] },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  return { value, bytes, sha256: sha256(bytes) }
}
