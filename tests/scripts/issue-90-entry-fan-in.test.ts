import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const { createD1TransportMock, runD1StagesMock } = vi.hoisted(() => ({
  createD1TransportMock: vi.fn(),
  runD1StagesMock: vi.fn(),
}))

vi.mock('../../scripts/issue-23-delivery-d1-transport.mjs', () => ({
  createD1Transport: createD1TransportMock,
}))
vi.mock('../../scripts/issue-23-delivery-d1-stages.mjs', () => ({
  D1_STAGE_ORDER: [
    'd1_identity',
    'clean_start_reset',
    'empty_d1_proof',
    'migrations_001_006',
    'reconciliation',
  ],
  runD1Stages: runD1StagesMock,
}))

import { execute } from '../../scripts/issue-23-delivery-entry.mjs'

const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const MANIFEST_FORMAT = 'blogman-issue-23-canonical-frozen-manifest/v1'
const D1_RESULT_FORMAT = 'blogman-issue-23-d1-stages/v1'
const CANDIDATE = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
const D1_TRACE_HASH = 'c'.repeat(64)
const D1_OPERATIONS = [
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migration_catalog',
  'migration_plan',
  'migration_apply',
  'migration_verify',
  'reconciliation',
]

function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function policy() {
  return {
    stages: [
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
    ],
    overall_timeout_seconds: 5400,
  }
}

function expectedReconciliation() {
  return {
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: HASH },
    migration_ledger: { state: 'present', row_count: 6, sha256: HASH },
    posts: { count: 0, status: {}, content_sha256: HASH },
  }
}

function d1Binding(overrides: Record<string, unknown> = {}) {
  const expected = expectedReconciliation()
  const expectedBytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8')
  const binding = {
    mode: 'remote',
    database: 'DB',
    config_path: 'wrangler.toml',
    config_sha256: HASH,
    wrangler_sha256: HASH,
    account_id: 'account-id',
    d1_database_id: 'd1-id',
    reset_sql_path: 'db/issue-23-clean-start-reset.sql',
    reset_sql_sha256: HASH,
    migration_runner_path: 'scripts/migrations.mjs',
    migration_runner_sha256: HASH,
    migration_catalog_path: 'db/ledger-migrations',
    migration_catalog_sha256: HASH,
    rollout_safety_path: 'scripts/rollout-safety.mjs',
    rollout_safety_sha256: HASH,
    expected_reconciliation_format: expected.format,
    expected_reconciliation_sha256: hash(expectedBytes),
    expected_reconciliation: expected,
    candidate_id: CANDIDATE,
    evidence_class: 'production',
    migrations: [
      { number: 1, name: '001_initial_schema', checksum: HASH },
      { number: 2, name: '002_add_ai_image_configuration', checksum: HASH },
      { number: 3, name: '003_migrate_runtime_ai_configuration', checksum: HASH },
      { number: 4, name: '004_complete_historical_text_ai_schema', checksum: HASH },
      { number: 5, name: '005_fix_posts_fts_sync', checksum: HASH },
      { number: 6, name: '006_add_rollout_safety_controls', checksum: HASH },
    ],
    ...overrides,
  }
  return binding
}

