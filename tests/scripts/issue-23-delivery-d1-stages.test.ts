import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  D1_RECONCILIATION_DIMENSIONS,
  D1_STAGE_ORDER,
  D1_STAGE_TIMEOUT_MS,
  runD1Stages,
} from '../../scripts/issue-23-delivery-d1-stages.mjs'
import {
  D1TransportError,
  createD1Transport,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'
import { runWorkerStages } from '../../scripts/issue-23-delivery-worker-stages.mjs'

const MIGRATIONS = [
  { number: 1, name: '001_initial_schema', checksum: '8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05' },
  { number: 2, name: '002_add_ai_image_configuration', checksum: '8b4ad57e43a9f0dfcad5908c22b8f2965fa17771154db6d69f40168b8da30c49' },
  { number: 3, name: '003_migrate_runtime_ai_configuration', checksum: '719883025ac3013b0e435101b5ebd98ad358349b81f32935d7add646146d1bff' },
  { number: 4, name: '004_complete_historical_text_ai_schema', checksum: '12afd5f8171987b638692a564335165018d198ff8c7e5a706b0738c024c3d2fc' },
  { number: 5, name: '005_fix_posts_fts_sync', checksum: 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441' },
  { number: 6, name: '006_add_rollout_safety_controls', checksum: '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551' },
]

const RECONCILIATION_DIMENSIONS = [
  'schema',
  'migration_ledger',
  'post_count',
  'post_status',
  'post_content',
]

const repoRoot = process.cwd()

const BINDINGS = {
  mode: 'local',
  persist_path: realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-stage-fake-'))),
  database: 'DB',
  config_path: join(repoRoot, 'wrangler.toml'),
  config_sha256: sha256File(join(repoRoot, 'wrangler.toml')),
  wrangler_sha256: sha256File(realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))),
  account_id: 'account-public-id',
  d1_database_id: 'd1-public-id',
  reset_sql_path: join(repoRoot, 'db', 'issue-23-clean-start-reset.sql'),
  reset_sql_sha256: sha256File(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')),
  migration_runner_path: join(repoRoot, 'scripts', 'migrations.mjs'),
  migration_runner_sha256: sha256File(join(repoRoot, 'scripts', 'migrations.mjs')),
  migration_catalog_path: join(repoRoot, 'db', 'ledger-migrations'),
  migration_catalog_sha256: hashDirectory(join(repoRoot, 'db', 'ledger-migrations')),
  rollout_safety_path: join(repoRoot, 'scripts', 'rollout-safety.mjs'),
  rollout_safety_sha256: sha256File(join(repoRoot, 'scripts', 'rollout-safety.mjs')),
  expected_reconciliation_path: join(repoRoot, 'package.json'),
  expected_reconciliation_sha256: sha256File(join(repoRoot, 'package.json')),
  candidate_id: 'c'.repeat(40),
  evidence_class: 'test-non-production',
  migrations: MIGRATIONS,
}

const temporaryDirectories: string[] = [BINDINGS.persist_path]

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashDirectory(path: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const metadata = statSync(child)
      if (metadata.isDirectory()) visit(child, relativePath)
      else hash.update(`${relativePath}\0${metadata.size}\0`).update(readFileSync(child)).update('\0')
    }
  }
  visit(path, '')
  return hash.digest('hex')
}

function createLocalIntegrationBindings(
  statePath: string,
  expectedPath: string,
) {
  const configPath = join(repoRoot, 'wrangler.toml')
  const resetSqlPath = join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')
  const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
  const catalogPath = join(repoRoot, 'db', 'ledger-migrations')
  const rolloutSafetyPath = join(repoRoot, 'scripts', 'rollout-safety.mjs')
  return {
    mode: 'local' as const,
    persist_path: statePath,
    database: 'DB',
    config_path: configPath,
    config_sha256: sha256File(configPath),
    wrangler_sha256: sha256File(realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))),
    account_id: 'local-account-not-production',
    d1_database_id: 'local-d1-not-production',
    reset_sql_path: resetSqlPath,
    reset_sql_sha256: sha256File(resetSqlPath),
    migration_runner_path: runnerPath,
    migration_runner_sha256: sha256File(runnerPath),
    migration_catalog_path: catalogPath,
    migration_catalog_sha256: hashDirectory(catalogPath),
    rollout_safety_path: rolloutSafetyPath,
    rollout_safety_sha256: sha256File(rolloutSafetyPath),
    expected_reconciliation_path: expectedPath,
    expected_reconciliation_sha256: sha256File(expectedPath),
    candidate_id: 'c'.repeat(40),
    evidence_class: 'local-non-production',
    migrations: MIGRATIONS,
  }
}

