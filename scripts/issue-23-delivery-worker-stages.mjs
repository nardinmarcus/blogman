import { createHash } from 'node:crypto'
import { parseStrictJson } from './issue-23-delivery-d1-contracts.mjs'

export const WORKER_STAGE_ORDER = Object.freeze(['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'])
const TIMEOUT_MS = Object.freeze({ worker_deploy: 600000, version_traffic_verification: 300000, smoke_control_t0: 300000 })
const OVERALL_TIMEOUT_MS = 5400000
const DIMENSIONS = Object.freeze(['schema', 'migration_ledger', 'post_count', 'post_status', 'post_content'])
const UPLOAD_KEYS = Object.freeze([
  'format', 'state', 'upload_operation_id', 'version_id', 'config_sha256',
  'snapshot_tree_sha256', 'snapshot_identity_sha256', 'snapshot_proof_before_sha256',
  'snapshot_proof_after_sha256', 'build_directory_proof_sha256', 'wrangler_output_sha256',
  'upload_stdout_sha256', 'upload_stderr_sha256',
])
const EVIDENCE_HASHES = Object.freeze([
  'upload_acceptance_sha256', 'upload_stdout_sha256', 'upload_stderr_sha256',
  'wrapper_stderr_sha256', 'version_traffic_sha256', 'smoke_control_t0_sha256',
])
const EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  'manifest_sha256', 'authorization_sha256', 'attempt_id', 'candidate_id',
])

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function bytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8') }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]+$/u.test(value) }
function sha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }

