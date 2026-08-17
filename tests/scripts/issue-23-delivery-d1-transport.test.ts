import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  D1TransportError,
  D1_TRANSPORT_MAX_OUTPUT_BYTES,
  createLocalD1Transport,
  hashD1ArtifactDirectory as transportHashD1ArtifactDirectory,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'
import {
  d1StageBindingsSha256,
  hashD1ArtifactDirectory as contractHashD1ArtifactDirectory,
  identityDurationMs,
  parseRemoteD1InfoResponse,
  parseStrictJson,
  parseWranglerWhoamiResponse,
} from '../../scripts/issue-23-delivery-d1-contracts.mjs'
import {
  D1ChildError,
  runBoundedChild,
} from '../../scripts/issue-23-delivery-d1-child.mjs'
import { D1_STAGE_TIMEOUT_MS } from '../../scripts/issue-23-delivery-d1-stages.mjs'

const repoRoot = process.cwd()
const configPath = join(repoRoot, 'wrangler.toml')
const resetSqlPath = join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')
const catalogPath = join(repoRoot, 'db', 'ledger-migrations')
const temporaryDirectories: string[] = []
const MIGRATIONS = [
  { number: 1, name: '001_initial_schema', checksum: '8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05' },
  { number: 2, name: '002_add_ai_image_configuration', checksum: '8b4ad57e43a9f0dfcad5908c22b8f2965fa17771154db6d69f40168b8da30c49' },
  { number: 3, name: '003_migrate_runtime_ai_configuration', checksum: '719883025ac3013b0e435101b5ebd98ad358349b81f32935d7add646146d1bff' },
  { number: 4, name: '004_complete_historical_text_ai_schema', checksum: '12afd5f8171987b638692a564335165018d198ff8c7e5a706b0738c024c3d2fc' },
  { number: 5, name: '005_fix_posts_fts_sync', checksum: 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441' },
  { number: 6, name: '006_add_rollout_safety_controls', checksum: '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551' },
]

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashDirectory(path: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (statSync(child).isDirectory()) visit(child, relativePath)
      else hash.update(`${relativePath}\0${statSync(child).size}\0`).update(readFileSync(child)).update('\0')
    }
  }
  visit(path, '')
  return hash.digest('hex')
}

function request(operation: string, stage = operation, elapsedMs = 0, overallElapsedMs = 0) {
  return {
    operation,
    stage,
    timeout_ms: D1_STAGE_TIMEOUT_MS[stage as keyof typeof D1_STAGE_TIMEOUT_MS],
    elapsed_ms: elapsedMs,
    overall_elapsed_ms: overallElapsedMs,
  }
}

function createConfig(overrides: Record<string, unknown> = {}, repositoryRoot = repoRoot) {
  const repositoryConfigPath = join(repositoryRoot, 'wrangler.toml')
  const repositoryResetSqlPath = join(repositoryRoot, 'db', 'issue-23-clean-start-reset.sql')
  const repositoryRunnerPath = join(repositoryRoot, 'scripts', 'migrations.mjs')
  const repositoryCatalogPath = join(repositoryRoot, 'db', 'ledger-migrations')
  const repositoryRolloutSafetyPath = join(repositoryRoot, 'scripts', 'rollout-safety.mjs')
  const statePath = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-transport-')))
  temporaryDirectories.push(statePath)
  const expectedPath = join(statePath, 'expected-reconciliation.json')
  writeFileSync(expectedPath, `${JSON.stringify({
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: 'a'.repeat(64) },
    migration_ledger: { state: 'present', row_count: 6, sha256: 'b'.repeat(64) },
    posts: { count: 0, status: {}, content_sha256: 'c'.repeat(64) },
  })}\n`, { mode: 0o600 })
  const config = {
    mode: 'local',
    persist_path: statePath,
    database: 'DB',
    config_path: repositoryConfigPath,
    config_sha256: sha256File(repositoryConfigPath),
    wrangler_sha256: sha256File(realpathSync(join(repositoryRoot, 'node_modules', '.bin', 'wrangler'))),
    account_id: 'local-account-not-production',
    d1_database_id: 'local-d1-not-production',
    reset_sql_path: repositoryResetSqlPath,
    reset_sql_sha256: sha256File(repositoryResetSqlPath),
    migration_runner_path: repositoryRunnerPath,
    migration_runner_sha256: sha256File(repositoryRunnerPath),
    migration_catalog_path: repositoryCatalogPath,
    migration_catalog_sha256: hashDirectory(repositoryCatalogPath),
    rollout_safety_path: repositoryRolloutSafetyPath,
    rollout_safety_sha256: sha256File(repositoryRolloutSafetyPath),
    expected_reconciliation_path: expectedPath,
    expected_reconciliation_sha256: sha256File(expectedPath),
    manifest_sha256: '1'.repeat(64),
    authorization_sha256: '2'.repeat(64),
    attempt_id: '3'.repeat(64),
    candidate_id: 'c'.repeat(40),
    evidence_class: 'test-non-production',
    migrations: MIGRATIONS,
    ...overrides,
  }
  return { config, statePath, expectedPath }
}

