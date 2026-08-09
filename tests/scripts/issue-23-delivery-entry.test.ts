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

function preparedManifest(marker: string, repositoryCommit = SYNTHETIC_LIVE_REPOSITORY_COMMIT) {
  const value = {
    format: 'blogman-issue-23-canonical-frozen-manifest/v1',
    marker,
    repository: { commit: repositoryCommit },
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

  it('rejects manifest-mismatched Authorization before consumption', () => {
    const manifest = preparedManifest('manifest-binding')
    const otherManifest = preparedManifest('other-manifest')
    const auth = authorization(manifest, 'authorization-before-mismatch')

    expect(() => execute(otherManifest, auth)).toThrow(/manifest/u)
    expect(execute(manifest, auth).value.authorization_consumed).toBe(true)
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
