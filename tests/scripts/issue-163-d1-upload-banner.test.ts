import { createHash } from 'node:crypto'
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
import { runD1Stages } from '../../scripts/issue-23-delivery-d1-stages.mjs'

const repoRoot = process.cwd()
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const MIGRATIONS = [
  { number: 1, name: '001_initial_schema', checksum: '8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05' },
  { number: 2, name: '002_add_ai_image_configuration', checksum: '8b4ad57e43a9f0dfcad5908c22b8f2965fa17771154db6d69f40168b8da30c49' },
  { number: 3, name: '003_migrate_runtime_ai_configuration', checksum: '719883025ac3013b0e435101b5ebd98ad358349b81f32935d7add646146d1bff' },
  { number: 4, name: '004_complete_historical_text_ai_schema', checksum: '12afd5f8171987b638692a564335165018d198ff8c7e5a706b0738c024c3d2fc' },
  { number: 5, name: '005_fix_posts_fts_sync', checksum: 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441' },
  { number: 6, name: '006_add_rollout_safety_controls', checksum: '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551' },
  { number: 7, name: '007_seed_rollout_executor', checksum: '282038f800f031de9716c07e2566f1a3efcd8ba8013cec9bf4e918a2a660c02d' },
]
const RECONCILIATION_DIMENSIONS = [
  'schema', 'migration_ledger', 'post_count', 'post_status', 'post_content',
]
// Issue #163: Cloudflare D1 v3-prod file imports print this dynamic upload
// banner (with a per-upload hash that changes every invocation) between the
// legacy two-line prefix and the JSON envelope. Captured read-only probes:
// dc240831c065defb and d4b4d8c56dd001fa.
const LEGACY_PREFIX = '├ Checking if file needs uploading\n│\n'
const UPLOAD_BANNER = (hash: string) => (
  `├ 🌀 Uploading 5d1cadcf-e10e-4245-b07d-16c64754f00d.${hash}.sql\n│ 🌀 Uploading complete.\n│\n`
)

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

function remoteStageBindings() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-163-remote-')))
  temporaryDirectories.push(directory)
  const expectedPath = writeExpectedReconciliation(directory)
  return {
    mode: 'remote' as const,
    database: 'DB',
    config_path: join(repoRoot, 'wrangler.toml'),
    config_sha256: sha256File(join(repoRoot, 'wrangler.toml')),
    wrangler_sha256: sha256File(realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))),
    account_id: 'account-public-id',
    d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
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

