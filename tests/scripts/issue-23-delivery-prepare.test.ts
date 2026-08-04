import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_MANIFEST_FORMAT,
  DEFAULT_STAGE_POLICY,
  parseCanonicalManifest,
  prepare,
} from '../../scripts/issue-23-delivery-prepare.mjs'
import { runLocalRehearsal } from '../../scripts/issue-23-delivery-rehearsal.mjs'

const SHA40 = 'a'.repeat(40)
const SHA40_B = 'b'.repeat(40)
const FORMAL_CLI_CHILD_TIMEOUT_MS = 240_000
const FORMAL_CLI_TEST_TIMEOUT_MS = FORMAL_CLI_CHILD_TIMEOUT_MS + 60_000

function hash(character: string) {
  return character.repeat(64)
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
        path: 'db/schema.sql',
        sha256: hash('f'),
      },
      runner: { path: 'scripts/migrations.mjs', sha256: hash('e') },
      catalog: {
        path: 'db/ledger-migrations',
        sha256: hash('a'),
        migrations: [
          { id: '001', path: 'db/ledger-migrations/001_initial_schema.sql', sha256: hash('b') },
        { id: '002', path: 'db/ledger-migrations/002_add_ai_image_configuration.sql', sha256: hash('c') },
          { id: '003', path: 'db/ledger-migrations/003_migrate_runtime_ai_configuration.sql', sha256: hash('d') },
          { id: '004', path: 'db/ledger-migrations/004_complete_historical_text_ai_schema.sql', sha256: hash('e') },
          { id: '005', path: 'db/ledger-migrations/005_fix_posts_fts_sync.sql', sha256: hash('f') },
          { id: '006', path: 'db/ledger-migrations/006_add_rollout_safety_controls.sql', sha256: hash('a') },
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
  return prepare(fixture, {
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
    rehearsalRunner: () => ({
      runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: hash('a'),
      production_write_adapter_calls: 0,
    }),
    buildRunner: fixtureBuild,
    ...options,
  })
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('Issue #23 Delivery Preparation', () => {
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
      'target',
      'policy',
      'rehearsal',
    ])
    expect(text).toMatch(/^\{\n  "format": "blogman-issue-23-canonical-frozen-manifest\/v1",\n/u)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('PRIVATE')
    expect(text).not.toContain('DROP TABLE')
    expect(parseCanonicalManifest(result.bytes, result.sha256)).toEqual(result.value)
  })

  it('returns an isolated bytes copy so mutation cannot diverge from its identity', () => {
    const result = prepareFixture(baseConfig())
    const originalBytes = Buffer.from(result.bytes)
    const mutableAccess = result.bytes
    mutableAccess[0] ^= 1

    expect(result.bytes).toEqual(originalBytes)
    expect(result.sha256).toBe(sha256(originalBytes))
    expect(parseCanonicalManifest(result.bytes, result.sha256)).toEqual(result.value)
  })

  it('binds the configured migration runner to catalog and rehearsal', () => {
    const runnerPath = 'tests/scripts/.issue-23-configured-runner.mjs'
    const catalog = {
      source: 'configured-runner',
      migrations: [1, 2, 3, 4, 5, 6].map((number) => ({ number })),
    }
    writeFileSync(join(repoRoot, runnerPath), `process.stdout.write(${JSON.stringify(JSON.stringify(catalog))})\n`)

    try {
      const config = baseConfig()
      config.migration.runner.path = runnerPath
      let rehearsalRunnerPath = ''
      const result = prepareFixture(config, {
        rehearsalRunner: ({ migrationRunnerPath }: { migrationRunnerPath: string }) => {
          rehearsalRunnerPath = migrationRunnerPath
          return {
            runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
            network: 'disabled',
            status: 'PASS',
            receipt_sha256: hash('a'),
            production_write_adapter_calls: 0,
          }
        },
      })

      expect(result.value.migration.catalog.sha256).toBe(sha256(Buffer.from(JSON.stringify(catalog))))
      expect(rehearsalRunnerPath).toBe(runnerPath)
    } finally {
      rmSync(join(repoRoot, runnerPath), { force: true })
    }
  })

  it('enumerates the complete public artifact tree independently of caller-listed files', () => {
    const result = prepareFixture(baseConfig())
    const paths = result.value.artifact.file_tree.files.map((file) => file.path)

    expect(result.value.artifact.file_tree.complete).toBe(true)
    expect(paths.length).toBeGreaterThan(baseConfig().artifact.file_tree.files.length)
    expect(paths).toContain('.open-next/assets/index.html')
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

  it('is repeatable and changes identity for meaningful input changes', () => {
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
    const receiptRunner = ({ manifestDraftSha256 }: { manifestDraftSha256: string }) => ({
      runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: manifestDraftSha256,
      production_write_adapter_calls: 0,
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

  it('does not trust caller-supplied repository facts', () => {
    const forged = baseConfig()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()

    expect(() => prepare(forged, {
      repositoryPath: repoRoot,
      repositoryResolver: () => ({ commit, tree, clean: true }),
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

    expect(result.value.toolchain.npm.version).toBe(npmVersion)
    expect(result.value.toolchain.npm.version).not.toBe(process.versions.node)
    expect(result.value.toolchain.opennextjs_cloudflare.version)
      .toBe(lockfile.packages['node_modules/@opennextjs/cloudflare'].version)
  })

  it('rejects a dirty production repository even when identities match', () => {
    const dirty = baseConfig()
    dirty.repository.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    dirty.repository.tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    dirty.ci.head_sha = dirty.repository.commit
    dirty.ci.tree = dirty.repository.tree

    expect(() => prepare(dirty, {
      repositoryPath: repoRoot,
      repositoryResolver: () => ({ commit: dirty.repository.commit, tree: dirty.repository.tree, clean: false }),
      ciResolver: (_path, source, repository) => ({ ...source.ci, run_id: 1, attempt: 1, event: 'pull_request', head_sha: repository.commit, tree: repository.tree, conclusion: 'success' }),
      rehearsalRunner: () => ({ runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node }, network: 'disabled', status: 'PASS', receipt_sha256: hash('a'), production_write_adapter_calls: 0 }),
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
        return {
          runtime: { os: 'macos', architecture: 'arm64', node_version: process.versions.node },
          network: 'disabled',
          status: 'PASS',
          receipt_sha256: hash('a'),
          production_write_adapter_calls: 0,
        }
      },
    })

    expect(invocations).toBe(1)
    expect(adapter.calls).toBe(0)
  })

  it('writes only canonical manifest bytes through the formal CLI entry', { timeout: FORMAL_CLI_TEST_TIMEOUT_MS }, () => (
    withTemporaryDirectory('blogman-issue-23-prepare-', (directory) => {
      const configPath = join(directory, 'prepare-config.json')
      const fixtureRepo = join(directory, 'repo')
      execFileSync('git', ['clone', '--local', repoRoot, fixtureRepo])
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/nardinmarcus/blogman.git'], { cwd: fixtureRepo })
      copyFileSync(join(repoRoot, 'scripts', 'issue-23-delivery-prepare.mjs'), join(fixtureRepo, 'scripts', 'issue-23-delivery-prepare.mjs'))
      copyFileSync(join(repoRoot, 'scripts', 'issue-23-delivery-entry.mjs'), join(fixtureRepo, 'scripts', 'issue-23-delivery-entry.mjs'))
      copyFileSync(join(repoRoot, 'scripts', 'issue-23-delivery-rehearsal.mjs'), join(fixtureRepo, 'scripts', 'issue-23-delivery-rehearsal.mjs'))
      writeFileSync(join(fixtureRepo, 'fixture-marker.txt'), 'Issue #23 prepare fixture\n')
      symlinkSync(join(repoRoot, 'node_modules'), join(fixtureRepo, 'node_modules'))
      execFileSync('git', ['add', 'fixture-marker.txt', 'scripts/issue-23-delivery-prepare.mjs', 'scripts/issue-23-delivery-entry.mjs', 'scripts/issue-23-delivery-rehearsal.mjs'], { cwd: fixtureRepo })
      execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: fixtureRepo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } })
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
      const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
      const expectedConfig = baseConfig()
      expectedConfig.repository.commit = commit
      expectedConfig.repository.tree = tree
      expectedConfig.ci.head_sha = commit
      expectedConfig.ci.tree = tree
      const expected = withTargetMacosRuntime(() => prepare(expectedConfig, {
        repositoryPath: fixtureRepo,
        ciResolver: (_path, source, repository) => ({ ...source.ci, run_id: 1, attempt: 1, event: 'pull_request', head_sha: repository.commit, tree: repository.tree, conclusion: 'success' }),
        buildRunner: fixtureBuild,
      }))
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
      writeFileSync(fakeNpx, '#!/bin/sh\nmkdir -p .open-next/assets\nprintf \'%s\\n\' \'fixture artifact: .open-next/assets/index.html\' > .open-next/assets/index.html\nprintf \'%s\\n\' \'fixture worker: .open-next/worker.js\' > .open-next/worker.js\nprintf \'%s\\n\' \'fixture runtime\' > .open-next/runtime.js\n')
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
      expect(JSON.parse(result.stdout.toString('utf8')).rehearsal).toMatchObject({
        runtime: { os: 'macos' },
        network: 'disabled',
        status: 'PASS',
        production_write_adapter_calls: 0,
      })
      expect(result.stdout, JSON.stringify({ status: result.status, stdoutLength: result.stdout.length, stderr: result.stderr.toString('utf8') })).toEqual(expected.bytes)
    })
  ))

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
        setTimeout(() => {}, 60_000)
      } else {
        process.stdout.write(JSON.stringify({ state: 'current' }))
      }
    `
    writeFileSync(join(repoRoot, runnerPath), runner)
    const adapter = { calls: 0 }

    try {
      expect(() => runLocalRehearsal({
        repositoryPath: repoRoot,
        runnerPath,
        manifestDraftSha256: hash('a'),
        productionWriteAdapter: adapter,
        childTimeoutMs: 100,
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
})
