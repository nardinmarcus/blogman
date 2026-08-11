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
const ADAPTER_FIRST_ERROR_STAGES = [
  'live_preconditions',
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
  'worker_deploy',
  'version_traffic_verification',
  'smoke_control_t0',
]
const FIXED_STAGE_POLICY = [
  { name: 'authorization_accept', timeout_seconds: 30 },
  { name: 'live_preconditions', timeout_seconds: 120 },
  { name: 'd1_identity', timeout_seconds: 120 },
  { name: 'clean_start_reset', timeout_seconds: 300 },
  { name: 'empty_d1_proof', timeout_seconds: 300 },
  { name: 'migrations_001_006', timeout_seconds: 2100 },
  { name: 'reconciliation', timeout_seconds: 300 },
  { name: 'worker_deploy', timeout_seconds: 600 },
  { name: 'version_traffic_verification', timeout_seconds: 300 },
  { name: 'smoke_control_t0', timeout_seconds: 300 },
]

function fixedPolicy() {
  return {
    stages: FIXED_STAGE_POLICY.map((stage) => ({ ...stage })),
    overall_timeout_seconds: 5400,
  }
}

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
    policy: fixedPolicy(),
    ...(d1DatabaseId ? { target: { d1_database_id: d1DatabaseId } } : {}),
  }
  return encodedManifest(value)
}

function encodedManifest(value: Record<string, unknown>) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function manifestWithPolicy(manifest: ReturnType<typeof preparedManifest>, policy: unknown) {
  return encodedManifest({ ...manifest.value, policy })
}

