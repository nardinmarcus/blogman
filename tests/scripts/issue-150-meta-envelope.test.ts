import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { D1_STAGE_TIMEOUT_MS, runD1Stages } from '../../scripts/issue-23-delivery-d1-stages.mjs'
import {
  D1_COMMAND_CONTRACT,
  createRehearsalD1Transport,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'
import {
  parseRemoteD1InfoResponse,
  parseWranglerWhoamiResponse,
} from '../../scripts/issue-23-delivery-d1-contracts.mjs'
import { WORKER_COMMAND_CONTRACT } from '../../scripts/issue-23-delivery-worker-transport.mjs'

const repoRoot = process.cwd()
const D1_UUID = '11111111-2222-4333-8444-555555555555'
const ACCOUNT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MIGRATIONS = [
  { number: 1, name: '001_initial_schema', checksum: '8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05' },
  { number: 2, name: '002_add_ai_image_configuration', checksum: '8b4ad57e43a9f0dfcad5908c22b8f2965fa17771154db6d69f40168b8da30c49' },
  { number: 3, name: '003_migrate_runtime_ai_configuration', checksum: '719883025ac3013b0e435101b5ebd98ad358349b81f32935d7add646146d1bff' },
  { number: 4, name: '004_complete_historical_text_ai_schema', checksum: '12afd5f8171987b638692a564335165018d198ff8c7e5a706b0738c024c3d2fc' },
  { number: 5, name: '005_fix_posts_fts_sync', checksum: 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441' },
  { number: 6, name: '006_add_rollout_safety_controls', checksum: '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551' },
]

const temporaryDirectories: string[] = []

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

function fixture(name: string): string {
  return readFileSync(join(repoRoot, 'tests', 'fixtures', 'issue-150', name), 'utf8')
}

function writeExpectedReconciliation(directory: string): string {
  const expectedPath = join(directory, 'expected-reconciliation.json')
  writeFileSync(expectedPath, `${JSON.stringify({
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: 'a'.repeat(64) },
    migration_ledger: { state: 'present', row_count: 6, sha256: 'b'.repeat(64) },
    posts: { count: 0, status: {}, content_sha256: 'c'.repeat(64) },
  })}\n`, { mode: 0o600 })
  return expectedPath
}

function remoteStageBindings(evidenceClass = 'test-non-production') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-150-remote-')))
  temporaryDirectories.push(directory)
  const expectedPath = writeExpectedReconciliation(directory)
  return {
    mode: 'remote' as const,
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
    expected_reconciliation_path: expectedPath,
    expected_reconciliation_sha256: sha256File(expectedPath),
    manifest_sha256: '1'.repeat(64),
    authorization_sha256: '2'.repeat(64),
    attempt_id: '3'.repeat(64),
    candidate_id: 'c'.repeat(40),
    evidence_class: evidenceClass,
    migrations: MIGRATIONS,
  }
}

function localTransportConfig() {
  const statePath = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-150-local-')))
  temporaryDirectories.push(statePath)
  const expectedPath = writeExpectedReconciliation(statePath)
  return {
    mode: 'local' as const,
    persist_path: statePath,
    database: 'DB',
    config_path: join(repoRoot, 'wrangler.toml'),
    config_sha256: sha256File(join(repoRoot, 'wrangler.toml')),
    wrangler_sha256: sha256File(realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))),
    account_id: 'local-account-not-production',
    d1_database_id: 'local-d1-not-production',
    reset_sql_path: join(repoRoot, 'db', 'issue-23-clean-start-reset.sql'),
    reset_sql_sha256: sha256File(join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')),
    migration_runner_path: join(repoRoot, 'scripts', 'migrations.mjs'),
    migration_runner_sha256: sha256File(join(repoRoot, 'scripts', 'migrations.mjs')),
    migration_catalog_path: join(repoRoot, 'db', 'ledger-migrations'),
    migration_catalog_sha256: hashDirectory(join(repoRoot, 'db', 'ledger-migrations')),
    rollout_safety_path: join(repoRoot, 'scripts', 'rollout-safety.mjs'),
    rollout_safety_sha256: sha256File(join(repoRoot, 'scripts', 'rollout-safety.mjs')),
    expected_reconciliation_path: expectedPath,
    expected_reconciliation_sha256: sha256File(expectedPath),
    manifest_sha256: null,
    authorization_sha256: null,
    attempt_id: null,
    candidate_id: 'c'.repeat(40),
    evidence_class: 'test-non-production',
    migrations: MIGRATIONS,
  }
}

