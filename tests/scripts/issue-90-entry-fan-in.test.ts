import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createD1TransportMock, runD1StagesMock, createWorkerTransportMock, runWorkerStagesMock, fsActual } = vi.hoisted(() => ({
  createD1TransportMock: vi.fn(),
  runD1StagesMock: vi.fn(),
  createWorkerTransportMock: vi.fn(),
  runWorkerStagesMock: vi.fn(),
  fsActual: {
    realpathSync: undefined as typeof import('node:fs').realpathSync | undefined,
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  fsActual.realpathSync = actual.realpathSync
  return {
    ...actual,
    realpathSync: vi.fn(actual.realpathSync),
  }
})

vi.mock('../../scripts/issue-23-delivery-d1-transport.mjs', () => ({
  createD1Transport: createD1TransportMock,
  createRehearsalD1Transport: createD1TransportMock,
}))
vi.mock('../../scripts/issue-23-delivery-d1-stages.mjs', () => ({
  D1_STAGE_ORDER: ['d1_identity', 'clean_start_reset', 'empty_d1_proof', 'migrations_001_006', 'reconciliation'],
  runD1Stages: runD1StagesMock,
}))
vi.mock('../../scripts/issue-23-delivery-worker-transport.mjs', () => ({
  createWorkerTransport: createWorkerTransportMock,
  createRehearsalWorkerTransport: createWorkerTransportMock,
}))
vi.mock('../../scripts/issue-23-delivery-worker-stages.mjs', () => ({ runWorkerStages: runWorkerStagesMock }))

afterEach(() => {
  vi.mocked(realpathSync).mockImplementation(fsActual.realpathSync!)
})

import { execute, validateProductionTerminalEvidence } from '../../scripts/issue-23-delivery-entry.mjs'
import {
  canonicalBytes,
  prepareForTestsOnly,
} from '../../scripts/issue-23-delivery-prepare.mjs'
import { buildFormalRuntimeReceipt } from '../../scripts/issue-23-delivery-formal-runtime.mjs'
import { hashD1ArtifactDirectory } from '../../scripts/issue-23-delivery-d1-contracts.mjs'

const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const MANIFEST_FORMAT = 'blogman-issue-23-canonical-frozen-manifest/v1'
const D1_RESULT_FORMAT = 'blogman-issue-23-d1-stages/v1'
const CANDIDATE = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
const D1_TRACE_HASH = 'c'.repeat(64)
const D1_EVIDENCE_HASHES = [
  'bindings_sha256', 'wrangler_sha256', 'config_sha256', 'reset_sql_sha256',
  'migration_runner_sha256', 'migration_catalog_sha256', 'rollout_safety_sha256',
  'expected_reconciliation_sha256', 'trace_sha256',
]
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
const REPOSITORY_ROOT = process.cwd()
const DURABLE_SINK_ROOT = join(REPOSITORY_ROOT, '.issue-23-delivery')
const ENTRY_MODULE_URL = pathToFileURL(join(REPOSITORY_ROOT, 'scripts/issue-23-delivery-entry.mjs')).href
const SINK_MODULE_URL = pathToFileURL(join(REPOSITORY_ROOT, 'scripts/issue-23-delivery-evidence-sink.mjs')).href
const RUNTIME_RECEIPT = buildFormalRuntimeReceipt().value
const PREPARE_ENTRY_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'scripts/issue-23-delivery-prepare.mjs')))
const EXECUTE_ENTRY_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'scripts/issue-23-delivery-entry.mjs')))
const WORKER_UPLOAD_ENTRY_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'scripts/issue-23-delivery-worker-upload.mjs')))
const MANIFEST_SCHEMA_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json')))
const CONFIG_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'wrangler.toml')))
const RESET_SQL_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'db/issue-23-clean-start-reset.sql')))
const MIGRATION_RUNNER_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'scripts/migrations.mjs')))
const MIGRATION_CATALOG_HASH = hashD1ArtifactDirectory(realpathSync(join(REPOSITORY_ROOT, 'db/ledger-migrations')))
const ROLLOUT_SAFETY_HASH = hash(readFileSync(join(REPOSITORY_ROOT, 'scripts/rollout-safety.mjs')))

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
    config_sha256: CONFIG_HASH,
    wrangler_sha256: RUNTIME_RECEIPT.wrangler.identity_sha256,
    account_id: 'account-id',
    d1_database_id: 'd1-id',
    reset_sql_path: 'db/issue-23-clean-start-reset.sql',
    reset_sql_sha256: RESET_SQL_HASH,
    migration_runner_path: 'scripts/migrations.mjs',
    migration_runner_sha256: MIGRATION_RUNNER_HASH,
    migration_catalog_path: 'db/ledger-migrations',
    migration_catalog_sha256: MIGRATION_CATALOG_HASH,
    rollout_safety_path: 'scripts/rollout-safety.mjs',
    rollout_safety_sha256: ROLLOUT_SAFETY_HASH,
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