export class WorkerTransportError extends Error {
  constructor(outcome = 'UNCERTAIN', classification = 'worker_adapter_uncertain', duration_ms = 1, uploadStdoutSha256 = null, uploadStderrSha256 = null) {
    super('worker transport failed')
    this.outcome = ['NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(outcome) ? outcome : 'UNCERTAIN'
    this.classification = classification
    this.duration_ms = Number.isSafeInteger(duration_ms) && duration_ms > 0 ? duration_ms : 1
    // Issue #158: the durable upload child evidence references ride the error
    // so the failure receipt can keep them retrievable after the temp tree is
    // cleaned; only well-formed sha256 references are accepted.
    if (sha256(uploadStdoutSha256)) this.upload_stdout_sha256 = uploadStdoutSha256
    if (sha256(uploadStderrSha256)) this.upload_stderr_sha256 = uploadStderrSha256
  }
}

function emptyEvidenceHashes() {
  return Object.fromEntries(EVIDENCE_HASHES.map((name) => [name, null]))
}

function terminal(trace, evidenceHashes, mutation_counts, identity) {
  const last = trace.at(-1)
  // Public/test-facing stage runners can only emit non-production evidence.
  // Production promotion belongs exclusively to execute's private real-adapter path.
  const production = false
  const hashes = { ...evidenceHashes }
  // Issue #158: on the failure path the bounded upload child references arrive
  // on the terminal trace entry (when the child actually ran); on the success
  // path they were copied from the acceptance record. Later-stage failures keep
  // the worker_deploy references already accumulated from the acceptance.
  if (last.outcome !== 'PASS') {
    if (last.upload_stdout_sha256 !== undefined) hashes.upload_stdout_sha256 = last.upload_stdout_sha256
    if (last.upload_stderr_sha256 !== undefined) hashes.upload_stderr_sha256 = last.upload_stderr_sha256
    // Issue #168: the wrapper's own stderr identity (the supervisor-captured
    // bounded bytes containing the wrapper-failure record) rides the terminal
    // receipt so the failure bytes stay referenced after the temp tree is gone.
    if (last.wrapper_stderr_sha256 !== undefined) hashes.wrapper_stderr_sha256 = last.wrapper_stderr_sha256
  }
  const value = {
    format: 'blogman-issue-23-worker-stages/v1', outcome: last.outcome,
    first_terminal_stage: last.outcome === 'PASS' ? null : last.stage,
    failure: last.outcome === 'PASS' ? null : { classification: last.classification },
    stage_counts: Object.fromEntries(WORKER_STAGE_ORDER.map((stage) => [stage, trace.filter((entry) => entry.stage === stage).length])),
    stage_durations_ms: Object.fromEntries(WORKER_STAGE_ORDER.map((stage) => [stage, trace.filter((entry) => entry.stage === stage).reduce((sum, entry) => sum + entry.duration_ms, 0)])),
    mutation_counts,
    evidence: {
      source: 'stage-runner-non-production',
      production,
      promotable: production && last.outcome === 'PASS',
      ...identity,
      hashes,
    },
    finalized: true,
  }
  const serialized = bytes(value)
  return { value, bytes: serialized, sha256: hash(serialized) }
}

function response(value) {
  if (!exact(value, ['status', 'stdout', 'stderr', 'duration_ms'])
    || !Number.isSafeInteger(value.duration_ms) || value.duration_ms <= 0
    || !Number.isSafeInteger(value.status) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string') {
    return null
  }
  if (value.status !== 0 || value.stderr !== '') return { error: true, duration_ms: value.duration_ms }
  try {
    return { value: parseStrictJson(value.stdout), duration_ms: value.duration_ms }
  } catch {
    return { malformed: true, duration_ms: value.duration_ms }
  }
}

function transportResult(transport, request) {
  try {
    const parsed = response(transport.execute(request))
    if (parsed?.malformed) {
      return { failure: { outcome: 'ERROR', classification: 'worker_response_malformed' }, duration_ms: parsed.duration_ms }
    }
    if (parsed) return parsed
  } catch (error) {
    if (error instanceof WorkerTransportError) {
      const failure = { outcome: error.outcome, classification: error.classification }
      // Issue #158: carry the durable upload child evidence references through
      // the failure so the receipt can keep them retrievable.
      if (error.upload_stdout_sha256 !== undefined) failure.upload_stdout_sha256 = error.upload_stdout_sha256
      if (error.upload_stderr_sha256 !== undefined) failure.upload_stderr_sha256 = error.upload_stderr_sha256
      if (error.wrapper_stderr_sha256 !== undefined) failure.wrapper_stderr_sha256 = error.wrapper_stderr_sha256
      return { failure, duration_ms: error.duration_ms }
    }
  }
  return { failure: { outcome: 'UNCERTAIN', classification: 'worker_adapter_uncertain' }, duration_ms: 1 }
}

function deploymentMatches(value, version, d1DatabaseId) {
  return exact(value, ['deployment_id', 'version_id', 'd1_database_id', 'traffic'])
    && safeId(value.deployment_id)
    && value.version_id === version
    && value.d1_database_id === d1DatabaseId
    && Array.isArray(value.traffic)
    && value.traffic.length === 1
    && exact(value.traffic[0], ['version_id', 'percentage'])
    && value.traffic[0].version_id === version
    && value.traffic[0].percentage === 100
}

/** Private suffix seam. A response has only public facts; raw adapter output never escapes. */
export function runWorkerStages({ bindings, transport, elapsed_ms = 0, monotonic_ms, initial_stage_started_ms }) {
  if (monotonic_ms !== undefined && typeof monotonic_ms !== 'function') throw new Error('monotonic_ms is invalid')
  if (initial_stage_started_ms !== undefined
    && (!Number.isSafeInteger(initial_stage_started_ms) || initial_stage_started_ms < 0)) {
    throw new Error('initial_stage_started_ms is invalid')
  }
  const identity = Object.fromEntries(EVIDENCE_IDENTITY_FIELDS.map((field) => [field, bindings?.[field]]))
  if (!EVIDENCE_IDENTITY_FIELDS.slice(0, 3).every((field) => sha256(identity[field]))
    || typeof identity.candidate_id !== 'string' || !/^[a-f0-9]{40}$/u.test(identity.candidate_id)) {
    throw new Error('worker evidence identity is invalid')
  }
  const trace = []
  const evidenceHashes = emptyEvidenceHashes()
  const mutation_counts = { attempted: 0, confirmed: 0 }
  let elapsed = elapsed_ms
  let version
  let deployment
  let firstStage = true
  for (const stage of WORKER_STAGE_ORDER) {
    // The first Stage clock may be seeded by the caller so Stage-owned setup
    // (materialization, binding derivation, transport construction) is accounted
    // inside the Stage duration and its child budget.
    const stageStarted = firstStage && initial_stage_started_ms !== undefined
      ? initial_stage_started_ms
      : monotonic_ms?.() ?? elapsed
    firstStage = false
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || stageStarted >= OVERALL_TIMEOUT_MS) {
      trace.push({ stage, outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: 1 })
      break
    }
    if (stage === 'worker_deploy') mutation_counts.attempted += 1
    if (stage === 'version_traffic_verification') mutation_counts.attempted += 1
    const parsed = transportResult(transport, {
      operation: stage,
      stage,
      timeout_ms: TIMEOUT_MS[stage],
      elapsed_ms: elapsed,
      version_id: version,
      deployment_id: deployment,
    })
    const measuredDuration = monotonic_ms === undefined ? parsed.duration_ms : monotonic_ms() - stageStarted
    parsed.duration_ms = Math.max(parsed.duration_ms, measuredDuration)
    elapsed += parsed.duration_ms
    if (parsed.failure) {
      trace.push({ stage, ...parsed.failure, duration_ms: parsed.duration_ms })
      break
    }
    if (elapsed >= OVERALL_TIMEOUT_MS) {
      trace.push({ stage, outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: parsed.duration_ms })
      break
    }
    if (parsed.duration_ms > TIMEOUT_MS[stage]) {
      trace.push({ stage, outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: parsed.duration_ms })
      break
    }
    if (stage === 'worker_deploy') {
      if (!exact(parsed.value, UPLOAD_KEYS)
        || parsed.value.format !== 'blogman-upload-source-lifecycle-acceptance/v1'
        || parsed.value.state !== 'accepted'
        || parsed.value.upload_operation_id !== `issue-23-${bindings.candidate_id}-upload-1`
        || !safeId(parsed.value.version_id)
        || ![
          'config_sha256', 'snapshot_tree_sha256', 'snapshot_identity_sha256',
          'snapshot_proof_before_sha256', 'snapshot_proof_after_sha256',
          'build_directory_proof_sha256', 'wrangler_output_sha256',
          'upload_stdout_sha256', 'upload_stderr_sha256',
        ].every((key) => sha256(parsed.value[key]))
        || parsed.value.config_sha256 !== bindings.config_sha256
        || parsed.value.snapshot_tree_sha256 !== bindings.delivery_snapshot_sha256) {
        trace.push({ stage, outcome: 'ERROR', classification: 'upload_contract_invalid', duration_ms: parsed.duration_ms })
        break
      }
      version = parsed.value.version_id
      mutation_counts.confirmed += 1
      evidenceHashes.upload_acceptance_sha256 = hash(bytes(parsed.value))
      // Issue #158: the acceptance object already binds the bounded upload child
      // stdout/stderr hashes; mirror them onto the receipt evidence so the
      // durable upload evidence files stay referenced on the success path too.
      evidenceHashes.upload_stdout_sha256 = parsed.value.upload_stdout_sha256
      evidenceHashes.upload_stderr_sha256 = parsed.value.upload_stderr_sha256
    } else if (stage === 'version_traffic_verification') {
      if (!deploymentMatches(parsed.value, version, bindings.d1_database_id)) {
        trace.push({ stage, outcome: 'NON_PASS', classification: 'version_traffic_mismatch', duration_ms: parsed.duration_ms })
        break
      }
      deployment = parsed.value.deployment_id
      mutation_counts.confirmed += 1
      evidenceHashes.version_traffic_sha256 = hash(bytes(parsed.value))
    } else {
      const expectedChecks = Object.fromEntries(bindings.smoke.requests.map(({ path, status }) => [path, status]))
      if (!exact(parsed.value, ['before', 'after', 'checks', 'controls', 'reconciliation'])
        || !deploymentMatches(parsed.value.before, version, bindings.d1_database_id)
        || parsed.value.before.deployment_id !== deployment
        || !deploymentMatches(parsed.value.after, version, bindings.d1_database_id)
        || parsed.value.after.deployment_id !== deployment
        || !exact(parsed.value.checks, Object.keys(expectedChecks))
        || JSON.stringify(parsed.value.checks) !== JSON.stringify(expectedChecks)
        || !exact(parsed.value.controls, ['producer', 'authority', 'executors'])
        || parsed.value.controls.producer !== 'disabled'
        || parsed.value.controls.authority !== 'disabled'
        || !record(parsed.value.controls.executors)
        || Object.keys(parsed.value.controls.executors).length === 0
        || Object.values(parsed.value.controls.executors).some((state) => state !== 'disabled')
        || !exact(parsed.value.reconciliation, ['state', 'checks'])
        || parsed.value.reconciliation.state !== 'matched'
        || !exact(parsed.value.reconciliation.checks, DIMENSIONS)
        || DIMENSIONS.some((dimension) => parsed.value.reconciliation.checks[dimension] !== 'matched')) {
        trace.push({ stage, outcome: 'NON_PASS', classification: 'smoke_control_contract_invalid', duration_ms: parsed.duration_ms })
        break
      }
      evidenceHashes.smoke_control_t0_sha256 = hash(bytes(parsed.value))
    }
    trace.push({ stage, outcome: 'PASS', duration_ms: parsed.duration_ms })
  }
  return terminal(trace, evidenceHashes, mutation_counts, identity)
}
