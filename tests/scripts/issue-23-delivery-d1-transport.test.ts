import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
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
import { afterEach, describe, expect, it } from 'vitest'
import {
  D1TransportError,
  D1_TRANSPORT_MAX_OUTPUT_BYTES,
  createD1Transport,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'
import {
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
const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const catalogPath = join(repoRoot, 'db', 'ledger-migrations')
const rolloutSafetyPath = join(repoRoot, 'scripts', 'rollout-safety.mjs')
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

function request(operation: string, stage = operation, elapsedMs = 0) {
  return {
    operation,
    stage,
    timeout_ms: D1_STAGE_TIMEOUT_MS[stage as keyof typeof D1_STAGE_TIMEOUT_MS],
    elapsed_ms: elapsedMs,
  }
}

function createConfig(overrides: Record<string, unknown> = {}) {
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
    config_path: configPath,
    config_sha256: sha256File(configPath),
    wrangler_sha256: sha256File(realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))),
    account_id: 'local-account-not-production',
    d1_database_id: 'local-d1-not-production',
    reset_sql_path: resetSqlPath,
    reset_sql_sha256: sha256File(resetSqlPath),
    migration_runner_path: runnerPath,
    migration_runner_sha256: sha256File(runnerPath),
    migration_catalog_path: catalogPath,
    migration_catalog_sha256: hashDirectory(catalogPath),
    rollout_safety_path: rolloutSafetyPath,
    rollout_safety_sha256: sha256File(rolloutSafetyPath),
    expected_reconciliation_path: expectedPath,
    expected_reconciliation_sha256: sha256File(expectedPath),
    candidate_id: 'c'.repeat(40),
    evidence_class: 'test-non-production',
    migrations: MIGRATIONS,
    ...overrides,
  }
  return { config, statePath, expectedPath }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Issue #90 D1 transport', () => {
  it('exposes the internal execute contract and dispatches a bounded local D1 query', () => {
    const { config } = createConfig()
    const transport = createD1Transport(config)

    expect(Object.keys(transport)).toEqual(['execute'])
    const result = transport.execute(request('empty_d1_proof'))

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.duration_ms).toBeGreaterThan(0)
    expect(JSON.parse(result.stdout)).toEqual([{ results: [], success: true, meta: { duration: expect.any(Number) } }])
  })

  it('keeps command construction private while exposing only the bounded execute seam', { timeout: 30_000 }, async () => {
    const { config } = createConfig()
    const transport = createD1Transport(config)
    const transportModule = await import('../../scripts/issue-23-delivery-d1-transport.mjs')

    expect(transportModule).not.toHaveProperty('buildD1Command')
    expect(transportModule).not.toHaveProperty('registerD1TransportCapability')
    expect(Object.keys(transport)).toEqual(['execute'])
    expect(transport.execute(request('empty_d1_proof')).status).toBe(0)
  })

  it('dispatches migration operations through the canonical runner instead of accepting SQL or file overrides', () => {
    const { config } = createConfig()
    const transport = createD1Transport(config)

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

    expect(() => createD1Transport(config, { runChild: () => ({}) })).toThrow(/exactly one|unsupported/u)
    expect(() => createD1Transport({ ...config, command: '/tmp/evil' })).toThrow(/unsupported/u)
    expect(() => createD1Transport({ ...config, timeout_ms: 1 })).toThrow(/unsupported/u)
  })

  it('rejects duplicate keys in the bound expected reconciliation contract before spawning a child', () => {
    const { config, expectedPath } = createConfig()
    const duplicate = '{"format":"blogman-d1-reconciliation/v1","\\u0066ormat":"forged"}'
    writeFileSync(expectedPath, duplicate, { mode: 0o600 })

    expect(() => createD1Transport({
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
    const transport = createD1Transport(config)
    writeFileSync(temporaryConfig, `${readFileSync(temporaryConfig)}\n`)

    expect(() => transport.execute(request('d1_identity'))).toThrow('D1 transport malformed')
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

    expect(() => createD1Transport(mutated)).toThrow('D1 transport malformed')
    try {
      createD1Transport(mutated)
    } catch (error) {
      expect(String(error)).not.toContain('x'.repeat(100))
      expect(error).toBeInstanceOf(D1TransportError)
    }
  })

  it('rejects a symlinked canonical reset artifact before any operation can spawn', () => {
    const { config } = createConfig()
    const symlinkPath = join(config.persist_path, 'reset.sql')
    symlinkSync(resetSqlPath, symlinkPath)

    expect(() => createD1Transport({
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

    expect(() => createD1Transport(config)).toThrow('D1 transport malformed')
  })

  it('requires a local persist directory to be private and outside the repository', () => {
    const { config, statePath } = createConfig()
    chmodSync(statePath, 0o755)
    expect(() => createD1Transport(config)).toThrow('D1 transport malformed')
    chmodSync(statePath, 0o700)

    expect(() => createD1Transport({ ...config, persist_path: repoRoot })).toThrow('D1 transport malformed')
  })

  it('binds the local persist directory identity for the full transport lifecycle', () => {
    const { config, statePath } = createConfig()
    const transport = createD1Transport(config)
    const movedPath = `${statePath}.moved`
    renameSync(statePath, movedPath)
    mkdirSync(statePath, { mode: 0o700 })
    temporaryDirectories.push(movedPath)

    expect(() => transport.execute(request('empty_d1_proof'))).toThrow('D1 transport malformed')
  })

  it.each([
    ['config', configPath],
    ['reset SQL', resetSqlPath],
    ['migration runner', runnerPath],
    ['rollout safety', rolloutSafetyPath],
  ])('rejects a %s content mutation before the next child spawn', (_label, path) => {
    const original = readFileSync(path)
    const { config } = createConfig()
    const transport = path === configPath ? createD1Transport(config) : null
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]))
      if (transport) {
        expect(() => transport.execute(request('d1_identity'))).toThrow('D1 transport malformed')
      } else {
        expect(() => createD1Transport(config)).toThrow('D1 transport malformed')
      }
    } finally {
      writeFileSync(path, original)
    }
  })

  it('rejects a migration catalog tree mutation before the next child spawn', () => {
    const marker = join(catalogPath, '999_issue_90_mutation.sql')
    const { config } = createConfig()
    try {
      writeFileSync(marker, '-- mutation\n', { mode: 0o600 })
      expect(() => createD1Transport(config)).toThrow('D1 transport malformed')
    } finally {
      unlinkSync(marker)
    }
  })

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
      info.replace('"uuid": "11111111-2222-4333-8444-555555555555"', '"uuid": "11111111-2222-4333-8444-555555555555", "\\u0075uid": "forged"'),
      '11111111-2222-4333-8444-555555555555',
    )).toThrow()
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

  it('accepts the pinned Wrangler whoami fixture and rejects unsupported key/type variants', () => {
    const whoami = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami.json'),
      'utf8',
    )

    expect(parseWranglerWhoamiResponse(whoami, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      loggedIn: true,
    })
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"api_access_enabled": true', '"api_access_enabled": "true"'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )).toThrow()
    expect(() => parseWranglerWhoamiResponse(
      whoami.replace('"loggedIn": true', '"loggedIn": true, "\\u006coggedIn": false'),
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
    ['timeout', 'setInterval(() => {}, 1000)', 'timeout'],
    ['nonzero', 'process.stderr.write("private child secret"); process.exit(7)', 'nonzero'],
  ] as const)('classifies a real child %s once without exposing raw output', (_name, source, classification) => {
    try {
      runBoundedChild(process.execPath, ['-e', source], 40, 1024)
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
