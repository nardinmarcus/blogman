import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKER_COMMAND_CONTRACT } from '../../scripts/issue-23-delivery-worker-transport.mjs'
import { comparePathSegments } from '../../scripts/issue-23-delivery-d1-contracts.mjs'
import { prepareForTestsOnly } from '../../scripts/issue-23-delivery-prepare.mjs'
import { buildFormalRuntimeReceipt } from '../../scripts/issue-23-delivery-formal-runtime.mjs'
import {
  FORMAL_EXECUTION_CLOSURE_PATHS,
} from '../../scripts/issue-23-delivery-execution-closure.mjs'

/**
 * Issue #132 — artifact ordering invariant (byte/code-unit order).
 *
 * prepare freezes artifact.file_tree.files in byte/code-unit order
 * (enumerateBuildFiles segment walk + `.sort()`), and its self-check uses the
 * default code-unit sort. entry's live validation and the upload snapshot proofs
 * used localeCompare, which diverges from byte order on punctuation-weighted
 * pairs (e.g. `assets/BUILD_ID` vs `assets/_next/static/x.js`), so a perfectly
 * byte-ordered frozen tree could never pass live preconditions.
 *
 * These tests lock the invariant: a two-order-divergence fixture must pass the
 * production validation path, and upload snapshot hashes must be byte-ordered.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPOSITORY_ROOT = process.cwd()
const workerUploadPath = join(REPOSITORY_ROOT, 'scripts', 'issue-23-delivery-worker-upload.mjs')
const temporaryDirectories: string[] = []

const SHA40 = 'a'.repeat(40)
const SHA40_B = 'b'.repeat(40)
const ZERO_ACTIONS_TEST_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const SERVER_REFERENCE_TEST_PLACEHOLDER = 'process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'
const RUNTIME_RECEIPT = buildFormalRuntimeReceipt().value

const CANONICAL_EXPECTED_RECONCILIATION = {
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
const CANONICAL_EXPECTED_RECONCILIATION_SHA256 = '48a68fc43d4ffe66f9df969865ad232c0e3071129e63bed3660314eb809ac5dd'

/**
 * The two-order-divergence fixture: `assets/BUILD_ID` and `assets/_next/static/x.js`
 * sort in opposite directions under code-unit order ('B' < '_') vs en_US locale
 * collation (punctuation is secondary, so '_next' precedes 'BUILD_ID').
 */
const DIVERGENCE_FILES = [
  { path: 'assets/BUILD_ID', content: 'build-id\n' },
  { path: 'assets/_next/static/x.js', content: 'x\n' },
  { path: 'worker.js', content: 'worker\n' },
] as const