function localStageBindings() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-163-local-')))
  temporaryDirectories.push(directory)
  const expectedPath = writeExpectedReconciliation(directory)
  return {
    mode: 'local' as const,
    persist_path: directory,
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

function importResetEnvelope(): Record<string, unknown> {
  return JSON.parse(fixture('wrangler-4.86.0-d1-import-reset-remote.json'))[0] as Record<string, unknown>
}

function queryEnvelope(): Record<string, unknown> {
  return JSON.parse(fixture('wrangler-4.86.0-d1-query-remote.json'))[0] as Record<string, unknown>
}

function jsonResponse(stdout: string): Record<string, unknown> {
  return { status: 0, stdout, stderr: '', duration_ms: 1 }
}

function localResetStatements(): unknown[] {
  return Array.from({ length: 15 }, () => ({ success: true, results: [], meta: { duration: 1 } }))
}

function migrationState(state: 'current' | 'verified', candidateId: string) {
  return {
    state,
    applied: MIGRATIONS.map((migration) => ({
      ...migration,
      applied_at: '2026-08-18T00:00:00.000Z',
      candidate_id: candidateId,
    })),
    pending: [],
  }
}

function createTransport(
  bindings: ReturnType<typeof remoteStageBindings> | ReturnType<typeof localStageBindings>,
  overrides: Record<string, (request: Record<string, unknown>) => Record<string, unknown> | null> = {},
) {
  const execute = (request: Record<string, unknown>): Record<string, unknown> => {
    const override = overrides[String(request.operation)]
    if (override) {
      const result = override(request)
      if (result !== null) return result
    }
    switch (request.operation) {
      case 'd1_identity':
        return jsonResponse(JSON.stringify({
          account_id: bindings.account_id,
          config_sha256: bindings.config_sha256,
          d1_database_id: bindings.d1_database_id,
        }))
      case 'clean_start_reset':
        return bindings.mode === 'local'
          ? jsonResponse(JSON.stringify(localResetStatements()))
          : jsonResponse(JSON.stringify([importResetEnvelope()]))
      case 'empty_d1_proof':
        return jsonResponse(JSON.stringify([{ ...queryEnvelope(), results: [] }]))
      case 'migration_catalog':
        return jsonResponse(JSON.stringify({ format: 'blogman-migration-catalog/v1', migrations: MIGRATIONS }))
      case 'migration_plan':
        return jsonResponse(JSON.stringify({
          state: 'pending',
          applied: [],
          pending: MIGRATIONS.map((migration) => ({ ...migration, action: 'apply' })),
        }))
      case 'migration_apply':
        return jsonResponse(JSON.stringify(migrationState('current', bindings.candidate_id)))
      case 'migration_verify':
        return jsonResponse(JSON.stringify(migrationState('verified', bindings.candidate_id)))
      case 'reconciliation':
        return jsonResponse(JSON.stringify({
          state: 'matched',
          checks: Object.fromEntries(RECONCILIATION_DIMENSIONS.map((dimension) => [dimension, 'matched'])),
        }))
      default:
        throw new Error(`unexpected operation: ${String(request.operation)}`)
    }
  }
  return { execute }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Issue #163 D1 v3-prod dynamic upload banner tolerance', () => {
  it('replays the D14-R5 burn: dynamic per-upload hash banner before the reset envelope', () => {
    const bindings = remoteStageBindings()
    // The exact v3-prod shape captured in the read-only probe
    // prepare-r4-evidence/d14c9/d14c9-fileimport-envelope.json.
    const polluted = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}${JSON.stringify([importResetEnvelope()])}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(polluted),
    })

    const result = runD1Stages({ bindings, transport })

    expect(result.value.outcome).toBe('PASS')
    expect(result.value.first_terminal_stage).toBeNull()
  })

  it('accepts a second probe hash (per-upload hashes differ every invocation)', () => {
    const bindings = remoteStageBindings()
    const polluted = `${LEGACY_PREFIX}${UPLOAD_BANNER('d4b4d8c56dd001fa')}${JSON.stringify([importResetEnvelope()])}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(polluted),
    })

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it('accepts multi-line banners listing several upload files', () => {
    const bindings = remoteStageBindings()
    const multi = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}${UPLOAD_BANNER('d4b4d8c56dd001fa')}${JSON.stringify([importResetEnvelope()])}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(multi),
    })

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it('keeps accepting the legacy two-line prefix without the upload banner', () => {
    const bindings = remoteStageBindings()
    const legacy = `${LEGACY_PREFIX}${JSON.stringify([importResetEnvelope()])}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(legacy),
    })

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it('accepts a banner before the local reset multi-envelope array (15 statements)', () => {
    const bindings = localStageBindings()
    const polluted = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}${JSON.stringify(localResetStatements())}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(polluted),
    })

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it('still fails closed when stdout carries banner noise but no JSON document', () => {
    const bindings = remoteStageBindings()
    const noise = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}upload finished, nothing printed`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(noise),
    })

    const result = runD1Stages({ bindings, transport })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
  })

  it('hardens the query capture family: upload banner before the empty-D1-proof envelope', () => {
    const bindings = remoteStageBindings()
    const polluted = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}${JSON.stringify([{ ...queryEnvelope(), results: [] }])}`
    const transport = createTransport(bindings, {
      empty_d1_proof: () => jsonResponse(polluted),
    })

    const result = runD1Stages({ bindings, transport })

    expect(result.value.outcome).toBe('PASS')
  })

  it('hardens the catalog family: banner before the migration catalog document', () => {
    const bindings = remoteStageBindings()
    const polluted = `${UPLOAD_BANNER('dc240831c065defb')}${JSON.stringify({ format: 'blogman-migration-catalog/v1', migrations: MIGRATIONS })}`
    const transport = createTransport(bindings, {
      migration_catalog: () => jsonResponse(polluted),
    })

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })

  it('prefers a line-start JSON envelope over a JSON-shaped mid-line banner fragment', () => {
    const bindings = remoteStageBindings()
    // A future banner that embeds a balanced JSON fragment mid-line must not
    // shadow the real envelope that starts at a line boundary.
    const polluted = `${LEGACY_PREFIX}├ 🌀 Uploading {"probe":"fragment"}.sql\n│\n${JSON.stringify([importResetEnvelope()])}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(polluted),
    })

    expect(runD1Stages({ bindings, transport }).value.outcome).toBe('PASS')
  })
})

describe('Issue #163 durable D1 stage evidence sink', () => {
  it('persists bounded hash-named stdout/stderr per executed stage on success', () => {
    const bindings = remoteStageBindings()
    const evidenceDir = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-163-evidence-')))
    temporaryDirectories.push(evidenceDir)
    const transport = createTransport(bindings)

    const result = runD1Stages({ bindings, transport, d1_evidence_dir: evidenceDir })

    expect(result.value.outcome).toBe('PASS')
    const files = readdirSync(evidenceDir).sort()
    const executed = [
      'd1_identity', 'clean_start_reset', 'empty_d1_proof',
      'migrations_001_007', 'reconciliation',
    ]
    const stageEvidence = result.value.stage_evidence as Record<string, { stdout_sha256: string; stderr_sha256: string }>
    for (const stage of executed) {
      const stdoutFile = files.find((name) => name.startsWith(`${stage}.`) && name.endsWith('.stdout'))
      const stderrFile = files.find((name) => name.startsWith(`${stage}.`) && name.endsWith('.stderr'))
      expect(stdoutFile, `${stage} stdout evidence`).toBeDefined()
      expect(stderrFile, `${stage} stderr evidence`).toBeDefined()
      expect((statSync(join(evidenceDir, stdoutFile as string)).mode & 0o777)).toBe(0o600)
      expect((statSync(join(evidenceDir, stderrFile as string)).mode & 0o777)).toBe(0o600)
    }
    const operations = Reflect.ownKeys(stageEvidence)
    expect(operations).toEqual([
      'd1_identity', 'clean_start_reset', 'empty_d1_proof',
      'migration_catalog', 'migration_plan', 'migration_apply', 'migration_verify',
      'reconciliation',
    ])
    for (const operation of operations) {
      const { stdout_sha256, stderr_sha256 } = stageEvidence[String(operation)]
      expect(stdout_sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(stderr_sha256).toBe(SHA256_EMPTY)
    }
  })

  it('keeps receipt hashes addressable: hash-named files match the receipt stage_evidence', () => {
    const bindings = remoteStageBindings()
    const evidenceDir = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-163-evidence-')))
    temporaryDirectories.push(evidenceDir)
    const resetPolluted = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}${JSON.stringify([importResetEnvelope()])}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(resetPolluted),
    })

    const result = runD1Stages({ bindings, transport, d1_evidence_dir: evidenceDir })

    expect(result.value.outcome).toBe('PASS')
    const stageEvidence = result.value.stage_evidence as Record<string, { stdout_sha256: string; stderr_sha256: string }>
    const files = readdirSync(evidenceDir)
    for (const [operation, { stdout_sha256 }] of Object.entries(stageEvidence)) {
      const stage = operation === 'clean_start_reset' ? 'clean_start_reset'
        : operation.startsWith('migration_') ? 'migrations_001_007'
          : operation
      const name = `${stage}.${stdout_sha256}.stdout`
      expect(files, `file for ${operation}`).toContain(name)
    }
    // The reset capture replayed the burn: its durable stdout is the polluted
    // banner + envelope stream whose hash appears in the receipt.
    const resetHash = stageEvidence.clean_start_reset.stdout_sha256
    expect(readFileSync(join(evidenceDir, `clean_start_reset.${resetHash}.stdout`), 'utf8')).toContain('Uploading')
  })

  it('persists byte-level evidence for a failed reset parse (the burn needs this)', () => {
    const bindings = remoteStageBindings()
    const evidenceDir = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-163-evidence-')))
    temporaryDirectories.push(evidenceDir)
    const polluted = `${LEGACY_PREFIX}${UPLOAD_BANNER('dc240831c065defb')}${JSON.stringify({ not: 'an-envelope' })}`
    const transport = createTransport(bindings, {
      clean_start_reset: () => jsonResponse(polluted),
    })

    const result = runD1Stages({ bindings, transport, d1_evidence_dir: evidenceDir })

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'clean_start_reset',
      failure: { classification: 'reset_response_invalid' },
    })
    const files = readdirSync(evidenceDir)
    const stageEvidence = result.value.stage_evidence as Record<string, { stdout_sha256: string; stderr_sha256: string }>
    // d1_identity and clean_start_reset both executed; their raw stdout landed.
    expect(files.some((name) => name.startsWith('d1_identity.') && name.endsWith('.stdout'))).toBe(true)
    expect(files.some((name) => name.startsWith('clean_start_reset.') && name.endsWith('.stdout'))).toBe(true)
    expect(Object.keys(stageEvidence)).toEqual(['d1_identity', 'clean_start_reset'])
    // The record keeps the recomputed reset stdout identity itself.
    expect(stageEvidence.clean_start_reset).toBeDefined()
  })
})