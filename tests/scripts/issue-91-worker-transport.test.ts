import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as transport from '../../scripts/issue-23-delivery-worker-transport.mjs'
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