function preparedFromValue(value: Record<string, unknown>) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function manifest(overrides: Record<string, unknown> = {}) {
  const d1 = d1Binding()
  const value = {
    format: MANIFEST_FORMAT,
    preparation: {
      prepare_entry: { path: 'scripts/issue-23-delivery-prepare.mjs', sha256: PREPARE_ENTRY_HASH },
      execute_entry: { path: 'scripts/issue-23-delivery-entry.mjs', sha256: EXECUTE_ENTRY_HASH },
      worker_upload_entry: { path: 'scripts/issue-23-delivery-worker-upload.mjs', sha256: WORKER_UPLOAD_ENTRY_HASH },
      manifest_schema: {
        path: 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
        sha256: MANIFEST_SCHEMA_HASH,
      },
    },
    repository: {
      canonical: 'nardinmarcus/blogman',
      remote: 'https://github.com/nardinmarcus/blogman.git',
      commit: CANDIDATE,
      tree: 'd'.repeat(40),
      clean: true,
    },
    ci: {
      provider: 'github-actions',
      workflow: '.github/workflows/verify.yml',
      run_id: 1,
      attempt: 1,
      event: 'push',
      head_sha: CANDIDATE,
      tree: 'd'.repeat(40),
      conclusion: 'success',
      evidence_class: 'production-ci-evidence',
    },
    toolchain: {
      node: RUNTIME_RECEIPT.node,
      npm: RUNTIME_RECEIPT.npm,
      curl: RUNTIME_RECEIPT.curl,
      wrangler: RUNTIME_RECEIPT.wrangler,
      opennextjs_cloudflare: RUNTIME_RECEIPT.opennextjs_cloudflare,
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
      runner: { path: 'scripts/migrations.mjs', sha256: HASH },
      catalog: {
        path: 'db/ledger-migrations',
        sha256: HASH,
        migrations: [
          { id: '001', path: 'db/ledger-migrations/001_initial_schema.sql', sha256: HASH },
          { id: '002', path: 'db/ledger-migrations/002_add_ai_image_configuration.sql', sha256: HASH },
          { id: '003', path: 'db/ledger-migrations/003_migrate_runtime_ai_configuration.sql', sha256: HASH },
          { id: '004', path: 'db/ledger-migrations/004_complete_historical_text_ai_schema.sql', sha256: HASH },
          { id: '005', path: 'db/ledger-migrations/005_fix_posts_fts_sync.sql', sha256: HASH },
          { id: '006', path: 'db/ledger-migrations/006_add_rollout_safety_controls.sql', sha256: HASH },
        ],
      },
      historical_data_disposition: {
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      },
    },
    d1,
    target: {
      account_id: 'account-id',
      d1_database_id: 'd1-id',
      worker_name: 'blogman',
      origin: 'https://blog.example.com',
      smoke: {
        requests: [
          { path: '/api/search', status: 200 },
          { path: '/api/settings/appearance', status: 200 },
          { path: '/api/admin/tokens', status: 200 },
          { path: '/api/admin/ai-provider', status: 200 },
          { path: '/api/admin/ai-post-generators', status: 200 },
          { path: '/api/admin/posts/__blogman_smoke_absent__', status: 404 },
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
      runtime: { os: RUNTIME_RECEIPT.os, architecture: RUNTIME_RECEIPT.arch, node_version: RUNTIME_RECEIPT.node.version },
      runtime_receipt: RUNTIME_RECEIPT,
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: HASH,
      production_write_adapter_calls: 0,
      expected_reconciliation_sha256: d1.expected_reconciliation_sha256,
      d1_stage_receipt_sha256: D1_TRACE_HASH,
      cleanup: { created: true, cleaned: true, observed_absent: true },
    },
    ...overrides,
  }
  return preparedFromValue(value)
}

type ManifestValue = ReturnType<typeof manifest>['value']

function authorizationFor(prepared: ReturnType<typeof manifest>, id: string) {
  return {
    format: AUTHORIZATION_FORMAT,
    authorization_id: id,
    manifest_sha256: prepared.sha256,
    decision: 'approve',
  }
}

function actualPreparedManifest() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  const migrationCatalogPath = join(REPOSITORY_ROOT, 'db', 'ledger-migrations')
  const catalogBytes = Buffer.from(execFileSync(
    process.execPath,
    ['scripts/migrations.mjs', 'catalog', '--migrations-dir', realpathSync(migrationCatalogPath)],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  ).trim())
  const catalog = JSON.parse(catalogBytes.toString('utf8')) as {
    migrations: Array<{ number: number; name: string }>
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
      prepare_entry: { path: 'scripts/issue-23-delivery-prepare.mjs', sha256: PREPARE_ENTRY_HASH },
      execute_entry: { path: 'scripts/issue-23-delivery-entry.mjs', sha256: EXECUTE_ENTRY_HASH },
      worker_upload_entry: { path: 'scripts/issue-23-delivery-worker-upload.mjs', sha256: WORKER_UPLOAD_ENTRY_HASH },
      manifest_schema: {
        path: 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
        sha256: MANIFEST_SCHEMA_HASH,
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
      expected_head_sha: commit,
    },
    toolchain: {
      node: { version: '22.14.0', identity_sha256: HASH },
      npm: { version: '10.9.2', identity_sha256: HASH },
      curl: { version: '8.0.0', identity_sha256: HASH },
      wrangler: { version: '4.86.0', identity_sha256: HASH },
      opennextjs_cloudflare: { version: '1.19.10', identity_sha256: HASH },
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
          { path: '/api/admin/tokens', status: 200 },
          { path: '/api/admin/ai-provider', status: 200 },
          { path: '/api/admin/ai-post-generators', status: 200 },
          { path: '/api/admin/posts/__blogman_smoke_absent__', status: 404 },
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
      runtime: {
        os: RUNTIME_RECEIPT.os,
        architecture: RUNTIME_RECEIPT.arch,
        node_version: RUNTIME_RECEIPT.node.version,
      },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: HASH,
      production_write_adapter_calls: 0,
    },
  }
  const buildRunner = (repositoryPath: string, { artifact }: { artifact: typeof config.artifact }) => {
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
    expect(artifact.file_tree.files).toHaveLength(3)
  }
  try {
    const prepared = prepareForTestsOnly(config, {
      repositoryPath: REPOSITORY_ROOT,
      repositoryResolver: () => ({ commit, tree, clean: true }),
      ciResolver: (_path: string, source: typeof config, repository: { commit: string; tree: string }) => ({
        provider: source.ci.provider,
        workflow: source.ci.workflow,
        run_id: 1,
        attempt: 1,
        event: 'pull_request',
        head_sha: repository.commit,
        tree: repository.tree,
        conclusion: 'success',
      }),
      buildRunner,
      rehearsalRunner: () => ({
        runtime: {
          os: RUNTIME_RECEIPT.os,
          architecture: RUNTIME_RECEIPT.arch,
          node_version: RUNTIME_RECEIPT.node.version,
        },
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
    const result = { value, bytes, sha256: hash(bytes) }
    expect(Object.keys(result.value.rehearsal)).toEqual([
      'runtime',
      'runtime_receipt',
      'network',
      'status',
      'receipt_sha256',
      'production_write_adapter_calls',
      'expected_reconciliation_sha256',
      'd1_stage_receipt_sha256',
      'cleanup',
    ])
    return result
  } finally {
    rmSync(join(REPOSITORY_ROOT, '.next'), { recursive: true, force: true })
    rmSync(join(REPOSITORY_ROOT, '.open-next'), { recursive: true, force: true })
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
      ...Object.fromEntries(D1_EVIDENCE_HASHES.map((name) => [name, name === 'trace_sha256' ? D1_TRACE_HASH : HASH])),
      account_id: 'account-id',
      d1_database_id: 'd1-id',
      candidate_id: CANDIDATE,
    },
    finalized: true,
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function workerResult() {
  const value = { format: 'blogman-issue-23-worker-stages/v1', outcome: 'ERROR', first_terminal_stage: 'worker_deploy', failure: { classification: 'worker_adapter_error' }, stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 }, stage_durations_ms: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 }, mutation_counts: { attempted: 1, confirmed: 0 }, evidence: { source: 'production', production: true, promotable: false, hashes: { upload_acceptance_sha256: null, version_traffic_sha256: null, smoke_control_t0_sha256: null } }, finalized: true }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function passingWorkerResult() {
  const value = {
    format: 'blogman-issue-23-worker-stages/v1', outcome: 'PASS', first_terminal_stage: null, failure: null,
    stage_counts: { worker_deploy: 1, version_traffic_verification: 1, smoke_control_t0: 1 },
    stage_durations_ms: { worker_deploy: 1, version_traffic_verification: 1, smoke_control_t0: 1 },
    mutation_counts: { attempted: 2, confirmed: 2 },
    evidence: {
      source: 'production', production: true, promotable: true,
      hashes: {
        upload_acceptance_sha256: '1'.repeat(64), version_traffic_sha256: '2'.repeat(64),
        smoke_control_t0_sha256: '3'.repeat(64),
      },
    },
    finalized: true,
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: hash(bytes) }
}

function configureWorker() {
  createWorkerTransportMock.mockReturnValue({ livePreconditions: () => ({ outcome: 'PASS', duration_ms: 1 }), execute() {} })
  runWorkerStagesMock.mockReturnValue(workerResult())
}

function configureD1(failedStage: string | null = null, receipt = d1Result(failedStage)) {
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
    return receipt
  })
  return calls
}

describe('Issue #90 formal entry fan-in', () => {
  beforeEach(() => {
    rmSync(DURABLE_SINK_ROOT, { recursive: true, force: true })
    mkdirSync(join(DURABLE_SINK_ROOT, 'authorizations'), { recursive: true, mode: 0o700 })
    mkdirSync(join(DURABLE_SINK_ROOT, 'records'), { recursive: true, mode: 0o700 })
    mkdirSync(join(DURABLE_SINK_ROOT, 'terminals'), { recursive: true, mode: 0o700 })
    configureWorker()
  })
  afterAll(() => rmSync(DURABLE_SINK_ROOT, { recursive: true, force: true }))
  it('rejects missing-d1 and d1-only wrappers before Authorization or adapter selection', () => {
    configureD1()
    const complete = manifest()
    const missingD1Value = structuredClone(complete.value) as Record<string, unknown>
    Reflect.deleteProperty(missingD1Value, 'd1')
    const missingD1 = preparedFromValue(missingD1Value)
    const d1Only = preparedFromValue({
      format: MANIFEST_FORMAT,
      repository: { commit: CANDIDATE, tree: 'd'.repeat(40) },
      target: { account_id: 'account-id', d1_database_id: 'd1-id' },
      policy: {
        stages: policy().stages,
        overall_timeout_seconds: 5400,
      },
      d1: complete.value.d1,
    })

    for (const [prepared, id] of [[missingD1, 'fan-in-missing-d1'], [d1Only, 'fan-in-d1-only']]) {
      let authorizationRead = false
      const authorization = new Proxy(authorizationFor(prepared, id), {
        get() {
          authorizationRead = true
          throw new Error('Authorization must not be read for an invalid manifest')
        },
      })
      expect(() => execute(prepared, authorization)).toThrow(/manifest|required|canonical/u)
      expect(authorizationRead).toBe(false)
    }

    expect(createD1TransportMock).not.toHaveBeenCalled()
    expect(runD1StagesMock).not.toHaveBeenCalled()
  })

  it.each([
    ['preparation path', (value: ManifestValue) => { value.preparation.prepare_entry.path = 'scripts/@prepare.mjs' }],
    ['CI workflow path', (value: ManifestValue) => { value.ci.workflow = '.github/workflows/@verify.yml' }],
    ['artifact archive path', (value: ManifestValue) => { value.artifact.archive.path = '.open-next/@build.zip' }],
    ['artifact worker path', (value: ManifestValue) => { value.artifact.worker.path = '.open-next/@worker.js' }],
    ['migration path', (value: ManifestValue) => { value.migration.reset_sql.path = 'db/@reset.sql' }],
  ])('rejects @ in a generic manifest %s before Authorization or adapter selection', (_name, mutate) => {
    const value = structuredClone(manifest().value) as ManifestValue
    mutate(value)
    const prepared = preparedFromValue(value)
    let authorizationRead = false
    const authorization = new Proxy(authorizationFor(prepared, `generic-path-${_name}`), {
      get() {
        authorizationRead = true
        throw new Error('Authorization must not be read for an invalid manifest')
      },
    })

    expect(() => execute(prepared, authorization)).toThrow(/(?:path|workflow) is invalid/u)
    expect(authorizationRead).toBe(false)
    expect(createD1TransportMock).not.toHaveBeenCalled()
    expect(runD1StagesMock).not.toHaveBeenCalled()
  })

  it.each([
    '/absolute.js',
    '.open-next/../worker.js',
    '../worker.js',
    '.open-next\\worker.js',
    '.open-next/control\nworker.js',
  ])('rejects unsafe artifact file-tree path %j before Authorization or adapter selection', (path) => {
    const value = structuredClone(manifest().value) as ManifestValue
    value.artifact.file_tree.files[0].path = path
    const prepared = preparedFromValue(value)
    let authorizationRead = false
    const authorization = new Proxy(authorizationFor(prepared, `artifact-path-${path}`), {
      get() {
        authorizationRead = true
        throw new Error('Authorization must not be read for an invalid manifest')
      },
    })

    expect(() => execute(prepared, authorization)).toThrow(/path is invalid/u)
    expect(authorizationRead).toBe(false)
    expect(createD1TransportMock).not.toHaveBeenCalled()
    expect(runD1StagesMock).not.toHaveBeenCalled()
  })

  it.each([
    ['formal entry', (value: ManifestValue) => { value.preparation.execute_entry.sha256 = 'a'.repeat(64) }],
    ['Worker upload entry', (value: ManifestValue) => { value.preparation.worker_upload_entry.sha256 = 'a'.repeat(64) }],
    ['rollout control entry', (value: ManifestValue) => { value.d1.rollout_safety_sha256 = 'a'.repeat(64) }],
  ])('rejects %s closure drift before reading Authorization or selecting an adapter', (_name, mutate) => {
    configureD1()
    const value = structuredClone(manifest().value) as ManifestValue
    mutate(value)
    const prepared = preparedFromValue(value)
    let authorizationRead = false
    const authorization = new Proxy(authorizationFor(prepared, `fan-in-entry-drift-${_name}`), {
      get() {
        authorizationRead = true
        throw new Error('Authorization must not be read for formal entry drift')
      },
    })

    expect(() => execute(prepared, authorization)).toThrow(/formal|entry|closure|drift/u)
    expect(authorizationRead).toBe(false)
    expect(createD1TransportMock).not.toHaveBeenCalled()
    expect(createWorkerTransportMock).not.toHaveBeenCalled()
  })

  it('allows @ only in artifact file-tree paths', () => {
    configureD1()
    const value = structuredClone(manifest().value) as ManifestValue
    value.artifact.file_tree.files[0].path = '.open-next/@scope/index.js'
    const prepared = preparedFromValue(value)

    expect(() => execute(prepared, authorizationFor(prepared, 'artifact-file-tree-at-sign'))).not.toThrow()
  })

  it('does not select an adapter until Authorization has been consumed', () => {
    configureD1()
    const events: string[] = []
    createD1TransportMock.mockImplementation(() => {
      events.push('adapter-selected')
      return {
        livePreconditions() { return { outcome: 'PASS', duration_ms: 1 } },
        execute(request: { operation: string }) {
          events.push(`transport:${request.operation}`)
          return { status: 0, stdout: '{}', stderr: '', duration_ms: 1 }
        },
      }
    })
    const prepared = manifest()
    const baseAuthorization = authorizationFor(prepared, 'fan-in-adversarial-order')
    const authorization = {
      get format() {
        events.push('authorization:format')
        return baseAuthorization.format
      },
      get authorization_id() {
        events.push('authorization:authorization_id')
        return baseAuthorization.authorization_id
      },
      get manifest_sha256() {
        events.push('authorization:manifest_sha256')
        return baseAuthorization.manifest_sha256
      },
      get decision() {
        events.push('authorization:decision')
        return baseAuthorization.decision
      },
    }

    execute(prepared, authorization)

    expect(events.indexOf('adapter-selected')).toBeGreaterThan(events.lastIndexOf('authorization:decision'))
    expect(events.indexOf('transport:d1_identity')).toBeGreaterThan(events.indexOf('adapter-selected'))
  })

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
      failure: { classification: 'worker_adapter_error' },
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
    expect(result.value.failure.classification).toBe('worker_adapter_error')
  })

  it('terminalizes a malformed worker receipt as ERROR and preserves its possible upload attempt', () => {
    configureD1()
    const prepared = manifest()
    const malformed = { format: 'blogman-issue-23-worker-stages/v1', outcome: 'PASS' }
    const bytes = Buffer.from(`${JSON.stringify(malformed, null, 2)}\n`, 'utf8')
    runWorkerStagesMock.mockReturnValue({ value: malformed, bytes, sha256: hash(bytes) })

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-malformed-worker-receipt'))

    expect(result.value).toMatchObject({
      outcome: 'ERROR', first_terminal_stage: 'worker_deploy',
      failure: { classification: 'worker_result_malformed' },
      mutation_counts: { attempted: 3, confirmed: 2 },
    })
    expect(result.value.evidence.promotable).toBe(false)
  })

  it('stops at live_preconditions on drift without selecting a D1 adapter', () => {
    configureD1()
    createWorkerTransportMock.mockReturnValue({
      livePreconditions: () => ({ outcome: 'NON_PASS', classification: 'Manifest Drift', duration_ms: 1 }),
      execute() {},
    })
    const prepared = manifest()

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-live-preconditions-drift'))

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS', first_terminal_stage: 'live_preconditions',
      failure: { classification: 'Manifest Drift' }, mutation_counts: { attempted: 0, confirmed: 0 },
    })
    expect(createD1TransportMock).not.toHaveBeenCalled()
  })

  it('validates an execute-produced early NON_PASS terminal with no D1 or Worker receipt', () => {
    const prepared = actualPreparedManifest()
    createWorkerTransportMock.mockReturnValue({
      livePreconditions: () => ({ outcome: 'NON_PASS', classification: 'Manifest Drift', duration_ms: 1 }),
      execute() {},
    })

    const terminal = execute(prepared, authorizationFor(prepared, 'fan-in-early-production-terminal'))

    expect(terminal.value).toMatchObject({
      outcome: 'NON_PASS', first_terminal_stage: 'live_preconditions',
      failure: { classification: 'Manifest Drift' },
    })
    expect(validateProductionTerminalEvidence(structuredClone(terminal))).toBe(true)
    expect(createD1TransportMock).not.toHaveBeenCalled()
  })

  it('replays and validates execute-produced durable evidence after a fresh process without leaking adapter credentials', () => {
    const credentialMarker = 'sk-test-only-durable-boundary'
    const prepared = actualPreparedManifest()
    const authorization = authorizationFor(prepared, 'fan-in-fresh-process-durable-boundary')
    createWorkerTransportMock.mockImplementationOnce(() => {
      throw new Error(credentialMarker)
    })

    const terminal = execute(prepared, authorization)
    expect(terminal.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'live_preconditions_error' },
    })
    expect(JSON.stringify(terminal.value)).not.toContain(credentialMarker)

    const encodeRecord = (record: { value: unknown, bytes: Uint8Array, sha256: string }) => ({
      value: record.value,
      bytes: Buffer.from(record.bytes).toString('base64'),
      sha256: record.sha256,
    })
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { execute, validateProductionTerminalEvidence } from ${JSON.stringify(ENTRY_MODULE_URL)}
      import { repositoryDeliverySink } from ${JSON.stringify(SINK_MODULE_URL)}
      const decodeRecord = (record) => ({
        value: record.value,
        bytes: Buffer.from(record.bytes, 'base64'),
        sha256: record.sha256,
      })
      const manifest = decodeRecord(${JSON.stringify(encodeRecord(prepared))})
      const terminal = decodeRecord(${JSON.stringify(encodeRecord(terminal))})
      const authorization = ${JSON.stringify(authorization)}
      if (validateProductionTerminalEvidence(terminal) !== true) process.exitCode = 2
      const durable = repositoryDeliverySink.readTerminalEvidence(terminal.sha256)
      const durableValues = [durable.terminal, durable.manifest, durable.d1, durable.worker]
        .filter(Boolean).map((record) => record.value)
      if (JSON.stringify(durableValues).includes(${JSON.stringify(credentialMarker)})) process.exitCode = 3
      const forged = structuredClone(terminal)
      forged.value.identities.manifest_sha256 = 'f'.repeat(64)
      try {
        validateProductionTerminalEvidence(forged)
        process.exitCode = 4
      } catch (error) {
        if (!/production terminal evidence/u.test(error instanceof Error ? error.message : String(error))) {
          process.exitCode = 5
        }
      }
      try {
        execute(manifest, authorization)
        process.exitCode = 6
      } catch (error) {
        if (!/consumed|replay|one-shot/u.test(error instanceof Error ? error.message : String(error))) {
          process.exitCode = 7
        }
      }
    `], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })

    expect(child.status, child.stderr).toBe(0)
  })

  it('validates an execute-produced D1 terminal with its D1 receipt and no Worker receipt', () => {
    const prepared = actualPreparedManifest()
    const receipt = d1Result('d1_identity')
    receipt.value.evidence.account_id = prepared.value.target.account_id
    receipt.value.evidence.d1_database_id = prepared.value.target.d1_database_id
    receipt.value.evidence.candidate_id = prepared.value.repository.commit
    receipt.value.evidence.config_sha256 = prepared.value.d1.config_sha256
    receipt.value.evidence.wrangler_sha256 = prepared.value.d1.wrangler_sha256
    receipt.value.evidence.expected_reconciliation_sha256 = prepared.value.d1.expected_reconciliation_sha256
    receipt.bytes = Buffer.from(`${JSON.stringify(receipt.value, null, 2)}\n`, 'utf8')
    receipt.sha256 = hash(receipt.bytes)
    configureD1('d1_identity', receipt)

    const terminal = execute(prepared, authorizationFor(prepared, 'fan-in-d1-production-terminal'))

    expect(terminal.value).toMatchObject({ outcome: 'NON_PASS', first_terminal_stage: 'd1_identity' })
    expect(validateProductionTerminalEvidence(structuredClone(terminal))).toBe(true)
  })

  it('rejects rehearsal schema drift and an unbound expected reconciliation hash before selecting a production adapter', () => {
    configureD1()
    const missingCleanup = manifest()
    Reflect.deleteProperty(missingCleanup.value.rehearsal, 'cleanup')
    missingCleanup.bytes = Buffer.from(`${JSON.stringify(missingCleanup.value, null, 2)}\n`, 'utf8')
    missingCleanup.sha256 = hash(missingCleanup.bytes)

    expect(() => execute(missingCleanup, authorizationFor(missingCleanup, 'fan-in-missing-cleanup')))
      .toThrow(/rehearsal.*missing|required|cleanup/u)

    const unbound = manifest()
    unbound.value.rehearsal.expected_reconciliation_sha256 = 'e'.repeat(64)
    unbound.bytes = Buffer.from(`${JSON.stringify(unbound.value, null, 2)}\n`, 'utf8')
    unbound.sha256 = hash(unbound.bytes)

    expect(() => execute(unbound, authorizationFor(unbound, 'fan-in-unbound-rehearsal')))
      .toThrow(/expected reconciliation/u)
    expect(createD1TransportMock).not.toHaveBeenCalled()
  })

  it('returns a sanitized live-preconditions error before selecting D1 when expected snapshot materialization fails', () => {
    configureD1()
    const originalRealpathSync = fsActual.realpathSync!
    let materializedDirectory = ''
    vi.mocked(realpathSync).mockImplementation((path, options) => {
      if (String(path).includes('blogman-issue-23-execute-expected-')) {
        materializedDirectory = String(path)
        throw new Error('materialization failed')
      }
      return originalRealpathSync(path, options)
    })
    const prepared = manifest()

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-materialization-failure'))

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'live_preconditions',
      failure: { classification: 'live_preconditions_error' },
      authorization_consumed: true,
      evidence: {
        cleanup: { created: false, cleaned: true, observed_absent: true },
      },
    })
    expect(JSON.stringify(result.value)).not.toMatch(/materialization failed/u)
    expect(materializedDirectory).not.toBe('')
    expect(existsSync(materializedDirectory)).toBe(false)
    expect(createD1TransportMock).not.toHaveBeenCalled()
    vi.mocked(realpathSync).mockImplementation(originalRealpathSync)
  })

  it('returns a sanitized terminal D1 error and cleans materialized state when binding setup fails', () => {
    configureD1()
    const prepared = actualPreparedManifest()
    const originalRealpathSync = fsActual.realpathSync!
    let materializedDirectory = ''
    vi.mocked(realpathSync).mockImplementation((path, options) => {
      if (String(path).includes('blogman-issue-23-execute-expected-')) {
        materializedDirectory = String(path)
      }
      if (String(path).endsWith('/scripts/migrations.mjs')
        && materializedDirectory !== '') throw new Error('binding setup failed')
      return originalRealpathSync(path, options)
    })

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-binding-setup-failure'))

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'production_d1_setup_error' },
      evidence: {
        cleanup: { created: true, cleaned: true, observed_absent: true },
      },
    })
    expect(JSON.stringify(result.value)).not.toMatch(/binding setup failed/u)
    expect(materializedDirectory).not.toBe('')
    expect(existsSync(materializedDirectory)).toBe(false)
    expect(createD1TransportMock).not.toHaveBeenCalled()
    vi.mocked(realpathSync).mockImplementation(originalRealpathSync)
  })

  it('returns a sanitized terminal D1 error and cleanup proof when transport setup fails', () => {
    createD1TransportMock.mockImplementationOnce(() => {
      throw new Error('transport setup failed')
    })
    const prepared = manifest()

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-transport-setup-failure'))

    expect(result.value).toMatchObject({
      outcome: 'ERROR',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'production_d1_setup_error' },
      evidence: {
        cleanup: { created: true, cleaned: true, observed_absent: true },
      },
    })
    expect(JSON.stringify(result.value)).not.toMatch(/transport setup failed/u)
  })

  it('binds terminal production evidence to durable canonical records', () => {
    const prepared = actualPreparedManifest()
    const d1Receipt = d1Result()
    d1Receipt.value.evidence.account_id = prepared.value.target.account_id
    d1Receipt.value.evidence.d1_database_id = prepared.value.target.d1_database_id
    d1Receipt.value.evidence.candidate_id = prepared.value.repository.commit
    d1Receipt.value.evidence.config_sha256 = prepared.value.d1.config_sha256
    d1Receipt.value.evidence.wrangler_sha256 = prepared.value.d1.wrangler_sha256
    d1Receipt.value.evidence.expected_reconciliation_sha256 = prepared.value.d1.expected_reconciliation_sha256
    d1Receipt.bytes = Buffer.from(`${JSON.stringify(d1Receipt.value, null, 2)}\n`, 'utf8')
    d1Receipt.sha256 = hash(d1Receipt.bytes)
    configureD1(null, d1Receipt)
    configureWorker()
    const terminal = execute(prepared, authorizationFor(prepared, 'fan-in-terminal-evidence'))
    expect(Object.keys(terminal)).toEqual(['value', 'bytes', 'sha256'])
    expect(validateProductionTerminalEvidence(terminal)).toBe(true)
    expect(validateProductionTerminalEvidence(structuredClone(terminal))).toBe(true)

    const forged = structuredClone(terminal)
    forged.value.identities.manifest_sha256 = 'f'.repeat(64)
    expect(() => validateProductionTerminalEvidence(forged))
      .toThrow(/production terminal evidence/u)
  })

  it('keeps PASS valid when execute produces every receipt sidecar', () => {
    const prepared = actualPreparedManifest()
    const d1Receipt = d1Result()
    d1Receipt.value.evidence.account_id = prepared.value.target.account_id
    d1Receipt.value.evidence.d1_database_id = prepared.value.target.d1_database_id
    d1Receipt.value.evidence.candidate_id = prepared.value.repository.commit
    d1Receipt.value.evidence.config_sha256 = prepared.value.d1.config_sha256
    d1Receipt.value.evidence.wrangler_sha256 = prepared.value.d1.wrangler_sha256
    d1Receipt.value.evidence.expected_reconciliation_sha256 = prepared.value.d1.expected_reconciliation_sha256
    d1Receipt.bytes = Buffer.from(`${JSON.stringify(d1Receipt.value, null, 2)}\n`, 'utf8')
    d1Receipt.sha256 = hash(d1Receipt.bytes)
    configureD1(null, d1Receipt)
    const workerReceipt = passingWorkerResult()
    runWorkerStagesMock.mockReturnValue(workerReceipt)

    const terminal = execute(prepared, authorizationFor(prepared, 'fan-in-passing-terminal-evidence'))

    expect(terminal.value.outcome).toBe('PASS')
    expect(validateProductionTerminalEvidence(structuredClone(terminal))).toBe(true)
  })

  it('accepts the canonical output produced by prepare at the execute seam', () => {
    const calls = configureD1()
    const prepared = actualPreparedManifest()

    const result = execute(prepared, authorizationFor(prepared, 'fan-in-real-prepare-output'))

    expect(calls).toEqual(D1_OPERATIONS)
    expect(result.value).toMatchObject({
      authorization_consumed: true,
      outcome: 'ERROR',
      first_terminal_stage: 'worker_deploy',
      failure: { classification: 'worker_adapter_error' },
      evidence: { source: 'production', production: true },
    })
  })

  it('does not select a local non-production lane at the production entry', () => {
    configureD1()
    const prepared = manifest({ d1: d1Binding({ mode: 'local', evidence_class: 'local-non-production' }) })

    expect(() => execute(prepared, authorizationFor(prepared, 'fan-in-local-lane')))
      .toThrow(/remote production|d1 evidence/u)
    expect(createD1TransportMock).not.toHaveBeenCalled()
  })

  it('rejects an embedded plan/callback override before selecting a production adapter', () => {
    configureD1()
    const prepared = manifest()
    const authorization = {
      ...authorizationFor(prepared, 'fan-in-embedded-plan-override'),
      plan: { callback: 'alternate-production-path' },
    }

    expect(() => execute(prepared, authorization)).toThrow(/authorization.*unsupported fields/u)
    expect(createD1TransportMock).not.toHaveBeenCalled()
    expect(createWorkerTransportMock).not.toHaveBeenCalled()
  })

  it('keeps the public execute arity at exactly two arguments', () => {
    configureD1()
    const prepared = manifest()

    expect(execute).toHaveLength(2)
    expect(() => execute(prepared, authorizationFor(prepared, 'fan-in-arity'), { override: true }))
      .toThrow(/two arguments/u)
  })
})
