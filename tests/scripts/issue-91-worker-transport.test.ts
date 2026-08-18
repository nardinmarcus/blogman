import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as transport from '../../scripts/issue-23-delivery-worker-transport.mjs'
import { createProductionWorkerTransport } from '../../scripts/issue-23-delivery-entry.mjs'
import { WorkerTransportError } from '../../scripts/issue-23-delivery-worker-stages.mjs'

const { r2ProbeCommand, r2ProbeStdin, parseR2ProbeResponse } = transport.WORKER_COMMAND_CONTRACT

function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

const probeBindings = {
  curl_path: '/usr/bin/curl',
  account_id: 'account-id',
}

const rehearsalBindings = {
  origin: 'https://blog.example.com',
  account_id: 'account-id',
  worker_name: 'blogman',
  database: 'DB',
  config_path: '/repo/wrangler.toml',
  wrangler_path: '/repo/node_modules/.bin/wrangler',
  curl_path: '/usr/bin/curl',
  d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
  baseline: {
    deployment_id: 'deployment-before',
    version_id: 'version-before',
    d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
    traffic: [{ version_id: 'version-before', percentage: 100 }],
  },
}

describe('Issue #91 Worker transport public boundary', () => {
  it('exports only non-dispatching command contracts and formal no-network transport', () => {
    expect(transport).not.toHaveProperty('createWorkerTransport')
    expect(transport).toHaveProperty('createRehearsalWorkerTransport')
    expect(transport).toHaveProperty('WORKER_COMMAND_CONTRACT')
    for (const capability of ['createTransport', 'execute', 'runBoundedChild']) {
      expect(Object.keys(transport.WORKER_COMMAND_CONTRACT)).not.toContain(capability)
    }
    expect(Object.values(transport.WORKER_COMMAND_CONTRACT).some((value) => (
      typeof value === 'function' && /runBoundedChild|spawn(?:Sync)?\s*\(/u.test(Function.prototype.toString.call(value))
    ))).toBe(false)
  })
})

describe('Issue #154 R2 read-only pre-burn probe contract', () => {
  it('builds the read-only account bucket-list probe command without any credential in argv', () => {
    expect(r2ProbeCommand(probeBindings)).toEqual({
      executable: '/usr/bin/curl',
      args: [
        '--disable', '--config', '-', '--request', 'GET', '--silent', '--show-error',
        '--output', '/dev/null', '--write-out', '%{http_code}',
        'https://api.cloudflare.com/client/v4/accounts/account-id/r2/buckets',
      ],
    })
    expect(JSON.stringify(r2ProbeCommand(probeBindings))).not.toMatch(/bearer|token|authorization/i)
  })

  it('carries the delivery token only through the stdin curl config', () => {
    const stdin = r2ProbeStdin('test-only-cloudflare-authority')
    expect(stdin).toEqual(Buffer.from('header = "Authorization: Bearer test-only-cloudflare-authority"\n', 'utf8'))
  })

  it('accepts the 200 capability response', () => {
    expect(parseR2ProbeResponse('200', 5)).toBe(null)
  })

  it('classifies the 403/10000 scope-gap response as a credential insufficiency, not malformed', () => {
    expect(() => parseR2ProbeResponse('403', 7)).toThrow(WorkerTransportError)
    try {
      parseR2ProbeResponse('403', 7)
      expect.unreachable('parseR2ProbeResponse must reject a 403 scope gap')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerTransportError)
      expect(error).toMatchObject({
        outcome: 'NON_PASS',
        classification: 'cloudflare_permission_insufficient',
        duration_ms: 7,
      })
    }
  })

  it('keeps every other probe outcome inside the bounded uncertain class', () => {
    for (const stdout of ['401', '429', '500', '000', '', 'not-a-code']) {
      try {
        parseR2ProbeResponse(stdout, 3)
        expect.unreachable(`parseR2ProbeResponse must reject ${JSON.stringify(stdout)}`)
      } catch (error) {
        expect(error).toBeInstanceOf(WorkerTransportError)
        expect(error).toMatchObject({ outcome: 'UNCERTAIN', classification: 'live_preconditions_uncertain' })
      }
    }
  })

  it('records the probe after the baseline and D1 identity checks in the formal no-network transport', () => {
    const sink: Array<Record<string, unknown>> = []
    const rehearsal = transport.createRehearsalWorkerTransport(rehearsalBindings, sink, null, {
      cloudflare: { CLOUDFLARE_API_TOKEN: 'formal-cloudflare-placeholder', CLOUDFLARE_ACCOUNT_ID: 'account-id' },
      smoke: {},
    })

    const result = rehearsal.livePreconditions(0)

    expect(result).toMatchObject({ outcome: 'PASS' })
    expect(sink.map((entry) => entry.operation)).toEqual([
      'live_preconditions.deployment_status',
      'live_preconditions.d1_identity',
      'live_preconditions.r2_probe',
    ])
    const probe = sink.at(-1)!
    expect(probe.argv).toEqual([
      '/usr/bin/curl', '--disable', '--config', '-', '--request', 'GET', '--silent', '--show-error',
      '--output', '/dev/null', '--write-out', '%{http_code}',
      'https://api.cloudflare.com/client/v4/accounts/account-id/r2/buckets',
    ])
    expect(probe.stdin_sha256).toBe(hash(r2ProbeStdin('formal-cloudflare-placeholder')))
    expect(probe.stdin_bytes).toBe(r2ProbeStdin('formal-cloudflare-placeholder').byteLength)
    expect(probe.env_keys).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
    expect(JSON.stringify(probe)).not.toMatch(/formal-cloudflare-placeholder/u)
  })
})

