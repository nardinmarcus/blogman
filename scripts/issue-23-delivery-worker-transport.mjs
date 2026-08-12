import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fail(message) { throw new Error(`Issue #23 worker transport: ${message}`) }
function invoke(executable, args, timeout_ms, env = process.env) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: timeout_ms, maxBuffer: 64 * 1024, env })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', duration_ms: 1 }
}
function canonical(response) {
  if (response.status !== 0 || response.stderr !== '') return response
  try { return { ...response, stdout: JSON.stringify(JSON.parse(response.stdout)) } } catch { return { ...response, status: 1, stdout: '', stderr: '' } }
}

/** Private adapter; no synthetic result is capable of production evidence. */
export function createWorkerTransport(bindings) {
  if (!bindings || typeof bindings !== 'object') fail('bindings are required')
  for (const key of ['config_path', 'artifact_archive_path', 'artifact_archive_sha256', 'artifact_source_path', 'artifact_sha256', 'candidate_id', 'worker_name', 'd1_database_id', 'rollout_safety_path', 'smoke']) if (!Object.hasOwn(bindings, key)) fail(`${key} is required`)
  return Object.freeze({ execute(request) {
    if (!request || request.operation !== request.stage) fail('request is invalid')
    if (request.operation === 'worker_deploy') {
      const root = mkdtempSync(join(tmpdir(), 'blogman-issue-91-upload-')); chmodSync(root, 0o700)
      try {
        const output = join(root, 'upload.jsonl'); const before = join(root, 'before.json'); const after = join(root, 'after.json'); const proof = join(root, 'proof.json'); const destination = join(root, 'source')
        for (const path of [output, before, after, proof]) writeFileSync(path, '', { mode: 0o600 })
        const response = invoke(process.execPath, ['scripts/phase-b-sequence.mjs', 'run-upload-source-lifecycle', '--config', bindings.config_path, '--source', bindings.artifact_source_path, '--destination', destination, '--operation-id', `issue-23-${bindings.candidate_id}-upload-1`, '--proof-before', before, '--proof-after', after, '--archive', bindings.artifact_archive_path, '--archive-sha256', bindings.artifact_archive_sha256, '--build-proof', proof, '--expected-config-sha256', bindings.config_sha256], request.timeout_ms, { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output })
        return canonical(response)
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
    if (request.operation === 'version_traffic_verification') return canonical(invoke('npx', ['wrangler', 'deployments', 'status', '--name', bindings.worker_name, '--config', bindings.config_path, '--json'], request.timeout_ms))
    if (request.operation === 'smoke_control_t0') {
      // The live smoke/capture composition is intentionally private to this adapter; its receipt is facts only.
      return { status: 1, stdout: '', stderr: '', duration_ms: 1 }
    }
    fail('operation is invalid')
  } })
}
