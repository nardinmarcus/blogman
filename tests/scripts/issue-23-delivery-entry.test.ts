import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildLocalEntryReceipt,
  buildLocalRehearsalCommands,
  execute,
  parseLocalCommandResult,
} from '../../scripts/issue-23-delivery-entry.mjs'

const draft = 'a'.repeat(64)

const TERMINAL_RESULT_FORMAT = 'blogman-issue-23-terminal-result/v1'
const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const SYNTHETIC_LIVE_REPOSITORY_COMMIT = '1'.repeat(40)

function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function preparedManifest(
  marker: string,
  repositoryCommit = SYNTHETIC_LIVE_REPOSITORY_COMMIT,
  d1DatabaseId?: string,
) {
  const value = {
    format: 'blogman-issue-23-canonical-frozen-manifest/v1',
    marker,
    repository: { commit: repositoryCommit },
    ...(d1DatabaseId ? { target: { d1_database_id: d1DatabaseId } } : {}),
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function authorization(manifest: ReturnType<typeof preparedManifest>, authorizationId: string) {
  return {
    format: AUTHORIZATION_FORMAT,
    authorization_id: authorizationId,
    manifest_sha256: manifest.sha256,
    decision: 'approve',
  }
}

function authorizationHash(record: ReturnType<typeof authorization>) {
  const bytes = Buffer.from(`${JSON.stringify({
    format: record.format,
    authorization_id: record.authorization_id,
    manifest_sha256: record.manifest_sha256,
    decision: record.decision,
  }, null, 2)}\n`, 'utf8')
  return hash(bytes)
}

const expectedStageCounts = {
  authorization_accept: 1,
  live_preconditions: 1,
  d1_identity: 1,
  clean_start_reset: 1,
  empty_d1_proof: 1,
  migrations_001_006: 1,
  reconciliation: 1,
  worker_deploy: 1,
  version_traffic_verification: 1,
  smoke_control_t0: 1,
}

const expectedStageDurations = {
  authorization_accept: 0,
  live_preconditions: 0,
  d1_identity: 0,
  clean_start_reset: 0,
  empty_d1_proof: 0,
  migrations_001_006: 0,
  reconciliation: 0,
  worker_deploy: 0,
  version_traffic_verification: 0,
  smoke_control_t0: 0,
}

const EXPECTED_TRACE_SHA256 = 'bd19b4591857ea9aab139ced2eb1afb5955050297ef2d4edb7c722f5b736e68c'

function commands() {
  return buildLocalRehearsalCommands({
    runnerPath: 'scripts/migrations.mjs',
    configPath: 'wrangler.toml',
    stateToken: '<disposable-state>',
    candidate: 'candidate',
  })
}

describe('Issue #23 pure local entry seam', () => {
  it('executes the deterministic synthetic state machine to an all-success Terminal Result', () => {
    const manifest = preparedManifest('accepted-manifest')
    const auth = authorization(manifest, 'authorization-accepted-once')

    expect(execute).toHaveLength(2)
    const result = execute(manifest, auth)

    expect(Object.keys(result)).toEqual(['value', 'bytes', 'sha256'])
    expect(result.value).toEqual({
      format: TERMINAL_RESULT_FORMAT,
      identities: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorizationHash(auth),
      },
      attempt_id: expect.stringMatching(/^[a-f0-9]{64}$/u),
      authorization_consumed: true,
      outcome: 'PASS',
      first_terminal_stage: 'smoke_control_t0',
      failure: null,
      stage_counts: expectedStageCounts,
      stage_durations_ms: expectedStageDurations,
      mutation_counts: { production_writes: 0 },
      evidence: { source: 'synthetic', hashes: [EXPECTED_TRACE_SHA256] },
      finalized: true,
    })
    expect(result.bytes).toEqual(Buffer.from(`${JSON.stringify(result.value, null, 2)}\n`, 'utf8'))
    expect(result.sha256).toBe(hash(result.bytes))
    expect(result.value).not.toHaveProperty('commands')
    expect(result.value).not.toHaveProperty('target')
    expect(result.value).not.toHaveProperty('adapters')
    expect(result.value).not.toHaveProperty('trace')
    expect(result.value).not.toHaveProperty('raw_output')
    expect(result.value).not.toHaveProperty('secrets')
    expect(result.value).not.toHaveProperty('production_evidence')
  })

  it('returns a consumed terminal Manifest Drift result when public execute observes repository commit drift', () => {
    const manifest = preparedManifest('live-precondition-manifest-drift', '2'.repeat(40))
    const auth = authorization(manifest, 'authorization-live-precondition-drift')
    const expected = {
      format: TERMINAL_RESULT_FORMAT,
      identities: {
        manifest_sha256: '4c35c731d28b29005eb431e9b8651ffe94ec18032cfe79c9a894a5feec9b6f3f',
        authorization_sha256: '6106ab2a7d7942d0897942ca49d5f04e7e9a9e8d267428322849363ced5e1bf2',
      },
      attempt_id: 'f549c539c02d15ccd95e8c50fb1642897f2584ab1d6523879aad1766385a6367',
      authorization_consumed: true,
      outcome: 'NON_PASS',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'Manifest Drift' },
      stage_counts: {
        authorization_accept: 1,
        live_preconditions: 1,
        d1_identity: 0,
        clean_start_reset: 0,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
        worker_deploy: 0,
        version_traffic_verification: 0,
        smoke_control_t0: 0,
      },
      stage_durations_ms: expectedStageDurations,
      mutation_counts: { production_writes: 0 },
      evidence: {
        source: 'synthetic',
        hashes: ['44d27745230e500b0176a4605b6477c12abf3e1877a2bd0abbcfb3313236119b'],
      },
      finalized: true,
    }

    expect(manifest.sha256).toBe(expected.identities.manifest_sha256)
    const result = execute(manifest, auth)
    expect(result.value).toEqual(expected)
    expect(result.bytes).toEqual(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8'))
    expect(result.sha256).toBe('d93cf8e0e28f1f3b54bb9c28fb845d72fad4fefbb2a2682dcb49ecfec43265a0')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
    for (const excluded of ['commands', 'target', 'adapters', 'trace', 'raw_output', 'secrets', 'production_evidence']) {
      expect(result.value).not.toHaveProperty(excluded)
    }
  })

  it('returns a consumed terminal D1 NON_PASS result when public execute observes a different database identity', () => {
    const manifest = preparedManifest(
      'd1-identity-mismatch',
      SYNTHETIC_LIVE_REPOSITORY_COMMIT,
      'wrong-d1-public-id',
    )
    const auth = authorization(manifest, 'authorization-d1-identity-mismatch')
    const expected = {
      format: TERMINAL_RESULT_FORMAT,
      identities: {
        manifest_sha256: 'e8c2b0c79bfac6c7d28eccc27f9b34cb756253115ae78b05986f68f90cc4e952',
        authorization_sha256: '0aec3a52909fe3f4c122598e1792982286119b9ff37960f5ed7a29d3f20a6d9a',
      },
      attempt_id: '4e8156b14f216e5448ddeb30190a740954cf574124f4d2e64867dfa4af2873fd',
      authorization_consumed: true,
      outcome: 'NON_PASS',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'synthetic_adapter_non_pass' },
      stage_counts: {
        authorization_accept: 1,
        live_preconditions: 1,
        d1_identity: 1,
        clean_start_reset: 0,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
        worker_deploy: 0,
        version_traffic_verification: 0,
        smoke_control_t0: 0,
      },
      stage_durations_ms: expectedStageDurations,
      mutation_counts: { production_writes: 0 },
      evidence: {
        source: 'synthetic',
        hashes: ['5254fe4ae57c5438e76d40aae510b80488cb71fbd74c53c476009474bb8cf889'],
      },
      finalized: true,
    }

    expect(manifest.sha256).toBe(expected.identities.manifest_sha256)
    const result = execute(manifest, auth)
    expect(result.value).toEqual(expected)
    expect(result.bytes).toEqual(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8'))
    expect(result.sha256).toBe('746d40d1313599ed41e7cf8a1ff062ae28e54bea1842ce9a5381494a8733dd64')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
    for (const excluded of ['commands', 'target', 'adapters', 'trace', 'raw_output', 'secrets', 'production_evidence']) {
      expect(result.value).not.toHaveProperty(excluded)
    }
  })

  it('returns a consumed terminal ERROR result when public execute encounters a malformed repository wrapper', () => {
    const value = {
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      marker: 'malformed-repository-wrapper',
      repository: null,
    }
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const manifest = { value, bytes, sha256: hash(bytes) }
    const auth = {
      format: AUTHORIZATION_FORMAT,
      authorization_id: 'authorization-malformed-repository-wrapper',
      manifest_sha256: manifest.sha256,
      decision: 'approve',
    }

    expect(manifest.sha256).toBe('e2683c3dee1edb37f1826c662d8787710f647c817e4b38f673cdf8801355feb0')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'ERROR',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'synthetic_adapter_error' },
      finalized: true,
    })
    expect(result.value.identities).toEqual({
      manifest_sha256: 'e2683c3dee1edb37f1826c662d8787710f647c817e4b38f673cdf8801355feb0',
      authorization_sha256: 'db2a7a1db6e35d1f6dc3e164eca082fc125c6104d5ec54b42b8317991d1ab4c6',
    })
    expect(result.value.attempt_id).toBe('536ff231c110ff1769e1b961cd9274db85b1e5738e3b25c827365e51f1c5f86a')
    expect(result.value.stage_counts).toEqual({
      ...Object.fromEntries(Object.keys(expectedStageCounts).map((stage) => [stage, 0])),
      authorization_accept: 1,
      live_preconditions: 1,
    })
    expect(result.value.stage_durations_ms).toEqual(expectedStageDurations)
    expect(result.value.mutation_counts).toEqual({ production_writes: 0 })
    expect(result.value.evidence).toEqual({
      source: 'synthetic',
      hashes: ['e2eabe3dba794f26cca0b3c9911521e764bbd0e3f7a6344eb7fb89a7ad608c14'],
    })
    expect(result.bytes).toEqual(Buffer.from(`${JSON.stringify(result.value, null, 2)}\n`, 'utf8'))
    expect(result.sha256).toBe('22396585fd95dbda128f23ec8e1a11090f6290ebea51813798673106ed0a453d')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
    for (const excluded of ['commands', 'target', 'adapters', 'trace', 'raw_output', 'secrets', 'production_evidence', 'error', 'message', 'stack']) {
      expect(result.value).not.toHaveProperty(excluded)
    }
    expect(JSON.stringify(result.value)).not.toMatch(/TypeError|Cannot read .*null|reading ['"]commit['"]/u)
  })

  it('rejects manifest-mismatched Authorization before consumption', () => {
    const manifest = preparedManifest('manifest-binding')
    const otherManifest = preparedManifest('other-manifest')
    const auth = authorization(manifest, 'authorization-before-mismatch')

    expect(() => execute(otherManifest, auth)).toThrow(/manifest/u)
    expect(execute(manifest, auth).value.authorization_consumed).toBe(true)
  })

  it('rejects a prepared manifest value with an unencoded own property before Authorization consumption', () => {
    const manifest = preparedManifest('unencoded-own-property')
    const auth = authorization(manifest, 'authorization-unencoded-own-property')
    Reflect.defineProperty(manifest.value, 'unencoded', { value: 'must-not-leak', enumerable: false, configurable: true })

    expect(() => execute(manifest, auth)).toThrowError(new Error('Issue #23 local entry: manifest value does not match bytes'))
    Reflect.deleteProperty(manifest.value, 'unencoded')
    const result = execute(manifest, auth)
    expect(result.value.identities.manifest_sha256).toBe('e4b41d575043bd366f7caa83e6196852c191fb864bbaec0197b640ab95f0d091')
    expect(result.value.identities.authorization_sha256).toBe('5fda14a14654dbc885aa975baf4d41fc4cd16157752bb1d6247a2a93e58f9b2f')
    expect(result.value.attempt_id).toBe('b43b820a89920488879c4a5c815f9907423ab75c6263026e25db3b9c73fcf589')
    expect(result.value.evidence.hashes).toEqual(['bd19b4591857ea9aab139ced2eb1afb5955050297ef2d4edb7c722f5b736e68c'])
    expect(result.value.authorization_consumed).toBe(true)
    expect(result.sha256).toBe('0ef58a054a86d236766068c4147fa20572f29f752736197653abb486bd359c3a')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
  })

  it('rejects Authorization plan fields and any third execute argument', () => {
    const manifest = preparedManifest('argument-boundary')
    const auth = authorization(manifest, 'authorization-argument-boundary')

    expect(() => execute(manifest, { ...auth, plan: { stages: [] } })).toThrow(/authorization/u)
    expect(() => execute(manifest, auth, { target: 'alternate-target' })).toThrow(/two arguments/u)
    expect(execute(manifest, auth).value.authorization_consumed).toBe(true)
  })

  it('rejects replay of the same Authorization after the first terminal result', () => {
    const manifest = preparedManifest('replay-boundary')
    const auth = authorization(manifest, 'authorization-replay')

    expect(execute(manifest, auth).value.finalized).toBe(true)
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
  })

  it('constructs fixed local commands and rejects command mutation', () => {
    const first = commands()
    const changed = buildLocalRehearsalCommands({
      runnerPath: 'scripts/migrations.mjs',
      configPath: 'wrangler.toml',
      stateToken: '<disposable-state>',
      candidate: 'different-candidate',
    })

    expect(first.map(({ name, args }) => ({ name, args }))).not.toEqual(
      changed.map(({ name, args }) => ({ name, args })),
    )
    expect(() => buildLocalRehearsalCommands({
      runnerPath: 'scripts/migrations.mjs',
      configPath: 'wrangler.toml',
      stateToken: 'bad\ninput',
      candidate: 'candidate',
    })).toThrow(/single-line/u)
  })

  it('parses only successful JSON adapter responses', () => {
    expect(parseLocalCommandResult({ status: 0, stdout: '{"state":"current"}', stderr: '' }, 'verify'))
      .toEqual({ state: 'current' })
    expect(() => parseLocalCommandResult({ status: 1, stdout: '', stderr: '' }, 'apply'))
      .toThrow(/did not complete successfully/u)
    expect(() => parseLocalCommandResult({ status: 0, stdout: 'not-json', stderr: '' }, 'apply'))
      .toThrow(/did not return JSON/u)
    expect(() => parseLocalCommandResult({
      status: 0,
      stdout: JSON.stringify({
        format: 'blogman-issue-23-supervisor/v1',
        status: 'timed_out',
        stdout: '',
        stderr: '',
      }),
      stderr: '',
    }, 'apply')).toThrow(/timed out/u)
    expect(() => parseLocalCommandResult({
      status: 0,
      stdout: JSON.stringify({
        format: 'blogman-issue-23-supervisor/v1',
        status: 'output_overflow',
        stdout: '',
        stderr: '',
      }),
      stderr: '',
    }, 'catalog')).toThrow(/output exceeded/u)
  })

  it('binds receipt identity to draft, commands, outputs, adapters, and cleanup', () => {
    const input = {
      commands: commands().map(({ name, args }) => ({ name, args })),
      outputs: [
        { name: 'catalog', value: { migrations: ['001'] } },
        { name: 'apply', value: { state: 'current' } },
        { name: 'verify', value: { state: 'verified' } },
      ],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'disabled',
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: true, observed_absent: true },
      networkEvidence: { boundary: 'node-guard-only', external_probe: 'blocked' },
      adapterOutputs: [{ name: 'production-write', calls: 0 }],
    }
    const first = buildLocalEntryReceipt({ manifestDraftSha256: draft, ...input })
    const changed = buildLocalEntryReceipt({ manifestDraftSha256: 'c'.repeat(64), ...input })

    expect(first.sha256).not.toBe(changed.sha256)
    expect(first.value.manifest_draft_sha256).toBe(draft)
    expect(first.value.disposable_state.cleaned).toBe(true)
  })

  it('rejects cleanup claims without a post-cleanup absence observation', () => {
    expect(() => buildLocalEntryReceipt({
      manifestDraftSha256: draft,
      commands: [],
      outputs: [],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'disabled',
      networkEvidence: { boundary: 'node-guard-only', external_probe: 'blocked' },
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: true, observed_absent: false },
    })).toThrow(/evidence is incomplete/u)
  })

  it('fails closed when network or disposable cleanup proof is absent', () => {
    expect(() => buildLocalEntryReceipt({
      manifestDraftSha256: draft,
      commands: [],
      outputs: [],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'enabled',
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: false },
    })).toThrow(/evidence is incomplete/u)
  })
})
