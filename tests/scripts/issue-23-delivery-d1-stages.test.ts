import { describe, expect, it } from 'vitest'
import {
  D1_RECONCILIATION_DIMENSIONS,
  D1_STAGE_ORDER,
  D1_STAGE_TIMEOUT_MS,
  runD1Stages,
} from '../../scripts/issue-23-delivery-d1-stages.mjs'

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

const BINDINGS = {
  database: 'DB',
  config_path: '/repo/wrangler.toml',
  config_sha256: 'a'.repeat(64),
  account_id: 'account-public-id',
  d1_database_id: 'd1-public-id',
  reset_sql_path: '/repo/db/issue-23-clean-start-reset.sql',
  reset_sql_sha256: 'b'.repeat(64),
  migration_runner_path: '/repo/scripts/migrations.mjs',
  migration_catalog_path: '/repo/db/ledger-migrations',
  candidate_id: 'candidate-001',
  migrations: MIGRATIONS,
}

function jsonResponse(value: unknown) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' }
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
          return jsonResponse({
            account_id: BINDINGS.account_id,
            config_sha256: BINDINGS.config_sha256,
            d1_database_id: BINDINGS.d1_database_id,
          })
        case 'clean_start_reset':
          return resetResponse()
        case 'empty_d1_objects':
          return jsonResponse([{ success: true, results: [] }])
        case 'migration_catalog':
          return jsonResponse({
            format: 'blogman-migration-catalog/v1',
            migrations: MIGRATIONS,
          })
        case 'migration_plan':
          return jsonResponse({
            state: 'pending',
            applied: [],
            pending: MIGRATIONS.map((migration) => ({ ...migration, action: 'apply' })),
          })
        case 'migration_apply':
          return jsonResponse(migrationState('current'))
        case 'migration_verify':
          return jsonResponse(migrationState('verified'))
        case 'reconciliation':
          return jsonResponse({
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
  it('runs the five stages in order and returns only a sanitized PASS receipt', () => {
    const transport = createSuccessTransport()

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_objects',
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
      expected_account_id: BINDINGS.account_id,
      expected_config_sha256: BINDINGS.config_sha256,
      d1_database_id: BINDINGS.d1_database_id,
    })
    expect(transport.calls[1].request).toMatchObject({
      reset_sql_path: BINDINGS.reset_sql_path,
      reset_sql_sha256: BINDINGS.reset_sql_sha256,
      config_path: BINDINGS.config_path,
      d1_database_id: BINDINGS.d1_database_id,
    })
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
    expect(result.bytes).toEqual(Buffer.from(`${JSON.stringify(result.value, null, 2)}\n`, 'utf8'))
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
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
      empty_d1_objects: (request) => {
        const query = String(request.query)
        expect(query).toContain("(name, tbl_name) IN (('_cf_KV', '_cf_KV'), ('_cf_METADATA', '_cf_METADATA'))")
        expect(query).not.toContain("name LIKE '_cf_%'")
        if (query.includes("name NOT GLOB '_cf_*'")) return jsonResponse([{ success: true, results: [] }])
        return jsonResponse([{
          success: true,
          results: [{
            type: 'table',
            name: '_cf_unknown',
            tbl_name: '_cf_unknown',
            sql: 'CREATE TABLE _cf_unknown(private_body TEXT)',
          }],
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
      'empty_d1_objects',
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
      'empty_d1_objects',
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
      'empty_d1_objects',
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
      candidate_id: BINDINGS.candidate_id,
      migration_runner_path: BINDINGS.migration_runner_path,
      migration_catalog_path: BINDINGS.migration_catalog_path,
    })
    expect(verify?.request).toMatchObject({
      migration_runner_path: BINDINGS.migration_runner_path,
      migration_catalog_path: BINDINGS.migration_catalog_path,
    })
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
      'empty_d1_objects',
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
      empty_d1_objects: () => ({
        status: 0,
        stdout: 'x'.repeat(64 * 1024 + 1),
        stderr: '',
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'empty_d1_proof',
      failure: { classification: 'output_overflow' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
      'empty_d1_objects',
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
      failure: { classification: 'stage_timeout' },
    })
    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'd1_identity',
      'clean_start_reset',
    ])
  })

  it('rejects successful transport with stderr before parsing its response', () => {
    const transport = overrideTransport({
      clean_start_reset: () => ({ ...resetResponse(), stderr: 'private stderr body' }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'transport_failure' },
    })
    expect(JSON.stringify(result.value)).not.toContain('private stderr body')
  })

  it('rejects duplicate response keys instead of accepting the last value', () => {
    const transport = overrideTransport({
      clean_start_reset: () => ({
        status: 0,
        stderr: '',
        stdout: '[{"success":false,"finalBookmark":"bookmark","meta":{"rows_read":0,"rows_written":1,"size_after":1},"results":[{"Total queries executed":1,"Rows read":0,"Rows written":1,"Database size (MB)":"0.00"}],"success":true}]',
      }),
    })

    const result = runD1Stages({ bindings: BINDINGS, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
  })
})