function manifest(overrides: Record<string, unknown> = {}) {
  const d1 = d1Binding()
  const value = {
    format: MANIFEST_FORMAT,
    repository: { commit: CANDIDATE, tree: 'd'.repeat(40) },
    target: { account_id: 'account-id', d1_database_id: 'd1-id' },
    policy: policy(),
    d1,
    ...overrides,
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function authorizationFor(prepared: ReturnType<typeof manifest>, id: string) {
  return {
    format: AUTHORIZATION_FORMAT,
    authorization_id: id,
    manifest_sha256: prepared.sha256,
    decision: 'approve',
  }
}

function d1Result(failedStage: string | null = null) {
  const stages = [
    'd1_identity',
    'clean_start_reset',
    'empty_d1_proof',
    'migrations_001_006',
    'reconciliation',
  ]
  const terminal = failedStage ?? null
  const failedIndex = failedStage === null ? stages.length - 1 : stages.indexOf(failedStage)
  const counts = Object.fromEntries(stages.map((stage, index) => [stage, index <= failedIndex ? 1 : 0]))
  const durations = Object.fromEntries(stages.map((stage) => [stage, 1]))
  const value = {
    format: D1_RESULT_FORMAT,
    outcome: failedStage === null ? 'PASS' : 'NON_PASS',
    first_terminal_stage: terminal,
    failure: failedStage === null ? null : { classification: 'Manifest Drift' },
    stage_counts: counts,
    stage_durations_ms: durations,
    evidence: {
      source: 'production',
      production: true,
      promotable: failedStage === null,
      trace_sha256: D1_TRACE_HASH,
    },
    finalized: true,
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function configureD1(failedStage: string | null = null) {
  const calls: string[] = []
  const transport = {
    execute(request: { operation: string }) {
      calls.push(request.operation)
      return { status: 0, stdout: '{}', stderr: '', duration_ms: 1 }
    },
  }
  createD1TransportMock.mockImplementation(() => transport)
  runD1StagesMock.mockImplementation(({ transport: activeTransport }: { transport: typeof transport }) => {
    const operations = failedStage === null
      ? D1_OPERATIONS
      : D1_OPERATIONS.slice(0, D1_OPERATIONS.indexOf(failedStage) + 1)
    for (const operation of operations) activeTransport.execute({ operation })
    return d1Result(failedStage)
  })
  return calls
}

describe('Issue #90 formal entry fan-in', () => {
  it('consumes authorization before reads, preserves D1 operation order, and cleans materialized expected state', () => {
    const calls = configureD1()
    let authorizationRead = false
    createD1TransportMock.mockImplementationOnce(() => {
      expect(authorizationRead).toBe(true)
      return {
        execute(request: { operation: string }) {
          calls.push(request.operation)
          return { status: 0, stdout: '{}', stderr: '', duration_ms: 1 }
        },
      }
    })
    const prepared = manifest()
    const authorization = {
      ...authorizationFor(prepared, 'fan-in-order'),
      get decision() {
        authorizationRead = true
        return 'approve'
      },
    }

    const result = execute(prepared, authorization)
    const bindings = createD1TransportMock.mock.calls.at(-1)?.[0] as Record<string, unknown>

    expect(calls).toEqual(D1_OPERATIONS)
    expect(Object.keys(bindings)).not.toContain('expected_reconciliation')
    expect(bindings.expected_reconciliation_path).toEqual(expect.any(String))
    expect(existsSync(String(bindings.expected_reconciliation_path))).toBe(false)
    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'worker_deploy',
      failure: { classification: 'production_stage_adapter_unavailable' },
      evidence: { source: 'production', production: true, promotable: false },
    })
  })

  it('terminalizes D1 drift before reset with no suffix and no retry', () => {
    const calls = configureD1('d1_identity')
    const prepared = manifest()
    const authorization = authorizationFor(prepared, 'fan-in-drift')

    const result = execute(prepared, authorization)

    expect(calls).toEqual(['d1_identity'])
    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'Manifest Drift' },
    })
    expect(result.value.stage_counts).toMatchObject({
      authorization_accept: 1,
      live_preconditions: 1,
      d1_identity: 1,
      clean_start_reset: 0,
      worker_deploy: 0,
    })
    expect(() => execute(prepared, authorization)).toThrow(/consumed|replay|one-shot/u)
  })

  it('reaches the first unavailable suffix stage after D1 PASS and never claims production PASS', () => {
    configureD1()
    const prepared = manifest()

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-suffix'))

    expect(result.value.first_terminal_stage).toBe('worker_deploy')
    expect(result.value.stage_counts).toMatchObject({
      worker_deploy: 1,
      version_traffic_verification: 0,
      smoke_control_t0: 0,
    })
    expect(result.value.outcome).not.toBe('PASS')
    expect(result.value.failure.classification).toBe('production_stage_adapter_unavailable')
  })

  it('rejects expected reconciliation hash drift before selecting a production adapter', () => {
    configureD1()
    const prepared = manifest()
    prepared.value.d1.expected_reconciliation.schema.sha256 = 'e'.repeat(64)
    prepared.bytes = Buffer.from(`${JSON.stringify(prepared.value, null, 2)}\n`, 'utf8')
    prepared.sha256 = hash(prepared.bytes)

    expect(() => execute(prepared, authorizationFor(prepared, 'fan-in-expected-drift')))
      .toThrow(/expected reconciliation hash/u)
    expect(createD1TransportMock).not.toHaveBeenCalled()
  })

  it('does not select a local non-production lane at the production entry', () => {
    configureD1()
    const prepared = manifest({ d1: d1Binding({ mode: 'local', evidence_class: 'local-non-production' }) })

    expect(() => execute(prepared, authorizationFor(prepared, 'fan-in-local-lane')))
      .toThrow(/remote production/u)
    expect(createD1TransportMock).not.toHaveBeenCalled()
  })

  it('keeps the public execute arity at exactly two arguments', () => {
    configureD1()
    const prepared = manifest()

    expect(execute).toHaveLength(2)
    expect(() => execute(prepared, authorizationFor(prepared, 'fan-in-arity'), { override: true }))
      .toThrow(/two arguments/u)
  })
})