function jsonResponse(value: unknown) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '', duration_ms: 1 }
}

function migrationState(state: 'current' | 'verified', candidateId: string) {
  return {
    state,
    applied: MIGRATIONS.map((migration) => ({
      ...migration,
      applied_at: '2026-08-16T00:00:00.000Z',
      candidate_id: candidateId,
    })),
    pending: [],
  }
}

function createSuccessTransport(bindings: ReturnType<typeof remoteStageBindings>) {
  return {
    execute(request: Record<string, unknown>) {
      switch (request.operation) {
        case 'd1_identity':
          return jsonResponse({
            account_id: bindings.account_id,
            config_sha256: bindings.config_sha256,
            d1_database_id: bindings.d1_database_id,
          })
        case 'clean_start_reset':
          return jsonResponse(JSON.parse(fixture('wrangler-4.86.0-d1-import-reset-remote.json')))
        case 'empty_d1_proof':
          return jsonResponse(withResults(JSON.parse(fixture('wrangler-4.86.0-d1-query-remote.json')), []))
        case 'migration_catalog':
          return jsonResponse({ format: 'blogman-migration-catalog/v1', migrations: MIGRATIONS })
        case 'migration_plan':
          return jsonResponse({
            state: 'pending',
            applied: [],
            pending: MIGRATIONS.map((migration) => ({ ...migration, action: 'apply' })),
          })
        case 'migration_apply':
          return jsonResponse(migrationState('current', bindings.candidate_id))
        case 'migration_verify':
          return jsonResponse(migrationState('verified', bindings.candidate_id))
        case 'reconciliation':
          return jsonResponse({
            state: 'matched',
            checks: Object.fromEntries(['schema', 'migration_ledger', 'post_count', 'post_status', 'post_content']
              .map((dimension) => [dimension, 'matched'])),
          })
        default:
          throw new Error(`unexpected operation: ${String(request.operation)}`)
      }
    },
  }
}

function withResults(envelopes: Array<Record<string, unknown>>, results: unknown[]) {
  return envelopes.map((envelope) => ({ ...envelope, results }))
}