function makeRemovable(root: string) {
  // upload snapshots chmod directories 0500 and files 0400; restore write bits
  // so temporary-tree cleanup can remove them.
  const visit = (path: string) => {
    const metadata = lstatSync(path)
    if (metadata.isDirectory()) {
      chmodSync(path, 0o700)
      for (const name of readdirSync(path)) visit(join(path, name))
    } else {
      chmodSync(path, 0o600)
    }
  }
  if (existsSync(root)) visit(root)
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    makeRemovable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function hash(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hashRepeated(character: string) {
  return character.repeat(64)
}

function byteOrdered<T extends string>(values: T[]) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function divergenceFixtureTree() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-132-sort-')))
  temporaryDirectories.push(directory)
  const source = join(directory, '.open-next')
  for (const file of DIVERGENCE_FILES) {
    const absolute = join(source, file.path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.content)
  }
  return { directory, source }
}

describe('Issue #132 artifact ordering invariant', () => {
  it('orders path segments by code-unit (byte) order, consistent with default sort', () => {
    // The divergence pair: '_' (0x5F) sorts after 'B' (0x42) in code-unit
    // order, while en_US locale collation weights punctuation secondarily.
    expect(comparePathSegments('BUILD_ID', '_next')).toBe(-1)
    expect(comparePathSegments('_next', 'BUILD_ID')).toBe(1)
    expect(comparePathSegments('BUILD_ID', 'BUILD_ID')).toBe(0)
    const paths = [
      '.open-next/assets/BUILD_ID',
      '.open-next/assets/_next/static/x.js',
      '.open-next/worker.js',
    ]
    expect([...paths].sort(comparePathSegments)).toEqual(paths)
    expect([...paths].sort()).toEqual(paths)
  })

  it('accepts a byte-order frozen artifact tree through the production validation path', () => {
    const { source } = divergenceFixtureTree()
    const archive = join(source, 'open-next-build.zip')
    writeFileSync(archive, 'archive\n')

    // prepare freezes `.open-next/**` paths in byte/code-unit order
    // (enumerateBuildFiles walk + `.sort()`), and the divergence pair sorts
    // BUILD_ID before _next under code-unit order.
    const files = DIVERGENCE_FILES.map((file) => ({
      path: `.open-next/${file.path}`,
      sha256: hash(file.content),
      bytes: Buffer.byteLength(file.content),
    }))
    expect(byteOrdered(files.map((file) => file.path))).toEqual(files.map((file) => file.path))
    expect(files.map((file) => file.path)[0]).toBe('.open-next/assets/BUILD_ID')

    const bindings = {
      artifact_source_path: source,
      artifact_archive_path: archive,
      artifact_file_tree_sha256: hash(JSON.stringify(files)),
      artifact_file_tree_files: files,
    }
    expect(() => WORKER_COMMAND_CONTRACT.validateArtifactSource(bindings)).not.toThrow()
  })

  it('snapshots the divergence tree in byte order (upload tree hash matches the byte-order expectation)', () => {
    const { directory, source } = divergenceFixtureTree()
    const destination = join(directory, 'evidence', 'upload-source-snapshot')
    mkdirSync(dirname(destination), { mode: 0o700 })

    const result = spawnSync(process.execPath, [
      workerUploadPath,
      'create-upload-source-snapshot',
      '--source', source,
      '--destination', destination,
    ], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)

    const proof = JSON.parse(result.stdout) as { tree_sha256: string }
    const entries = DIVERGENCE_FILES.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content),
      sha256: hash(file.content),
    }))
    const expectedTreeSha256 = hash(`${JSON.stringify(entries)}\n`)
    expect(proof.tree_sha256).toBe(expectedTreeSha256)
  })

  it('freezes a prepare-built divergence artifact in byte order and live transport accepts it', () => {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const fixture = createFakePrepareArtifactRepository()
    try {
      const config = divergenceBaseConfig()
      config.repository.commit = commit
      config.repository.tree = tree
      config.ci.expected_head_sha = commit

      const prepared = prepareForTestsOnly(config, {
        repositoryPath: fixture.artifactRepositoryPath,
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
        rehearsalRunner: () => testRehearsalResult(),
        buildRunner: divergenceFixtureBuild,
      })

      const frozenFiles = prepared.value.artifact.file_tree.files as Array<{
        path: string
        sha256: string
        bytes: number
      }>
      const openNextPaths = frozenFiles.map((file) => file.path).filter((path) => path.startsWith('.open-next/'))
      // prepare froze the divergence pair in byte order: BUILD_ID before _next
      expect(openNextPaths.indexOf('.open-next/assets/BUILD_ID')).toBeGreaterThan(-1)
      expect(openNextPaths.indexOf('.open-next/assets/BUILD_ID'))
        .toBeLessThan(openNextPaths.indexOf('.open-next/assets/_next/static/x.js'))
      expect(byteOrdered(openNextPaths)).toEqual(openNextPaths)

      const bindings = {
        artifact_source_path: join(fixture.artifactRepositoryPath, '.open-next'),
        artifact_archive_path: join(fixture.artifactRepositoryPath, '.open-next', 'open-next-build.zip'),
        artifact_file_tree_sha256: prepared.value.artifact.file_tree.sha256 as string,
        artifact_file_tree_files: frozenFiles,
      }
      expect(() => WORKER_COMMAND_CONTRACT.validateArtifactSource(bindings)).not.toThrow()
    } finally {
      removeFakePrepareArtifactRepository(fixture)
    }
  })
})

function testRehearsalResult(overrides: Record<string, unknown> = {}) {
  return {
    runtime: {
      os: RUNTIME_RECEIPT.os,
      architecture: RUNTIME_RECEIPT.arch,
      node_version: RUNTIME_RECEIPT.node.version,
    },
    network: 'disabled',
    status: 'PASS',
    receipt_sha256: hashRepeated('a'),
    production_write_adapter_calls: 0,
    expected_reconciliation: {
      value: structuredClone(CANONICAL_EXPECTED_RECONCILIATION),
      sha256: CANONICAL_EXPECTED_RECONCILIATION_SHA256,
    },
    d1: {
      outcome: 'PASS',
      production: false,
      promotable: false,
      sha256: hashRepeated('d'),
    },
    cleanup: {
      created: true,
      cleaned: true,
      observed_absent: true,
    },
    ...overrides,
  }
}

