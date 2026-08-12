import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_MANIFEST_FORMAT,
  DEFAULT_STAGE_POLICY,
  canonicalBytes,
  parseCanonicalManifest,
  prepare,
  prepareForTestsOnly,
} from '../../scripts/issue-23-delivery-prepare.mjs'
import { runLocalRehearsal, runLocalRehearsalForTestsOnly } from '../../scripts/issue-23-delivery-rehearsal.mjs'

const SHA40 = 'a'.repeat(40)
const SHA40_B = 'b'.repeat(40)
const ZERO_ACTIONS_TEST_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const SERVER_REFERENCE_TEST_PLACEHOLDER = 'process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'
const FORMAL_CLI_CHILD_TIMEOUT_MS = 240_000
const FORMAL_CLI_TEST_TIMEOUT_MS = FORMAL_CLI_CHILD_TIMEOUT_MS + 60_000

function hash(character: string) {
  return character.repeat(64)
}

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

function testRehearsalResult(overrides: Record<string, unknown> = {}) {
  return {
    runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
    network: 'disabled',
    status: 'PASS',
    receipt_sha256: hash('a'),
    production_write_adapter_calls: 0,
    expected_reconciliation: {
      value: structuredClone(CANONICAL_EXPECTED_RECONCILIATION),
      sha256: CANONICAL_EXPECTED_RECONCILIATION_SHA256,
    },
    d1: {
      outcome: 'PASS',
      production: false,
      promotable: false,
      sha256: hash('d'),
    },
    cleanup: {
      created: true,
      cleaned: true,
      observed_absent: true,
    },
    ...overrides,
  }
}