function createBoundTransportBindings() {
  const statePath = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-stage-bound-')))
  temporaryDirectories.push(statePath)
  const expectedPath = join(statePath, 'expected-reconciliation.json')
  writeFileSync(expectedPath, `${JSON.stringify({
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: 'a'.repeat(64) },
    migration_ledger: { state: 'present', row_count: 6, sha256: 'b'.repeat(64) },
    posts: { count: 0, status: {}, content_sha256: 'c'.repeat(64) },
  })}\n`, { mode: 0o600 })
  return {
    ...BINDINGS,
    persist_path: statePath,
    expected_reconciliation_path: expectedPath,
    expected_reconciliation_sha256: sha256File(expectedPath),
    evidence_class: 'local-non-production',
  }
}

function createExpectedReconciliation(statePath: string): string {
  const expectedDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-expected-')))
  temporaryDirectories.push(expectedDirectory)
  const runner = join(repoRoot, 'scripts', 'migrations.mjs')
  const config = join(repoRoot, 'wrangler.toml')
  const apply = spawnSync(process.execPath, [
    runner,
    'apply',
    '--database', 'DB',
    '--local',
    '--persist-to', expectedDirectory,
    '--config', config,
    '--candidate', 'c'.repeat(40),
  ], { cwd: repoRoot, encoding: 'utf8' })
  expect(apply.status, apply.stderr).toBe(0)
  const capture = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'rollout-safety.mjs'),
    'reconcile',
    'capture',
    '--database', 'DB',
    '--local',
    '--persist-to', expectedDirectory,
    '--config', config,
  ], { cwd: repoRoot, encoding: 'utf8' })
  expect(capture.status, capture.stderr).toBe(0)
  const expectedPath = join(statePath, 'expected-reconciliation.json')
  writeFileSync(expectedPath, capture.stdout, { mode: 0o600 })
  return expectedPath
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function jsonResponse(value: unknown) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '', duration_ms: 1 }
}

function stageJsonResponse(value: unknown) {
  return jsonResponse(value)
}

function queryResponse(results: unknown[]) {
  return jsonResponse([{ results, success: true, meta: { duration: 0 } }])
}

function resetResponse() {
  return jsonResponse([{
    success: true,
    finalBookmark: 'reset-bookmark',
    meta: { rows_read: 0, rows_written: 1, size_after: 1 },
    results: [{
      'Total queries executed': 1,
      'Rows read': 0,
      'Rows written': 1,
      'Database size (MB)': '0.00',
    }],
  }])
}

function localResetResponse() {
  return jsonResponse(Array.from({ length: 15 }, () => ({
    success: true,
    results: [],
    meta: { duration: 1 },
  })))
}

function migrationState(state: 'current' | 'verified') {
  return {
    state,
    applied: MIGRATIONS.map((migration) => ({
      ...migration,
      applied_at: '2026-08-11T00:00:00.000Z',
      candidate_id: BINDINGS.candidate_id,
    })),
    pending: [],
  }
}

function createSuccessTransport() {
  const calls: Array<{ operation: string; request: Record<string, unknown> }> = []
  return {
    calls,
    execute(request: Record<string, unknown>) {
      calls.push({ operation: String(request.operation), request })
      switch (request.operation) {
        case 'd1_identity':
          return stageJsonResponse({
            account_id: BINDINGS.account_id,
            config_sha256: BINDINGS.config_sha256,
            d1_database_id: BINDINGS.d1_database_id,
          })
        case 'clean_start_reset':
          return BINDINGS.mode === 'local' ? localResetResponse() : resetResponse()
        case 'empty_d1_proof':
          return queryResponse([])
        case 'migration_catalog':
          return stageJsonResponse({
            format: 'blogman-migration-catalog/v1',
            migrations: MIGRATIONS,
          })
        case 'migration_plan':
          return stageJsonResponse({
            state: 'pending',
            applied: [],
            pending: MIGRATIONS.map((migration) => ({ ...migration, action: 'apply' })),
          })
        case 'migration_apply':
          return stageJsonResponse(migrationState('current'))
        case 'migration_verify':
          return stageJsonResponse(migrationState('verified'))
        case 'reconciliation':
          return stageJsonResponse({
            state: 'matched',
            checks: Object.fromEntries(RECONCILIATION_DIMENSIONS.map((dimension) => [dimension, 'matched'])),
          })
        default:
          throw new Error(`unexpected operation: ${String(request.operation)}`)
      }
    },
  }
}

