import { describe, expect, it } from 'vitest'
import { runWorkerStages } from '../../scripts/issue-23-delivery-worker-stages.mjs'

const smoke = { requests: [
  { path: '/api/search', status: 200 }, { path: '/api/settings/appearance', status: 200 },
  { path: '/api/admin/tokens', status: 200 }, { path: '/api/admin/ai-provider', status: 200 },
  { path: '/api/admin/ai-post-generators', status: 200 }, { path: '/api/admin/posts/__blogman_smoke_absent__', status: 404 },
], admin_credential_slot: 'delivery_smoke_admin' }
const identity = {
  manifest_sha256: '1'.repeat(64),
  authorization_sha256: '2'.repeat(64),
  attempt_id: '3'.repeat(64),
  candidate_id: 'a'.repeat(40),
}
const bindings = { artifact_sha256: 'a'.repeat(64), config_sha256: 'c'.repeat(64), ...identity, d1_database_id: 'd1-id', smoke }

function transport(responses: unknown[]) {
  let index = 0
  return { execute: () => responses[index++] }
}
function response(value: unknown, duration_ms = 1) { return { status: 0, stderr: '', stdout: JSON.stringify(value), duration_ms } }

function acceptedUpload(version = 'version-new') {
  return response({
    format: 'blogman-upload-source-lifecycle-acceptance/v1',
    state: 'accepted',
    upload_operation_id: `issue-23-${identity.candidate_id}-upload-1`,
    version_id: version,
    config_sha256: 'c'.repeat(64),
    snapshot_tree_sha256: 'a'.repeat(64),
    snapshot_identity_sha256: 'd'.repeat(64),
    snapshot_proof_before_sha256: 'e'.repeat(64),
    snapshot_proof_after_sha256: 'f'.repeat(64),
    build_directory_proof_sha256: '0'.repeat(64),
    wrangler_output_sha256: 'b'.repeat(64),
  })
}

function acceptedTraffic(version = 'version-new') {
  return response({
    deployment_id: 'deployment-new',
    version_id: version,
    d1_database_id: 'd1-id',
    traffic: [{ version_id: version, percentage: 100 }],
  })
}