function manifestWithoutPolicy(manifest: ReturnType<typeof preparedManifest>) {
  const value = { ...manifest.value }
  Reflect.deleteProperty(value, 'policy')
  return encodedManifest(value)
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

const EXPECTED_FIRST_ERROR_TRACE_HASHES = {
  live_preconditions: '07601158bcbad1336a0c10b3a5f10d4b4a99bfcfc74a7bbf4a86f82ad8c2329f',
  d1_identity: '5254fe4ae57c5438e76d40aae510b80488cb71fbd74c53c476009474bb8cf889',
  clean_start_reset: 'db7004f45f1cc8fdf0da722e5ab363d4164fa7b97c3d80f295da9f86517c2192',
  empty_d1_proof: '0a5f5e43b4e13d5b0b290d903e0d51bc287f00600de5c48169a5b0c519402d7f',
  migrations_001_006: '2a41c4098dce269b66904bf8f216bdfe3f4e789ac870a895c7b59a102184fb98',
  reconciliation: '6cc5ee845d0add75b9057a5e6000aef343803b3b9a7d34f63668c4eb56b12f91',
  worker_deploy: '4378d40f3d6682bed7c599c1f5b8194a38e4bf252311b268db84a722b536ba6d',
  version_traffic_verification: '703686011f2910ab059a95778f03abca6d89ac5500a2e11b9505dbed0365693a',
  smoke_control_t0: 'a29ab75d435b8eb7d8b08b82fbc579845bd914c6c97f6cec7a5e7e41fe2763a3',
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
  it('covers every adapter-backed Stage first-error matrix', () => {
    for (const [failedIndex, failedStage] of ADAPTER_FIRST_ERROR_STAGES.entries()) {
      const marker = `synthetic-first-error-${failedStage}`
      const manifest = preparedManifest(marker)
      const auth = authorization(manifest, `authorization-${marker}`)
      const expectedStageCountsForFailure = {
        authorization_accept: 1,
        ...Object.fromEntries(ADAPTER_FIRST_ERROR_STAGES.map((stage, index) => [
          stage,
          index <= failedIndex ? 1 : 0,
        ])),
      }
      const result = execute(manifest, auth)

      expect(result.value).toMatchObject({
        authorization_consumed: true,
        outcome: 'NON_PASS',
        first_terminal_stage: failedStage,
        failure: { classification: 'synthetic_adapter_non_pass' },
        stage_counts: expectedStageCountsForFailure,
        stage_durations_ms: expectedStageDurations,
        mutation_counts: { production_writes: 0 },
        evidence: {
          source: 'synthetic',
          hashes: [EXPECTED_FIRST_ERROR_TRACE_HASHES[failedStage]],
        },
        finalized: true,
      })
    }
  })

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
        manifest_sha256: '0d12bed02c7895f07dea4f1892b066c7dca9c5353c3a7dda974d2cefc052deaa',
        authorization_sha256: '1d3a3216f8c136eed9f3afaac767946b449de379f14df1b90c0c751512806a19',
      },
      attempt_id: 'f4ff8820bf77c9371401c657a7472b1248efcdb485f07ff6124b4127b3f8696b',
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
    expect(result.sha256).toBe('7f8f1b8b4d8a0b86719dd04334c42ea685b7bc9950e4f98a18ddd1ffa0c2152a')
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
        manifest_sha256: '7e8a5a24dea9a20bd98d104bc5717bbf37ac456c3c03f6aee78ef984dfde3ba7',
        authorization_sha256: '57e0de9361e2b5f2715909217a7969f16db86aab358f33c0bb5db5fbff3331f9',
      },
      attempt_id: '07d331f8bb6004c0e8b665e688439c7b657c62eea367fe9f3e7ae4e741a32149',
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
    expect(result.sha256).toBe('de38378809ff53161538ad0f17fab817d05a03ff5e484706a43b42cbbaf82388')
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
      policy: fixedPolicy(),
    }
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const manifest = { value, bytes, sha256: hash(bytes) }
    const auth = {
      format: AUTHORIZATION_FORMAT,
      authorization_id: 'authorization-malformed-repository-wrapper',
      manifest_sha256: manifest.sha256,
      decision: 'approve',
    }

    expect(manifest.sha256).toBe('4e048f9f458dfef58fb2ea05ba70e8b278082e78284470524e15ec402a6df13c')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'ERROR',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'synthetic_adapter_error' },
      finalized: true,
    })
    expect(result.value.identities).toEqual({
      manifest_sha256: '4e048f9f458dfef58fb2ea05ba70e8b278082e78284470524e15ec402a6df13c',
      authorization_sha256: '2ea8626129f4e8fa70f1bcc87882a610a09e4b4aede042a461ee3fb88d379e4b',
    })
    expect(result.value.attempt_id).toBe('6c8d3a98d5b73f6a52a192acc4428bc57dc2c66da723d2c67ef1edb6402b56cb')
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
    expect(result.sha256).toBe('96c4a09e4adc5f7f5fef4d15cacf47f5c152281be98145a275372ec57ecc3218')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
    for (const excluded of ['commands', 'target', 'adapters', 'trace', 'raw_output', 'secrets', 'production_evidence', 'error', 'message', 'stack']) {
      expect(result.value).not.toHaveProperty(excluded)
    }
    expect(JSON.stringify(result.value)).not.toMatch(/TypeError|Cannot read .*null|reading ['"]commit['"]/u)
  })

  it('rejects missing or drifted execution policy before Authorization consumption', () => {
    const accepted = preparedManifest('policy-validation')
    const drifted = manifestWithPolicy(accepted, {
      ...accepted.value.policy,
      stages: accepted.value.policy.stages.map((stage, index) => (
        index === 0 ? { ...stage, timeout_seconds: 31 } : stage
      )),
    })
    const driftedAuth = authorization(accepted, 'authorization-policy-drift')

    expect(() => execute(drifted, driftedAuth)).toThrow(/policy/u)
    expect(execute(accepted, driftedAuth).value.authorization_consumed).toBe(true)

    const missing = manifestWithoutPolicy(accepted)
    const missingAuth = authorization(accepted, 'authorization-policy-missing')
    expect(() => execute(missing, missingAuth)).toThrow(/policy/u)
    expect(execute(accepted, missingAuth).value.authorization_consumed).toBe(true)
  })

  it('terminalizes a stage timeout before an overall timeout and ignores inherited scenario keys', () => {
    const manifest = preparedManifest('synthetic-stage-timeout')
    const auth = authorization(manifest, 'authorization-synthetic-stage-timeout')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'TIMEOUT',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'stage_timeout' },
      mutation_counts: { production_writes: 0 },
      evidence: { source: 'synthetic' },
      finalized: true,
    })
    expect(result.value.stage_counts).toEqual({
      ...Object.fromEntries(Object.keys(expectedStageCounts).map((stage) => [stage, 0])),
      authorization_accept: 1,
      live_preconditions: 1,
    })
    expect(result.value.stage_durations_ms).toEqual({
      ...expectedStageDurations,
      live_preconditions: 5401000,
    })
    for (const excluded of ['commands', 'target', 'adapters', 'trace', 'raw_output', 'secrets', 'production_evidence']) {
      expect(result.value).not.toHaveProperty(excluded)
    }
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)

    const inheritedStage = Object.getOwnPropertyDescriptor(Object.prototype, 'stage')
    const inheritedResult = Object.getOwnPropertyDescriptor(Object.prototype, 'result')
    Object.defineProperties(Object.prototype, {
      stage: { configurable: true, value: 'live_preconditions' },
      result: {
        configurable: true,
        value: {
          outcome: 'NON_PASS',
          classification: 'private-inherited-scenario',
          duration_ms: 0,
        },
      },
    })
    try {
      for (const marker of ['toString', 'constructor', '__proto__']) {
        const ordinaryManifest = preparedManifest(marker)
        const ordinaryAuth = authorization(ordinaryManifest, `authorization-inherited-${marker}`)
        const ordinaryResult = execute(ordinaryManifest, ordinaryAuth)
        expect(ordinaryResult.value.outcome).toBe('PASS')
        expect(JSON.stringify(ordinaryResult.value)).not.toMatch(/private-inherited-scenario/u)
      }
    } finally {
      if (inheritedStage) Object.defineProperty(Object.prototype, 'stage', inheritedStage)
      else Reflect.deleteProperty(Object.prototype, 'stage')
      if (inheritedResult) Object.defineProperty(Object.prototype, 'result', inheritedResult)
      else Reflect.deleteProperty(Object.prototype, 'result')
    }
  })

  it('continues after a Stage duration exactly at its deadline', () => {
    const manifest = preparedManifest('synthetic-stage-timeout-equality')
    const auth = authorization(manifest, 'authorization-synthetic-stage-timeout-equality')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'PASS',
      first_terminal_stage: 'smoke_control_t0',
      failure: null,
      mutation_counts: { production_writes: 0 },
      evidence: { source: 'synthetic' },
      finalized: true,
    })
    expect(result.value.stage_counts).toEqual(expectedStageCounts)
    expect(result.value.stage_durations_ms).toEqual({
      ...expectedStageDurations,
      live_preconditions: 120000,
    })
    expect(result.value).not.toHaveProperty('synthetic_elapsed_ms')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
  })

  it('terminalizes an uncertain synthetic adapter outcome with no suffix execution', () => {
    const manifest = preparedManifest('synthetic-uncertain-adapter')
    const auth = authorization(manifest, 'authorization-synthetic-uncertain-adapter')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'UNCERTAIN',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'uncertain_adapter_outcome' },
      mutation_counts: { production_writes: 0 },
      evidence: { source: 'synthetic' },
      finalized: true,
    })
    expect(result.value.stage_counts).toEqual({
      ...Object.fromEntries(Object.keys(expectedStageCounts).map((stage) => [stage, 0])),
      authorization_accept: 1,
      live_preconditions: 1,
      d1_identity: 1,
    })
    expect(result.value.stage_durations_ms).toEqual({
      ...expectedStageDurations,
    })
    for (const excluded of ['commands', 'target', 'adapters', 'trace', 'raw_output', 'secrets', 'production_evidence', 'error', 'message', 'stack']) {
      expect(result.value).not.toHaveProperty(excluded)
    }
    expect(JSON.stringify(result.value)).not.toMatch(/synthetic-private-output/u)
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
  })

  it('enforces cumulative overall duration from a private synthetic elapsed observation at the public execute seam', () => {
    const manifest = preparedManifest('synthetic-overall-timeout')
    const auth = authorization(manifest, 'authorization-synthetic-overall-timeout')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'TIMEOUT',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'overall_timeout' },
      mutation_counts: { production_writes: 0 },
      evidence: { source: 'synthetic' },
      finalized: true,
    })
    expect(result.value.stage_counts).toEqual({
      ...Object.fromEntries(Object.keys(expectedStageCounts).map((stage) => [stage, 0])),
      authorization_accept: 1,
      live_preconditions: 1,
    })
    expect(result.value.stage_durations_ms).toEqual({
      ...expectedStageDurations,
    })
    expect(result.value).not.toHaveProperty('synthetic_elapsed_ms')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
  })

  it('continues after cumulative elapsed exactly at the overall deadline', () => {
    const manifest = preparedManifest('synthetic-overall-timeout-equality')
    const auth = authorization(manifest, 'authorization-synthetic-overall-timeout-equality')
    const result = execute(manifest, auth)

    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'PASS',
      first_terminal_stage: 'smoke_control_t0',
      failure: null,
      mutation_counts: { production_writes: 0 },
      evidence: { source: 'synthetic' },
      finalized: true,
    })
    expect(result.value.stage_counts).toEqual(expectedStageCounts)
    expect(result.value.stage_durations_ms).toEqual(expectedStageDurations)
    expect(result.value).not.toHaveProperty('synthetic_elapsed_ms')
    expect(() => execute(manifest, auth)).toThrow(/consumed|replay|one-shot/u)
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
    expect(result.value.identities.manifest_sha256).toBe('c25189412aa7ea80bec6c78bd47380b6e477c696547e5e11b548ce848a4820a0')
    expect(result.value.identities.authorization_sha256).toBe('3a018d41c529acdbe5dedf83cf99487115a313fa69a8fa2d21f5cfaa5824a5fa')
    expect(result.value.attempt_id).toBe('3686549b77142bb240354b6535856072354b9a85bbd0b57afafa444e20e565aa')
    expect(result.value.evidence.hashes).toEqual(['bd19b4591857ea9aab139ced2eb1afb5955050297ef2d4edb7c722f5b736e68c'])
    expect(result.value.authorization_consumed).toBe(true)
    expect(result.sha256).toBe('b7c73664d835980537ef791360d3e5f3b03307a14dd8da5f1c3f8bfccfa53995')
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