// Issue #168: the supervisor-captured bounded wrapper stderr rides the
// D1ChildError; the adapter must carry its sha256 identity onto the
// WorkerStageError so the stage receipt can reference the durable bytes.
describe('Issue #168 wrapper stderr sidecar on child failure', () => {
  it('maps a nonzero wrapper child error to worker_adapter_nonzero with wrapper_stderr_sha256', async () => {
    const { D1ChildError } = await import('../../scripts/issue-23-delivery-d1-child.mjs')
    const error = new D1ChildError('nonzero', 5, {
      stdout: 'upload log line\n',
      stderr: 'wrapper failure stack summary\n',
    })
    const mapped = transport.WORKER_COMMAND_CONTRACT.childFailure(error)
    expect(mapped).toBeInstanceOf(WorkerTransportError)
    expect(mapped.outcome).toBe('ERROR')
    expect(mapped.classification).toBe('worker_adapter_nonzero')
    expect(mapped.duration_ms).toBe(5)
    expect(mapped.wrapper_stderr_sha256).toBe(hash(Buffer.from('wrapper failure stack summary\n')))
  })

  it('drops the sidecar when the wrapper stderr is empty', async () => {
    const { D1ChildError } = await import('../../scripts/issue-23-delivery-d1-child.mjs')
    const error = new D1ChildError('nonzero', 3, { stdout: '', stderr: '' })
    const mapped = transport.WORKER_COMMAND_CONTRACT.childFailure(error)
    expect(mapped.classification).toBe('worker_adapter_nonzero')
    expect(mapped.wrapper_stderr_sha256).toBeUndefined()
  })
})

// Issue #177: the upload wrapper's bounded stderr is sideband (the wrapper
// persists child stdout/stderr to durable evidence and its exit-0 acceptance
// JSON on stdout is authoritative), so a warning-level stderr from tooling the
// wrapper shells out to (npm build, wrangler) must not flip an otherwise
// successful upload to UNCERTAIN. Every other command keeps stderr-fatal.
function forgeWorkerBindings() {
  const h = 'a'.repeat(64)
  return {
    manifest_sha256: h, authorization_sha256: h, attempt_id: h,
    smoke_admin_credential: 'test-smoke-credential',
    config_path: '/repo/wrangler.toml', config_sha256: h,
    artifact_archive_path: '/repo/.open-next/open-next-build.zip', artifact_archive_sha256: h,
    artifact_source_path: '/repo/.open-next', artifact_file_tree_sha256: h,
    artifact_file_tree_files: [], artifact_sha256: h, delivery_snapshot_sha256: h,
    candidate_id: 'c'.repeat(40), worker_name: 'blogman',
    d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d', account_id: 'account-id',
    rollout_safety_path: '/repo/scripts/rollout-safety.mjs', rollout_safety_sha256: h,
    expected_reconciliation_path: '/repo/expected.json', expected_reconciliation_sha256: h,
    worker_upload_entry_path: '/repo/scripts/issue-23-delivery-worker-upload.mjs', worker_upload_entry_sha256: h,
    wrangler_path: '/repo/node_modules/.bin/wrangler', wrangler_sha256: h,
    node_path: '/usr/bin/node', node_sha256: h,
    npm_path: '/usr/bin/npm', npm_sha256: h,
    open_next_path: '/repo/node_modules/.bin/opennextjs-cloudflare', open_next_sha256: h,
    working_directory: '/repo', curl_path: '/usr/bin/curl', curl_sha256: h,
    package_json_path: '/repo/package.json', package_json_sha256: h,
    lockfile_path: '/repo/package-lock.json', lockfile_sha256: h,
    database: 'DB', origin: 'https://blog.example.com',
    smoke: {
      requests: transport.WORKER_COMMAND_CONTRACT.SMOKE_PATHS.map(([path, status]) => ({ path, status })),
    },
    baseline: {
      deployment_id: 'deployment-before', version_id: 'version-before',
      d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
      traffic: [{ version_id: 'version-before', percentage: 100 }],
    },
  }
}

function issue177Transport(childResult: { status: number; stdout: string; stderr: string; duration_ms: number }) {
  return createProductionWorkerTransport(
    forgeWorkerBindings(),
    {
      cloudflare: { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'account-id' },
      smoke: {},
    },
    () => 0,
    {
      skipLocalBindings: true,
      runBoundedChild: () => childResult,
    },
  )
}

describe('Issue #177 upload invoke stderr gate', () => {
  it('accepts a warning-stderr, exit-0 upload invoke as success', () => {
    const upload = issue177Transport({
      status: 0,
      stdout: JSON.stringify({ format: 'blogman-upload-wrapper-acceptance/v1', ok: true }),
      stderr: 'npm warn deprecated some-package: use another\n',
      duration_ms: 1,
    })

    const result = upload.execute({
      operation: 'worker_deploy', stage: 'worker_deploy',
      timeout_ms: 120000, elapsed_ms: 0, version_id: 'version-x', deployment_id: 'deployment-x',
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: 'blogman-upload-wrapper-acceptance/v1', ok: true,
    })
  })

  it('keeps stderr fatal for non-upload commands', () => {
    const transportUnderTest = issue177Transport({
      status: 0,
      stdout: '{}',
      stderr: 'nm warning on a non-upload command\n',
      duration_ms: 1,
    })

    expect(() => transportUnderTest.execute({
      operation: 'version_traffic_verification', stage: 'version_traffic_verification',
      timeout_ms: 120000, elapsed_ms: 0, version_id: 'version-x', deployment_id: 'deployment-x',
    })).toThrow(expect.objectContaining({
      outcome: 'UNCERTAIN', classification: 'worker_adapter_uncertain', duration_ms: 1,
    }))
  })
})