function divergenceBaseConfig() {
  return {
    preparation: {
      prepare_entry: { path: 'scripts/issue-23-delivery-prepare.mjs', sha256: hashRepeated('c') },
      execute_entry: { path: 'scripts/issue-23-delivery-entry.mjs', sha256: hashRepeated('d') },
      worker_upload_entry: { path: 'scripts/issue-23-delivery-worker-upload.mjs', sha256: hashRepeated('1') },
      manifest_schema: {
        path: 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
        sha256: hashRepeated('e'),
      },
    },
    repository: {
      canonical: 'nardinmarcus/blogman',
      remote: 'https://github.com/nardinmarcus/blogman.git',
      commit: SHA40,
      tree: SHA40_B,
      clean: true,
    },
    ci: {
      provider: 'github-actions',
      workflow: '.github/workflows/verify.yml',
      expected_head_sha: SHA40,
    },
    toolchain: {
      node: { version: '22.14.0', identity_sha256: hashRepeated('f') },
      npm: { version: '10.9.2', identity_sha256: hashRepeated('a') },
      curl: { version: '8.0.0', identity_sha256: hashRepeated('0') },
      wrangler: { version: '4.84.1', identity_sha256: hashRepeated('b') },
      opennextjs_cloudflare: { version: '1.19.1', identity_sha256: hashRepeated('c') },
      package_json_sha256: hashRepeated('d'),
      lockfile_sha256: hashRepeated('e'),
    },
    artifact: {
      archive: { path: '.open-next/open-next-build.zip', sha256: hashRepeated('f'), bytes: 123 },
      worker: { path: '.open-next/worker.js', sha256: hashRepeated('a'), bytes: 456 },
      file_tree: {
        sha256: hashRepeated('b'),
        complete: true,
        files: [
          { path: '.open-next/assets/BUILD_ID', sha256: hashRepeated('d'), bytes: 789 },
          { path: '.open-next/assets/_next/static/x.js', sha256: hashRepeated('d'), bytes: 789 },
          { path: '.open-next/worker.js', sha256: hashRepeated('c'), bytes: 456 },
          { path: 'wrangler.toml', sha256: hashRepeated('e'), bytes: 456 },
        ],
      },
    },
    migration: {
      delivery_mode: 'clean-start',
      reset_sql: { path: 'db/issue-23-clean-start-reset.sql', sha256: hashRepeated('f') },
      runner: { path: 'scripts/migrations.mjs', sha256: '643594349a3f70d3bf9a7185c6449065cab497c07582cb92aacddb9dbf934c4d' },
      catalog: {
        path: 'db/ledger-migrations',
        sha256: 'f0d0b2729f533127cc184bbf644a1aafc74dd736311e1b3f162dc799a2589691',
        migrations: [
          { id: '001', path: 'db/ledger-migrations/001_initial_schema.sql', sha256: 'ce80438c559ff16bfc9909761837ea83b053d33c80616bd8477cee8841d7bfd1' },
          { id: '002', path: 'db/ledger-migrations/002_add_ai_image_configuration.sql', sha256: '20abce1feba8dbf376448a359ba7e96dd11ac8458e097a8538cf67db632133af' },
          { id: '003', path: 'db/ledger-migrations/003_migrate_runtime_ai_configuration.sql', sha256: 'f08a53117936495af5c85c61fbee678103bb1c8d335a18d62684834888ee864d' },
          { id: '004', path: 'db/ledger-migrations/004_complete_historical_text_ai_schema.sql', sha256: '938e64fa93a4bbbabc8376ce2a02e90ca1d0d6896201f7350612bbd40da2b77a' },
          { id: '005', path: 'db/ledger-migrations/005_fix_posts_fts_sync.sql', sha256: 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441' },
          { id: '006', path: 'db/ledger-migrations/006_add_rollout_safety_controls.sql', sha256: '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551' },
          { id: '007', path: 'db/ledger-migrations/007_seed_rollout_executor.sql', sha256: '282038f800f031de9716c07e2566f1a3efcd8ba8013cec9bf4e918a2a660c02d' },
        ],
      },
      historical_data_disposition: {
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      },
    },
    target: {
      account_id: 'account-public-id',
      d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
      worker_name: 'blogman',
      origin: 'https://blog.example.com',
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    },
    policy: {
      authorization: {
        manifest_binding: 'manifest_sha256',
        one_shot: true,
        credential_slots: [
          { name: 'cloudflare_delivery', scopes: ['account:read', 'workers:write', 'd1:write', 'r2:write'] },
          { name: 'delivery_smoke_admin', scopes: ['admin:smoke'] },
        ],
      },
      stages: [
        { name: 'authorization_accept', timeout_seconds: 30 },
        { name: 'live_preconditions', timeout_seconds: 120 },
        { name: 'd1_identity', timeout_seconds: 120 },
        { name: 'clean_start_reset', timeout_seconds: 300 },
        { name: 'empty_d1_proof', timeout_seconds: 300 },
        { name: 'migrations_001_007', timeout_seconds: 2100 },
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
    },
    rehearsal: {
      runtime: {
        os: RUNTIME_RECEIPT.os,
        architecture: RUNTIME_RECEIPT.arch,
        node_version: RUNTIME_RECEIPT.node.version,
      },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: hashRepeated('c'),
      production_write_adapter_calls: 0,
      expected_reconciliation_sha256: CANONICAL_EXPECTED_RECONCILIATION_SHA256,
      d1_stage_receipt_sha256: hashRepeated('d'),
      cleanup: {
        created: true,
        cleaned: true,
        observed_absent: true,
      },
    },
  }
}

function divergenceFixtureBuild(repositoryPath: string, { artifact }: { artifact: ReturnType<typeof divergenceBaseConfig>['artifact'] }) {
  const outputRoot = join(repositoryPath, '.open-next')
  rmSync(outputRoot, { recursive: true, force: true })
  for (const file of artifact.file_tree.files) {
    if (file.path === 'wrangler.toml' || !file.path.startsWith('.open-next/')) continue
    const absolute = join(repositoryPath, file.path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, `fixture artifact: ${file.path}\n`)
  }
  const workerPath = join(repositoryPath, artifact.worker.path)
  mkdirSync(dirname(workerPath), { recursive: true })
  writeFileSync(workerPath, `fixture worker: ${artifact.worker.path}\n`)
  writeFileSync(join(outputRoot, 'runtime.js'), 'fixture runtime\n')

  const serverDirectory = join(repositoryPath, '.next', 'server')
  mkdirSync(serverDirectory, { recursive: true })
  const jsonManifest = JSON.stringify({ node: {}, edge: {}, encryptionKey: ZERO_ACTIONS_TEST_KEY })
  const jsManifest = JSON.stringify({ node: {}, edge: {}, encryptionKey: SERVER_REFERENCE_TEST_PLACEHOLDER })
  writeFileSync(join(serverDirectory, 'server-reference-manifest.json'), jsonManifest)
  writeFileSync(join(serverDirectory, 'server-reference-manifest.js'), `self.__RSC_SERVER_MANIFEST=${JSON.stringify(jsManifest)}`)
  writeFileSync(join(serverDirectory, 'app-paths-manifest.json'), '{}')
  writeFileSync(join(serverDirectory, 'pages-manifest.json'), '{}')
  writeFileSync(join(serverDirectory, 'middleware-manifest.json'), JSON.stringify({
    version: 3,
    middleware: {},
    functions: {},
    sortedMiddleware: [],
  }))
  writeFileSync(join(repositoryPath, '.next', 'routes-manifest.json'), JSON.stringify({
    staticRoutes: [],
    dynamicRoutes: [],
    rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  }))
}

function copyConfiguredFakeFixtureInputs(config: ReturnType<typeof divergenceBaseConfig>, artifactRepositoryPath: string) {
  const paths = new Set([
    ...FORMAL_EXECUTION_CLOSURE_PATHS,
    config.migration.reset_sql.path,
    config.migration.runner.path,
    config.migration.catalog.path,
    ...config.migration.catalog.migrations.map((entry) => entry.path),
    config.artifact.worker.path,
    ...config.artifact.file_tree.files.map((entry) => entry.path),
  ].filter((path) => !path.startsWith('.open-next/') && path !== 'wrangler.toml'))
  for (const relativePath of paths) {
    const source = join(repoRoot, relativePath)
    if (!existsSync(source)) continue
    const destination = join(artifactRepositoryPath, relativePath)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
  }
}

function createFakePrepareArtifactRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-132-prepare-artifact-'))
  temporaryDirectories.push(directory)
  const artifactRepositoryPath = join(directory, 'repository')
  execFileSync('git', ['worktree', 'add', '--detach', artifactRepositoryPath, 'HEAD'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  const fixtureBinDirectory = join(artifactRepositoryPath, 'node_modules', '.bin')
  mkdirSync(fixtureBinDirectory, { recursive: true })
  for (const executable of ['wrangler', 'opennextjs-cloudflare']) {
    symlinkSync(
      realpathSync(join(repoRoot, 'node_modules', '.bin', executable)),
      join(fixtureBinDirectory, executable),
      'file',
    )
  }
  copyConfiguredFakeFixtureInputs(divergenceBaseConfig(), artifactRepositoryPath)
  return { directory, artifactRepositoryPath }
}

function removeFakePrepareArtifactRepository(fixture: { directory: string; artifactRepositoryPath: string }) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', fixture.artifactRepositoryPath], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
}