function overrideReset(stdout: string) {
  return jsonResponse(JSON.parse(stdout))
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Issue #150 reset import envelope meta tolerance', () => {
  it('accepts the live remote import meta carrying duration and other upstream keys', () => {
    const bindings = remoteStageBindings()
    const result = runD1Stages({ bindings, transport: createSuccessTransport(bindings) })

    expect(result.value.outcome).toBe('PASS')
    expect(result.value.first_terminal_stage).toBeNull()
  })

  it('tolerates extra keys in the reset envelope and its summary row', () => {
    const live = JSON.parse(fixture('wrangler-4.86.0-d1-import-reset-remote.json'))
    live[0].future_envelope_key = null
    live[0].results[0]['Duration (ms)'] = '21.35'
    const bindings = remoteStageBindings()
    const transport = {
      execute(request: Record<string, unknown>) {
        if (request.operation === 'clean_start_reset') return overrideReset(JSON.stringify(live))
        return createSuccessTransport(bindings).execute(request)
      },
    }

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it.each([
    ['missing rows_written', (meta: Record<string, unknown>) => { delete meta.rows_written }],
    ['string rows_read', (meta: Record<string, unknown>) => { meta.rows_read = '0' }],
    ['negative size_after', (meta: Record<string, unknown>) => { meta.size_after = -1 }],
    ['fractional rows_written', (meta: Record<string, unknown>) => { meta.rows_written = 1.5 }],
  ] as const)('keeps rejecting reset meta with %s', (_label, mutate) => {
    const live = JSON.parse(fixture('wrangler-4.86.0-d1-import-reset-remote.json'))
    mutate(live[0].meta)
    const bindings = remoteStageBindings()
    const transport = {
      execute(request: Record<string, unknown>) {
        if (request.operation === 'clean_start_reset') return overrideReset(JSON.stringify(live))
        return createSuccessTransport(bindings).execute(request)
      },
    }

    expect(runD1Stages({ bindings, transport }).value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
  })

  it('keeps the summary-row cross-checks against the frozen meta numerics', () => {
    const live = JSON.parse(fixture('wrangler-4.86.0-d1-import-reset-remote.json'))
    live[0].results[0]['Rows read'] = 999
    const bindings = remoteStageBindings()
    const transport = {
      execute(request: Record<string, unknown>) {
        if (request.operation === 'clean_start_reset') return overrideReset(JSON.stringify(live))
        return createSuccessTransport(bindings).execute(request)
      },
    }

    expect(runD1Stages({ bindings, transport }).value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
  })

  it('keeps requiring finalBookmark and success on the import envelope', () => {
    const live = JSON.parse(fixture('wrangler-4.86.0-d1-import-reset-remote.json'))
    delete live[0].finalBookmark
    const bindings = remoteStageBindings()
    const transport = {
      execute(request: Record<string, unknown>) {
        if (request.operation === 'clean_start_reset') return overrideReset(JSON.stringify(live))
        return createSuccessTransport(bindings).execute(request)
      },
    }

    expect(runD1Stages({ bindings, transport }).value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
  })
})

describe('Issue #150 query envelope meta tolerance', () => {
  it('accepts the live 13-key remote query meta with a float duration for the empty proof', () => {
    const bindings = remoteStageBindings()
    const result = runD1Stages({ bindings, transport: createSuccessTransport(bindings) })

    expect(result.value.outcome).toBe('PASS')
    expect(result.value.stage_counts.empty_d1_proof).toBe(1)
  })

  it('still requires meta.duration as a non-negative finite number', () => {
    for (const mutate of [
      (meta: Record<string, unknown>) => { delete meta.duration },
      (meta: Record<string, unknown>) => { meta.duration = -0.5 },
      (meta: Record<string, unknown>) => { meta.duration = 'fast' },
      (meta: Record<string, unknown>) => { meta.duration = Number.NaN },
    ]) {
      const live = JSON.parse(fixture('wrangler-4.86.0-d1-query-remote.json'))
      mutate(live[0].meta)
      const bindings = remoteStageBindings()
      const transport = {
        execute(request: Record<string, unknown>) {
          if (request.operation === 'empty_d1_proof') {
            return jsonResponse(withResults(live, []))
          }
          return createSuccessTransport(bindings).execute(request)
        },
      }

      expect(runD1Stages({ bindings, transport }).value).toMatchObject({
        outcome: 'ERROR',
        first_terminal_stage: 'empty_d1_proof',
      })
    }
  })

  it('tolerates extra envelope keys on remote query envelopes', () => {
    const live = JSON.parse(fixture('wrangler-4.86.0-d1-query-remote.json'))
    live[0].finalBookmark = 'upstream-may-add-this-to-command-queries'
    const bindings = remoteStageBindings()
    const transport = {
      execute(request: Record<string, unknown>) {
        if (request.operation === 'empty_d1_proof') return jsonResponse(withResults(live, []))
        return createSuccessTransport(bindings).execute(request)
      },
    }

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it('accepts extra meta keys on local reset statement envelopes', () => {
    const statements = Array.from({ length: 15 }, () => ({
      success: true,
      results: [],
      meta: { duration: 1, changes: 0, last_row_id: 0 },
    }))
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-150-local-reset-')))
    temporaryDirectories.push(directory)
    const expectedPath = writeExpectedReconciliation(directory)
    const bindings = {
      ...remoteStageBindings(),
      mode: 'local' as const,
      persist_path: directory,
      expected_reconciliation_path: expectedPath,
      expected_reconciliation_sha256: sha256File(expectedPath),
      evidence_class: 'test-non-production' as const,
    }
    const success = createSuccessTransport({ ...bindings, mode: 'remote' as const })
    const transport = {
      execute(request: Record<string, unknown>) {
        if (request.operation === 'clean_start_reset') return jsonResponse(statements)
        if (request.operation === 'empty_d1_proof') {
          return jsonResponse([{ results: [], success: true, meta: { duration: 0 } }])
        }
        return success.execute(request)
      },
    }

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })
})

describe('Issue #150 D1 info variant tolerance', () => {
  it('accepts the live info shape carrying an upstream-added key', () => {
    const info = JSON.parse(fixture('wrangler-4.86.0-d1-info-remote-live.json'))
    info.estimation_threshold = 99

    expect(parseRemoteD1InfoResponse(JSON.stringify(info), D1_UUID)).toMatchObject({
      running_in_region: 'APAC',
      database_size: 16384,
    })
  })

  it('keeps the database identity drift defense under key tolerance', () => {
    const info = JSON.parse(fixture('wrangler-4.86.0-d1-info-remote-live.json'))
    info.estimation_threshold = 99

    expect(() => parseRemoteD1InfoResponse(
      JSON.stringify({ ...info, uuid: '22222222-3333-4444-8555-666666666666' }),
      D1_UUID,
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_DATABASE_MISMATCH' }))
  })

  it('keeps rejecting a non-alpha version value on tolerant variants', () => {
    const info = JSON.parse(fixture('wrangler-4.86.0-d1-info-remote-live.json'))
    info.version = 'beta'

    expect(() => parseRemoteD1InfoResponse(JSON.stringify(info), D1_UUID)).toThrow()
  })
})

describe('Issue #150 whoami shape tolerance', () => {
  it('accepts upstream-added top-level keys on the env-token shape', () => {
    const whoami = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami-env-token.json'),
      'utf8',
    )

    expect(parseWranglerWhoamiResponse(
      whoami.replace('"loggedIn": true', '"loggedIn": true, "email": "upstream@example.invalid"'),
      ACCOUNT_ID,
    )).toMatchObject({ loggedIn: true })
  })

  it('accepts upstream-added keys at the account, settings, and quota levels', () => {
    const whoami = JSON.parse(readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami.json'),
      'utf8',
    ))
    whoami.scheduled_deprecation = false
    whoami.accounts[0].enforce_invite_links = false
    whoami.accounts[0].settings.worker_chat_enabled = null
    whoami.accounts[0].legacy_flags.enterprise_zone_quota.future_quota = 5

    expect(parseWranglerWhoamiResponse(JSON.stringify(whoami), ACCOUNT_ID)).toMatchObject({ loggedIn: true })
  })

  it.each([
    ['api_access_enabled removed', (settings: Record<string, unknown>) => { delete settings.api_access_enabled }],
    ['enforce_twofactor removed', (settings: Record<string, unknown>) => { delete settings.enforce_twofactor }],
    ['enforce_twofactor non-boolean', (settings: Record<string, unknown>) => { settings.enforce_twofactor = 'no' }],
  ] as const)('keeps rejecting the OAuth account settings with %s', (_label, mutate) => {
    const whoami = JSON.parse(readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami.json'),
      'utf8',
    ))
    mutate(whoami.accounts[0].settings)

    expect(() => parseWranglerWhoamiResponse(JSON.stringify(whoami), ACCOUNT_ID)).toThrow()
  })

  it('keeps rejecting an unauthenticated or mismatched account under tolerance', () => {
    const whoami = JSON.parse(readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami-env-token.json'),
      'utf8',
    ))
    whoami.future_top_level_key = true
    whoami.loggedIn = false

    expect(() => parseWranglerWhoamiResponse(JSON.stringify(whoami), ACCOUNT_ID)).toThrow()
    whoami.loggedIn = true
    whoami.accounts[0].id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    expect(() => parseWranglerWhoamiResponse(JSON.stringify(whoami), ACCOUNT_ID))
      .toThrowError(expect.objectContaining({ code: 'DELIVERY_ACCOUNT_MISMATCH' }))
  })
})

describe('Issue #150 local identity probe tolerance', () => {
  it('accepts a local identity envelope with float duration and upstream meta keys', () => {
    const config = localTransportConfig()
    const stdout = JSON.stringify([{
      results: [{ __blogman_d1_identity_probe: 1 }],
      success: true,
      meta: { duration: 0.25, changes: 0, last_row_id: 0 },
    }])

    expect(() => D1_COMMAND_CONTRACT.identityResponse(config, {
      status: 0,
      stdout,
      stderr: '',
      duration_ms: 1,
    })).not.toThrow()
  })

  it('keeps the exact single-key identity probe row', () => {
    const config = localTransportConfig()
    const stdout = JSON.stringify([{
      results: [{ __blogman_d1_identity_probe: 1, extra_column: 2 }],
      success: true,
      meta: { duration: 0.25 },
    }])

    expect(() => D1_COMMAND_CONTRACT.identityResponse(config, {
      status: 0,
      stdout,
      stderr: '',
      duration_ms: 1,
    })).toThrow('D1 transport malformed')
  })
})

describe('Issue #150 deployment status tolerance', () => {
  it('accepts upstream-added keys in deployment version entries', () => {
    const stdout = JSON.stringify({
      id: 'deployment-id',
      source: 'wrangler',
      versions: [{
        version_id: 'version-id',
        percentage: 100,
        created_on: '2026-08-16T00:00:00.000Z',
      }],
    })

    expect(WORKER_COMMAND_CONTRACT.parseDeployment(stdout, 'version-id', 'd1-id'))
      .toMatchObject({ deployment_id: 'deployment-id', version_id: 'version-id' })
  })

  it('keeps the 100% traffic drift defense', () => {
    const stdout = JSON.stringify({
      id: 'deployment-id',
      versions: [{ version_id: 'version-id', percentage: 90 }],
    })

    expect(() => WORKER_COMMAND_CONTRACT.parseDeployment(stdout, 'version-id', 'd1-id'))
      .toThrowError(expect.objectContaining({ classification: 'version_traffic_mismatch' }))
  })
})

describe('Issue #150 formal rehearsal synthesizers align with live shapes', () => {
  it('passes the full stage contract with live-shaped synthesized envelopes', () => {
    const bindings = remoteStageBindings('formal-rehearsal-test-evidence')
    const transport = createRehearsalD1Transport(bindings, [])

    const result = runD1Stages({ bindings, transport })

    expect(result.value.outcome).toBe('PASS')
  })

  it('synthesizes the reset envelope with live import meta keys', () => {
    const bindings = remoteStageBindings('formal-rehearsal-test-evidence')
    const transport = createRehearsalD1Transport(bindings, [])
    const reset = transport.execute({
      operation: 'clean_start_reset',
      stage: 'clean_start_reset',
      timeout_ms: D1_STAGE_TIMEOUT_MS.clean_start_reset,
      elapsed_ms: 0,
      overall_elapsed_ms: 0,
    })
    const envelope = JSON.parse(reset.stdout)[0]

    expect(Object.keys(envelope.meta)).toEqual(expect.arrayContaining([
      'duration', 'rows_read', 'rows_written', 'size_after',
    ]))
    expect(envelope.meta.duration).toEqual(expect.any(Number))
    expect(envelope.results[0]['Rows read']).toBe(envelope.meta.rows_read)
  })

  it('synthesizes the empty-proof query envelope with the live remote meta shape', () => {
    const bindings = remoteStageBindings('formal-rehearsal-test-evidence')
    const transport = createRehearsalD1Transport(bindings, [])
    const proof = transport.execute({
      operation: 'empty_d1_proof',
      stage: 'empty_d1_proof',
      timeout_ms: D1_STAGE_TIMEOUT_MS.empty_d1_proof,
      elapsed_ms: 0,
      overall_elapsed_ms: 0,
    })
    const meta = JSON.parse(proof.stdout)[0].meta

    expect(Object.keys(meta)).toEqual(expect.arrayContaining([
      'served_by', 'timings', 'duration', 'changes', 'last_row_id',
      'changed_db', 'size_after', 'rows_read', 'rows_written', 'total_attempts',
    ]))
    expect(Number.isFinite(meta.duration)).toBe(true)
  })
})