function overrideTransport(
  overrides: Record<string, (request: Record<string, unknown>) => unknown>,
) {
  const transport = createSuccessTransport()
  const successExecute = transport.execute.bind(transport)
  transport.execute = (request: Record<string, unknown>) => {
    const override = overrides[String(request.operation)]
    if (override) {
      transport.calls.push({ operation: String(request.operation), request })
      return override(request)
    }
    return successExecute(request)
  }
  return transport
}

describe('Issue #23 D1 delivery stages', () => {
  it('forces unbranded transports to explicit non-production provenance', () => {
    const transport = createSuccessTransport()
    const result = runD1Stages({
      bindings: { ...BINDINGS, evidence_class: 'production' },
      transport,
    })

    expect(result.value.evidence).toMatchObject({
      source: 'untrusted-test-transport',
      production: false,
      promotable: false,
    })
  })

  it('preserves a transport account mismatch as Manifest Drift with no suffix', () => {
    const transport = overrideTransport({
      d1_identity: () => { throw new D1TransportError('manifest_drift') },
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'Manifest Drift' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual(['d1_identity'])
  })

  it('never marks an unbranded terminal failure promotable', () => {
    const transport = overrideTransport({
      clean_start_reset: () => ({
        status: 0,
        stdout: '{}',
        stderr: '',
        duration_ms: D1_STAGE_TIMEOUT_MS.clean_start_reset + 1,
      }),
    })
    const result = runD1Stages({
      bindings: { ...BINDINGS, evidence_class: 'production' },
      transport,
    })

    expect(result.value).toMatchObject({
      outcome: 'TIMEOUT',
      evidence: {
        source: 'untrusted-test-transport',
        production: false,
        promotable: false,
      },
    })
  })

  it('runs the five stages in order and returns only a sanitized PASS receipt', () => {
    const transport = createSuccessTransport()

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
      'migration_catalog',
      'migration_plan',
      'migration_apply',
      'migration_verify',
      'reconciliation',
    ])
    expect(transport.calls.map(({ request }) => request.timeout_ms)).toEqual([
      D1_STAGE_TIMEOUT_MS.d1_identity,
      D1_STAGE_TIMEOUT_MS.clean_start_reset,
      D1_STAGE_TIMEOUT_MS.empty_d1_proof,
      D1_STAGE_TIMEOUT_MS.migrations_001_006,
      D1_STAGE_TIMEOUT_MS.migrations_001_006,
      D1_STAGE_TIMEOUT_MS.migrations_001_006,
      D1_STAGE_TIMEOUT_MS.migrations_001_006,
      D1_STAGE_TIMEOUT_MS.reconciliation,
    ])
    expect(transport.calls[0].request).toMatchObject({
      operation: 'd1_identity',
      stage: 'd1_identity',
      elapsed_ms: 0,
    })
    expect(transport.calls[1].request).toMatchObject({
      operation: 'clean_start_reset',
      stage: 'clean_start_reset',
      elapsed_ms: 0,
    })
    expect(transport.calls[1].request).not.toHaveProperty('reset_sql_path')
    expect(transport.calls[1].request).not.toHaveProperty('sql')
    expect(D1_STAGE_ORDER).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
      'migrations_001_006',
      'reconciliation',
    ])
    expect(D1_RECONCILIATION_DIMENSIONS).toEqual(RECONCILIATION_DIMENSIONS)
    expect(result.value).toMatchObject({
      format: 'blogman-issue-23-d1-stages/v1',
      outcome: 'PASS',
      first_terminal_stage: null,
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 1,
        reconciliation: 1,
      },
      failure: null,
      finalized: true,
    })
    expect(result.value).not.toHaveProperty('raw_rows')
    expect(result.value).not.toHaveProperty('raw_output')
    expect(result.value).not.toHaveProperty('sql')
    expect(result.value).not.toHaveProperty('content')
    expect(result.value).not.toHaveProperty('password')
    expect(result.value.evidence).toMatchObject({
      bindings_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      wrangler_sha256: BINDINGS.wrangler_sha256,
    })
    expect(result.bytes).toEqual(Buffer.from(`${JSON.stringify(result.value, null, 2)}\n`, 'utf8'))
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('keeps binding digest stable across equivalent input key order', () => {
    const reordered = Object.fromEntries(
      Reflect.ownKeys(BINDINGS).reverse().map((key) => [key, BINDINGS[key as keyof typeof BINDINGS]]),
    )
    const first = runD1Stages({ bindings: BINDINGS, transport: createSuccessTransport() })
    const second = runD1Stages({ bindings: reordered, transport: createSuccessTransport() })

    expect(second.value.evidence.bindings_sha256).toBe(first.value.evidence.bindings_sha256)
  })

  it('terminalizes a transport-A and bindings-B digest mismatch before any child call', () => {
    const transportBindingsA = createBoundTransportBindings()
    const transportA = createD1Transport(transportBindingsA)
    const bindingsB = { ...transportBindingsA, candidate_id: 'd'.repeat(40) }

    const result = runD1Stages({ bindings: bindingsB, transport: transportA })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'transport_binding_mismatch' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 0,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
      },
      stage_durations_ms: {
        d1_identity: 0,
        clean_start_reset: 0,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
      },
      evidence: {
        production: false,
        promotable: false,
        wrangler_sha256: bindingsB.wrangler_sha256,
      },
    })
  })

  it('fails closed on account, config, or D1 identity drift before reset', () => {
    const transport = overrideTransport({
      d1_identity: () => jsonResponse({
        account_id: 'different-account',
        config_sha256: BINDINGS.config_sha256,
        d1_database_id: BINDINGS.d1_database_id,
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'Manifest Drift' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 0,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
      },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual(['d1_identity'])
    expect(JSON.stringify(result.value)).not.toContain('different-account')
  })

  it.each([
    ['account_id', 'different-account'],
    ['config_sha256', 'c'.repeat(64)],
    ['d1_database_id', 'different-d1'],
  ] as const)('stops before reset when %s drifts', (field, value) => {
    const identity: Record<string, string> = {
      account_id: BINDINGS.account_id,
      config_sha256: BINDINGS.config_sha256,
      d1_database_id: BINDINGS.d1_database_id,
    }
    identity[field] = value
    const transport = overrideTransport({
      d1_identity: () => jsonResponse(identity),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value.first_terminal_stage).toBe('d1_identity')
    expect(transport.calls.map(({ operation }) => operation)).toEqual(['d1_identity'])
  })

  it('validates the reset response before allowing the empty proof to run', () => {
    const transport = overrideTransport({
      clean_start_reset: () => jsonResponse({ success: true, body: 'private-reset-body' }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
      },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
    ])
    expect(JSON.stringify(result.value)).not.toContain('private-reset-body')
  })

  it('uses an exact internal-object allowlist and rejects _cf_unknown', () => {
    const transport = overrideTransport({
      empty_d1_proof: (request) => {
        expect(request).not.toHaveProperty('query')
        expect(request).not.toHaveProperty('sql')
        return queryResponse([{
          type: 'table',
          name: '_cf_unknown',
          tbl_name: '_cf_unknown',
          sql: 'CREATE TABLE _cf_unknown(private_body TEXT)',
        }])
      },
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'empty_d1_proof',
      failure: { classification: 'd1_not_empty' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 0,
        reconciliation: 0,
      },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
    ])
    expect(JSON.stringify(result.value)).not.toContain('_cf_unknown')
    expect(JSON.stringify(result.value)).not.toContain('private_body')
  })

  it('rejects a baseline or non-empty migration plan before apply', () => {
    const transport = overrideTransport({
      migration_plan: () => jsonResponse({
        state: 'pending',
        applied: [],
        pending: MIGRATIONS.map((migration, index) => ({
          ...migration,
          action: index === 0 ? 'baseline' : 'apply',
        })),
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'migrations_001_006',
      failure: { classification: 'empty_only_plan_invalid' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 1,
        reconciliation: 0,
      },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
      'migration_catalog',
      'migration_plan',
    ])
    expect(JSON.stringify(result.value)).not.toContain('baseline')
  })

  it('rejects a catalog missing one canonical migration before plan or apply', () => {
    const transport = overrideTransport({
      migration_catalog: () => jsonResponse({
        format: 'blogman-migration-catalog/v1',
        migrations: MIGRATIONS.slice(0, 5),
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'migrations_001_006',
      failure: { classification: 'migration_contract_invalid' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 1,
        reconciliation: 0,
      },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
      'migration_catalog',
    ])
  })

  it('binds apply and verify to the exact candidate and canonical migration identities', () => {
    const transport = createSuccessTransport()
    const result = runD1Stages({ bindings: BINDINGS, transport })
    const apply = transport.calls.find(({ operation }) => operation === 'migration_apply')
    const verify = transport.calls.find(({ operation }) => operation === 'migration_verify')

    expect(result.value.outcome).toBe('PASS')
    expect(apply?.request).toMatchObject({
      operation: 'migration_apply',
      stage: 'migrations_001_006',
    })
    expect(verify?.request).toMatchObject({
      operation: 'migration_verify',
      stage: 'migrations_001_006',
    })
    expect(apply?.request).not.toHaveProperty('candidate_id')
    expect(apply?.request).not.toHaveProperty('migration_runner_path')
  })

  it('stops after an apply ledger candidate mismatch and never verifies it', () => {
    const invalidState = migrationState('current')
    invalidState.applied[0].candidate_id = 'different-candidate'
    const transport = overrideTransport({
      migration_apply: () => jsonResponse(invalidState),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'migrations_001_006',
      failure: { classification: 'migration_ledger_invalid' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 1,
        reconciliation: 0,
      },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
      'migration_catalog',
      'migration_plan',
      'migration_apply',
    ])
    expect(JSON.stringify(result.value)).not.toContain('different-candidate')
  })

  it('stops after a verify checksum mutation instead of accepting a partial ledger', () => {
    const invalidState = migrationState('verified')
    invalidState.applied[2].checksum = 'f'.repeat(64)
    const transport = overrideTransport({
      migration_verify: () => jsonResponse(invalidState),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'migrations_001_006',
      failure: { classification: 'migration_ledger_invalid' },
    })
    expect(transport.calls.map(({ operation }) => operation).at(-1)).toBe('migration_verify')
    expect(JSON.stringify(result.value)).not.toContain('f'.repeat(64))
  })

  it.each(RECONCILIATION_DIMENSIONS)('fails when reconciliation mutates %s', (dimension) => {
    const transport = overrideTransport({
      reconciliation: () => jsonResponse({
        state: 'drift',
        checks: Object.fromEntries(RECONCILIATION_DIMENSIONS.map((current) => [
          current,
          current === dimension ? 'drift' : 'matched',
        ])),
        drift_dimensions: [dimension],
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'reconciliation',
      failure: { classification: 'reconciliation_drift' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 1,
        reconciliation: 1,
      },
    })
    expect(JSON.stringify(result.value)).not.toContain(dimension)
  })

  it('rejects reconciliation that drops one of the five dimensions', () => {
    const checks = Object.fromEntries(RECONCILIATION_DIMENSIONS.map((dimension) => [dimension, 'matched']))
    Reflect.deleteProperty(checks, 'post_content')
    const transport = overrideTransport({
      reconciliation: () => jsonResponse({ state: 'matched', checks }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'reconciliation',
      failure: { classification: 'reconciliation_contract_invalid' },
    })
  })

  it('does not retry or fall back after a transport failure', () => {
    const transport = overrideTransport({
      clean_start_reset: () => {
        throw new Error('private password and raw response body')
      },
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'transport_error' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
    ])
    expect(JSON.stringify(result.value)).not.toMatch(/private|password|raw response body/u)
  })

  it('rejects alternate runner paths and unsupported runtime bindings before transport', () => {
    const transport = createSuccessTransport()

    expect(() => runD1Stages({
      bindings: { ...BINDINGS, target: 'alternate-d1' },
      transport,
    })).toThrow(/unsupported fields/u)
    expect(() => runD1Stages({
      bindings: { ...BINDINGS, migration_runner_path: '/repo/scripts/other-runner.mjs' },
      transport,
    })).toThrow(/canonical/u)
    expect(transport.calls).toHaveLength(0)
  })

  it('bounds transport output and terminalizes without parsing or retrying it', () => {
    const transport = overrideTransport({
      empty_d1_proof: () => ({
        status: 0,
        stdout: 'x'.repeat(64 * 1024 + 1),
        stderr: '',
        duration_ms: 1,
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'UNCERTAIN',
      first_terminal_stage: 'empty_d1_proof',
      failure: { classification: 'uncertain' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_proof',
    ])
    expect(JSON.stringify(result.value)).not.toContain('x'.repeat(100))
  })

  it('turns a stage timeout into a terminal result with no suffix call', () => {
    const transport = overrideTransport({
      clean_start_reset: () => ({
        status: 0,
        stdout: '{}',
        stderr: '',
        duration_ms: D1_STAGE_TIMEOUT_MS.clean_start_reset + 1,
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'TIMEOUT',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'timeout' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
    ])
  })

  it.each([
    ['timed out', { status: 0, stdout: '', stderr: '', duration_ms: 3, timed_out: true }, 'TIMEOUT', 'timeout'],
    ['string timed_out', { status: 0, stdout: '', stderr: '', duration_ms: 3, timed_out: 'true' }, 'ERROR', 'malformed'],
    ['null timed_out', { status: 0, stdout: '', stderr: '', duration_ms: 3, timed_out: null }, 'ERROR', 'malformed'],
    ['nonzero', { status: 7, stdout: '', stderr: '', duration_ms: 3 }, 'ERROR', 'nonzero'],
    ['uncertain signal', { status: 0, signal: 'SIGKILL', stdout: '', stderr: '', duration_ms: 3 }, 'UNCERTAIN', 'uncertain'],
    ['malformed transport response', { status: 0, stdout: '', stderr: '' }, 'ERROR', 'malformed'],
  ] as const)('preserves the transport %s classification at the terminal boundary', (_name, response, outcome, classification) => {
    const transport = overrideTransport({ clean_start_reset: () => response })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome,
      first_terminal_stage: 'clean_start_reset',
      failure: { classification },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
    ])
  })

  it('rejects identity stderr as UNCERTAIN without exposing it or calling suffix stages', () => {
    const transport = overrideTransport({
      d1_identity: () => ({
        status: 0,
        stdout: JSON.stringify({
          account_id: BINDINGS.account_id,
          config_sha256: BINDINGS.config_sha256,
          d1_database_id: BINDINGS.d1_database_id,
        }),
        stderr: 'private identity stderr',
        duration_ms: 13,
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'UNCERTAIN',
      first_terminal_stage: 'd1_identity',
      stage_durations_ms: { d1_identity: 13 },
      failure: { classification: 'uncertain' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual(['d1_identity'])
    expect(JSON.stringify(result.value)).not.toContain('private identity stderr')
  })

  it('rejects successful transport with stderr before parsing its response', () => {
    const transport = overrideTransport({
      clean_start_reset: () => ({ ...resetResponse(), stderr: 'private stderr body' }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'UNCERTAIN',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'uncertain' },
    })
    expect(JSON.stringify(result.value)).not.toContain('private stderr body')
  })

  it('rejects duplicate response keys instead of accepting the last value', () => {
    const transport = overrideTransport({
      clean_start_reset: () => ({
        status: 0,
        stderr: '',
        stdout: '[{"success":false,"finalBookmark":"bookmark","meta":{"rows_read":0,"rows_written":1,"size_after":1},"results":[{"Total queries executed":1,"Rows read":0,"Rows written":1,"Database size (MB)":"0.00"}],"success":true}]',
        duration_ms: 1,
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
  })

  it('rejects escaped duplicate keys in identity and reconciliation contracts', () => {
    const identityTransport = overrideTransport({
      d1_identity: () => ({
        status: 0,
        stderr: '',
        stdout: `{"account_id":"${BINDINGS.account_id}","config_sha256":"${BINDINGS.config_sha256}","d1_database_id":"${BINDINGS.d1_database_id}","\\u0064\\u0031_database_id":"forged"}`,
        duration_ms: 1,
      }),
    })
    const identity = runD1Stages({ bindings: BINDINGS, transport: identityTransport })

    expect(identity.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'd1_identity_response_invalid' },
    })

    const reconciliationTransport = overrideTransport({
      reconciliation: () => ({
        status: 0,
        stderr: '',
        stdout: `{"state":"matched","checks":{"schema":"matched","migration_ledger":"matched","post_count":"matched","post_status":"matched","post_content":"matched"},"\\u0063hecks":{"forged":true}}`,
        duration_ms: 1,
      }),
    })
    const reconciliation = runD1Stages({ bindings: BINDINGS, transport: reconciliationTransport })

    expect(reconciliation.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'reconciliation',
      failure: { classification: 'reconciliation_response_invalid' },
    })
  })

  it.each([
    ['malformed', { status: 0, stdout: '{}', stderr: '', duration_ms: 7 }, 14],
    ['timeout', { status: 0, stdout: '', stderr: '', duration_ms: 11, timed_out: true }, 18],
  ] as const)('accounts migration operation duration exactly once for %s responses', (_label, response, expectedDuration) => {
    const transport = overrideTransport({
      migration_catalog: () => ({
        status: 0,
        stdout: JSON.stringify({ format: 'blogman-migration-catalog/v1', migrations: MIGRATIONS }),
        stderr: '',
        duration_ms: 7,
      }),
      migration_plan: () => response,
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value.stage_durations_ms.migrations_001_006).toBe(expectedDuration)
    expect(result.value.stage_durations_ms.migrations_001_006).not.toBe(expectedDuration * 2)
  })

  it('stops a multi-operation Stage suffix when the actual monotonic Stage deadline expires', () => {
    const transport = createSuccessTransport()
    const successExecute = transport.execute.bind(transport)
    let elapsedMs = 0
    transport.execute = (request: Record<string, unknown>) => {
      const response = successExecute(request)
      if (request.operation === 'migration_catalog') elapsedMs = D1_STAGE_TIMEOUT_MS.migrations_001_006
      return response
    }

    const result = runD1Stages({ bindings: BINDINGS, transport, monotonic_ms: () => elapsedMs })

    expect(result.value).toMatchObject({
      outcome: 'TIMEOUT',
      first_terminal_stage: 'migrations_001_006',
      failure: { classification: 'timeout' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity', 'clean_start_reset', 'empty_d1_proof', 'migration_catalog',
    ])
  })

  it('shares one monotonic 5,400-second budget with preconditions and Worker stages, including equality', () => {
    const livePreconditionsElapsedMs = 5_399_992
    const d1Transport = createSuccessTransport()
    const d1 = runD1Stages({
      bindings: BINDINGS,
      transport: d1Transport,
      elapsed_ms: livePreconditionsElapsedMs,
    })
    const d1ElapsedMs = Object.values(d1.value.stage_durations_ms).reduce((sum, duration) => sum + duration, 0)
    const workerCalls: unknown[] = []
    const worker = runWorkerStages({
      bindings: {
        manifest_sha256: '1'.repeat(64),
        authorization_sha256: '2'.repeat(64),
        attempt_id: '3'.repeat(64),
        candidate_id: '4'.repeat(40),
        smoke: { requests: [] },
      },
      transport: { execute(request: unknown) { workerCalls.push(request); throw new Error('must not run') } },
      elapsed_ms: livePreconditionsElapsedMs + d1ElapsedMs,
    })

    expect(d1.value.outcome).toBe('PASS')
    expect(d1Transport.calls.map(({ request }) => request.overall_elapsed_ms)).toEqual([
      5_399_992, 5_399_993, 5_399_994, 5_399_995,
      5_399_996, 5_399_997, 5_399_998, 5_399_999,
    ])
    expect(livePreconditionsElapsedMs + d1ElapsedMs).toBe(5_400_000)
    expect(worker.value).toMatchObject({
      outcome: 'TIMEOUT',
      first_terminal_stage: 'worker_deploy',
      failure: { classification: 'overall_timeout' },
    })
    expect(workerCalls).toEqual([])

    const exhausted = runD1Stages({
      bindings: BINDINGS,
      transport: createSuccessTransport(),
      elapsed_ms: 5_400_000,
    })
    expect(exhausted.value).toMatchObject({
      outcome: 'TIMEOUT',
      first_terminal_stage: 'd1_identity',
      stage_durations_ms: { d1_identity: 0 },
    })
  })

  it('composes the real local transport with all five D1 stages', () => {
    const statePath = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-stage-integration-')))
    temporaryDirectories.push(statePath)
    const expectedPath = createExpectedReconciliation(statePath)
    const bindings = createLocalIntegrationBindings(statePath, expectedPath)
    const transport = createD1Transport(bindings)

    const result = runD1Stages({ bindings, transport })

    expect(result.value).toMatchObject({
      outcome: 'PASS',
      first_terminal_stage: null,
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 1,
        empty_d1_proof: 1,
        migrations_001_006: 1,
        reconciliation: 1,
      },
      evidence: {
        source: 'local-non-production',
        production: false,
        promotable: false,
        d1_database_id: 'local-d1-not-production',
        expected_reconciliation_sha256: sha256File(expectedPath),
      },
    })
  }, 180_000)
})