function createTransportWorkspace() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-transport-workspace-')))
  temporaryDirectories.push(directory)
  const repository = join(directory, 'repository')
  execFileSync('git', ['clone', '--quiet', '--shared', repoRoot, repository])
  cpSync(join(repoRoot, 'scripts'), join(repository, 'scripts'), { recursive: true, force: true })
  symlinkSync(join(repoRoot, 'node_modules'), join(repository, 'node_modules'), 'dir')
  return repository
}

async function workspaceTransportModule(repository: string) {
  return import(pathToFileURL(join(repository, 'scripts', 'issue-23-delivery-d1-transport.mjs')).href)
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Issue #90 D1 transport', () => {
  it('uses one exact actual-NUL catalog tree framing across D1 contracts and transport', () => {
    const expected = '4713f17de5d32b512ab7d5611474a9605576b3f612fd056b355759e96270e32c'

    expect(contractHashD1ArtifactDirectory(catalogPath)).toBe(expected)
    expect(transportHashD1ArtifactDirectory(catalogPath)).toBe(expected)
    expect(d1StageBindingsSha256({
      ...createConfig().config,
      migration_catalog_sha256: expected,
    })).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects every remote transport config at the public local-only boundary', () => {
    const { config } = createConfig({
      mode: 'remote',
      evidence_class: 'test-non-production',
    })
    const remoteConfig = { ...config }
    Reflect.deleteProperty(remoteConfig, 'persist_path')

    expect(() => createLocalD1Transport(remoteConfig)).toThrow('local transport requires structurally nonproduction local evidence')
  })

  it('exposes only a binding digest and no caller-readable provenance brand', () => {
    const { config } = createConfig()
    const transport = createLocalD1Transport(config)

    expect(transport).not.toHaveProperty('evidence')
    expect(transport.bindings_sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('exposes the internal execute contract and dispatches a bounded local D1 query', () => {
    const { config } = createConfig()
    const transport = createLocalD1Transport(config)

    expect(Object.keys(transport)).toEqual(['execute', 'bindings_sha256'])
    const result = transport.execute(request('empty_d1_proof'))

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.duration_ms).toBeGreaterThan(0)
    expect(JSON.parse(result.stdout)).toEqual([{ results: [], success: true, meta: { duration: expect.any(Number) } }])
  })

  it('keeps command construction private while exposing only the bounded execute seam', { timeout: 30_000 }, async () => {
    const { config } = createConfig()
    const transport = createLocalD1Transport(config)
    const transportModule = await import('../../scripts/issue-23-delivery-d1-transport.mjs')

    expect(transportModule).not.toHaveProperty('buildD1Command')
    expect(transportModule).not.toHaveProperty('registerD1TransportCapability')
    expect(Object.keys(transport)).toEqual(['execute', 'bindings_sha256'])
    expect(transport.execute(request('empty_d1_proof')).status).toBe(0)
  })

  it('keeps the request contract to five keys and rejects extras', () => {
    const { config } = createConfig()
    const transport = createLocalD1Transport(config)

    expect(Object.keys(request('empty_d1_proof'))).toEqual([
      'operation',
      'stage',
      'timeout_ms',
      'elapsed_ms',
      'overall_elapsed_ms',
    ])
    expect(() => transport.execute({ ...request('empty_d1_proof'), extra: true }))
      .toThrow(/unsupported fields/u)
  })

  it('recomputes actual Stage and overall deadlines after local validation before child dispatch', () => {
    const { config } = createConfig()
    const environment = Object.assign(Object.create(null), process.env)

    const stageExpired = createLocalD1Transport(config, environment, () => D1_STAGE_TIMEOUT_MS.migrations_001_006)
    expect(() => stageExpired.execute(request('migration_catalog', 'migrations_001_006')))
      .toThrowError(expect.objectContaining({ classification: 'timeout' }))

    const overallExpired = createLocalD1Transport(config, environment, () => 5_400_000)
    expect(() => overallExpired.execute(request('d1_identity')))
      .toThrowError(expect.objectContaining({ classification: 'overall_timeout' }))
  })

  it('dispatches migration operations through the canonical runner instead of accepting SQL or file overrides', () => {
    const { config } = createConfig()
    const transport = createLocalD1Transport(config)

    const catalog = transport.execute(request('migration_catalog', 'migrations_001_006'))
    const catalogValue = JSON.parse(catalog.stdout)
    expect(catalogValue).toMatchObject({ format: 'blogman-migration-catalog/v1' })
    expect(catalogValue.migrations[0]).toMatchObject({
      number: 1,
      name: '001_initial_schema',
    })
    expect(catalog.stderr).toBe('')

    expect(() => transport.execute({
      ...request('query'),
      sql: 'DROP TABLE secrets',
    })).toThrow(/unsupported|operation/u)
    expect(() => transport.execute({
      ...request('migration_apply', 'migrations_001_006'),
      migration_runner_path: '/tmp/alternate-runner.mjs',
    })).toThrow(/unsupported|operation/u)
  })

  it('rejects caller dependency injection and overrides', () => {
    const { config } = createConfig()

    expect(() => createLocalD1Transport(config, { runChild: () => ({}) })).toThrow(/exactly one|unsupported/u)
    expect(() => createLocalD1Transport({ ...config, command: '/tmp/evil' })).toThrow(/unsupported/u)
    expect(() => createLocalD1Transport({ ...config, timeout_ms: 1 })).toThrow(/unsupported/u)
  })

  it('rejects duplicate keys in the bound expected reconciliation contract before spawning a child', () => {
    const { config, expectedPath } = createConfig()
    const duplicate = '{"format":"blogman-d1-reconciliation/v1","\\u0066ormat":"forged"}'
    writeFileSync(expectedPath, duplicate, { mode: 0o600 })

    expect(() => createLocalD1Transport({
      ...config,
      expected_reconciliation_sha256: sha256File(expectedPath),
    })).toThrow('D1 transport malformed')
  })

  it('fails closed on a bound config mutation before spawning a child', () => {
    const temporaryConfig = join(
      realpathSync(temporaryDirectories[0] ?? realpathSync(mkdtempSync(join(tmpdir(), 'blogman-config-')))),
      'bound-wrangler.toml',
    )
    if (!temporaryDirectories.includes(temporaryConfig)) temporaryDirectories.push(temporaryConfig)
    writeFileSync(temporaryConfig, readFileSync(configPath), { mode: 0o600 })
    const originalHash = sha256File(temporaryConfig)
    const { config } = createConfig({ config_path: temporaryConfig, config_sha256: originalHash })
    const transport = createLocalD1Transport(config)
    writeFileSync(temporaryConfig, `${readFileSync(temporaryConfig)}\n`)

    expect(() => transport.execute(request('d1_identity'))).toThrow('D1 transport manifest_drift')
  })

  it('classifies bounded child output overflow without returning raw bytes', () => {
    const { config } = createConfig()
    const oversizedPath = join(config.persist_path, 'oversized-expected.json')
    writeFileSync(oversizedPath, 'x'.repeat(D1_TRANSPORT_MAX_OUTPUT_BYTES + 1), { mode: 0o600 })
    const mutated = {
      ...config,
      expected_reconciliation_path: oversizedPath,
      expected_reconciliation_sha256: sha256File(oversizedPath),
    }

    expect(() => createLocalD1Transport(mutated)).toThrow('D1 transport malformed')
    try {
      createLocalD1Transport(mutated)
    } catch (error) {
      expect(String(error)).not.toContain('x'.repeat(100))
      expect(error).toBeInstanceOf(D1TransportError)
    }
  })

  it('rejects a symlinked canonical reset artifact before any operation can spawn', () => {
    const { config } = createConfig()
    const symlinkPath = join(config.persist_path, 'reset.sql')
    symlinkSync(resetSqlPath, symlinkPath)

    expect(() => createLocalD1Transport({
      ...config,
      reset_sql_path: symlinkPath,
      reset_sql_sha256: sha256File(resetSqlPath),
    })).toThrow('D1 transport malformed')
  })

  it('rejects unsafe bound artifact permissions before any operation can spawn', () => {
    const temporaryConfig = join(realpathSync(temporaryDirectories[0] ?? mkdtempSync(join(tmpdir(), 'blogman-config-'))), 'unsafe-wrangler.toml')
    writeFileSync(temporaryConfig, readFileSync(configPath), { mode: 0o600 })
    chmodSync(temporaryConfig, 0o666)
    const { config } = createConfig({
      config_path: temporaryConfig,
      config_sha256: sha256File(temporaryConfig),
    })

    expect(() => createLocalD1Transport(config)).toThrow('D1 transport malformed')
  })

  it('requires a local persist directory to be private and outside the repository', () => {
    const { config, statePath } = createConfig()
    chmodSync(statePath, 0o755)
    expect(() => createLocalD1Transport(config)).toThrow('D1 transport malformed')
    chmodSync(statePath, 0o700)

    expect(() => createLocalD1Transport({ ...config, persist_path: repoRoot })).toThrow('D1 transport malformed')
  })

  it('binds the local persist directory identity for the full transport lifecycle', () => {
    const { config, statePath } = createConfig()
    const transport = createLocalD1Transport(config)
    const movedPath = `${statePath}.moved`
    renameSync(statePath, movedPath)
    mkdirSync(statePath, { mode: 0o700 })
    temporaryDirectories.push(movedPath)

    expect(() => transport.execute(request('empty_d1_proof'))).toThrow('D1 transport manifest_drift')
  })

  it.each([
    ['config', 'wrangler.toml'],
    ['reset SQL', 'db/issue-23-clean-start-reset.sql'],
    ['migration runner', 'scripts/migrations.mjs'],
    ['rollout safety', 'scripts/rollout-safety.mjs'],
  ])('maps post-construction %s content drift to Manifest Drift before the next child spawn', async (_label, relativePath) => {
    const repository = createTransportWorkspace()
    const transportModule = await workspaceTransportModule(repository)
    const { config } = createConfig({}, repository)
    const transport = transportModule.createLocalD1Transport(config)
    writeFileSync(join(repository, relativePath), Buffer.concat([
      readFileSync(join(repository, relativePath)),
      Buffer.from('\n'),
    ]))

    expect(() => transport.execute(request('d1_identity'))).toThrowError(expect.objectContaining({
      classification: transportModule.D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT,
    }))
  })

  it('maps post-construction migration catalog drift to Manifest Drift before the next child spawn', async () => {
    const repository = createTransportWorkspace()
    const transportModule = await workspaceTransportModule(repository)
    const { config } = createConfig({}, repository)
    const transport = transportModule.createLocalD1Transport(config)
    writeFileSync(join(repository, 'db/ledger-migrations/999_issue_90_mutation.sql'), '-- mutation\n', { mode: 0o600 })

    expect(() => transport.execute(request('d1_identity'))).toThrowError(expect.objectContaining({
      classification: transportModule.D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT,
    }))
  })

  it('maps same-byte post-construction bound artifact identity replacement to Manifest Drift', async () => {
    const repository = createTransportWorkspace()
    const transportModule = await workspaceTransportModule(repository)
    const { config } = createConfig({}, repository)
    const transport = transportModule.createLocalD1Transport(config)
    const path = join(repository, 'wrangler.toml')
    const bytes = readFileSync(path)
    rmSync(path)
    writeFileSync(path, bytes, { mode: 0o644 })

    expect(() => transport.execute(request('d1_identity'))).toThrowError(expect.objectContaining({
      classification: transportModule.D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT,
    }))
  })

  it('isolates D1 artifact drift between concurrent test-owned repository fixtures', async () => {
    const firstRepository = createTransportWorkspace()
    const secondRepository = createTransportWorkspace()
    const [firstModule, secondModule] = await Promise.all([
      workspaceTransportModule(firstRepository),
      workspaceTransportModule(secondRepository),
    ])
    const first = firstModule.createLocalD1Transport(createConfig({}, firstRepository).config)
    const second = secondModule.createLocalD1Transport(createConfig({}, secondRepository).config)
    writeFileSync(join(firstRepository, 'wrangler.toml'), `${readFileSync(join(firstRepository, 'wrangler.toml'))}\n`)

    expect(() => first.execute(request('d1_identity'))).toThrowError(expect.objectContaining({
      classification: firstModule.D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT,
    }))
    expect(second.execute(request('d1_identity')).status).toBe(0)
  }, 30_000)

  it('accepts the pinned Wrangler 4.86.0 D1 info fixture with write_queries_24h', () => {
    const info = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-d1-info.json'),
      'utf8',
    )

    expect(parseRemoteD1InfoResponse(info, '11111111-2222-4333-8444-555555555555')).toMatchObject({
      read_queries_24h: 12,
      write_queries_24h: 7,
    })
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"uuid": "11111111-2222-4333-8444-555555555555"', '"uuid": "22222222-3333-4444-8555-666666666666"'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_DATABASE_MISMATCH' }))
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"uuid": "11111111-2222-4333-8444-555555555555"', '"uuid": "11111111-2222-4333-8444-555555555555", "\\u0075uid": "forged"'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrowError(expect.not.objectContaining({ code: 'DELIVERY_DATABASE_MISMATCH' }))
  })

  it('accepts only the pinned Wrangler alpha D1 info variant', () => {
    const info = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-d1-info-alpha.json'),
      'utf8',
    )

    expect(parseRemoteD1InfoResponse(info, '11111111-2222-4333-8444-555555555555')).toMatchObject({
      version: 'alpha',
    })
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"version": "alpha"', '"version": "beta"'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrow()
  })

  it('accepts the live jurisdiction-bearing Wrangler D1 info variant (issue #141)', () => {
    const info = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-d1-info-jurisdiction.json'),
      'utf8',
    )

    expect(parseRemoteD1InfoResponse(info, '11111111-2222-4333-8444-555555555555')).toMatchObject({
      jurisdiction: null,
      running_in_region: 'APAC',
      read_queries_24h: 12,
      write_queries_24h: 7,
    })
    // jurisdiction is nullable string: a non-null string is accepted.
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"jurisdiction": null', '"jurisdiction": "WEUR"'),
      '11111111-2222-4333-8444-555555555555',
    )).not.toThrow()
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"jurisdiction": null', '"jurisdiction": 7'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrow()
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"running_in_region": "APAC"', '"running_in_region": 7'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrow()
    expect(() => parseRemoteD1InfoResponse(
      info.replace('"running_in_region": "APAC"', '"running_in_region": "APAC", "\\u0072unning_in_region": "forged"'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrow()
  })

  it('accepts the pinned Wrangler whoami fixture and rejects unsupported key/type variants', () => {
    const whoami = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami.json'),
      'utf8',
    )

    expect(parseWranglerWhoamiResponse(whoami, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      loggedIn: true,
    })
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"account:Workers Scripts:write"', '"account:Workers Scripts:read"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_PERMISSION_INSUFFICIENT' }))
    // issue #154: the R2 storage write capability is required for the worker upload binding
    // verification (GET /accounts/{id}/r2/buckets); a read-only variant is insufficient.
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"account:Workers R2 Storage:write"', '"account:Workers R2 Storage:read"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_PERMISSION_INSUFFICIENT' }))
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('    "account:Workers R2 Storage:write",\n', ''),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_PERMISSION_INSUFFICIENT' }))
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', '"id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_ACCOUNT_MISMATCH' }))
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"api_access_enabled": true', '"api_access_enabled": "true"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrow()
    // the OAuth (with-email) variant keeps the strict boolean assertion: null is rejected
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"api_access_enabled": true', '"api_access_enabled": null'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrow()
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"loggedIn": true', '"loggedIn": true, "\\u006coggedIn": false'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrow()
  })

  it('accepts the live env-token Wrangler whoami variant (issue #144)', () => {
    const whoami = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami-env-token.json'),
      'utf8',
    )

    expect(parseWranglerWhoamiResponse(whoami, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      loggedIn: true,
    })
    // the env-token shape keeps the account-match identity/drift defense
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', '"id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_ACCOUNT_MISMATCH' }))
    // the env-token live shape reports api_access_enabled as null, but an explicit boolean remains valid
    expect(parseWranglerWhoamiResponse(
      whoami.replace('"api_access_enabled": null', '"api_access_enabled": true'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toMatchObject({ loggedIn: true })
    // the env-token variant still rejects any non-boolean non-null api_access_enabled
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"api_access_enabled": null', '"api_access_enabled": "true"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrow()
    // a tokenPermissions key smuggled into the env-token shape still must satisfy the permission
    // contract: with shape-consistent boolean settings the forged variant is classified as the
    // strict (non-env-token) variant, so the empty permission list must trip DELIVERY_PERMISSION_INSUFFICIENT.
    expect(() => parseWranglerWhoamiResponse(
      whoami
        .replace('"loggedIn": true', '"loggedIn": true, "tokenPermissions": []')
        .replace('"api_access_enabled": null', '"api_access_enabled": true'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrowError(expect.objectContaining({ code: 'DELIVERY_PERMISSION_INSUFFICIENT' }))
    // issue #150: upstream-added top-level keys on the env-token shape (e.g. a
    // future email field) are tolerated; the drift defenses still hold below.
    expect(parseWranglerWhoamiResponse(
      whoami.replace('"loggedIn": true', '"loggedIn": true, "email": "upstream@example.invalid"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toMatchObject({ loggedIn: true })
    // the env-token shape never carries OAuth authentication
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"authType": "User API Token"', '"authType": "OAuth Token"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrow()
  })

  it('rejects escaped duplicate keys before JSON.parse', () => {
    expect(() => parseStrictJson('{"account_id":"a","\\u0061ccount_id":"b"}')).toThrow()
  })

  it('classifies stderr from every identity child as UNCERTAIN with accumulated duration', () => {
    expect(() => identityDurationMs({ duration_ms: 5, stderr: 'private info stderr' }, null, true))
      .toThrowError(expect.objectContaining({ classification: 'uncertain', durationMs: 5 }))
    expect(() => identityDurationMs(
      { duration_ms: 5, stderr: '' },
      { duration_ms: 7, stderr: 'private whoami stderr' },
      true,
    )).toThrowError(expect.objectContaining({ classification: 'uncertain', durationMs: 12 }))
  })

  it.each([
    ['timeout', 'setInterval(() => {}, 1000)', 'timeout', 40],
    ['nonzero', 'process.stderr.write("private child secret"); process.exit(7)', 'nonzero', 500],
  ] as const)('classifies a real child %s once without exposing raw output', (_name, source, classification, timeoutMs) => {
    try {
      runBoundedChild(process.execPath, ['-e', source], timeoutMs, 1024)
      throw new Error('expected child failure')
    } catch (error) {
      expect(error).toBeInstanceOf(D1ChildError)
      expect(error.classification).toBe(classification)
      expect(error.durationMs).toBeGreaterThan(0)
      expect(String(error)).not.toContain('private child secret')
    }
  })

  it('keeps malformed child stdout bounded until the strict evidence parser rejects it', () => {
    const result = runBoundedChild(
      process.execPath,
      ['-e', 'process.stdout.write("{")'],
      500,
      1024,
    )

    expect(result.status).toBe(0)
    expect(() => parseStrictJson(result.stdout)).toThrow()
    expect(result.stderr).toBe('')
  })

  it('marks a child that leaves a residual process group UNCERTAIN and consumes one attempt', () => {
    const source = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'child.unref()',
      'process.exit(0)',
    ].join(';')

    expect(() => runBoundedChild(process.execPath, ['-e', source], 500, 1024)).toThrowError(
      expect.objectContaining({ classification: 'uncertain' }),
    )
  })
})
