import { createHash } from 'node:crypto'
import { readFileSync, chmodSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { D1ChildError } from './issue-23-delivery-d1-child.mjs'
import { parseStrictJson, comparePathSegments } from './issue-23-delivery-d1-contracts.mjs'
import { WorkerTransportError } from './issue-23-delivery-worker-stages.mjs'

const OVERALL_TIMEOUT_MS = 5400000
const MAX_OUTPUT_BYTES = 64 * 1024
const SMOKE_PATHS = Object.freeze([
  ['/api/search', 200],
  ['/api/settings/appearance', 200],
  ['/api/admin/tokens', 200],
  ['/api/admin/ai-provider', 200],
  ['/api/admin/ai-post-generators', 200],
  ['/api/admin/posts/__blogman_smoke_absent__', 404],
])
const RECONCILIATION_DIMENSIONS = Object.freeze(['schema', 'migration_ledger', 'post_count', 'post_status', 'post_content'])
const ARTIFACT_FILE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._/-]+$/u

function fail(message) { throw new Error(`Issue #23 worker transport: ${message}`) }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]+$/u.test(value) }
function sha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }

export const FORMAL_REHEARSAL_WORKER_EVIDENCE_SOURCE = 'formal-rehearsal-test-evidence'

function parseJson(stdout, label, duration_ms = 1) {
  try { return parseStrictJson(stdout) } catch { throw new WorkerTransportError('ERROR', `${label}_malformed`, duration_ms) }
}

function assertPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) fail(`${label} is invalid`)
}
function assertHash(value, label) { if (!sha256(value)) fail(`${label} is invalid`) }
function assertBoundDirectory(path, label) {
  try {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory() || realpathSync(path) !== path) {
      throw new Error('drift')
    }
  } catch {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
}
function assertBoundFile(path, expectedHash) {
  try {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || hash(readFileSync(path)) !== expectedHash) {
      throw new Error('drift')
    }
  } catch {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
  return path
}
function artifactFile(value) {
  return exact(value, ['path', 'sha256', 'bytes'])
    && typeof value.path === 'string' && ARTIFACT_FILE_PATH_PATTERN.test(value.path)
    && sha256(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0
}
function validateArtifactSource(bindings) {
  const sourcePath = resolve(bindings.artifact_source_path)
  const archivePath = resolve(bindings.artifact_archive_path)
  if (dirname(archivePath) !== sourcePath) {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
  if (!Array.isArray(bindings.artifact_file_tree_files)
    || !bindings.artifact_file_tree_files.every(artifactFile)
    || JSON.stringify(bindings.artifact_file_tree_files) !== JSON.stringify([...bindings.artifact_file_tree_files].sort((left, right) => comparePathSegments(left.path, right.path)))
    || hash(Buffer.from(JSON.stringify(bindings.artifact_file_tree_files))) !== bindings.artifact_file_tree_sha256) {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
  const actual = []
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePathSegments(left.name, right.name))) {
      const path = join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (path === archivePath) continue
      if (entry.isSymbolicLink()) throw new Error('symlink')
      if (entry.isDirectory()) visit(path, relative)
      else if (entry.isFile()) actual.push({
        path: `.open-next/${relative}`,
        sha256: hash(readFileSync(path)),
        bytes: statSync(path).size,
      })
      else throw new Error('unsupported')
    }
  }
  try {
    if (lstatSync(bindings.artifact_source_path).isSymbolicLink() || !statSync(bindings.artifact_source_path).isDirectory()) {
      throw new Error('source')
    }
    visit(bindings.artifact_source_path)
  } catch {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
  const sourceFiles = bindings.artifact_file_tree_files.filter((file) => file.path.startsWith('.open-next/'))
  if (JSON.stringify(actual) !== JSON.stringify(sourceFiles)) {
    throw new WorkerTransportError('NON_PASS', 'Manifest Drift')
  }
}
function response(stdout, duration_ms) {
  return { status: 0, stdout: JSON.stringify(stdout), stderr: '', duration_ms }
}
function formalFaultResultForLivePreconditions(fault) {
  if (fault?.stage !== 'live_preconditions') return null
  if (fault.kind === 'failure') {
    return { outcome: 'NON_PASS', classification: 'formal_rehearsal_forced_failure', duration_ms: 1 }
  }
  if (fault.kind === 'timeout') {
    return { outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: 1 }
  }
  if (fault.kind === 'malformed') return { outcome: 'MALFORMED', duration_ms: 1 }
  if (fault.kind === 'drift') return { outcome: 'NON_PASS', classification: 'Manifest Drift', duration_ms: 1 }
  return { outcome: 'UNCERTAIN', classification: 'formal_rehearsal_uncertain', duration_ms: 1 }
}
function makeTransportTreeRemovable(path) {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) return
  if (entry.isDirectory()) {
    chmodSync(path, 0o700)
    let failure
    for (const name of readdirSync(path)) {
      try {
        makeTransportTreeRemovable(join(path, name))
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
    return
  }
  if (!entry.isFile() || entry.nlink !== 1) throw new Error('transport cleanup encountered an unsafe file')
  chmodSync(path, 0o600)
}
function removeTransportTree(root) {
  let failure
  try {
    makeTransportTreeRemovable(root)
  } catch (error) {
    failure = error
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch (error) {
    failure ??= error
  }
  if (failure) throw new WorkerTransportError('UNCERTAIN', 'worker_adapter_uncertain', 1)
}
function childFailure(error, timeoutClassification = 'stage_timeout') {
  if (error instanceof D1ChildError) {
    const duration = Math.max(1, error.durationMs)
    if (error.classification === 'timeout') return new WorkerTransportError('TIMEOUT', timeoutClassification, duration)
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

// These are the production request-to-command constructors. Formal rehearsal
// invokes exactly these functions and replaces only their process/network I/O.
function deploymentStatusCommand(bindings) {
  return Object.freeze({ executable: bindings.wrangler_path, args: Object.freeze([
    'deployments', 'status', '--name', bindings.worker_name, '--config', bindings.config_path, '--json',
  ]) })
}
function d1IdentityCommand(bindings) {
  return Object.freeze({ executable: bindings.wrangler_path, args: Object.freeze([
    'd1', 'info', bindings.database, '--config', bindings.config_path, '--json',
  ]) })
}
function versionDeployCommand(bindings, versionId) {
  return Object.freeze({ executable: bindings.wrangler_path, args: Object.freeze([
    'versions', 'deploy', `${versionId}@100%`, '-y', '--config', bindings.config_path,
  ]) })
}
function smokeCommand(bindings, url) {
  return Object.freeze({ executable: bindings.curl_path, args: Object.freeze([
    '--disable', '--config', '-', '--request', 'GET', '--silent', '--show-error',
    '--output', '/dev/null', '--write-out', '%{http_code}', url,
  ]) })
}
function smokeStdin(credential) {
  return Buffer.from(`header = "Cookie: blogman_admin=${credential}"\n`, 'utf8')
}
function controlsCommand(bindings) {
  return Object.freeze({ executable: bindings.node_path, args: Object.freeze([
    bindings.rollout_safety_path, 'rollout', 'controls-status', '--database', bindings.database,
    '--remote', '--config', bindings.config_path,
  ]) })
}
function reconciliationCommand(bindings) {
  return Object.freeze({ executable: bindings.node_path, args: Object.freeze([
    bindings.rollout_safety_path, 'reconcile', 'compare', '--expected', bindings.expected_reconciliation_path,
    '--database', bindings.database, '--remote', '--config', bindings.config_path,
  ]) })
}
function uploadCommand(bindings, paths) {
  return Object.freeze({ executable: bindings.node_path, args: Object.freeze([
    bindings.worker_upload_entry_path, 'run-upload-source-lifecycle',
    '--node-path', bindings.node_path, '--node-sha256', bindings.node_sha256,
    '--npm-path', bindings.npm_path, '--npm-sha256', bindings.npm_sha256,
    '--open-next-path', bindings.open_next_path, '--open-next-sha256', bindings.open_next_sha256,
    '--working-directory', bindings.working_directory,
    '--config', bindings.config_path, '--source', bindings.artifact_source_path,
    '--destination', paths.destination, '--operation-id', `issue-23-${bindings.candidate_id}-upload-1`,
    '--proof-before', paths.before, '--proof-after', paths.after, '--archive', bindings.artifact_archive_path,
    '--archive-sha256', bindings.artifact_archive_sha256, '--build-proof', paths.proof,
    '--expected-config-sha256', bindings.config_sha256,
  ]) })
}

export const WORKER_COMMAND_CONTRACT = Object.freeze({
  OVERALL_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  SMOKE_PATHS,
  fail,
  exact,
  safeId,
  sha256,
  assertPath,
  assertHash,
  assertBoundDirectory,
  assertBoundFile,
  validateArtifactSource,
  response,
  childFailure,
  parseDeployment,
  parseD1Identity,
  parseControls,
  parseReconciliation,
  deploymentStatusCommand,
  d1IdentityCommand,
  versionDeployCommand,
  smokeCommand,
  smokeStdin,
  controlsCommand,
  reconciliationCommand,
  uploadCommand,
  removeTransportTree,
})

/**
 * No-network formal adapter. Every would-be subprocess/network/write command
 * first passes through the same production constructors above. The executor
 * records that argv and returns a bounded recorded response; it never invokes
 * a command and rejects anything outside the fixed formal command plan.
 */
export function createRehearsalWorkerTransport(bindings, sink, fault = null, environments = { cloudflare: {}, smoke: {} }) {
  if (!bindings || typeof bindings !== 'object') fail('bindings are required')
  const origin = new URL(bindings.origin)
  if (!['http:', 'https:'].includes(origin.protocol)) fail('origin is invalid')
  const record = (operation, command, stdout, request = {}) => {
    if (!command || typeof command.executable !== 'string' || !Array.isArray(command.args)) {
      fail(`formal rehearsal refused unconstructed ${operation} command`)
    }
    const environment = operation.endsWith('.smoke') ? environments.smoke : environments.cloudflare
    if (sink) sink.push({
      adapter: 'worker', operation, argv: [command.executable, ...command.args],
      env_keys: Object.keys(environment).sort(), ...request,
    })
    return { status: 0, stdout: JSON.stringify(stdout), stderr: '', duration_ms: 1 }
  }
  const deploymentRaw = (version) => ({
    id: bindings.baseline.deployment_id,
    versions: [{ version_id: version, percentage: 100 }],
  })
  const d1Raw = { uuid: bindings.d1_database_id }
  const controlsRaw = { state: 'captured', controls: { producer: 'disabled', authority: 'disabled', executors: { scheduler: 'disabled' } } }
  const reconciliationRaw = { state: 'matched', checks: Object.fromEntries(RECONCILIATION_DIMENSIONS.map((key) => [key, 'matched'])) }

  function forcedResponse(request) {
    if (fault?.stage !== request.stage) return null
    if (fault.kind === 'failure') {
      throw new WorkerTransportError('NON_PASS', 'formal_rehearsal_forced_failure', 1)
    }
    if (fault.kind === 'drift') throw new WorkerTransportError('NON_PASS', 'Manifest Drift', 1)
    if (fault.kind === 'timeout') {
      return { status: 0, stdout: '{}', stderr: '', duration_ms: request.timeout_ms + 1 }
    }
    if (fault.kind === 'malformed') {
      return { status: 0, stdout: '{', stderr: '', duration_ms: 1 }
    }
    throw new WorkerTransportError('UNCERTAIN', 'formal_rehearsal_uncertain', 1)
  }

  function livePreconditions(elapsed_ms = 0) {
    if (!Number.isSafeInteger(elapsed_ms) || elapsed_ms < 0 || elapsed_ms >= OVERALL_TIMEOUT_MS) {
      return { outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: 1 }
    }
    const baseline = record('live_preconditions.deployment_status', deploymentStatusCommand(bindings), deploymentRaw(bindings.baseline.version_id))
    const liveFault = formalFaultResultForLivePreconditions(fault)
    if (liveFault) return liveFault
    const deployment = parseDeployment(baseline.stdout, bindings.baseline.version_id, bindings.d1_database_id, baseline.duration_ms)
    if (deployment.deployment_id !== bindings.baseline.deployment_id) return { outcome: 'NON_PASS', classification: 'Manifest Drift', duration_ms: 1 }
    const identity = record('live_preconditions.d1_identity', d1IdentityCommand(bindings), d1Raw)
    parseD1Identity(identity.stdout, bindings.d1_database_id, identity.duration_ms)
    return { outcome: 'PASS', duration_ms: baseline.duration_ms + identity.duration_ms }
  }

  function execute(request) {
    if (!exact(request, ['operation', 'stage', 'timeout_ms', 'elapsed_ms', 'version_id', 'deployment_id'])
      || request.operation !== request.stage || !['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'].includes(request.operation)
      || !Number.isSafeInteger(request.timeout_ms) || !Number.isSafeInteger(request.elapsed_ms)
      || request.timeout_ms <= 0 || request.elapsed_ms < 0) fail('request is invalid')
    if (request.operation === 'worker_deploy') {
      const command = uploadCommand(bindings, { destination: '<formal-no-network>', before: '<formal-no-network>', after: '<formal-no-network>', proof: '<formal-no-network>' })
      const recorded = record(request.operation, command, {
        format: 'blogman-upload-source-lifecycle-acceptance/v1', state: 'accepted',
        upload_operation_id: `issue-23-${bindings.candidate_id}-upload-1`, version_id: `rehearsal-version-${bindings.candidate_id.slice(0, 12)}`,
        config_sha256: bindings.config_sha256, snapshot_tree_sha256: bindings.artifact_sha256,
        snapshot_identity_sha256: 'a'.repeat(64), snapshot_proof_before_sha256: 'b'.repeat(64), snapshot_proof_after_sha256: 'c'.repeat(64),
        build_directory_proof_sha256: 'd'.repeat(64), wrangler_output_sha256: 'e'.repeat(64),
      })
      return forcedResponse(request) ?? recorded
    }
    if (!safeId(request.version_id)) throw new WorkerTransportError('ERROR', 'worker_adapter_uncertain')
    if (request.operation === 'version_traffic_verification') {
      record(`${request.operation}.deploy`, versionDeployCommand(bindings, request.version_id), {})
      const forced = forcedResponse(request)
      if (forced) return forced
      const status = record(`${request.operation}.deployment_status`, deploymentStatusCommand(bindings), deploymentRaw(request.version_id))
      const deployment = parseDeployment(status.stdout, request.version_id, bindings.d1_database_id, status.duration_ms)
      const identity = record(`${request.operation}.d1_identity`, d1IdentityCommand(bindings), d1Raw)
      parseD1Identity(identity.stdout, bindings.d1_database_id, identity.duration_ms)
      return response(deployment, status.duration_ms + identity.duration_ms + 1)
    }
    if (!safeId(request.deployment_id)) throw new WorkerTransportError('ERROR', 'worker_adapter_uncertain')
    const beforeResponse = record(`${request.operation}.before`, deploymentStatusCommand(bindings), deploymentRaw(request.version_id))
    const forced = forcedResponse(request)
    if (forced) return forced
    const before = parseDeployment(beforeResponse.stdout, request.version_id, bindings.d1_database_id)
    const identity = record(`${request.operation}.d1_identity`, d1IdentityCommand(bindings), d1Raw)
    parseD1Identity(identity.stdout, bindings.d1_database_id, identity.duration_ms)
    const checks = {}
    for (const { path, status } of bindings.smoke.requests) {
      const stdin = smokeStdin(bindings.smoke_admin_credential)
      const result = record(
        `${request.operation}.smoke`,
        smokeCommand(bindings, new URL(path, origin).toString()),
        status,
        {
          stdin_sha256: hash(stdin),
          stdin_bytes: stdin.byteLength,
          env_keys: Object.keys(environments.smoke).sort(),
        },
      )
      if (result.stdout !== JSON.stringify(status)) throw new WorkerTransportError('NON_PASS', 'smoke_control_contract_invalid')
      checks[path] = status
    }
    const after = parseDeployment(record(`${request.operation}.after`, deploymentStatusCommand(bindings), deploymentRaw(request.version_id)).stdout, request.version_id, bindings.d1_database_id)
    const controls = parseControls(record(`${request.operation}.controls`, controlsCommand(bindings), controlsRaw).stdout)
    const reconciliation = parseReconciliation(record(`${request.operation}.reconciliation`, reconciliationCommand(bindings), reconciliationRaw).stdout)
    return response({ before, after, checks, controls, reconciliation }, 1)
  }

  return Object.freeze({
    livePreconditions,
    execute,
  })
}
