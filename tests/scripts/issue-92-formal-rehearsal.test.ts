import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as deliveryEntry from '../../scripts/issue-23-delivery-entry.mjs'
import { runFormalRehearsal } from '../../scripts/issue-23-delivery-formal-rehearsal.mjs'
import { runInFormalRehearsalContext } from '../../scripts/issue-23-delivery-formal-context.mjs'

const REPOSITORY_ROOT = process.cwd()
const IS_MACOS = platform() === 'darwin'
const IS_MACOS_CI_GATE = IS_MACOS && process.env.GITHUB_ACTIONS === 'true'
const SHA256 = /^[a-f0-9]{64}$/u
const ALL_STAGES = [
  'authorization_accept',
  'live_preconditions',
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
  'worker_deploy',
  'version_traffic_verification',
  'smoke_control_t0',
] as const

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

function repositoryFact(args: string[]) {
  return execFileSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
}

function declaredFile(path: string) {
  return { path, sha256: sha256(readFileSync(join(REPOSITORY_ROOT, path))) }
}

function formalConfig() {
  const commit = repositoryFact(['rev-parse', 'HEAD'])
  const tree = repositoryFact(['rev-parse', 'HEAD^{tree}'])
  const catalogOutput = execFileSync(
    process.execPath,
    ['scripts/migrations.mjs', 'catalog', '--migrations-dir', 'db/ledger-migrations'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  ).trim()
  const catalog = JSON.parse(catalogOutput) as { migrations: Array<{ number: number; name: string; checksum: string }> }

  return {
    preparation: {
      prepare_entry: declaredFile('scripts/issue-23-delivery-prepare.mjs'),
      execute_entry: declaredFile('scripts/phase-b-sequence.mjs'),
      manifest_schema: declaredFile('schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json'),
    },
    repository: {
      canonical: 'nardinmarcus/blogman',
      remote: 'https://github.com/nardinmarcus/blogman.git',
      commit,
      tree,
      clean: true,
    },
    ci: {
      provider: 'github-actions',
      workflow: '.github/workflows/verify.yml',
      expected_head_sha: commit,
    },
    toolchain: {
      node: { version: process.versions.node, identity_sha256: '0'.repeat(64) },
      npm: { version: '0.0.0', identity_sha256: '0'.repeat(64) },
      curl: { version: '0.0.0', identity_sha256: '0'.repeat(64) },
      wrangler: { version: '0.0.0', identity_sha256: '0'.repeat(64) },
      opennextjs_cloudflare: { version: '0.0.0', identity_sha256: '0'.repeat(64) },
      package_json_sha256: '0'.repeat(64),
      lockfile_sha256: '0'.repeat(64),
    },
    artifact: {
      archive: { path: '.open-next/open-next-build.zip', sha256: '0'.repeat(64), bytes: 0 },
      worker: { path: '.open-next/worker.js', sha256: '0'.repeat(64), bytes: 0 },
      file_tree: {
        sha256: '0'.repeat(64),
        complete: true,
        files: [{ path: 'wrangler.toml', sha256: '0'.repeat(64), bytes: 0 }],
      },
    },
    migration: {
      delivery_mode: 'clean-start',
      reset_sql: declaredFile('db/issue-23-clean-start-reset.sql'),
      runner: declaredFile('scripts/migrations.mjs'),
      catalog: {
        path: 'db/ledger-migrations',
        sha256: sha256(Buffer.from(catalogOutput, 'utf8')),
        migrations: catalog.migrations.map((migration) => ({
          id: String(migration.number).padStart(3, '0'),
          path: `db/ledger-migrations/${migration.name}.sql`,
          sha256: sha256(readFileSync(join(REPOSITORY_ROOT, 'db/ledger-migrations', `${migration.name}.sql`))),
        })),
      },
      historical_data_disposition: {
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      },
    },
    target: {
      account_id: 'formal-account',
      d1_database_id: 'formal-d1',
      worker_name: 'blogman-formal',
      origin: 'https://formal.example.test',
      baseline: {
        deployment_id: 'formal-deployment',
        version_id: 'formal-version',
        d1_database_id: 'formal-d1',
        traffic: [{ version_id: 'formal-version', percentage: 100 }],
      },
    },
    policy: {
      authorization: {
        manifest_binding: 'manifest_sha256',
        one_shot: true,
        credential_slots: [{ name: 'cloudflare_delivery', scopes: ['account:read', 'workers:write', 'd1:write'] }],
      },
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
      drift: {
        frozen_preconditions: ['repository.commit', 'repository.tree', 'ci.head_sha', 'ci.tree', 'artifact.file_tree.sha256', 'migration.catalog.sha256', 'target.baseline'],
        observations: ['target.deployment_id', 'target.version_id', 'target.traffic', 'rehearsal.receipt_sha256'],
        mismatch_classification: 'Manifest Drift',
      },
      evidence: {
        allowed_hash_algorithm: 'sha256',
        excluded: ['secret_values', 'raw_private_adapter_output', 'sql_bodies', 'private_operator_paths'],
        production_evidence: 'real_adapters_only',
        local_rehearsal_evidence: 'test_only',
      },
    },
    rehearsal: {
      runtime: { os: 'macos', architecture: process.arch, node_version: process.versions.node },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: '0'.repeat(64),
      production_write_adapter_calls: 0,
    },
  }
}

describe('Issue #92 formal rehearsal public path', () => {
  it('exposes no public attempt/options wrapper or adapter injection surface', () => {
    expect(runFormalRehearsal.length).toBe(1)
    expect(deliveryEntry).not.toHaveProperty('runFormalRehearsalAttempt')
    expect(() => runFormalRehearsal({} as never, {} as never)).toThrow(/exactly one config/u)
  })

  it.skipIf(!IS_MACOS_CI_GATE)('runs public prepare(config) then public execute(manifest, authorization) through the exact no-network formal gate', { timeout: 120_000 }, () => {
    const result = runFormalRehearsal(formalConfig())

    expect(result.manifest.bytes).toEqual(expect.any(Uint8Array))
    expect(result.manifest.sha256).toMatch(SHA256)
    expect(result.manifest.value).toMatchObject({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      ci: {
        conclusion: 'in_progress-test-evidence',
        evidence_class: 'formal-rehearsal-test-evidence',
      },
      d1: { mode: 'remote', evidence_class: 'formal-rehearsal-test-evidence' },
    })
    expect(Object.keys(result.manifest.value)).not.toContain('test_only')
    expect(result.manifest.value.rehearsal.runtime_receipt).toMatchObject({
      format: 'blogman-issue-23-formal-rehearsal-runtime-receipt/v1',
      os: 'macos',
      arch: process.arch,
      node: { version: process.versions.node },
      entry: { path: 'scripts/issue-23-delivery-entry.mjs' },
    })
    for (const tool of ['node', 'npm', 'wrangler', 'opennextjs_cloudflare', 'curl', 'entry'] as const) {
      expect(result.manifest.value.rehearsal.runtime_receipt[tool].identity_sha256).toMatch(SHA256)
    }
    expect(result.terminal.value.outcome).toBe('PASS')
    expect(result.terminal.value.evidence).toMatchObject({
      source: 'formal-rehearsal-test-evidence',
      production: false,
      promotable: false,
    })
    expect(result.terminal.value.mutation_counts).toEqual({ production_writes: 0, attempted: 0, confirmed: 0 })
    for (const stage of ALL_STAGES) expect(result.terminal.value.stage_counts[stage]).toBe(1)
    expect(result.operations).toContainEqual(expect.objectContaining({
      adapter: 'd1', operation: 'clean_start_reset', command: expect.arrayContaining(['d1', 'execute', 'DB', '--remote']),
    }))
    expect(result.operations).toContainEqual(expect.objectContaining({
      adapter: 'worker', operation: 'version_traffic_verification.deploy', argv: expect.arrayContaining(['versions', 'deploy']),
    }))
    expect(result.operations).toContainEqual(expect.objectContaining({
      adapter: 'worker', operation: 'smoke_control_t0.smoke', argv: expect.arrayContaining(['--request', 'GET']),
    }))
    expect(() => deliveryEntry.validateProductionTerminalEvidence(result.terminal))
      .toThrow(/production terminal evidence/u)

    const productionAuthorization = {
      format: 'blogman-issue-23-authorization/v1',
      authorization_id: `formal-manifest-production-policy-${result.manifest.sha256.slice(0, 12)}`,
      manifest_sha256: result.manifest.sha256,
      decision: 'approve',
    }
    expect(() => deliveryEntry.execute(result.manifest, productionAuthorization))
      .toThrow(/ci evidence|d1 evidence|production/u)

    for (const mutate of [
      (value: Record<string, unknown>) => { value.format = 'invalid-manifest-format' },
      (value: Record<string, unknown>) => { (value.ci as Record<string, unknown>).conclusion = 'success' },
      (value: Record<string, unknown>) => { (value.d1 as Record<string, unknown>).evidence_class = 'production' },
    ]) {
      const value = structuredClone(result.manifest.value) as Record<string, unknown>
      mutate(value)
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      const manifest = { value, bytes, sha256: sha256(bytes) }
      const authorization = {
        format: 'blogman-issue-23-authorization/v1',
        authorization_id: `formal-manifest-mutation-${manifest.sha256.slice(0, 12)}`,
        manifest_sha256: manifest.sha256,
        decision: 'approve',
      }
      expect(() => runInFormalRehearsalContext({ sink: [] }, () => (
        deliveryEntry.execute(manifest, authorization)
      ))).toThrow(/formal test manifest|manifest format|ci\.conclusion|classification/u)
    }
  })

  it.skipIf(!IS_MACOS_CI_GATE)('covers a module-owned fail-closed live-precondition fault through the same public call graph', { timeout: 120_000 }, async () => {
    const { runFormalFaultHarnessForTestsOnly } = await import('../../scripts/issue-23-delivery-formal-fault-harness.mjs')
    const result = runFormalFaultHarnessForTestsOnly('live_preconditions', () => runFormalRehearsal(formalConfig()))

    expect(result.terminal.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'formal_rehearsal_forced_live_precondition_failure' },
      mutation_counts: { production_writes: 0, attempted: 0, confirmed: 0 },
    })
    expect(result.terminal.value.stage_counts).toEqual({
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
    })
    expect(result.operations).toEqual([
      expect.objectContaining({ adapter: 'worker', operation: 'live_preconditions.deployment_status' }),
    ])
  })

  it.skipIf(IS_MACOS)('does not substitute Linux ordinary verification for the macOS exact gate', () => {
    expect(() => runFormalRehearsal(formalConfig())).toThrow(/macOS/u)
  })

})