describe('Issue #91 worker suffix', () => {
  it('binds uploaded version, 100% traffic, smoke, controls, and all five reconciliation dimensions', () => {
    const version = 'version-new'; const deployment = 'deployment-new'
    const result = runWorkerStages({ bindings, transport: transport([
      response({ format: 'blogman-upload-source-lifecycle-acceptance/v1', state: 'accepted', upload_operation_id: `issue-23-${identity.candidate_id}-upload-1`, version_id: version, config_sha256: 'c'.repeat(64), snapshot_tree_sha256: 'a'.repeat(64), snapshot_identity_sha256: 'd'.repeat(64), snapshot_proof_before_sha256: 'e'.repeat(64), snapshot_proof_after_sha256: 'f'.repeat(64), build_directory_proof_sha256: '0'.repeat(64), wrangler_output_sha256: 'b'.repeat(64) }),
      response({ deployment_id: deployment, version_id: version, d1_database_id: 'd1-id', traffic: [{ version_id: version, percentage: 100 }] }),
      response({ before: { deployment_id: deployment, version_id: version, d1_database_id: 'd1-id', traffic: [{ version_id: version, percentage: 100 }] }, after: { deployment_id: deployment, version_id: version, d1_database_id: 'd1-id', traffic: [{ version_id: version, percentage: 100 }] }, checks: Object.fromEntries(smoke.requests.map(({ path, status }) => [path, status])), controls: { producer: 'disabled', authority: 'disabled', executors: { scheduled: 'disabled' } }, reconciliation: { state: 'matched', checks: { schema: 'matched', migration_ledger: 'matched', post_count: 'matched', post_status: 'matched', post_content: 'matched' } } }),
    ]) })
    expect(result.value).toMatchObject({
      outcome: 'PASS',
      first_terminal_stage: null,
      stage_counts: { worker_deploy: 1, version_traffic_verification: 1, smoke_control_t0: 1 },
      mutation_counts: { attempted: 2, confirmed: 2 },
      evidence: {
        source: 'stage-runner-non-production',
        production: false,
        promotable: false,
        ...identity,
      },
    })
    expect(JSON.stringify(result.value)).not.toMatch(/stdout|stderr|token|cookie|private/i)
  })

  it('ignores caller-forged production provenance on the public stage runner', () => {
    const deployment = 'deployment-new'
    const forged = Object.assign(transport([
      acceptedUpload(),
      acceptedTraffic(),
      response({
        before: { deployment_id: deployment, version_id: 'version-new', d1_database_id: 'd1-id', traffic: [{ version_id: 'version-new', percentage: 100 }] },
        after: { deployment_id: deployment, version_id: 'version-new', d1_database_id: 'd1-id', traffic: [{ version_id: 'version-new', percentage: 100 }] },
        checks: Object.fromEntries(smoke.requests.map(({ path, status }) => [path, status])),
        controls: { producer: 'disabled', authority: 'disabled', executors: { scheduled: 'disabled' } },
        reconciliation: { state: 'matched', checks: { schema: 'matched', migration_ledger: 'matched', post_count: 'matched', post_status: 'matched', post_content: 'matched' } },
      }),
    ]), { evidence: { source: 'production', production: true } })

    const result = runWorkerStages({ bindings, transport: forged })

    expect(result.value).toMatchObject({
      outcome: 'PASS',
      evidence: {
        source: 'stage-runner-non-production',
        production: false,
        promotable: false,
      },
    })
  })

  it('rejects duplicate Worker response keys at the strict JSON boundary', () => {
    const upload = acceptedUpload().stdout
    const duplicate = upload.replace(
      '"version_id":"version-new"',
      '"version_id":"forged-version","version_id":"version-new"',
    )
    const result = runWorkerStages({
      bindings,
      transport: transport([{ status: 0, stderr: '', stdout: duplicate, duration_ms: 1 }]),
    })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'worker_deploy',
      failure: { classification: 'worker_response_malformed' },
      stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    })
  })

  it.each([
    ['malformed', { status: 0, stderr: '', stdout: '{', duration_ms: 1 }, 'ERROR', 'worker_response_malformed'],
    ['timeout', response({ format: 'blogman-upload-source-lifecycle-acceptance/v1', state: 'accepted', upload_operation_id: `issue-23-${identity.candidate_id}-upload-1`, version_id: 'version-new', config_sha256: 'c'.repeat(64), snapshot_tree_sha256: 'a'.repeat(64), snapshot_identity_sha256: 'd'.repeat(64), snapshot_proof_before_sha256: 'e'.repeat(64), snapshot_proof_after_sha256: 'f'.repeat(64), build_directory_proof_sha256: '0'.repeat(64), wrangler_output_sha256: 'b'.repeat(64) }, 600001), 'TIMEOUT', 'stage_timeout'],
    ['invalid upload contract', response({ format: 'wrong', state: 'accepted', version_id: 'version-new', wrangler_output_sha256: 'b'.repeat(64) }), 'ERROR', 'upload_contract_invalid'],
  ])('terminalizes %s with no suffix retry', (_name, first, outcome, classification) => {
    const result = runWorkerStages({ bindings, transport: transport([first]) })
    expect(result.value).toMatchObject({ outcome, first_terminal_stage: 'worker_deploy', failure: { classification }, stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 } })
  })

  it('chooses the tighter overall deadline before Stage timeout when both expire together', () => {
    const result = runWorkerStages({
      bindings,
      elapsed_ms: 4_800_000,
      transport: transport([acceptedUpload('version-new')].map((entry) => ({ ...entry, duration_ms: 600_001 }))),
    })

    expect(result.value).toMatchObject({
      outcome: 'TIMEOUT',
      first_terminal_stage: 'worker_deploy',
      failure: { classification: 'overall_timeout' },
      stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
      mutation_counts: { attempted: 1, confirmed: 0 },
    })
  })

  it.each([
    {
      name: 'version/traffic verification',
      responses: [acceptedUpload(), response({ state: 'wrong' })],
      terminal: 'version_traffic_verification',
      counts: { worker_deploy: 1, version_traffic_verification: 1, smoke_control_t0: 0 },
    },
    {
      name: 'smoke/control/T0',
      responses: [acceptedUpload(), acceptedTraffic(), response({ state: 'wrong' })],
      terminal: 'smoke_control_t0',
      counts: { worker_deploy: 1, version_traffic_verification: 1, smoke_control_t0: 1 },
    },
  ])('enters $name once and never retries its failed suffix', ({ responses, terminal, counts }) => {
    let calls = 0
    const result = runWorkerStages({
      bindings,
      transport: { execute: () => responses[calls++] },
    })

    expect(result.value).toMatchObject({
      first_terminal_stage: terminal,
      stage_counts: counts,
    })
    expect(calls).toBe(responses.length)
  })
})
