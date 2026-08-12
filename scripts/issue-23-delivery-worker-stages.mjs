import { createHash } from 'node:crypto'

export const WORKER_STAGE_ORDER = Object.freeze(['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'])
const TIMEOUT_MS = Object.freeze({ worker_deploy: 600000, version_traffic_verification: 300000, smoke_control_t0: 300000 })
const DIMENSIONS = Object.freeze(['schema', 'migration_ledger', 'post_count', 'post_status', 'post_content'])

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function bytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8') }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]+$/u.test(value) }
function terminal(trace, hashes, mutation_counts) {
  const last = trace.at(-1)
  const value = {
    format: 'blogman-issue-23-worker-stages/v1', outcome: last.outcome,
    first_terminal_stage: last.outcome === 'PASS' ? null : last.stage,
    failure: last.outcome === 'PASS' ? null : { classification: last.classification },
    stage_counts: Object.fromEntries(WORKER_STAGE_ORDER.map((stage) => [stage, trace.filter((entry) => entry.stage === stage).length])),
    stage_durations_ms: Object.fromEntries(WORKER_STAGE_ORDER.map((stage) => [stage, trace.filter((entry) => entry.stage === stage).reduce((sum, entry) => sum + entry.duration_ms, 0)])),
    mutation_counts,
    evidence: { source: 'production', production: true, promotable: last.outcome === 'PASS', hashes }, finalized: true,
  }
  const serialized = bytes(value)
  return { value, bytes: serialized, sha256: hash(serialized) }
}
function result(response) {
  if (!exact(response, ['status', 'stdout', 'stderr', 'duration_ms']) || response.status !== 0 || response.stderr !== ''
    || !Number.isSafeInteger(response.duration_ms) || response.duration_ms < 0 || typeof response.stdout !== 'string') return null
  try { return { value: JSON.parse(response.stdout), duration_ms: response.duration_ms } } catch { return null }
}

/** Private suffix seam. A response has only public facts; raw adapter output never escapes. */
export function runWorkerStages({ bindings, transport, elapsed_ms = 0 }) {
  const trace = []; const hashes = []; const mutation_counts = { attempted: 0, confirmed: 0 }; let elapsed = elapsed_ms; let version; let deployment
  for (const stage of WORKER_STAGE_ORDER) {
    let parsed
    try { parsed = result(transport.execute({ operation: stage, stage, timeout_ms: TIMEOUT_MS[stage], elapsed_ms: elapsed, version_id: version, deployment_id: deployment })) } catch { parsed = null }
    if (!parsed) { trace.push({ stage, outcome: 'UNCERTAIN', classification: 'worker_adapter_uncertain', duration_ms: 0 }); break }
    elapsed += parsed.duration_ms
    if (parsed.duration_ms > TIMEOUT_MS[stage]) { trace.push({ stage, outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: parsed.duration_ms }); break }
    if (elapsed > 5400000) { trace.push({ stage, outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: parsed.duration_ms }); break }
    if (stage === 'worker_deploy') {
      mutation_counts.attempted += 1
      if (!exact(parsed.value, ['format', 'state', 'version_id', 'wrangler_output_sha256']) || parsed.value.format !== 'blogman-upload-source-lifecycle-acceptance/v1' || parsed.value.state !== 'accepted' || !safeId(parsed.value.version_id) || !/^[a-f0-9]{64}$/u.test(parsed.value.wrangler_output_sha256)) { trace.push({ stage, outcome: 'ERROR', classification: 'upload_contract_invalid', duration_ms: parsed.duration_ms }); break }
      version = parsed.value.version_id; mutation_counts.confirmed += 1; hashes.push(hash(bytes({ stage, version_id: version, artifact_sha256: bindings.artifact_sha256 })))
    } else if (stage === 'version_traffic_verification') {
      if (!exact(parsed.value, ['deployment_id', 'version_id', 'd1_database_id', 'traffic']) || !safeId(parsed.value.deployment_id) || parsed.value.version_id !== version || parsed.value.d1_database_id !== bindings.d1_database_id || JSON.stringify(parsed.value.traffic) !== JSON.stringify([{ version_id: version, percentage: 100 }])) { trace.push({ stage, outcome: 'NON_PASS', classification: 'version_traffic_mismatch', duration_ms: parsed.duration_ms }); break }
      deployment = parsed.value.deployment_id; hashes.push(hash(bytes({ stage, deployment_id: deployment, version_id: version, d1_database_id: bindings.d1_database_id })))
    } else {
      const expectedChecks = Object.fromEntries(bindings.smoke.requests.map(({ path, status }) => [path, status]))
      if (!exact(parsed.value, ['before', 'after', 'checks', 'controls', 'reconciliation']) || JSON.stringify(parsed.value.checks) !== JSON.stringify(expectedChecks) || JSON.stringify(parsed.value.before) !== JSON.stringify({ deployment_id: deployment, version_id: version, d1_database_id: bindings.d1_database_id }) || JSON.stringify(parsed.value.after) !== JSON.stringify(parsed.value.before) || parsed.value.controls?.producer !== 'disabled' || parsed.value.controls?.authority !== 'disabled' || Object.values(parsed.value.controls?.executors ?? {}).some((state) => state !== 'disabled') || parsed.value.reconciliation?.state !== 'matched' || DIMENSIONS.some((dimension) => parsed.value.reconciliation?.checks?.[dimension] !== 'matched')) { trace.push({ stage, outcome: 'NON_PASS', classification: 'smoke_control_contract_invalid', duration_ms: parsed.duration_ms }); break }
      hashes.push(hash(bytes({ stage, deployment_id: deployment, version_id: version, d1_database_id: bindings.d1_database_id })))
    }
    trace.push({ stage, outcome: 'PASS', duration_ms: parsed.duration_ms })
  }
  return terminal(trace, hashes, mutation_counts)
}
