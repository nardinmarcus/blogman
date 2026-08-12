import { createHash } from 'node:crypto'
import { existsSync, readFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { D1ChildError, runBoundedChild } from './issue-23-delivery-d1-child.mjs'
import { WorkerTransportError } from './issue-23-delivery-worker-stages.mjs'

const OVERALL_TIMEOUT_MS = 5400000
const MAX_OUTPUT_BYTES = 64 * 1024
const SMOKE_PATHS = Object.freeze([
  ['/api/search', 200],
  ['/api/settings/appearance', 200],
  ['/api/settings/tokens', 200],
  ['/api/settings/ai-provider', 200],
  ['/api/settings/ai-generators', 200],
  ['/api/admin/articles/__blogman_smoke_absent__', 404],
])
const RECONCILIATION_DIMENSIONS = Object.freeze(['schema', 'migration_ledger', 'post_count', 'post_status', 'post_content'])

function fail(message) { throw new Error(`Issue #23 worker transport: ${message}`) }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]+$/u.test(value) }
function sha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function parseJson(stdout, label, duration_ms = 1) {
  try { return JSON.parse(stdout) } catch { throw new WorkerTransportError('ERROR', `${label}_malformed`, duration_ms) }
}

function assertPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) fail(`${label} is invalid`)
}
function assertHash(value, label) { if (!sha256(value)) fail(`${label} is invalid`) }
function assertBoundFile(path, expectedHash) {
  if (!existsSync(path) || hash(readFileSync(path)) !== expectedHash) {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
  return path
}
function response(stdout, duration_ms) {
  return { status: 0, stdout: JSON.stringify(stdout), stderr: '', duration_ms }
}
function childFailure(error) {
  if (error instanceof D1ChildError) {
    const duration = Math.max(1, error.durationMs)
    if (error.classification === 'timeout') return new WorkerTransportError('TIMEOUT', 'stage_timeout', duration)
    if (error.classification === 'nonzero') return new WorkerTransportError('ERROR', 'worker_adapter_nonzero', duration)
    return new WorkerTransportError('UNCERTAIN', 'worker_adapter_uncertain', duration)
  }
  return new WorkerTransportError('UNCERTAIN', 'worker_adapter_uncertain', 1)
}

function parseDeployment(stdout, version, d1_database_id, duration_ms = 1) {
  const value = parseJson(stdout, 'deployment_status', duration_ms)
  if (!record(value) || !safeId(value.id) || !Array.isArray(value.versions)
    || value.versions.length !== 1 || !exact(value.versions[0], ['version_id', 'percentage'])
    || value.versions[0].version_id !== version || value.versions[0].percentage !== 100) {
    throw new WorkerTransportError('NON_PASS', 'version_traffic_mismatch', duration_ms)
  }
  return { deployment_id: value.id, version_id: version, d1_database_id, traffic: [{ version_id: version, percentage: 100 }] }
}
function parseD1Identity(stdout, expected, duration_ms = 1) {
  const value = parseJson(stdout, 'd1_identity', duration_ms)
  if (!record(value) || value.uuid !== expected) throw new WorkerTransportError('NON_PASS', 'Manifest Drift', duration_ms)
  return expected
}
function parseControls(stdout, duration_ms = 1) {
  const value = parseJson(stdout, 'rollout_controls', duration_ms)
  const controls = exact(value, ['state', 'producer', 'authority', 'executors'])
    ? value
    : record(value) && exact(value.controls, ['producer', 'authority', 'executors']) && value.state === 'captured'
      ? { state: value.state, ...value.controls }
      : null
  if (!controls || controls.state !== 'captured' || controls.producer !== 'disabled'
    || controls.authority !== 'disabled' || !record(controls.executors)
    || Object.keys(controls.executors).length === 0
    || Object.values(controls.executors).some((state) => state !== 'disabled')) {
    throw new WorkerTransportError('NON_PASS', 'smoke_control_contract_invalid', duration_ms)
  }
  return { producer: controls.producer, authority: controls.authority, executors: controls.executors }
}
function parseReconciliation(stdout, duration_ms = 1) {
  const value = parseJson(stdout, 'reconciliation', duration_ms)
  if (!exact(value, ['state', 'checks']) || value.state !== 'matched'
    || !exact(value.checks, RECONCILIATION_DIMENSIONS)
    || RECONCILIATION_DIMENSIONS.some((key) => value.checks[key] !== 'matched')) {
    throw new WorkerTransportError('NON_PASS', 'smoke_control_contract_invalid', duration_ms)
  }
  return { state: value.state, checks: value.checks }
}

/** Private adapter. It emits only bounded, public terminal facts. */
export function createWorkerTransport(bindings) {
  if (!bindings || typeof bindings !== 'object') fail('bindings are required')
  for (const key of [
    'config_path', 'config_sha256', 'artifact_archive_path', 'artifact_archive_sha256',
    'artifact_source_path', 'artifact_sha256', 'candidate_id', 'worker_name', 'd1_database_id',
    'rollout_safety_path', 'rollout_safety_sha256', 'expected_reconciliation_path',
    'wrangler_path', 'wrangler_sha256', 'database', 'origin', 'smoke', 'baseline',
  ]) if (!Object.hasOwn(bindings, key)) fail(`${key} is required`)
  for (const key of [
    'config_path', 'artifact_archive_path', 'artifact_source_path', 'rollout_safety_path',
    'expected_reconciliation_path', 'wrangler_path',
  ]) assertPath(bindings[key], key)
  for (const key of [
    'config_sha256', 'artifact_archive_sha256', 'artifact_sha256', 'rollout_safety_sha256', 'wrangler_sha256',
  ]) assertHash(bindings[key], key)
  if (!safeId(bindings.candidate_id) || !safeId(bindings.worker_name) || !safeId(bindings.d1_database_id)
    || !safeId(bindings.database) || typeof bindings.origin !== 'string' || !Array.isArray(bindings.smoke?.requests)
    || !exact(bindings.baseline, ['deployment_id', 'version_id', 'd1_database_id', 'traffic'])
    || !safeId(bindings.baseline.deployment_id) || !safeId(bindings.baseline.version_id)
    || bindings.baseline.d1_database_id !== bindings.d1_database_id
    || !Array.isArray(bindings.baseline.traffic) || bindings.baseline.traffic.length !== 1
    || !exact(bindings.baseline.traffic[0], ['version_id', 'percentage'])
    || bindings.baseline.traffic[0].version_id !== bindings.baseline.version_id
    || bindings.baseline.traffic[0].percentage !== 100
    || JSON.stringify(bindings.smoke.requests) !== JSON.stringify(SMOKE_PATHS.map(([path, status]) => ({ path, status })))) {
    fail('bindings are invalid')
  }
  const origin = new URL(bindings.origin)
  if (!['http:', 'https:'].includes(origin.protocol)) fail('origin is invalid')

  function validateLocalBindings() {
    assertBoundFile(bindings.config_path, bindings.config_sha256)
    assertBoundFile(bindings.artifact_archive_path, bindings.artifact_archive_sha256)
    assertBoundFile(bindings.rollout_safety_path, bindings.rollout_safety_sha256)
    assertBoundFile(bindings.wrangler_path, bindings.wrangler_sha256)
    if (!existsSync(bindings.artifact_source_path) || !existsSync(bindings.expected_reconciliation_path)) {
      throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
    }
  }

  function invoke(executable, args, request, spent) {
    const remaining = Math.min(request.timeout_ms - spent, OVERALL_TIMEOUT_MS - request.elapsed_ms - spent)
    if (!Number.isSafeInteger(remaining) || remaining <= 0) {
      throw new WorkerTransportError('TIMEOUT', 'overall_timeout', 1)
    }
    try {
      const result = runBoundedChild(executable, args, remaining, MAX_OUTPUT_BYTES, process.cwd())
      if (result.stderr !== '') throw new WorkerTransportError('UNCERTAIN', 'worker_adapter_uncertain', result.duration_ms)
      return result
    } catch (error) {
      if (error instanceof WorkerTransportError) throw error
      throw childFailure(error)
    }
  }

  function deploymentStatus(request, spent, version) {
    const result = invoke(
      bindings.wrangler_path,
      ['deployments', 'status', '--name', bindings.worker_name, '--config', bindings.config_path, '--json'],
      request,
      spent,
    )
    return { value: parseDeployment(result.stdout, version, bindings.d1_database_id, result.duration_ms), duration_ms: result.duration_ms }
  }
  function d1Identity(request, spent) {
    const result = invoke(
      bindings.wrangler_path,
      ['d1', 'info', bindings.database, '--config', bindings.config_path, '--json'],
      request,
      spent,
    )
    parseD1Identity(result.stdout, bindings.d1_database_id, result.duration_ms)
    return result.duration_ms
  }

  function livePreconditions() {
    const request = { timeout_ms: 120000, elapsed_ms: 0 }
    try {
      validateLocalBindings()
      const baseline = deploymentStatus(request, 0, bindings.baseline.version_id)
      if (baseline.value.deployment_id !== bindings.baseline.deployment_id) {
        throw new WorkerTransportError('NON_PASS', 'Manifest Drift', baseline.duration_ms)
      }
      const identityDuration = d1Identity(request, baseline.duration_ms)
      return { outcome: 'PASS', duration_ms: baseline.duration_ms + identityDuration }
    } catch (error) {
      const failure = error instanceof WorkerTransportError
        ? error
        : new WorkerTransportError('UNCERTAIN', 'live_preconditions_uncertain', 1)
      return { outcome: failure.outcome, classification: failure.classification, duration_ms: failure.duration_ms }
    }
  }

  return Object.freeze({ livePreconditions, execute(request) {
    if (!exact(request, ['operation', 'stage', 'timeout_ms', 'elapsed_ms', 'version_id', 'deployment_id'])
      || request.operation !== request.stage || !['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'].includes(request.operation)
      || !Number.isSafeInteger(request.timeout_ms) || !Number.isSafeInteger(request.elapsed_ms)
      || request.timeout_ms <= 0 || request.elapsed_ms < 0) fail('request is invalid')
    validateLocalBindings()
    if (request.operation === 'worker_deploy') {
      const root = mkdtempSync(join(tmpdir(), 'blogman-issue-91-upload-'))
      chmodSync(root, 0o700)
      try {
        const output = join(root, 'upload.jsonl')
        const before = join(root, 'before.json')
        const after = join(root, 'after.json')
        const proof = join(root, 'proof.json')
        const destination = join(root, 'source')
        for (const path of [output, before, after, proof]) writeFileSync(path, '', { mode: 0o600 })
        const result = invoke(process.execPath, [
          'scripts/phase-b-sequence.mjs', 'run-upload-source-lifecycle',
          '--config', bindings.config_path, '--source', bindings.artifact_source_path,
          '--destination', destination, '--operation-id', `issue-23-${bindings.candidate_id}-upload-1`,
          '--proof-before', before, '--proof-after', after, '--archive', bindings.artifact_archive_path,
          '--archive-sha256', bindings.artifact_archive_sha256, '--build-proof', proof,
          '--expected-config-sha256', bindings.config_sha256,
        ], request, 0)
        return response(parseJson(result.stdout, 'upload_acceptance', result.duration_ms), result.duration_ms)
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
    if (request.operation === 'version_traffic_verification') {
      if (!safeId(request.version_id)) throw new WorkerTransportError('ERROR', 'worker_adapter_uncertain')
      let spent = 0
      const deploy = invoke(bindings.wrangler_path, [
        'versions', 'deploy', `${request.version_id}@100%`, '-y', '--config', bindings.config_path,
      ], request, spent)
      spent += deploy.duration_ms
      const status = deploymentStatus(request, spent, request.version_id)
      spent += status.duration_ms
      const identityDuration = d1Identity(request, spent)
      spent += identityDuration
      return response(status.value, spent)
    }
    if (!safeId(request.version_id) || !safeId(request.deployment_id)) {
      throw new WorkerTransportError('ERROR', 'worker_adapter_uncertain')
    }
    let spent = 0
    const before = deploymentStatus(request, spent, request.version_id)
    spent += before.duration_ms
    if (before.value.deployment_id !== request.deployment_id) throw new WorkerTransportError('NON_PASS', 'version_traffic_mismatch', spent)
    spent += d1Identity(request, spent)
    const checks = {}
    for (const { path, status } of bindings.smoke.requests) {
      const url = new URL(path, origin).toString()
      const requestResult = invoke('curl', [
        '--request', 'GET', '--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', url,
      ], request, spent)
      spent += requestResult.duration_ms
      if (requestResult.stdout !== String(status)) {
        throw new WorkerTransportError('NON_PASS', 'smoke_control_contract_invalid', spent)
      }
      checks[path] = status
    }
    const after = deploymentStatus(request, spent, request.version_id)
    spent += after.duration_ms
    if (after.value.deployment_id !== request.deployment_id) throw new WorkerTransportError('NON_PASS', 'version_traffic_mismatch', spent)
    spent += d1Identity(request, spent)
    const controlsResult = invoke(process.execPath, [
      bindings.rollout_safety_path, 'rollout', 'controls-status', '--database', bindings.database,
      '--remote', '--config', bindings.config_path,
    ], request, spent)
    spent += controlsResult.duration_ms
    const controls = parseControls(controlsResult.stdout, controlsResult.duration_ms)
    const reconciliationResult = invoke(process.execPath, [
      bindings.rollout_safety_path, 'reconcile', 'compare', '--expected', bindings.expected_reconciliation_path,
      '--database', bindings.database, '--remote', '--config', bindings.config_path,
    ], request, spent)
    spent += reconciliationResult.duration_ms
    return response({ before: before.value, after: after.value, checks, controls, reconciliation: parseReconciliation(reconciliationResult.stdout, reconciliationResult.duration_ms) }, spent)
  } })
}