function baseConfig() {
  return {
    preparation: {
      prepare_entry: {
        path: 'scripts/issue-23-delivery-prepare.mjs',
        sha256: hash('c'),
      },
      execute_entry: {
        path: 'scripts/phase-b-sequence.mjs',
        sha256: hash('d'),
      },
      manifest_schema: {
        path: 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
        sha256: hash('e'),
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
      run_id: 30914559221,
      attempt: 1,
      event: 'push',
      head_sha: SHA40,
      tree: SHA40_B,
      conclusion: 'success',
    },
    toolchain: {
      node: { version: '22.14.0', identity_sha256: hash('f') },
      npm: { version: '10.9.2', identity_sha256: hash('a') },
      wrangler: { version: '4.84.1', identity_sha256: hash('b') },
      opennextjs_cloudflare: { version: '1.19.1', identity_sha256: hash('c') },
      package_json_sha256: hash('d'),
      lockfile_sha256: hash('e'),
    },
    artifact: {
      archive: { path: '.open-next/open-next-build.zip', sha256: hash('f'), bytes: 123 },
      worker: { path: '.open-next/worker.js', sha256: hash('a'), bytes: 456 },
      file_tree: {
        sha256: hash('b'),
        complete: true,
        files: [
          { path: '.open-next/assets/index.html', sha256: hash('d'), bytes: 789 },
          { path: '.open-next/worker.js', sha256: hash('c'), bytes: 456 },
          { path: 'wrangler.toml', sha256: hash('e'), bytes: 456 },
        ],
      },
    },
    migration: {
      delivery_mode: 'clean-start',
      reset_sql: {
        path: 'db/issue-23-clean-start-reset.sql',
        sha256: hash('f'),
      },
      runner: { path: 'scripts/migrations.mjs', sha256: '643594349a3f70d3bf9a7185c6449065cab497c07582cb92aacddb9dbf934c4d' },
      catalog: {
        path: 'db/ledger-migrations',
        sha256: '9421f735e2fa27b1051b884a16c6d2b0123791e05afc2bb6c02d2bcfac7e846c',
        migrations: [
          { id: '001', path: 'db/ledger-migrations/001_initial_schema.sql', sha256: 'ce80438c559ff16bfc9909761837ea83b053d33c80616bd8477cee8841d7bfd1' },
          { id: '002', path: 'db/ledger-migrations/002_add_ai_image_configuration.sql', sha256: '20abce1feba8dbf376448a359ba7e96dd11ac8458e097a8538cf67db632133af' },
          { id: '003', path: 'db/ledger-migrations/003_migrate_runtime_ai_configuration.sql', sha256: 'f08a53117936495af5c85c61fbee678103bb1c8d335a18d62684834888ee864d' },
          { id: '004', path: 'db/ledger-migrations/004_complete_historical_text_ai_schema.sql', sha256: '938e64fa93a4bbbabc8376ce2a02e90ca1d0d6896201f7350612bbd40da2b77a' },
          { id: '005', path: 'db/ledger-migrations/005_fix_posts_fts_sync.sql', sha256: 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441' },
          { id: '006', path: 'db/ledger-migrations/006_add_rollout_safety_controls.sql', sha256: '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551' },
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
      d1_database_id: 'd1-public-id',
      worker_name: 'blogman',
      origin: 'https://blog.example.com',
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: 'd1-public-id',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    },
    policy: {
      authorization: {
        manifest_binding: 'manifest_sha256',
        one_shot: true,
        credential_slots: [
          { name: 'cloudflare_delivery', scopes: ['account:read', 'workers:write', 'd1:write'] },
        ],
      },
      stages: DEFAULT_STAGE_POLICY,
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
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: hash('c'),
      production_write_adapter_calls: 0,
      expected_reconciliation_sha256: CANONICAL_EXPECTED_RECONCILIATION_SHA256,
      d1_stage_receipt_sha256: hash('d'),
      cleanup: {
        created: true,
        cleaned: true,
        observed_absent: true,
      },
    },
  }
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function withTargetMacosRuntime<T>(callback: () => T): T {
  if (process.platform === 'darwin') return callback()
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    return callback()
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
}

function withTemporaryDirectory<T>(prefix: string, callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  try {
    return callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function writeEmptyServerReferenceManifests(repositoryPath: string) {
  const serverDirectory = join(repositoryPath, '.next', 'server')
  const jsonManifest = JSON.stringify({ node: {}, edge: {}, encryptionKey: ZERO_ACTIONS_TEST_KEY })
  const jsManifest = JSON.stringify({ node: {}, edge: {}, encryptionKey: SERVER_REFERENCE_TEST_PLACEHOLDER })
  mkdirSync(serverDirectory, { recursive: true })
  writeFileSync(join(serverDirectory, 'server-reference-manifest.json'), jsonManifest)
  writeFileSync(join(serverDirectory, 'server-reference-manifest.js'), `self.__RSC_SERVER_MANIFEST=${JSON.stringify(jsManifest)}`)
}

function fixtureBuild(repositoryPath: string, { artifact }: { artifact: ReturnType<typeof baseConfig>['artifact'] }) {
  const outputRoot = join(repositoryPath, '.open-next')
  rmSync(outputRoot, { recursive: true, force: true })
  for (const file of artifact.file_tree.files) {
    if (file.path === 'wrangler.toml') continue
    const path = join(repositoryPath, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `fixture artifact: ${file.path}\n`)
  }
  const workerPath = join(repositoryPath, artifact.worker.path)
  mkdirSync(dirname(workerPath), { recursive: true })
  writeFileSync(workerPath, `fixture worker: ${artifact.worker.path}\n`)
  writeFileSync(join(outputRoot, 'runtime.js'), 'fixture runtime\n')
  writeEmptyServerReferenceManifests(repositoryPath)
  const nextServerDirectory = join(repositoryPath, '.next', 'server')
  mkdirSync(nextServerDirectory, { recursive: true })
  writeFileSync(join(nextServerDirectory, 'app-paths-manifest.json'), '{}')
  writeFileSync(join(nextServerDirectory, 'pages-manifest.json'), '{}')
  writeFileSync(join(nextServerDirectory, 'middleware-manifest.json'), JSON.stringify({
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

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    ) as T
  }
  return value
}

function runBoundedChild(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  timeoutMs = FORMAL_CLI_CHILD_TIMEOUT_MS,
) {
  return spawnSync(executable, args, {
    ...options,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
  })
}

function prepareFixture(config: ReturnType<typeof baseConfig>, options: Record<string, unknown> = {}) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const fixture = structuredClone(config)
  fixture.repository.commit = commit
  fixture.repository.tree = tree
  fixture.ci.head_sha = commit
  fixture.ci.tree = tree
  const fixtureOptions = { ...options }
  if (!Object.hasOwn(fixtureOptions, 'buildRunner')) fixtureOptions.buildRunner = fixtureBuild
  return prepareForTestsOnly(fixture, {
    repositoryPath: repoRoot,
    repositoryResolver: () => ({ commit, tree, clean: true }),
    ciResolver: (_path, source, repository) => ({
      ...source.ci,
      run_id: 1,
      attempt: 1,
      event: 'pull_request',
      head_sha: repository.commit,
      tree: repository.tree,
      conclusion: 'success',
    }),
    rehearsalRunner: () => testRehearsalResult(),
    ...fixtureOptions,
  })
}

function expectPreArchiveFailure(callback: () => unknown) {
  const archivePath = join(repoRoot, '.open-next', 'open-next-build.zip')
  rmSync(archivePath, { force: true })
  expect(callback).toThrow()
  expect(existsSync(archivePath)).toBe(false)
}

function readPatchContract(relativePath: string) {
  const patchPath = join(repoRoot, relativePath)
  return existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
}

async function emitCjsFlightManifest(
  chunkSpecs: Array<{ id: string; files: string[] }>,
  cssFiles: string[] = [],
) {
  const { ClientReferenceManifestPlugin } = await import(
    'next/dist/build/webpack/plugins/flight-manifest-plugin.js'
  )
  const dependency = {}
  const clientModule = { resource: join(repoRoot, 'app', 'client.tsx'), type: 'javascript/auto' }
  const entryModule = {
    layer: 'app-pages-browser',
    request: 'next-flight-client-entry-loader.js?test',
  }
  const entrypoint = {
    childrenIterable: [],
    chunks: chunkSpecs.map(({ id, files }) => ({ id, files, name: `chunk-${id}` })),
    getFiles: () => cssFiles,
  }
  let emitted = ''
  const compilation = {
    chunkGraph: {
      getChunkEntryModulesIterable: () => [entryModule],
      getModuleId: () => 'client-module',
    },
    emitAsset: (_path: string, source: { source: () => string | Uint8Array }) => {
      emitted = source.source().toString()
    },
    entrypoints: new Map([['app/page', entrypoint]]),
    getAsset: (file: string) => ({ source: { source: () => `/* ${file} */` } }),
    hooks: {
      processAssets: {
        tap: (_options: unknown, callback: () => void) => callback(),
      },
    },
    moduleGraph: {
      getOutgoingConnectionsInOrder: () => [{ dependency, module: clientModule }],
      getResolvedModule: () => clientModule,
      isAsync: () => false,
    },
    outputOptions: { crossOriginLoading: false, publicPath: '' },
  }
  const compiler = {
    context: repoRoot,
    hooks: {
      compilation: {
        tap: (_name: string, callback: (value: typeof compilation) => void) => callback(compilation),
      },
    },
  }

  new ClientReferenceManifestPlugin({
    appDir: join(repoRoot, 'app'),
    dev: false,
    experimentalInlineCss: false,
  }).apply(compiler)
  return emitted
}

function readFlightManifestChunkPairs(bytes: string) {
  const manifest = JSON.parse(bytes.slice(bytes.indexOf(']=') + 2, -1))
  const chunks = Object.values(manifest.clientModules)[0] as { chunks: string[] }
  return Array.from({ length: chunks.chunks.length / 2 }, (_, index) =>
    chunks.chunks.slice(index * 2, index * 2 + 2),
  )
}

function readFlightManifestEntryCssFiles(bytes: string) {
  const manifest = JSON.parse(bytes.slice(bytes.indexOf(']=') + 2, -1))
  return Object.values(manifest.entryCSSFiles)[0] as Array<{ inlined: boolean; path: string }>
}

function buildFileMap(result: ReturnType<typeof prepareFixture>) {
  const artifactPaths = new Set(
    result.value.artifact.file_tree.files
      .map(({ path }) => path)
      .filter((path) => path.startsWith('.open-next/')),
  )
  artifactPaths.add(result.value.artifact.archive.path)
  return [...artifactPaths]
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(repoRoot, path))
      return { path, bytes: bytes.byteLength, sha256: sha256(bytes) }
    })
}

function fileMapDiff(
  first: ReturnType<typeof buildFileMap>,
  second: ReturnType<typeof buildFileMap>,
) {
  const firstByPath = new Map(first.map((file) => [file.path, file]))
  const secondByPath = new Map(second.map((file) => [file.path, file]))
  const allPaths = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])].sort()
  return {
    added: allPaths.filter((path) => !firstByPath.has(path)),
    removed: allPaths.filter((path) => !secondByPath.has(path)),
    changed: allPaths
      .filter((path) => firstByPath.has(path) && secondByPath.has(path))
      .filter((path) => JSON.stringify(firstByPath.get(path)) !== JSON.stringify(secondByPath.get(path)))
      .map((path) => ({ path, first: firstByPath.get(path), second: secondByPath.get(path) })),
  }
}

function firstChangedByteContext(before: Buffer | string, after: Buffer | string) {
  const left = Buffer.from(before)
  const right = Buffer.from(after)
  let offset = 0
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset += 1
  if (offset === left.length && offset === right.length) return null
  const context = (bytes: Buffer) => {
    const start = Math.max(0, offset - 8)
    const end = Math.min(bytes.length, offset + 8)
    return { start, end, hex: bytes.subarray(start, end).toString('hex') }
  }
  return { offset, before: context(left), after: context(right) }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('Issue #23 Delivery Preparation', () => {
  it('manifest-order contract: stabilizes Next CJS pages-manifest serialization', () => {
    const patch = readPatchContract('patches/next+16.2.6.patch')

    expect(patch).toContain('a/node_modules/next/dist/build/webpack/plugins/pages-manifest-plugin.js')
    expect(patch).toContain('sortManifestObjectKeys')
    expect(patch).toContain('Array.isArray')
  })

  it('manifest-order contract: stabilizes Next ESM pages-manifest serialization', () => {
    const patch = readPatchContract('patches/next+16.2.6.patch')

    expect(patch).toContain('a/node_modules/next/dist/esm/build/webpack/plugins/pages-manifest-plugin.js')
    expect(patch).toContain('sortManifestObjectKeys')
    expect(patch).toContain('Array.isArray')
  })

  it('manifest-order contract: stabilizes Next CJS flight-manifest serialization', () => {
    const patch = readPatchContract('patches/next+16.2.6.patch')

    expect(patch).toContain('a/node_modules/next/dist/build/webpack/plugins/flight-manifest-plugin.js')
    expect(patch).toContain('sortManifestObjectKeys')
    expect(patch).toContain('Array.isArray')
  })

  it('manifest-order contract: stabilizes Next ESM flight-manifest serialization', () => {
    const patch = readPatchContract('patches/next+16.2.6.patch')

    expect(patch).toContain('a/node_modules/next/dist/esm/build/webpack/plugins/flight-manifest-plugin.js')
    expect(patch).toContain('sortManifestObjectKeys')
    expect(patch).toContain('Array.isArray')
  })

  it('manifest-order contract: emits identical flight manifests for equivalent chunk traversal order', async () => {
    const first = await emitCjsFlightManifest([
      { id: '2', files: ['static/chunks/a.js'] },
      { id: '10', files: ['static/chunks/z.js', 'static/chunks/[slug].js'] },
    ])
    const second = await emitCjsFlightManifest([
      { id: '10', files: ['static/chunks/[slug].js', 'static/chunks/z.js'] },
      { id: '2', files: ['static/chunks/a.js'] },
    ])
    const expectedPairs = [
      ['10', 'static/chunks/%5Bslug%5D.js'],
      ['10', 'static/chunks/z.js'],
      ['2', 'static/chunks/a.js'],
    ]

    expect(readFlightManifestChunkPairs(first).sort()).toEqual(expectedPairs)
    expect(readFlightManifestChunkPairs(second).sort()).toEqual(expectedPairs)
    expect(first).toBe(second)
    expect(readFlightManifestChunkPairs(first)).toEqual(expectedPairs)
  })

  it('manifest-order contract: emits identical flight manifests for equivalent CSS traversal order', async () => {
    const chunkSpecs = [{ id: '2', files: ['static/chunks/a.js'] }]
    const first = await emitCjsFlightManifest(chunkSpecs, ['static/css/z.css', 'static/css/a.css'])
    const second = await emitCjsFlightManifest(chunkSpecs, ['static/css/a.css', 'static/css/z.css'])
    const expectedCssFiles = [
      { inlined: false, path: 'static/css/a.css' },
      { inlined: false, path: 'static/css/z.css' },
    ]

    expect(first).toBe(second)
    expect(readFlightManifestEntryCssFiles(first)).toEqual(expectedCssFiles)
  })

  it('manifest-order contract: tie-breaks OpenNext manifest glob ordering lexically', () => {
    const patch = readPatchContract('patches/@opennextjs+cloudflare+1.19.10.patch')

    expect(patch).toContain('a/node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js')
    expect(patch).toContain('manifestPaths.sort')
    expect(patch).toContain('localeCompare')
  })

  it('emits schema-ordered canonical bytes with an exact-byte identity', () => {
    const result = prepareFixture(baseConfig())
    const text = result.bytes.toString('utf8')

    expect(result.value.format).toBe(CANONICAL_MANIFEST_FORMAT)
    expect(result.sha256).toBe(sha256(result.bytes))
    expect(JSON.parse(text)).toEqual(result.value)
    expect(Object.keys(result.value)).toEqual([
      'format',
      'preparation',
      'repository',
      'ci',
      'toolchain',
      'artifact',
      'migration',
      'd1',
      'target',
      'policy',
      'rehearsal',
    ])
    expect(text).toMatch(/^\{\n  "format": "blogman-issue-23-canonical-frozen-manifest\/v1",\n/u)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('PRIVATE')
    expect(text).not.toContain('DROP TABLE')
    const canonicalValue = structuredClone(result.value)
    canonicalValue.d1.mode = 'remote'
    canonicalValue.d1.evidence_class = 'production'
    const canonical = canonicalBytes(canonicalValue)
    expect(parseCanonicalManifest(canonical, sha256(canonical))).toEqual(canonicalValue)
  })

  it('returns an isolated bytes copy so mutation cannot diverge from its identity', () => {
    const result = prepareFixture(baseConfig())
    const originalBytes = Buffer.from(result.bytes)
    const mutableAccess = result.bytes
    mutableAccess[0] ^= 1

    expect(result.bytes).toEqual(originalBytes)
    expect(result.sha256).toBe(sha256(originalBytes))
    expect(() => parseCanonicalManifest(result.bytes, result.sha256)).toThrow(/canonical remote production/u)
  })

  it('binds the configured migration runner to catalog and rehearsal', () => {
    const runnerPath = 'tests/scripts/.issue-23-configured-runner.mjs'
    const catalog = {
      format: 'blogman-migration-catalog/v1',
      migrations: baseConfig().migration.catalog.migrations.map((entry, index) => ({
        number: index + 1,
        name: entry.path.slice(entry.path.lastIndexOf('/') + 1).replace(/\.sql$/u, ''),
        checksum: hash(String(index + 1)),
      })),
    }
    writeFileSync(join(repoRoot, runnerPath), `process.stdout.write(${JSON.stringify(JSON.stringify(catalog))})\n`)

    try {
      const config = baseConfig()
      config.migration.runner.path = runnerPath
      config.migration.runner.sha256 = sha256(readFileSync(join(repoRoot, runnerPath)))
      config.migration.catalog.sha256 = sha256(Buffer.from(JSON.stringify(catalog)))
      let rehearsalRunnerPath = ''
      const result = prepareFixture(config, {
        rehearsalRunner: ({ migrationRunnerPath }: { migrationRunnerPath: string }) => {
          rehearsalRunnerPath = migrationRunnerPath
          return testRehearsalResult()
        },
      })

      expect(result.value.migration.catalog.sha256).toBe(sha256(Buffer.from(JSON.stringify(catalog))))
      expect(rehearsalRunnerPath).toBe(runnerPath)
    } finally {
      rmSync(join(repoRoot, runnerPath), { force: true })
    }
  })

  it('binds configured migration names checksums catalog and declared hashes', () => {
    const runnerPath = 'tests/scripts/.issue-23-configured-runner-binding.mjs'
    const catalogPath = 'tests/scripts/.issue-23-catalog-binding'
    const catalogDirectory = join(repoRoot, catalogPath)
    const canonicalCatalogDirectory = join(repoRoot, 'db/ledger-migrations')
    const captureDirectory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-migration-binding-'))
    const capturePath = join(captureDirectory, 'argv.jsonl')
    const captureArguments = () => readFileSync(capturePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])

    rmSync(catalogDirectory, { recursive: true, force: true })
    mkdirSync(catalogDirectory, { recursive: true })
    for (const name of readdirSync(canonicalCatalogDirectory)) {
      copyFileSync(join(canonicalCatalogDirectory, name), join(catalogDirectory, name))
    }

    const configuredEntries = baseConfig().migration.catalog.migrations.map((entry) => {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      const path = `${catalogPath}/${name}`
      return {
        ...entry,
        path,
        sha256: sha256(readFileSync(join(repoRoot, path))),
      }
    })
    const goodCatalog = {
      format: 'blogman-migration-catalog/v1',
      migrations: configuredEntries.map((entry, index) => ({
        number: index + 1,
        name: entry.path.slice(entry.path.lastIndexOf('/') + 1).replace(/\.sql$/u, ''),
        checksum: hash(String(index + 1)),
      })),
    }
    const declaredCatalogSha256 = sha256(Buffer.from(JSON.stringify(goodCatalog)))

    const writeRunner = (catalog: typeof goodCatalog) => {
      writeFileSync(join(repoRoot, runnerPath), `
        import { appendFileSync } from 'node:fs'
        const args = process.argv.slice(2)
        appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args) + '\\n')
        if (args[0] === 'catalog') {
          process.stdout.write(${JSON.stringify(JSON.stringify(catalog))})
        } else {
          process.stdout.write(JSON.stringify({ state: 'current' }))
        }
      `)
    }

    const runPreparation = (
      catalog: typeof goodCatalog,
      mutateConfig: (config: ReturnType<typeof baseConfig>) => void = () => {},
    ) => {
      rmSync(capturePath, { force: true })
      writeRunner(catalog)
      const config = baseConfig()
      config.migration.runner.path = runnerPath
      config.migration.runner.sha256 = sha256(readFileSync(join(repoRoot, runnerPath)))
      config.migration.catalog.path = catalogPath
      config.migration.catalog.sha256 = declaredCatalogSha256
      config.migration.catalog.migrations = configuredEntries
      mutateConfig(config)
      return withTargetMacosRuntime(() => prepareFixture(config, {
        rehearsalRunner: ({
          repositoryPath,
          migrationRunnerPath,
          manifestDraftSha256,
        }: {
          repositoryPath: string
          migrationRunnerPath: string
          manifestDraftSha256: string
        }) => ({
          ...runLocalRehearsalForTestsOnly({
            repositoryPath,
            migrationRunnerPath,
            migrationCatalogPath: catalogPath,
            manifestDraftSha256,
          }),
          ...testRehearsalResult(),
        }),
      }))
    }

    const scenarios: Array<{
      label: string
      catalog: typeof goodCatalog
      mutateConfig?: (config: ReturnType<typeof baseConfig>) => void
    }> = [
      {
        label: 'missing name',
        catalog: {
          ...goodCatalog,
          migrations: goodCatalog.migrations.map(({ number, checksum }) => ({ number, checksum })),
        },
      },
      {
        label: 'forged name',
        catalog: {
          ...goodCatalog,
          migrations: goodCatalog.migrations.map((entry, index) => (
            index === 0 ? { ...entry, name: '001_forged' } : entry
          )),
        },
      },
      {
        label: 'missing checksum',
        catalog: {
          ...goodCatalog,
          migrations: goodCatalog.migrations.map(({ number, name }, index) => (
            index === 0 ? { number, name } : { number, name, checksum: hash(String(index + 1)) }
          )),
        },
      },
      {
        label: 'forged checksum',
        catalog: {
          ...goodCatalog,
          migrations: goodCatalog.migrations.map((entry, index) => (
            index === 0 ? { ...entry, checksum: hash('f') } : entry
          )),
        },
      },
      {
        label: 'declared runner hash',
        catalog: goodCatalog,
        mutateConfig: (config) => { config.migration.runner.sha256 = hash('0') },
      },
      {
        label: 'declared catalog hash',
        catalog: goodCatalog,
        mutateConfig: (config) => { config.migration.catalog.sha256 = hash('0') },
      },
      {
        label: 'declared migration hash',
        catalog: goodCatalog,
        mutateConfig: (config) => { config.migration.catalog.migrations[0].sha256 = hash('0') },
      },
    ]

    try {
      const result = runPreparation(goodCatalog)
      expect(result.value.migration.catalog.sha256).toBe(declaredCatalogSha256)
      const captured = captureArguments()
      expect(captured).toHaveLength(4)
      expect(captured.filter(([command]) => command === 'catalog')).toHaveLength(2)
      expect(captured.filter(([command]) => command === 'apply' || command === 'verify')).toHaveLength(2)
      for (const args of captured) {
        const directoryIndex = args.indexOf('--migrations-dir')
        expect(directoryIndex).toBeGreaterThan(-1)
        expect(args[directoryIndex + 1]).toBe(catalogPath)
      }

      for (const scenario of scenarios) {
        expect(() => runPreparation(scenario.catalog, scenario.mutateConfig), scenario.label)
          .toThrow(/migration|catalog|sha256/u)
      }
    } finally {
      rmSync(join(repoRoot, runnerPath), { force: true })
      rmSync(catalogDirectory, { recursive: true, force: true })
      rmSync(captureDirectory, { recursive: true, force: true })
    }
  }, 15_000)

  it('enumerates the complete public artifact tree independently of caller-listed files', () => {
    const result = prepareFixture(baseConfig())
    const paths = result.value.artifact.file_tree.files.map((file) => file.path)

    expect(result.value.artifact.file_tree.complete).toBe(true)
    expect(paths.length).toBeGreaterThan(baseConfig().artifact.file_tree.files.length)
    expect(paths).toContain('.open-next/assets/index.html')
  })

  it('excludes generated private files from archive membership', () => {
    const result = prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        const privateDirectory = join(repositoryPath, '.open-next', 'private')
        mkdirSync(privateDirectory, { recursive: true })
        writeFileSync(join(privateDirectory, 'secret.txt'), 'private fixture\n')
      },
    })
    const paths = result.value.artifact.file_tree.files.map((file) => file.path)
    const archiveEntries = execFileSync(
      'unzip',
      ['-Z1', join(repoRoot, '.open-next/open-next-build.zip')],
      { encoding: 'utf8' },
    ).trim().split(/\r?\n/u).filter(Boolean)

    expect(paths).not.toContain('.open-next/private/secret.txt')
    expect(archiveEntries).not.toContain('private/secret.txt')
    expect(archiveEntries).toContain('assets/index.html')
  })

  it('accepts generic Next DraftMode identifiers but rejects real Preview/Draft markers before archive', () => {
    const runWithCompiledSource = (compiledSource: string) => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        const appPathsManifestPath = join(repositoryPath, '.next', 'server', 'app-paths-manifest.json')
        const compiledPath = join(repositoryPath, '.next', 'server', 'app', 'page.js')
        mkdirSync(dirname(compiledPath), { recursive: true })
        writeFileSync(appPathsManifestPath, JSON.stringify({ 'app/page.js': 'app/page.js' }))
        writeFileSync(compiledPath, compiledSource)
      },
    })

    expect(() => runWithCompiledSource([
      'const multiZoneDraftMode = false',
      'const isDraftMode = false',
      'const previewProps = {}',
    ].join('\n'))).not.toThrow()

    expectPreArchiveFailure(() => runWithCompiledSource(
      'export default function Page() { return [draftMode(), previewData] }\n',
    ))
  })

  it('rejects reachable compiled Preview marker before archive identity', () => {
    const sourcePath = join(repoRoot, 'app', 'page.js')
    writeFileSync(sourcePath, 'export default function Page() { return null }\n')
    let thrown: Error | undefined
    try {
      expectPreArchiveFailure(() => {
        try {
          prepareFixture(baseConfig(), {
            buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
              fixtureBuild(repositoryPath, options)
              const appPathsManifestPath = join(repositoryPath, '.next', 'server', 'app-paths-manifest.json')
              const compiledPath = join(repositoryPath, '.next', 'server', 'app', 'page.js')
              mkdirSync(dirname(compiledPath), { recursive: true })
              writeFileSync(appPathsManifestPath, JSON.stringify({ 'app/page.js': 'app/page.js' }))
              writeFileSync(compiledPath, 'export default function Page() { return draftMode() }\n')
            },
          })
        } catch (error) {
          thrown = error as Error
          throw error
        }
      })
      expect(thrown?.message).toMatch(/Preview\/Draft Mode evidence/u)
    } finally {
      rmSync(sourcePath, { force: true })
    }
  })

  it('rejects an internal artifact symlink before archive creation', () => {
    let thrown: Error | undefined
    expectPreArchiveFailure(() => {
      try {
        prepareFixture(baseConfig(), {
          buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
            fixtureBuild(repositoryPath, options)
            const privateDirectory = join(repositoryPath, '.open-next', 'private')
            mkdirSync(privateDirectory, { recursive: true })
            writeFileSync(join(privateDirectory, 'secret.txt'), 'private fixture\n')
            symlinkSync('private/secret.txt', join(repositoryPath, '.open-next', 'public-link.js'))
          },
        })
      } catch (error) {
        thrown = error as Error
        throw error
      }
    })
    expect(thrown?.message).toMatch(/symbolic link/u)
  })

  it('binds generated deployable bytes and final config bytes, not the committed source tree', () => {
    const result = prepareFixture(baseConfig())
    const archiveBytes = readFileSync(join(repoRoot, '.open-next/open-next-build.zip'))
    const workerBytes = readFileSync(join(repoRoot, '.open-next/worker.js'))
    const configBytes = readFileSync(join(repoRoot, 'wrangler.toml'))
    const paths = result.value.artifact.file_tree.files.map((file) => file.path)

    expect(result.value.artifact.worker.path).toBe('.open-next/worker.js')
    expect(result.value.artifact.worker.sha256).toBe(sha256(workerBytes))
    expect(result.value.artifact.worker.bytes).toBe(workerBytes.byteLength)
    expect(result.value.artifact.archive.sha256).toBe(sha256(archiveBytes))
    expect(result.value.artifact.archive.bytes).toBe(archiveBytes.byteLength)
    expect(paths).toContain('wrangler.toml')
    expect(result.value.artifact.file_tree.files.find((file) => file.path === 'wrangler.toml'))
      .toMatchObject({ sha256: sha256(configBytes), bytes: configBytes.byteLength })
    expect(paths).not.toContain('package.json')
  })

  it('accepts an explicit zero-actions server-reference manifest', () => {
    expect(Buffer.from(ZERO_ACTIONS_TEST_KEY, 'base64').byteLength).toBe(32)
    expect(Buffer.from(ZERO_ACTIONS_TEST_KEY, 'base64').toString('base64')).toBe(ZERO_ACTIONS_TEST_KEY)
    expect(() => prepareFixture(baseConfig())).not.toThrow()
  })

  it('S3-W33 sentinel boundary exposes deterministic build inputs under NODE_ENV=test', () => {
    const previousNodeEnv = process.env.NODE_ENV
    let capturedOptions: Record<string, unknown> = {}
    const buildRunnerSentinel = new Error('S3-W33 build runner input sentinel')

    process.env.NODE_ENV = 'test'
    try {
      expect(() => prepareFixture(baseConfig(), {
        buildRunner: (_repositoryPath: string, options: Record<string, unknown>) => {
          capturedOptions = options
          throw buildRunnerSentinel
        },
      })).toThrow(buildRunnerSentinel)

      expect(capturedOptions.buildEnv).toEqual({
        BLOGMAN_BUILD_PREVIEW_MODE_ID: '0123456789abcdef0123456789abcdef',
        BLOGMAN_BUILD_PREVIEW_MODE_SIGNING_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        BLOGMAN_BUILD_PREVIEW_MODE_ENCRYPTION_KEY: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      })
      const expectedBuildEpochMs = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()) * 1000
      expect(capturedOptions.buildEpochMs).toBe(expectedBuildEpochMs)
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('rejects a node action before archive identity', () => {
    const action = { 'action-id': { workers: {}, layer: {} } }
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        const serverDirectory = join(repositoryPath, '.next', 'server')
        writeFileSync(join(serverDirectory, 'server-reference-manifest.json'), JSON.stringify({ node: action, edge: {}, encryptionKey: ZERO_ACTIONS_TEST_KEY }))
        writeFileSync(join(serverDirectory, 'server-reference-manifest.js'), `self.__RSC_SERVER_MANIFEST=${JSON.stringify(JSON.stringify({ node: action, edge: {}, encryptionKey: SERVER_REFERENCE_TEST_PLACEHOLDER }))}`)
      },
    }))
  })

  it('rejects an edge action before archive identity', () => {
    const action = { 'action-id': { workers: {}, layer: {} } }
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        const serverDirectory = join(repositoryPath, '.next', 'server')
        writeFileSync(join(serverDirectory, 'server-reference-manifest.json'), JSON.stringify({ node: {}, edge: action, encryptionKey: ZERO_ACTIONS_TEST_KEY }))
        writeFileSync(join(serverDirectory, 'server-reference-manifest.js'), `self.__RSC_SERVER_MANIFEST=${JSON.stringify(JSON.stringify({ node: {}, edge: action, encryptionKey: SERVER_REFERENCE_TEST_PLACEHOLDER }))}`)
      },
    }))
  })

  it('rejects a missing server-reference manifest before archive identity', () => {
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        rmSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.json'))
      },
    }))
  })

  it('rejects malformed or unexpected-shape server-reference manifests', () => {
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.json'), '{"node":')
      },
    }))
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.json'), JSON.stringify({ node: [], edge: {}, encryptionKey: ZERO_ACTIONS_TEST_KEY }))
      },
    }))
  })

  it('rejects an unexpected key or wrapper placeholder', () => {
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.json'), JSON.stringify({ node: {}, edge: {}, encryptionKey: 'unexpected-key' }))
      },
    }))
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.js'), `self.__RSC_SERVER_MANIFEST=${JSON.stringify(JSON.stringify({ node: {}, edge: {}, encryptionKey: ZERO_ACTIONS_TEST_KEY }))}`)
      },
    }))
  })

  it('rejects JSON and JS semantic mismatch before archive identity', () => {
    const action = { 'action-id': { workers: {}, layer: {} } }
    expectPreArchiveFailure(() => prepareFixture(baseConfig(), {
      buildRunner: (repositoryPath: string, options: Parameters<typeof fixtureBuild>[1]) => {
        fixtureBuild(repositoryPath, options)
        writeFileSync(join(repositoryPath, '.next', 'server', 'server-reference-manifest.js'), `self.__RSC_SERVER_MANIFEST=${JSON.stringify(JSON.stringify({ node: action, edge: {}, encryptionKey: SERVER_REFERENCE_TEST_PLACEHOLDER }))}`)
      },
    }))
  })

  it('is repeatable and changes identity for meaningful input changes', { timeout: 15_000 }, () => {
    const first = prepareFixture(baseConfig())
    const second = prepareFixture(baseConfig())
    const changed = baseConfig()
    changed.artifact.worker.path = '.open-next/worker-alt.js'
    const changedResult = prepareFixture(changed)

    expect(second.bytes).toEqual(first.bytes)
    expect(second.sha256).toBe(first.sha256)
    expect(changedResult.bytes).not.toEqual(first.bytes)
    expect(changedResult.sha256).not.toBe(first.sha256)
  })

  it('derives draft and receipt identity from schema-ordered bytes, not key insertion order', () => {
    const receiptRunner = ({ manifestDraftSha256 }: { manifestDraftSha256: string }) => testRehearsalResult({
      receipt_sha256: manifestDraftSha256,
    })
    const first = prepareFixture(baseConfig(), { rehearsalRunner: receiptRunner })
    const reordered = reverseObjectKeys(baseConfig())
    const second = prepareFixture(reordered, { rehearsalRunner: receiptRunner })

    expect(second.bytes).toEqual(first.bytes)
    expect(second.sha256).toBe(first.sha256)
    expect(second.value.rehearsal.receipt_sha256).toBe(first.value.rehearsal.receipt_sha256)
  })

  it('freezes the Issue #23 stage order and timeout policy', () => {
    const result = prepareFixture(baseConfig())

    expect(result.value.policy.stages).toEqual([
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
    ])
    expect(result.value.policy.overall_timeout_seconds).toBe(5400)
  })

  it('fails closed when a fixed stage policy is mutated', () => {
    const mutated = baseConfig()
    const stages: Array<{ name: string; timeout_seconds: number }> = mutated.policy.stages.map(
      (stage) => ({ ...stage }),
    )
    stages[0] = { name: 'authorization_accept', timeout_seconds: 31 }
    Reflect.set(mutated.policy, 'stages', stages)

    expect(() => prepareFixture(mutated)).toThrow(/fixed Issue #23 order and timeouts/u)
  })

  it('rejects unknown fields and material secret, SQL, or private-path input', () => {
    const unknown = baseConfig()
    Reflect.set(unknown.policy.authorization.credential_slots[0], 'value', 'secret-value')
    expect(() => prepareFixture(unknown)).toThrow(/not allowed/u)

    const sqlBody = baseConfig()
    Reflect.set(sqlBody.migration.reset_sql, 'sql', 'DROP TABLE posts')
    expect(() => prepareFixture(sqlBody)).toThrow(/not allowed/u)

    const privatePath = baseConfig()
    privatePath.artifact.worker.path = '/private/operator/worker.js'
    expect(() => prepareFixture(privatePath)).toThrow(/path/u)

    const topLevel = baseConfig()
    Reflect.set(topLevel, 'unexpected', true)
    expect(() => prepareFixture(topLevel)).toThrow(/not allowed/u)
  })

  it('rejects a repository symlink whose target is outside the canonical root', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-symlink-'))
    const externalPath = join(directory, 'operator-material.bin')
    const linkPath = join(repoRoot, 'tests', 'scripts', '.issue-23-external-link.bin')
    const externalBytes = Buffer.from('private operator material\n', 'utf8')
    writeFileSync(externalPath, externalBytes)
    symlinkSync(externalPath, linkPath)

    try {
      const config = baseConfig()
      config.artifact.worker.path = 'tests/scripts/.issue-23-external-link.bin'

      let thrown: Error | undefined
      try {
        prepareFixture(config)
      } catch (error) {
        thrown = error as Error
      }
      expect(thrown?.message).toMatch(/escapes repository/u)
      expect(thrown?.message).not.toContain(externalPath)
      expect(thrown?.message).not.toContain(externalBytes.toString('utf8'))
      expect(thrown?.message).not.toContain(sha256(externalBytes))
      expect(thrown?.message).not.toContain(String(externalBytes.length))
    } finally {
      rmSync(linkPath, { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a repository catalog-directory symlink before external catalog bytes drive preparation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-catalog-symlink-'))
    const externalCatalogDirectory = join(directory, 'catalog')
    const externalCatalogPath = join(externalCatalogDirectory, 'catalog.json')
    const reachedPath = join(externalCatalogDirectory, 'reached')
    const linkPath = join(repoRoot, 'tests', 'scripts', '.issue-23-external-catalog-directory')
    const runnerPath = 'tests/scripts/.issue-23-external-catalog-runner.mjs'
    const catalog = {
      format: 'blogman-migration-catalog/v1',
      migrations: baseConfig().migration.catalog.migrations.map((entry, index) => ({
        number: index + 1,
        name: entry.path.slice(entry.path.lastIndexOf('/') + 1).replace(/\.sql$/u, ''),
        checksum: hash(String(index + 1)),
      })),
    }
    const catalogBytes = Buffer.from(JSON.stringify(catalog))

    mkdirSync(externalCatalogDirectory, { recursive: true })
    writeFileSync(externalCatalogPath, catalogBytes)
    writeFileSync(join(repoRoot, runnerPath), `
      import { appendFileSync, readFileSync } from 'node:fs'
      import { join } from 'node:path'
      const args = process.argv.slice(2)
      const directory = args[args.indexOf('--migrations-dir') + 1]
      appendFileSync(${JSON.stringify(reachedPath)}, directory)
      process.stdout.write(readFileSync(join(directory, 'catalog.json')))
    `)
    symlinkSync(externalCatalogDirectory, linkPath)

    try {
      const config = baseConfig()
      config.migration.runner.path = runnerPath
      config.migration.runner.sha256 = sha256(readFileSync(join(repoRoot, runnerPath)))
      config.migration.catalog.path = 'tests/scripts/.issue-23-external-catalog-directory'
      config.migration.catalog.sha256 = sha256(catalogBytes)

      let thrown: Error | undefined
      try {
        prepareFixture(config)
      } catch (error) {
        thrown = error as Error
      }

      expect(existsSync(reachedPath)).toBe(false)
      expect(thrown?.message).toMatch(/escapes repository/u)
    } finally {
      rmSync(linkPath, { force: true })
      rmSync(join(repoRoot, runnerPath), { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a repository catalog-directory symlink before building local rehearsal argv', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-rehearsal-catalog-symlink-'))
    const reachedPath = join(directory, 'reached')
    const linkPath = join(repoRoot, 'tests', 'scripts', '.issue-23-rehearsal-catalog-directory')
    const runnerPath = 'tests/scripts/.issue-23-rehearsal-catalog-runner.mjs'
    writeFileSync(join(repoRoot, runnerPath), `
      import { appendFileSync } from 'node:fs'
      appendFileSync(${JSON.stringify(reachedPath)}, JSON.stringify(process.argv.slice(2)))
      process.stdout.write(JSON.stringify({ state: 'current' }))
    `)
    symlinkSync(directory, linkPath)

    try {
      let thrown: Error | undefined
      try {
        runLocalRehearsalForTestsOnly({
          repositoryPath: repoRoot,
          runnerPath,
          migrationCatalogPath: 'tests/scripts/.issue-23-rehearsal-catalog-directory',
          manifestDraftSha256: hash('a'),
        })
      } catch (error) {
        thrown = error as Error
      }

      expect(existsSync(reachedPath)).toBe(false)
      expect(thrown?.message).toMatch(/escapes repository/u)
    } finally {
      rmSync(linkPath, { force: true })
      rmSync(join(repoRoot, runnerPath), { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects missing identity, non-canonical bytes, and identity mismatch', () => {
    const missing = baseConfig()
    Reflect.deleteProperty(missing.artifact.file_tree, 'sha256')
    expect(() => prepareFixture(missing)).toThrow(/sha256.*required/u)

    const result = prepareFixture(baseConfig())
    expect(() => parseCanonicalManifest(result.bytes)).toThrow(/identity is required/u)
    expect(() => parseCanonicalManifest(result.bytes, '0'.repeat(64))).toThrow(/identity mismatch/u)

    const parsed = JSON.parse(result.bytes.toString('utf8'))
    const reversed = Object.fromEntries(
      Object.keys(parsed).reverse().map((key) => [key, parsed[key]]),
    )
    const reorderedBytes = Buffer.from(`${JSON.stringify(reversed)}\n`)
    expect(() => parseCanonicalManifest(reorderedBytes, sha256(reorderedBytes)))
      .toThrow(/canonical/u)

    const duplicateKeyBytes = Buffer.from(result.bytes.toString('utf8').replace(
      '{\n  "format":',
      '{\n  "format":',
    ).replace(
      '  "preparation":',
      `  "format": ${JSON.stringify(CANONICAL_MANIFEST_FORMAT)},\n  "preparation":`,
    ))
    expect(() => parseCanonicalManifest(duplicateKeyBytes, sha256(duplicateKeyBytes)))
      .toThrow(/duplicate/u)
  })

  it('keeps the production-write adapter untouched during read-only preparation', () => {
    const adapter = {
      calls: 0,
      write() {
        this.calls += 1
      },
    }

    const result = prepareFixture(baseConfig(), { productionWriteAdapter: adapter })

    expect(adapter.calls).toBe(0)
    expect(result.value.rehearsal.production_write_adapter_calls).toBe(0)
  })

  it('fails closed when canonical expected reconciliation evidence is missing', () => {
    expect(() => prepareFixture(baseConfig(), {
      rehearsalRunner: () => testRehearsalResult({ expected_reconciliation: undefined }),
    })).toThrow(/expected reconciliation evidence is required/u)
  })

  it('fails closed when canonical expected reconciliation evidence hash drifts', () => {
    expect(() => prepareFixture(baseConfig(), {
      rehearsalRunner: () => testRehearsalResult({
        expected_reconciliation: {
          value: structuredClone(CANONICAL_EXPECTED_RECONCILIATION),
          sha256: '0'.repeat(64),
        },
      }),
    })).toThrow(/identity does not match its bytes/u)
  })

  it('rejects caller adapter injection at the public prepare boundary', () => {
    let invoked = false
    expect(() => prepare(baseConfig(), {
      repositoryResolver: () => {
        invoked = true
        throw new Error('caller repository resolver must not run')
      },
      rehearsalRunner: () => {
        invoked = true
        throw new Error('caller rehearsal runner must not run')
      },
    } as never)).toThrow(/public prepare does not accept adapter overrides/u)
    expect(invoked).toBe(false)
  })

  it('rejects a custom migration runner in public production preparation', () => {
    const config = baseConfig()
    config.migration.runner.path = 'tests/scripts/custom-runner.mjs'

    expect(() => prepare(config)).toThrow(/canonical production artifact/u)
  })

  it('marks test-only prepared output as non-production and rejects it at the canonical manifest seam', () => {
    const result = prepareFixture(baseConfig())

    expect(result.test_only).toBe(true)
    expect(result.value.d1.mode).toBe('local')
    expect(result.value.d1.evidence_class).toBe('test-non-production')
    expect(() => parseCanonicalManifest(result.bytes, result.sha256)).toThrow(/canonical remote production/u)
  })

  it('does not trust caller-supplied repository facts', () => {
    const forged = baseConfig()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()

    expect(() => prepareForTestsOnly(forged, {
      repositoryPath: repoRoot,
      repositoryResolver: () => ({ commit, tree, clean: true }),
      ciResolver: (_path, source, repository) => ({ ...source.ci, run_id: 1, attempt: 1, event: 'pull_request', head_sha: repository.commit, tree: repository.tree, conclusion: 'success' }),
      buildRunner: fixtureBuild,
      rehearsalRunner: () => testRehearsalResult(),
    })).toThrow(
      /resolved repository identity/u,
    )
  })

  it('binds the actual npm executable and the lockfile OpenNext version', () => {
    const result = prepareFixture(baseConfig())
    const npmVersion = execFileSync('npm', ['--version'], { cwd: repoRoot, encoding: 'utf8' })
      .trim()
      .replace(/^v/u, '')
    const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
    const wranglerBytes = readFileSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))
    const openNextBytes = readFileSync(join(repoRoot, 'node_modules', '.bin', 'opennextjs-cloudflare'))

    expect(result.value.toolchain.npm.version).toBe(npmVersion)
    expect(result.value.toolchain.npm.version).not.toBe(process.versions.node)
    expect(result.value.toolchain.opennextjs_cloudflare.version)
      .toBe(lockfile.packages['node_modules/@opennextjs/cloudflare'].version)
    expect(result.value.toolchain.wrangler.identity_sha256).toBe(sha256(wranglerBytes))
    expect(result.value.toolchain.opennextjs_cloudflare.identity_sha256).toBe(sha256(openNextBytes))
  })

  it('rejects a dirty production repository even when identities match', () => {
    const dirty = baseConfig()
    dirty.repository.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    dirty.repository.tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    dirty.ci.head_sha = dirty.repository.commit
    dirty.ci.tree = dirty.repository.tree

    expect(() => prepareForTestsOnly(dirty, {
      repositoryPath: repoRoot,
      repositoryResolver: () => ({ commit: dirty.repository.commit, tree: dirty.repository.tree, clean: false }),
      ciResolver: (_path, source, repository) => ({ ...source.ci, run_id: 1, attempt: 1, event: 'pull_request', head_sha: repository.commit, tree: repository.tree, conclusion: 'success' }),
      rehearsalRunner: () => testRehearsalResult(),
    })).toThrow(/valid Git commit\/tree/u)
  })

  it('invokes the disposable no-network rehearsal seam', () => {
    let invocations = 0

    const adapter = { calls: 0 }
    prepareFixture(baseConfig(), {
      repositoryPath: repoRoot,
      productionWriteAdapter: adapter,
      rehearsalRunner: () => {
        invocations += 1
        return testRehearsalResult()
      },
    })

    expect(invocations).toBe(1)
    expect(adapter.calls).toBe(0)
  })

  it('rejects non-canonical rehearsal paths before executing a D1-aware run', () => {
    expect(() => runLocalRehearsal({
      repositoryPath: repoRoot,
      d1: {
        candidate_id: SHA40,
        config_path: 'wrangler.toml',
        reset_sql_path: 'db/schema.sql',
      },
      manifestDraftSha256: hash('a'),
    })).toThrow(/reset SQL path is not canonical/u)
  })

  it('writes only canonical manifest bytes through the formal CLI entry', { timeout: FORMAL_CLI_TEST_TIMEOUT_MS }, () => (
    withTemporaryDirectory('blogman-issue-23-prepare-', (directory) => {
      const configPath = join(directory, 'prepare-config.json')
      const fixtureRepo = join(directory, 'repo')
      execFileSync('git', ['clone', '--local', repoRoot, fixtureRepo])
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/nardinmarcus/blogman.git'], { cwd: fixtureRepo })
      const copiedPaths = [
        'scripts/issue-23-delivery-prepare.mjs',
        'scripts/issue-23-delivery-entry.mjs',
        'scripts/issue-23-delivery-rehearsal.mjs',
        'scripts/issue-23-delivery-d1-child.mjs',
        'scripts/issue-23-delivery-d1-contracts.mjs',
        'scripts/issue-23-delivery-d1-stages.mjs',
        'scripts/issue-23-delivery-d1-transport.mjs',
        'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
      ]
      for (const path of copiedPaths) copyFileSync(join(repoRoot, path), join(fixtureRepo, path))
      writeFileSync(join(fixtureRepo, 'fixture-marker.txt'), 'Issue #23 prepare fixture\n')
      symlinkSync(join(repoRoot, 'node_modules'), join(fixtureRepo, 'node_modules'))
      execFileSync('git', ['add', 'fixture-marker.txt', ...copiedPaths], { cwd: fixtureRepo })
      execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: fixtureRepo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } })
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
      const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
      const expectedConfig = baseConfig()
      expectedConfig.repository.commit = commit
      expectedConfig.repository.tree = tree
      expectedConfig.ci.head_sha = commit
      expectedConfig.ci.tree = tree
      const config = expectedConfig
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      const fakeBin = join(directory, 'bin')
      mkdirSync(fakeBin)
      const fakeGh = join(fakeBin, 'gh')
      const fakeNpx = join(fakeBin, 'npx')
      const runtimeShim = join(directory, 'formal-cli-macos.cjs')
      if (process.platform !== 'darwin') {
        writeFileSync(runtimeShim, "if (process.argv[1]?.endsWith('issue-23-delivery-prepare.mjs')) Object.defineProperty(process, 'platform', { value: 'darwin' })\n")
      }
      writeFileSync(fakeGh, '#!/bin/sh\nprintf \'[{"databaseId":1,"headSha":"%s","status":"completed","conclusion":"success","event":"pull_request","attempt":1}]\n\' "$BLOGMAN_TEST_HEAD"\n')
      chmodSync(fakeGh, 0o755)
      writeFileSync(fakeNpx, `#!/bin/sh
mkdir -p .open-next/assets .next/server
printf '%s\\n' 'fixture artifact: .open-next/assets/index.html' > .open-next/assets/index.html
printf '%s\\n' 'fixture worker: .open-next/worker.js' > .open-next/worker.js
printf '%s\\n' 'fixture runtime' > .open-next/runtime.js
printf '%s\\n' '{}' > .next/server/app-paths-manifest.json
printf '%s\\n' '{}' > .next/server/pages-manifest.json
printf '%s\\n' '{"version":3,"middleware":{},"functions":{},"sortedMiddleware":[]}' > .next/server/middleware-manifest.json
printf '%s\\n' '{"staticRoutes":[],"dynamicRoutes":[],"rewrites":{"beforeFiles":[],"afterFiles":[],"fallback":[]}}' > .next/routes-manifest.json
printf '%s\\n' '{"node":{},"edge":{},"encryptionKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}' > .next/server/server-reference-manifest.json
printf '%s\\n' 'self.__RSC_SERVER_MANIFEST="{\\"node\\":{},\\"edge\\":{},\\"encryptionKey\\":\\"process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY\\"}"' > .next/server/server-reference-manifest.js
`)
      chmodSync(fakeNpx, 0o755)

      const childEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BLOGMAN_TEST_HEAD: commit,
      }
      if (process.platform === 'darwin') {
        delete childEnv.NODE_OPTIONS
      } else {
        childEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require=${runtimeShim}`.trim()
      }
      const result = runBoundedChild(
        process.execPath,
        [join(fixtureRepo, 'scripts', 'issue-23-delivery-prepare.mjs'), '--config', configPath],
        { cwd: fixtureRepo, env: childEnv },
      )

      expect(result.error, JSON.stringify({ error: result.error?.message, signal: result.signal })).toBeUndefined()
      expect(result.status, result.stderr.toString('utf8')).toBe(0)
      expect(result.stderr.toString('utf8')).toBe('')
      const parsed = parseCanonicalManifest(result.stdout, sha256(result.stdout))
      expect(parsed.rehearsal).toMatchObject({
        runtime: { os: 'macos' },
        network: 'disabled',
        status: 'PASS',
        production_write_adapter_calls: 0,
        cleanup: { created: true, cleaned: true, observed_absent: true },
      })
      expect(parsed.d1.mode).toBe('remote')
      expect(parsed.d1.evidence_class).toBe('production')
    })
  ))

  it.runIf(process.platform === 'darwin')('[F1] binds repeatable real OpenNext 1.19.10 outputs on target macOS', { timeout: 8 * 60_000 }, () => {
    const realConfig = baseConfig()
    realConfig.artifact.file_tree.files[0].path = '.open-next/assets/BUILD_ID'
    const snapshotRoot = mkdtempSync(join('/tmp', 'blogman-s3w23-f1.'))
    const handlerPaths = [
      '.open-next/middleware/handler.mjs',
      '.open-next/server-functions/default/handler.mjs',
      '.open-next/server-functions/default/handler.mjs.meta.json',
    ]

    const captureRun = (run: number) => {
      rmSync(join(repoRoot, '.next'), { recursive: true, force: true })
      rmSync(join(repoRoot, '.open-next'), { recursive: true, force: true })
      const result = prepareFixture(realConfig, { buildRunner: undefined })
      const fileMap = buildFileMap(result)
      const jsBytes = Object.fromEntries(
        fileMap
          .filter(({ path }) => path.endsWith('.js') || path.endsWith('.mjs'))
          .map(({ path }) => [path, readFileSync(join(repoRoot, path))]),
      )
      const snapshot = {
        run,
        manifest: { bytes: result.bytes.byteLength, sha256: result.sha256 },
        artifact: result.value.artifact,
        handlerFiles: handlerPaths.map((path) => fileMap.find((file) => file.path === path)),
        fileMap,
      }
      writeFileSync(join(snapshotRoot, `run${run}.json`), `${JSON.stringify(snapshot, null, 2)}\n`)
      writeFileSync(join(snapshotRoot, `run${run}-file-map.json`), `${JSON.stringify(fileMap, null, 2)}\n`)
      return { result, fileMap, snapshot, jsBytes }
    }

    const first = captureRun(1)
    const second = captureRun(2)
    const diff = fileMapDiff(first.fileMap, second.fileMap)
    const firstChangedPath = diff.changed.find(({ path }) =>
      path.endsWith('.js') || path.endsWith('.mjs'),
    )?.path
    const firstChangedByte = firstChangedPath
      ? {
          path: firstChangedPath,
          detail: firstChangedByteContext(first.jsBytes[firstChangedPath], second.jsBytes[firstChangedPath]),
        }
      : null
    const report = {
      format: 'blogman-s3w23-f1/v1',
      snapshotRoot,
      runs: [first.snapshot, second.snapshot],
      diff,
      equalityAssertionsPerformed: false,
    }
    writeFileSync(join(snapshotRoot, 'diff-manifest.json'), `${JSON.stringify(diff, null, 2)}\n`)
    writeFileSync(join(snapshotRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

    expect(diff, JSON.stringify({ diff, firstChangedByte })).toEqual({
      added: [],
      removed: [],
      changed: [],
    })
    expect(first.fileMap).toEqual(second.fileMap)
    expect(first.result.bytes).toEqual(second.result.bytes)
    expect(first.result.sha256).toBe(second.result.sha256)
    expect(first.snapshot.handlerFiles).toEqual(second.snapshot.handlerFiles)
  })

  it('F1 reports first changed byte context for bounded synthetic buffers', () => {
    const before = Buffer.from('0123456789abcdefghij')
    const after = Buffer.from('0123456789ABcdefghij')

    expect(firstChangedByteContext(before, after)).toEqual({
      offset: 10,
      before: { start: 2, end: 18, hex: '32333435363738396162636465666768' },
      after: { start: 2, end: 18, hex: '32333435363738394142636465666768' },
    })
  })

  it('cleans temporary projections after a bounded child timeout', () => {
    let directory = ''
    withTemporaryDirectory('blogman-issue-23-timeout-', (root) => {
      directory = root
      const target = join(root, 'node-modules-target')
      writeFileSync(target, 'projection\n')
      symlinkSync(target, join(root, 'node_modules'))
      const result = runBoundedChild(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 60_000)'],
        { cwd: root, env: { ...process.env } },
        50,
      )

      expect(result.error?.code).toBe('ETIMEDOUT')
      expect(result.signal).toBe('SIGTERM')
    })
    expect(existsSync(directory)).toBe(false)
  })

  it('reports the formal command timeout instead of a generic apply failure', () => {
    const runnerPath = 'tests/scripts/.issue-23-timeout-runner.mjs'
    writeFileSync(join(repoRoot, runnerPath), `
      const command = process.argv[2]
      if (command === 'catalog') {
        process.stdout.write(JSON.stringify({ migrations: [1, 2, 3, 4, 5, 6].map((number) => ({ number })) }))
      } else if (command === 'apply') {
        setInterval(() => {}, 1_000)
      } else {
        process.stdout.write(JSON.stringify({ state: 'current' }))
      }
    `)

    try {
      expect(() => runLocalRehearsalForTestsOnly({
        repositoryPath: repoRoot,
        runnerPath,
        manifestDraftSha256: hash('a'),
        childTimeoutMs: 100,
      })).toThrow(/timed out/u)
    } finally {
      rmSync(join(repoRoot, runnerPath), { force: true })
    }
  })

  it('fails closed when one supervisor output stream exceeds its independent bound', () => {
    const runnerPath = 'tests/scripts/.issue-23-output-runner.mjs'
    writeFileSync(join(repoRoot, runnerPath), `
      const command = process.argv[2]
      if (command === 'catalog') {
        process.stdout.write(JSON.stringify({ migrations: [1, 2, 3, 4, 5, 6].map((number) => ({ number })), padding: 'x'.repeat(4096) }))
      } else if (command === 'apply') {
        process.stdout.write(JSON.stringify({ state: 'current' }))
      } else {
        process.stdout.write(JSON.stringify({ state: 'current' }))
      }
    `)

    try {
      expect(() => runLocalRehearsalForTestsOnly({
        repositoryPath: repoRoot,
        runnerPath,
        manifestDraftSha256: hash('a'),
        maxOutputBytes: 1024,
      })).toThrow(/output exceeded/u)
    } finally {
      rmSync(join(repoRoot, runnerPath), { force: true })
    }
  })

  it('rejects a command that leaves a descendant able to recreate disposable state', () => {
    const runnerPath = 'tests/scripts/.issue-23-recreate-runner.mjs'
    const stateCapturePath = join(mkdtempSync(join(tmpdir(), 'blogman-issue-88-recreate-capture-')), 'state-path')
    writeFileSync(join(repoRoot, runnerPath), `
      import { spawn } from 'node:child_process'
      import { join } from 'node:path'
      import { writeFileSync } from 'node:fs'
      const command = process.argv[2]
      if (command === 'catalog') {
        process.stdout.write(JSON.stringify({ migrations: [1, 2, 3, 4, 5, 6].map((number) => ({ number })) }))
      } else if (command === 'apply') {
        const persistIndex = process.argv.indexOf('--persist-to')
        const statePath = process.argv[persistIndex + 1]
        writeFileSync(process.env.BLOGMAN_ISSUE_88_STATE_CAPTURE, statePath)
        const child = spawn(process.execPath, ['-e', ${JSON.stringify("import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; setTimeout(() => { mkdirSync(process.argv[1], { recursive: true }); writeFileSync(join(process.argv[1], 'escaped'), 'recreated') }, 50)" )}, statePath], { stdio: 'ignore' })
        child.unref()
        process.stdout.write(JSON.stringify({ state: 'current' }))
      } else {
        process.stdout.write(JSON.stringify({ state: 'current' }))
      }
    `)

    try {
      expect(() => runLocalRehearsalForTestsOnly({
        repositoryPath: repoRoot,
        runnerPath,
        manifestDraftSha256: hash('a'),
        environment: { BLOGMAN_ISSUE_88_STATE_CAPTURE: stateCapturePath },
      })).toThrow(/residual process group/u)

      const statePath = readFileSync(stateCapturePath, 'utf8')
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { stdio: 'ignore' })
      expect(existsSync(join(statePath, 'escaped'))).toBe(false)
    } finally {
      const capturedStatePath = existsSync(stateCapturePath) ? readFileSync(stateCapturePath, 'utf8') : ''
      rmSync(join(repoRoot, runnerPath), { force: true })
      rmSync(dirname(stateCapturePath), { recursive: true, force: true })
      if (capturedStatePath) rmSync(capturedStatePath, { recursive: true, force: true })
    }
  })

  it('cleans a descendant on rehearsal timeout and blocks its network attempt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-88-descendant-'))
    const runnerPath = 'tests/scripts/.issue-23-descendant-runner.mjs'
    const probeBase = join(directory, 'probe')
    const runner = `
      import { spawn } from 'node:child_process'
      import { writeFileSync } from 'node:fs'
      const command = process.argv[2]
      if (command === 'catalog') {
        process.stdout.write(JSON.stringify({ migrations: [1, 2, 3, 4, 5, 6].map((number) => ({ number })) }))
      } else if (command === 'apply') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        writeFileSync(process.env.BLOGMAN_ISSUE_88_PROBE_PID, String(child.pid))
        try {
          await fetch('https://example.com')
        } catch {
          writeFileSync(process.env.BLOGMAN_ISSUE_88_PROBE_NETWORK, 'blocked')
        }
        process.kill(process.ppid, 'SIGTERM')
        setTimeout(() => {}, 60_000)
      } else {
        process.stdout.write(JSON.stringify({ state: 'current' }))
      }
    `
    writeFileSync(join(repoRoot, runnerPath), runner)
    const adapter = { calls: 0 }

    try {
      expect(() => runLocalRehearsalForTestsOnly({
        repositoryPath: repoRoot,
        runnerPath,
        manifestDraftSha256: hash('a'),
        productionWriteAdapter: adapter,
        environment: {
          BLOGMAN_ISSUE_88_PROBE_PID: `${probeBase}.pid`,
          BLOGMAN_ISSUE_88_PROBE_NETWORK: `${probeBase}.network`,
        },
      })).toThrow()

      const descendantPid = Number(readFileSync(`${probeBase}.pid`, 'utf8'))
      let descendantExists = true
      try {
        process.kill(descendantPid, 0)
      } catch {
        descendantExists = false
      }
      expect(descendantExists).toBe(false)
      expect(readFileSync(`${probeBase}.network`, 'utf8')).toBe('blocked')
      expect(adapter.calls).toBe(0)
    } finally {
      rmSync(join(repoRoot, runnerPath), { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('derives the canonical production D1 block after rehearsal without accepting caller injection', () => {
    const expectedReconciliation = structuredClone(CANONICAL_EXPECTED_RECONCILIATION)
    const result = prepareFixture(baseConfig(), {
      rehearsalRunner: () => testRehearsalResult({
        expected_reconciliation: {
          value: expectedReconciliation,
          sha256: CANONICAL_EXPECTED_RECONCILIATION_SHA256,
        },
      }),
    })

    expect(result.value.d1).toMatchObject({
      mode: 'local',
      database: 'DB',
      config_path: 'wrangler.toml',
      account_id: result.value.target.account_id,
      d1_database_id: result.value.target.d1_database_id,
      reset_sql_path: 'db/issue-23-clean-start-reset.sql',
      migration_runner_path: 'scripts/migrations.mjs',
      migration_catalog_path: 'db/ledger-migrations',
      rollout_safety_path: 'scripts/rollout-safety.mjs',
      expected_reconciliation_format: expectedReconciliation.format,
      candidate_id: result.value.repository.commit,
      evidence_class: 'test-non-production',
      migrations: expect.arrayContaining([
        expect.objectContaining({ number: 1, name: '001_initial_schema' }),
        expect.objectContaining({ number: 6, name: '006_add_rollout_safety_controls' }),
      ]),
    })
    expect(result.value.d1.expected_reconciliation_sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.value.d1.expected_reconciliation).toEqual(expectedReconciliation)

    const injected = baseConfig()
    Reflect.set(injected, 'd1', { mode: 'local' })
    expect(() => prepareFixture(injected)).toThrow(/not allowed/u)
  })
})
