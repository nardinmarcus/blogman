import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  runFormalRehearsalAttempt,
  validateProductionTerminalEvidence,
} from '../../scripts/issue-23-delivery-entry.mjs'
import { runFormalRehearsal } from '../../scripts/issue-23-delivery-formal-rehearsal.mjs'
import {
  canonicalBytes,
  prepareForTestsOnly,
} from '../../scripts/issue-23-delivery-prepare.mjs'
import {
  createRehearsalD1Transport,
  FORMAL_REHEARSAL_D1_EVIDENCE_SOURCE,
  getD1TransportProvenance,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'
import {
  createRehearsalWorkerTransport,
  createWorkerTransport,
  FORMAL_REHEARSAL_WORKER_EVIDENCE_SOURCE,
  getWorkerTransportProvenance,
} from '../../scripts/issue-23-delivery-worker-transport.mjs'
import { runWorkerStages } from '../../scripts/issue-23-delivery-worker-stages.mjs'

const REPOSITORY_ROOT = process.cwd()
const HASH = 'b'.repeat(64)
const D1_TRACE_HASH = 'c'.repeat(64)
const IS_MACOS = platform() === 'darwin'
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

function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function policy() {
  return {
    authorization: {
      manifest_binding: 'manifest_sha256',
      one_shot: true,
      credential_slots: [
        { name: 'cloudflare_delivery', scopes: ['account:read', 'workers:write', 'd1:write'] },
      ],
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
      frozen_preconditions: [
        'repository.commit',
        'repository.tree',
        'ci.head_sha',
        'ci.tree',
        'artifact.file_tree.sha256',
        'migration.catalog.sha256',
        'target.baseline',
      ],
      observations: [
        'target.deployment_id',
        'target.version_id',
        'target.traffic',
        'rehearsal.receipt_sha256',
      ],
      mismatch_classification: 'Manifest Drift',
    },
    evidence: {
      allowed_hash_algorithm: 'sha256',
      excluded: [
        'secret_values',
        'raw_private_adapter_output',
        'sql_bodies',
        'private_operator_paths',
      ],
      production_evidence: 'real_adapters_only',
      local_rehearsal_evidence: 'test_only',
    },
  }
}

function expectedReconciliation() {
  return {
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: '94d188515e4b8fcb1e97be029431328808c142a26adf50c045482f3fa8371c76' },
    migration_ledger: {
      state: 'present',
      row_count: 6,
      sha256: '1cf7c10bff6cf3d26bd46a59ef07af11bdf3376b3e989efd7e41c706b66a9f40',
    },
    posts: {
      count: 0,
      status: {},
      content_sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
  }
}

function cleanupArtifacts() {
  rmSync(join(REPOSITORY_ROOT, '.next'), { recursive: true, force: true })
  rmSync(join(REPOSITORY_ROOT, '.open-next'), { recursive: true, force: true })
}

let cachedPrepared: ReturnType<typeof formalPreparedManifest> | null = null
function preparedFixture() {
  cachedPrepared ??= formalPreparedManifest()
  return cachedPrepared
}

beforeAll(() => {
  cachedPrepared = formalPreparedManifest()
})

afterAll(() => {
  cleanupArtifacts()
  cachedPrepared = null
})

function formalPreparedManifest() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  const migrationCatalogPath = join(REPOSITORY_ROOT, 'db', 'ledger-migrations')
  const catalogBytes = Buffer.from(execFileSync(
    process.execPath,
    ['scripts/migrations.mjs', 'catalog', '--migrations-dir', realpathSync(migrationCatalogPath)],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  ).trim())
  const catalog = JSON.parse(catalogBytes.toString('utf8')) as {
    migrations: Array<{ number: number; name: string; checksum: string }>
  }
  const migrationEntries = catalog.migrations.map((entry) => {
    const name = `${String(entry.number).padStart(3, '0')}_${entry.name.replace(/^\d{3}_/u, '')}.sql`
    const path = `db/ledger-migrations/${name}`
    return {
      id: String(entry.number).padStart(3, '0'),
      path,
      sha256: hash(readFileSync(join(REPOSITORY_ROOT, path))),
    }
  })
  const expected = expectedReconciliation()
  const expectedSha256 = hash(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8'))
  const config = {
    preparation: {
      prepare_entry: { path: 'scripts/issue-23-delivery-prepare.mjs', sha256: HASH },
      execute_entry: { path: 'scripts/phase-b-sequence.mjs', sha256: HASH },
      manifest_schema: {
        path: 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
        sha256: HASH,
      },
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
      run_id: 1,
      attempt: 1,
      event: 'pull_request',
      head_sha: commit,
      tree,
      conclusion: 'success',
    },
    toolchain: {
      node: { version: process.versions.node, identity_sha256: HASH },
      npm: { version: '10.9.2', identity_sha256: HASH },
      curl: { version: '8.0.0', identity_sha256: HASH },
      wrangler: { version: '4.84.1', identity_sha256: HASH },
      opennextjs_cloudflare: { version: '1.19.1', identity_sha256: HASH },
      package_json_sha256: HASH,
      lockfile_sha256: HASH,
    },
    artifact: {
      archive: { path: '.open-next/open-next-build.zip', sha256: HASH, bytes: 1 },
      worker: { path: '.open-next/worker.js', sha256: HASH, bytes: 1 },
      file_tree: {
        sha256: HASH,
        complete: true,
        files: [
          { path: '.open-next/assets/index.html', sha256: HASH, bytes: 1 },
          { path: '.open-next/worker.js', sha256: HASH, bytes: 1 },
          { path: 'wrangler.toml', sha256: HASH, bytes: 1 },
        ],
      },
    },
    migration: {
      delivery_mode: 'clean-start',
      reset_sql: { path: 'db/issue-23-clean-start-reset.sql', sha256: HASH },
      runner: {
        path: 'scripts/migrations.mjs',
        sha256: hash(readFileSync(join(REPOSITORY_ROOT, 'scripts/migrations.mjs'))),
      },
      catalog: {
        path: 'db/ledger-migrations',
        sha256: hash(catalogBytes),
        migrations: migrationEntries,
      },
      historical_data_disposition: {
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      },
    },
    target: {
      account_id: 'account-id',
      d1_database_id: 'd1-id',
      worker_name: 'blogman',
      origin: 'https://blog.example.com',
      smoke: {
        requests: [
          { path: '/api/search', status: 200 },
          { path: '/api/settings/appearance', status: 200 },
          { path: '/api/settings/tokens', status: 200 },
          { path: '/api/settings/ai-provider', status: 200 },
          { path: '/api/settings/ai-generators', status: 200 },
          { path: '/api/admin/articles/__blogman_smoke_absent__', status: 404 },
        ],
        admin_credential_slot: 'delivery_smoke_admin',
      },
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: 'd1-id',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    },
    policy: policy(),
    rehearsal: {
      runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: HASH,
      production_write_adapter_calls: 0,
    },
  }
  const buildRunner = (repositoryPath: string) => {
    rmSync(join(repositoryPath, '.open-next'), { recursive: true, force: true })
    mkdirSync(join(repositoryPath, '.open-next', 'assets'), { recursive: true })
    writeFileSync(join(repositoryPath, '.open-next', 'assets', 'index.html'), 'index\n')
    writeFileSync(join(repositoryPath, '.open-next', 'worker.js'), 'worker\n')
    mkdirSync(join(repositoryPath, '.next', 'server'), { recursive: true })
    writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.json'), JSON.stringify({ node: {}, edge: {}, encryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }))
    writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.js'), 'self.__RSC_SERVER_MANIFEST="{\\"node\\":{},\\"edge\\":{},\\"encryptionKey\\":\\"process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY\\"}"')
    writeFileSync(join(repositoryPath, '.next', 'server', 'app-paths-manifest.json'), '{}')
    writeFileSync(join(repositoryPath, '.next', 'server', 'pages-manifest.json'), '{}')
    writeFileSync(join(repositoryPath, '.next', 'server', 'middleware-manifest.json'), JSON.stringify({ version: 3, middleware: {}, functions: {}, sortedMiddleware: [] }))
    writeFileSync(join(repositoryPath, '.next', 'routes-manifest.json'), JSON.stringify({ staticRoutes: [], dynamicRoutes: [], rewrites: { beforeFiles: [], afterFiles: [], fallback: [] } }))
  }
  const prepared = prepareForTestsOnly(config, {
    repositoryPath: REPOSITORY_ROOT,
    repositoryResolver: () => ({ commit, tree, clean: true }),
    ciResolver: (_path: string, source: typeof config, repository: { commit: string; tree: string }) => ({
      ...source.ci,
      head_sha: repository.commit,
      tree: repository.tree,
      conclusion: 'success',
    }),
    buildRunner,
    rehearsalRunner: () => ({
      runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: HASH,
      production_write_adapter_calls: 0,
      expected_reconciliation: { value: expected, sha256: expectedSha256 },
      d1: { outcome: 'PASS', production: false, promotable: false, sha256: D1_TRACE_HASH },
      cleanup: { created: true, cleaned: true, observed_absent: true },
    }),
  })
  const value = structuredClone(prepared.value)
  value.d1.mode = 'remote'
  value.d1.evidence_class = 'production'
  const bytes = canonicalBytes(value)
  return {
    value,
    bytes,
    sha256: hash(bytes),
    catalogMigrations: catalog.migrations,
  }
}

describe('Issue #92 formal rehearsal ordinary gate', () => {
  it('brands production worker transports and keeps unbranded transports non-production', () => {
    const production = createWorkerTransport({
      config_path: '/tmp/config',
      config_sha256: HASH,
      artifact_archive_path: '/tmp/archive',
      artifact_archive_sha256: HASH,
      artifact_source_path: '/tmp/source',
      artifact_file_tree_sha256: HASH,
      artifact_file_tree_files: [],
      artifact_sha256: HASH,
      candidate_id: 'a'.repeat(40),
      worker_name: 'blogman',
      d1_database_id: 'd1-id',
      rollout_safety_path: '/tmp/rollout',
      rollout_safety_sha256: HASH,
      expected_reconciliation_path: '/tmp/expected',
      expected_reconciliation_sha256: HASH,
      phase_b_sequence_path: '/tmp/phase-b',
      phase_b_sequence_sha256: HASH,
      wrangler_path: '/tmp/wrangler',
      wrangler_sha256: HASH,
      node_path: process.execPath,
      node_sha256: HASH,
      npm_path: '/tmp/npm',
      npm_sha256: HASH,
      open_next_path: '/tmp/opennext',
      open_next_sha256: HASH,
      curl_path: '/usr/bin/curl',
      curl_sha256: HASH,
      package_json_path: '/tmp/package.json',
      package_json_sha256: HASH,
      lockfile_path: '/tmp/package-lock.json',
      lockfile_sha256: HASH,
      database: 'DB',
      origin: 'https://blog.example.com',
      smoke: {
        requests: [
          { path: '/api/search', status: 200 },
          { path: '/api/settings/appearance', status: 200 },
          { path: '/api/settings/tokens', status: 200 },
          { path: '/api/settings/ai-provider', status: 200 },
          { path: '/api/settings/ai-generators', status: 200 },
          { path: '/api/admin/articles/__blogman_smoke_absent__', status: 404 },
        ],
      },
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: 'd1-id',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    })
    expect(getWorkerTransportProvenance(production)).toEqual({
      source: 'production',
      production: true,
    })

    const unbranded = runWorkerStages({
      bindings: {
        artifact_sha256: HASH,
        config_sha256: HASH,
        candidate_id: 'a'.repeat(40),
        d1_database_id: 'd1-id',
        smoke: { requests: [{ path: '/health', status: 200 }] },
      },
      transport: {
        execute: () => ({
          status: 1,
          stdout: '',
          stderr: 'fail',
          duration_ms: 1,
        }),
      },
    })
    expect(unbranded.value.evidence).toMatchObject({
      source: 'untrusted-test-transport',
      production: false,
      promotable: false,
    })
  })

  it('registers formal D1/Worker transports as source-level test evidence', () => {
    const sink: Array<Record<string, string>> = []
    const d1Bindings = {
      mode: 'remote',
      database: 'DB',
      config_path: `${REPOSITORY_ROOT}/wrangler.toml`,
      config_sha256: HASH,
      wrangler_sha256: HASH,
      account_id: 'account-id',
      d1_database_id: 'd1-id',
      reset_sql_path: `${REPOSITORY_ROOT}/db/issue-23-clean-start-reset.sql`,
      reset_sql_sha256: HASH,
      migration_runner_path: `${REPOSITORY_ROOT}/scripts/migrations.mjs`,
      migration_runner_sha256: HASH,
      migration_catalog_path: `${REPOSITORY_ROOT}/db/ledger-migrations`,
      migration_catalog_sha256: HASH,
      rollout_safety_path: `${REPOSITORY_ROOT}/scripts/rollout-safety.mjs`,
      rollout_safety_sha256: HASH,
      expected_reconciliation_path: '/tmp/expected.json',
      expected_reconciliation_sha256: HASH,
      candidate_id: 'a'.repeat(40),
      evidence_class: 'production',
      migrations: [
        { number: 1, name: '001_initial_schema', checksum: HASH },
        { number: 2, name: '002_add_ai_image_configuration', checksum: HASH },
        { number: 3, name: '003_migrate_runtime_ai_configuration', checksum: HASH },
        { number: 4, name: '004_complete_historical_text_ai_schema', checksum: HASH },
        { number: 5, name: '005_fix_posts_fts_sync', checksum: HASH },
        { number: 6, name: '006_add_rollout_safety_controls', checksum: HASH },
      ],
    }
    const d1 = createRehearsalD1Transport(d1Bindings, sink)
    expect(getD1TransportProvenance(d1)).toMatchObject({
      source: FORMAL_REHEARSAL_D1_EVIDENCE_SOURCE,
      production: false,
    })
    const worker = createRehearsalWorkerTransport({
      candidate_id: 'a'.repeat(40),
      worker_name: 'blogman',
      d1_database_id: 'd1-id',
      config_sha256: HASH,
      artifact_sha256: HASH,
      origin: 'https://blog.example.com',
      database: 'DB',
      smoke: {
        requests: [
          { path: '/api/search', status: 200 },
          { path: '/api/settings/appearance', status: 200 },
          { path: '/api/settings/tokens', status: 200 },
          { path: '/api/settings/ai-provider', status: 200 },
          { path: '/api/settings/ai-generators', status: 200 },
          { path: '/api/admin/articles/__blogman_smoke_absent__', status: 404 },
        ],
      },
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: 'd1-id',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    }, sink)
    expect(getWorkerTransportProvenance(worker)).toEqual({
      source: FORMAL_REHEARSAL_WORKER_EVIDENCE_SOURCE,
      production: false,
    })
    expect(() => createRehearsalWorkerTransport({
      candidate_id: 'a'.repeat(40),
      worker_name: 'blogman',
      d1_database_id: 'd1-id',
      config_sha256: HASH,
      artifact_sha256: HASH,
      origin: 'https://blog.example.com',
      database: 'DB',
      smoke: { requests: [{ path: '/api/search', status: 200 }] },
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: 'd1-id',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    }, sink, { networkProbe: 'worker_deploy' }).execute({
      operation: 'worker_deploy',
      stage: 'worker_deploy',
      timeout_ms: 1000,
      elapsed_ms: 0,
      version_id: null,
      deployment_id: null,
    })).toThrow(/refused network|production-write/u)
  })

  it('runs a complete formal PASS with zero production mutations and rejects production evidence', () => {
    const prepared = preparedFixture()
    const result = runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      { authorization_id: 'issue-92-pass' },
    )
    const terminal = result.terminal.value

    expect(terminal.outcome).toBe('PASS')
    expect(terminal.authorization_consumed).toBe(true)
    expect(terminal.evidence).toMatchObject({
      source: 'formal-rehearsal-test-evidence',
      production: false,
      promotable: false,
    })
    expect(terminal.mutation_counts).toEqual({
      production_writes: 0,
      attempted: 0,
      confirmed: 0,
    })
    for (const stage of ALL_STAGES) {
      expect(terminal.stage_counts[stage]).toBe(1)
    }
    expect(result.operations.some((entry) => entry.adapter === 'd1' && entry.operation === 'd1_identity')).toBe(true)
    expect(result.operations.some((entry) => entry.adapter === 'worker' && entry.operation === 'worker_deploy')).toBe(true)
    expect(result.runtime_receipt.value).toMatchObject({
      os: IS_MACOS ? 'macos' : platform(),
      arch: arch(),
      node: { version: process.versions.node },
      entry: { path: 'scripts/issue-23-delivery-entry.mjs' },
    })
    for (const tool of ['node', 'npm', 'wrangler', 'opennextjs_cloudflare', 'curl', 'entry'] as const) {
      expect(result.runtime_receipt.value[tool].identity_sha256).toMatch(/^[a-f0-9]{64}$/u)
    }
    expect(() => validateProductionTerminalEvidence(result.terminal)).toThrow(/production terminal evidence/u)
    expect(() => runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      { authorization_id: 'issue-92-pass' },
    )).toThrow(/consumed|replay|one-shot/u)
  })

  it('fail-closes at d1_identity with suffix-zero counters', () => {
    const prepared = preparedFixture()
    const result = runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      {
        authorization_id: 'issue-92-d1-fail',
        scenario: { failStage: 'd1_identity' },
      },
    )
    const terminal = result.terminal.value
    expect(terminal.outcome).not.toBe('PASS')
    expect(terminal.first_terminal_stage).toBe('d1_identity')
    expect(terminal.stage_counts.live_preconditions).toBe(1)
    expect(terminal.stage_counts.d1_identity).toBe(1)
    expect(terminal.stage_counts.clean_start_reset).toBe(0)
    expect(terminal.stage_counts.worker_deploy).toBe(0)
    expect(terminal.stage_counts.smoke_control_t0).toBe(0)
    expect(terminal.mutation_counts).toEqual({
      production_writes: 0,
      attempted: 0,
      confirmed: 0,
    })
    expect(terminal.evidence.production).toBe(false)
    expect(() => validateProductionTerminalEvidence(result.terminal)).toThrow(/production terminal evidence/u)
  })

  it('fail-closes at worker_deploy after D1 PASS with later suffix zero', () => {
    const prepared = preparedFixture()
    const result = runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      {
        authorization_id: 'issue-92-worker-fail',
        scenario: { failStage: 'worker_deploy' },
      },
    )
    const terminal = result.terminal.value
    expect(terminal.outcome).not.toBe('PASS')
    expect(terminal.first_terminal_stage).toBe('worker_deploy')
    expect(terminal.stage_counts.reconciliation).toBe(1)
    expect(terminal.stage_counts.worker_deploy).toBe(1)
    expect(terminal.stage_counts.version_traffic_verification).toBe(0)
    expect(terminal.stage_counts.smoke_control_t0).toBe(0)
    expect(terminal.mutation_counts).toEqual({
      production_writes: 0,
      attempted: 0,
      confirmed: 0,
    })
  })

  it('refuses network probes inside formal worker transport during an attempt', () => {
    const prepared = preparedFixture()
    const result = runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      {
        authorization_id: 'issue-92-network-trap',
        scenario: { networkProbe: 'worker_deploy' },
      },
    )
    expect(result.terminal.value.outcome).not.toBe('PASS')
    expect(result.terminal.value.first_terminal_stage).toBe('worker_deploy')
    expect(result.terminal.value.mutation_counts.production_writes).toBe(0)
  })

  it('keeps public execute arity at two arguments and rejects formal module option injection into prepare', () => {
    expect(runFormalRehearsal.length).toBeLessThanOrEqual(2)
    expect(() => runFormalRehearsal({}, null as never)).toThrow(/options must be a plain object/u)
  })
})

describe('Issue #92 formal rehearsal macOS exact gate', () => {
  it.skipIf(!IS_MACOS)('binds runtime receipt OS to macos on the target platform', () => {
    const prepared = preparedFixture()
    const result = runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      { authorization_id: 'issue-92-macos-receipt' },
    )
    expect(result.runtime_receipt.value.os).toBe('macos')
    expect(result.terminal.value.outcome).toBe('PASS')
  })

  it.skipIf(IS_MACOS)('records non-macos OS on ordinary Linux gate without substituting the macOS exact gate', () => {
    const prepared = preparedFixture()
    const result = runFormalRehearsalAttempt(
      { value: prepared.value, bytes: prepared.bytes, sha256: prepared.sha256 },
      { authorization_id: 'issue-92-linux-receipt' },
    )
    expect(result.runtime_receipt.value.os).not.toBe('macos')
    expect(result.terminal.value.evidence.production).toBe(false)
  })
})
