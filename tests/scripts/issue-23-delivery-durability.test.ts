import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as deliverySinkModule from '../../scripts/issue-23-delivery-evidence-sink.mjs'
import { createTestDeliverySink } from '../../scripts/issue-23-delivery-evidence-sink.mjs'
import {
  TEST_AUTHORITY_ROOT,
  isolatedAuthorityChildEnvironment,
} from '../helpers/issue-23-authority-isolation'

const temporaryDirectories: string[] = []
const sinkModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/issue-23-delivery-evidence-sink.mjs')).href
const entryModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/issue-23-delivery-entry.mjs')).href

function exportedLocalNames(source: string) {
  return [...source.matchAll(/\bexport\s*\{([^}]*)\}/gs)].flatMap((match) => (
    match[1].split(',').map((specifier) => specifier.trim().split(/\s+as\s+/u)[0].trim()).filter(Boolean)
  ))
}

function record(value: Record<string, unknown>) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { value, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function authorizationRecord() {
  return record({
    format: 'blogman-issue-23-authorization/v1',
    authorization_id: 'durable-authorization-replay',
    manifest_sha256: 'a'.repeat(64),
    decision: 'approve',
  })
}

function derivedAttemptId(manifestSha256: string, authorizationSha256: string) {
  return record({
    format: 'blogman-issue-23-attempt/v1',
    manifest_sha256: manifestSha256,
    authorization_sha256: authorizationSha256,
  }).sha256
}

const deliveryStages = [
  'authorization_accept', 'live_preconditions', 'd1_identity', 'clean_start_reset',
  'empty_d1_proof', 'migrations_001_006', 'reconciliation', 'worker_deploy',
  'version_traffic_verification', 'smoke_control_t0',
]
const d1Stages = ['d1_identity', 'clean_start_reset', 'empty_d1_proof', 'migrations_001_006', 'reconciliation']
const d1HashNames = [
  'bindings_sha256', 'wrangler_sha256', 'config_sha256', 'reset_sql_sha256',
  'migration_runner_sha256', 'migration_catalog_sha256', 'rollout_safety_sha256',
  'expected_reconciliation_sha256', 'trace_sha256',
]
const workerHashNames = ['upload_acceptance_sha256', 'version_traffic_sha256', 'smoke_control_t0_sha256']

function exactD1Record(manifest: ReturnType<typeof record>, authorization: ReturnType<typeof record>, attemptId: string, outcome = 'ERROR') {
  const terminalIndex = outcome === 'PASS' ? d1Stages.length - 1 : 0
  return record({
    format: 'blogman-issue-23-d1-stages/v1',
    outcome,
    first_terminal_stage: outcome === 'PASS' ? null : 'd1_identity',
    failure: outcome === 'PASS' ? null : { classification: 'stage_error' },
    stage_counts: Object.fromEntries(d1Stages.map((stage, index) => [stage, index <= terminalIndex ? 1 : 0])),
    stage_durations_ms: Object.fromEntries(d1Stages.map((stage, index) => [stage, index <= terminalIndex ? 1 : 0])),
    evidence: {
      source: 'production', production: true, promotable: outcome === 'PASS',
      ...Object.fromEntries(d1HashNames.map((name) => [name, 'd'.repeat(64)])),
      manifest_sha256: manifest.sha256,
      authorization_sha256: authorization.sha256,
      attempt_id: attemptId,
      account_id: 'account-public-id',
      d1_database_id: 'd1-public-id',
      candidate_id: String((manifest.value.repository as { commit: string }).commit),
    },
    finalized: true,
  })
}

function exactWorkerRecord(manifest: ReturnType<typeof record>, authorization: ReturnType<typeof record>, attemptId: string, extra: Record<string, unknown> = {}) {
  return record({
    format: 'blogman-issue-23-worker-stages/v1',
    outcome: 'ERROR',
    first_terminal_stage: 'worker_deploy',
    failure: { classification: 'worker_adapter_error' },
    stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    stage_durations_ms: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    mutation_counts: { attempted: 1, confirmed: 0 },
    evidence: {
      source: 'production', production: true, promotable: false,
      manifest_sha256: manifest.sha256,
      authorization_sha256: authorization.sha256,
      attempt_id: attemptId,
      candidate_id: String((manifest.value.repository as { commit: string }).commit),
      hashes: Object.fromEntries(workerHashNames.map((name) => [name, null])),
    },
    finalized: true,
    ...extra,
  })
}

function exactTerminalRecord(
  manifest: ReturnType<typeof record>,
  authorization: ReturnType<typeof record>,
  options: {
    attemptId?: string
    firstStage?: string
    outcome?: string
    classification?: string
    d1?: ReturnType<typeof record> | null
    worker?: ReturnType<typeof record> | null
    mutationCounts?: { production_writes: number; attempted: number; confirmed: number }
  } = {},
) {
  const attemptId = options.attemptId ?? derivedAttemptId(manifest.sha256, authorization.sha256)
  const outcome = options.outcome ?? 'ERROR'
  const firstStage = options.firstStage ?? 'authorization_accept'
  const terminalIndex = deliveryStages.indexOf(firstStage)
  const d1 = options.d1 ?? null
  const worker = options.worker ?? null
  const d1Attempted = d1 === null ? 0
    : Number(d1.value.stage_counts.clean_start_reset) + Number(d1.value.stage_counts.migrations_001_006)
  const d1Confirmed = d1?.value.outcome === 'PASS' ? 2 : 0
  const workerMutations = worker?.value.mutation_counts as { attempted?: number; confirmed?: number } | undefined
  const confirmed = d1Confirmed + (workerMutations?.confirmed ?? 0)
  const mutationCounts = options.mutationCounts ?? {
    production_writes: confirmed,
    attempted: d1Attempted + (workerMutations?.attempted ?? 0),
    confirmed,
  }
  const hashes = {
    d1_stage_receipt_sha256: d1?.sha256 ?? null,
    ...Object.fromEntries(d1HashNames.map((name) => [`d1_${name}`, d1 === null ? null : 'd'.repeat(64)])),
    worker_stage_receipt_sha256: worker?.sha256 ?? null,
    ...Object.fromEntries(workerHashNames.map((name) => [`worker_${name}`, worker === null ? null : worker.value.evidence.hashes[name]])),
  }
  return record({
    format: 'blogman-issue-23-terminal-result/v1',
    identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
    attempt_id: attemptId,
    started_at: '1970-01-01T00:00:00.000Z',
    ended_at: '1970-01-01T00:00:00.010Z',
    authorization_consumed: true,
    outcome,
    first_terminal_stage: firstStage,
    failure: outcome === 'PASS' ? null : { classification: options.classification ?? 'stage_error' },
    stage_counts: Object.fromEntries(deliveryStages.map((stage, index) => [stage, index <= terminalIndex ? 1 : 0])),
    stage_durations_ms: Object.fromEntries(deliveryStages.map((stage, index) => [stage, index <= terminalIndex ? 1 : 0])),
    mutation_counts: mutationCounts,
    evidence: {
      source: 'production', production: true, promotable: outcome === 'PASS', hashes,
      cleanup: { created: false, cleaned: true, observed_absent: true },
    },
    finalized: true,
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Issue #23 durable delivery records', () => {
  it('exposes no importable canonical root or writer and refuses direct canonical selection', () => {
    expect(Object.keys(deliverySinkModule).sort()).toEqual([
      'DeliverySinkDeadlineError',
      'createTestDeliverySink',
    ])
    expect(() => deliverySinkModule.createTestDeliverySink(TEST_AUTHORITY_ROOT))
      .toThrow(/canonical production (?:root|authority overlap)/u)

    const internalModule = join(process.cwd(), 'scripts/issue-23-delivery-evidence-sink-internal.mjs')
    expect(existsSync(internalModule)).toBe(false)
    const directImport = spawnSync(process.execPath, ['--input-type=module', '-e', `
      await import(${JSON.stringify(pathToFileURL(internalModule).href)})
    `], { encoding: 'utf8', env: isolatedAuthorityChildEnvironment() })
    expect(directImport.status).not.toBe(0)

    for (const name of readdirSync(join(process.cwd(), 'scripts')).filter((name) => name.endsWith('.mjs'))) {
      const source = readFileSync(join(process.cwd(), 'scripts', name), 'utf8')
      expect(source, name).not.toMatch(/export\s+(?:const|function|class)\s+(?:canonicalProduction|createCanonicalProduction|repositoryDeliverySink)/u)
    }

    const entrySource = readFileSync(join(process.cwd(), 'scripts/issue-23-delivery-entry.mjs'), 'utf8')
    const privateAuthorityLocals = ['canonicalDeliveryReader', 'canonicalDeliverySink', 'isCanonicalProductionAuthorityRoot']
    for (const localName of privateAuthorityLocals) expect(exportedLocalNames(entrySource)).not.toContain(localName)
    for (const mutation of [
      'export { canonicalDeliverySink }',
      'export { canonicalDeliverySink as deliveryAuthority }',
    ]) {
      expect(exportedLocalNames(`${entrySource}\n${mutation}\n`)).toContain('canonicalDeliverySink')
    }
  })

  it.each([
    ['exact', (canonicalRoot: string) => canonicalRoot],
    ['descendant', (canonicalRoot: string) => join(canonicalRoot, 'test-sink')],
    ['ancestor', (_canonicalRoot: string, blogmanRoot: string) => blogmanRoot],
    ['resolved descendant', (canonicalRoot: string, _blogmanRoot: string, aliasRoot: string) => (
      join(aliasRoot, canonicalRoot.split('/').at(-1)!, 'test-sink')
    )],
  ])('rejects a test sink with %s canonical namespace overlap before canonical mutation', (_label, requestedRoot) => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-23-overlap-')))
    temporaryDirectories.push(parent)
    const home = join(parent, 'home')
    const local = join(home, '.local')
    const state = join(local, 'state')
    const blogmanRoot = join(state, 'blogman')
    const canonicalRoot = join(blogmanRoot, 'issue-23-production-authority-v1')
    const aliasRoot = join(parent, 'blogman-alias')
    mkdirSync(blogmanRoot, { recursive: true, mode: 0o700 })
    for (const path of [home, local, state, blogmanRoot]) chmodSync(path, 0o700)
    symlinkSync(blogmanRoot, aliasRoot)
    const root = requestedRoot(canonicalRoot, blogmanRoot, aliasRoot)

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createTestDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      try {
        createTestDeliverySink(${JSON.stringify(root)})
        process.exitCode = 2
      } catch (error) {
        if (!/canonical|overlap/u.test(error instanceof Error ? error.message : String(error))) process.exitCode = 3
      }
    `], { encoding: 'utf8', env: isolatedAuthorityChildEnvironment({ BLOGMAN_TEST_AUTHORITY_HOME: home }) })

    expect(child.status, child.stderr).toBe(0)
    expect(existsSync(canonicalRoot)).toBe(false)
  })

  it('permits a test sink disjoint from the canonical authority namespace', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-23-disjoint-')))
    temporaryDirectories.push(parent)
    const home = join(parent, 'home')
    const root = join(parent, 'test-sink')
    mkdirSync(home, { mode: 0o700 })
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createTestDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      createTestDeliverySink(${JSON.stringify(root)})
    `], { encoding: 'utf8', env: isolatedAuthorityChildEnvironment({ BLOGMAN_TEST_AUTHORITY_HOME: home }) })

    expect(child.status, child.stderr).toBe(0)
    expect(existsSync(join(root, 'authorizations'))).toBe(true)
  })

  it('validates absent production evidence without creating the canonical authority namespace', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-23-read-only-validation-')))
    temporaryDirectories.push(parent)
    const home = join(parent, 'home')
    const canonicalRoot = join(home, '.local', 'state', 'blogman', 'issue-23-production-authority-v1')
    mkdirSync(home, { mode: 0o700 })
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createHash } from 'node:crypto'
      import { validateProductionTerminalEvidence } from ${JSON.stringify(entryModuleUrl)}
      const bytes = Buffer.from('{}\\n')
      try {
        validateProductionTerminalEvidence({ value: {}, bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
        process.exitCode = 2
      } catch (error) {
        if (!/production terminal evidence/u.test(error instanceof Error ? error.message : String(error))) process.exitCode = 3
      }
    `], { encoding: 'utf8', env: isolatedAuthorityChildEnvironment({ BLOGMAN_TEST_AUTHORITY_HOME: home }) })

    expect(child.status, child.stderr).toBe(0)
    expect(existsSync(join(home, '.local'))).toBe(false)
    expect(existsSync(canonicalRoot)).toBe(false)
  })

  it('accepts a benign embedded task path while rejecting credential tokens and arbitrary Authorization fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-boundary-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)

    for (const prefix of ['sk-', 'nm_']) {
      const secretShapedValue = `${prefix}test-only-credential`
      expect(() => sink.consumeAuthorization(record({
        ...authorizationRecord().value,
        marker: secretShapedValue,
      }))).toThrow(/secret value/u)
    }

    expect(() => sink.consumeAuthorization(record({
      ...authorizationRecord().value,
      marker: 'unsupported-authority',
    }))).toThrow(/authorization.*fields|malformed/u)
    expect(() => sink.consumeAuthorization(record({
      format: 'blogman-issue-23-authorization/v1',
      authorization_id: 'missing-decision',
      manifest_sha256: 'a'.repeat(64),
    }))).toThrow(/authorization.*field|malformed/u)

    const benign = record({
      ...authorizationRecord().value,
      authorization_id: 'after-task-async-storage.external.js',
    })
    expect(sink.consumeAuthorization(benign)).toBe(benign.sha256)
  })

  it('rejects symlink, owner/mode, and root identity drift', () => {
    const parent = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-integrity-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'sink')
    const sink = createTestDeliverySink(root)
    chmodSync(root, 0o755)
    expect(() => sink.consumeAuthorization(authorizationRecord())).toThrow(/mode|identity/u)
    chmodSync(root, 0o700)

    const authorizations = join(root, 'authorizations')
    const displaced = join(root, 'authorizations-displaced')
    spawnSync('mv', [authorizations, displaced])
    symlinkSync(displaced, authorizations)
    expect(() => sink.consumeAuthorization(authorizationRecord())).toThrow(/canonical|identity/u)
  })

  it('publishes and fsyncs the destination name before removing and fsyncing the temporary name', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/issue-23-delivery-entry.mjs'), 'utf8')
    const atomicWrite = source.slice(
      source.indexOf('function atomicWrite('),
      source.indexOf('function writeIfAbsent('),
    )
    const linked = atomicWrite.indexOf('linkSync(temporary, path)')
    const destinationSynced = atomicWrite.indexOf('syncDirectory(directory)', linked)
    const temporaryRemoved = atomicWrite.indexOf('unlinkSync(temporary)', destinationSynced)
    const removalSynced = atomicWrite.indexOf('syncDirectory(directory)', temporaryRemoved)

    expect(linked).toBeGreaterThanOrEqual(0)
    expect(destinationSynced).toBeGreaterThan(linked)
    expect(temporaryRemoved).toBeGreaterThan(destinationSynced)
    expect(removalSynced).toBeGreaterThan(temporaryRemoved)
  })

  it('rejects unsafe leaf entries on Authorization EEXIST instead of treating them as consumed records', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-leaf-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const authorization = authorizationRecord()
    const destination = join(root, 'authorizations', `${authorization.sha256}.json`)
    const target = join(root, 'leaf-target')
    writeFileSync(target, authorization.bytes, { mode: 0o600 })

    symlinkSync(target, destination)
    expect(() => sink.consumeAuthorization(authorization)).toThrow(/canonical durable file/u)
    rmSync(destination)

    linkSync(target, destination)
    expect(() => sink.consumeAuthorization(authorization)).toThrow(/canonical durable file/u)
  })

  it('rejects an untrusted attempt identity before terminal path construction or escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-attempt-traversal-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const validTerminal = exactTerminalRecord(manifest, authorization)
    const terminal = record({ ...validTerminal.value, attempt_id: '../escaped-terminal' })
    sink.consumeAuthorization(authorization)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null }))
      .toThrow(/attempt|identity/u)
    expect(() => readFileSync(join(root, 'escaped-terminal.json'))).toThrow()
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects unsupported Worker fields and contradictory Terminal trajectory before persistence', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-exact-durable-schema-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const worker = record({
      format: 'blogman-issue-23-worker-stages/v1',
      evidence: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorization.sha256,
        attempt_id: attemptId,
        candidate_id: manifest.value.repository.commit,
      },
      diagnostic: 'ordinary private adapter detail',
    })
    const contradictory = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      attempt_id: attemptId,
      outcome: 'PASS',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'stage_error' },
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: worker.sha256 } },
    })
    sink.consumeAuthorization(authorization)

    expect(() => sink.persistTerminalResult({ terminal: contradictory, manifest, d1: null, worker }))
      .toThrow(/unsupported|schema|trajectory|terminal|Worker/u)
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects an arbitrary unsupported Worker field with an otherwise coherent terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-worker-unsupported-field-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const baseWorker = exactWorkerRecord(manifest, authorization, attemptId)
    const worker = record({ ...baseWorker.value, diagnostic: 'ordinary private adapter detail' })
    const terminal = exactTerminalRecord(manifest, authorization, {
      attemptId,
      firstStage: 'worker_deploy',
      classification: 'worker_adapter_error',
      worker,
    })
    sink.consumeAuthorization(authorization)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker }))
      .toThrow(/Worker evidence schema contains unsupported fields/u)
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects Terminal mutation counts that contradict D1 and Worker sidecars', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-terminal-sidecar-mutations-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const d1 = exactD1Record(manifest, authorization, attemptId, 'PASS')
    const worker = exactWorkerRecord(manifest, authorization, attemptId)
    const terminal = exactTerminalRecord(manifest, authorization, {
      attemptId,
      firstStage: 'worker_deploy',
      classification: 'worker_adapter_error',
      d1,
      worker,
      mutationCounts: { production_writes: 0, attempted: 0, confirmed: 0 },
    })
    sink.consumeAuthorization(authorization)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1, worker }))
      .toThrow(/mutation evidence.*sidecar|mutation.*contradict/u)
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects exact-shape outcome/classification and mutation contradictions', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-terminal-coherence-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const terminal = exactTerminalRecord(manifest, authorization)
    sink.consumeAuthorization(authorization)

    const wrongPair = record({
      ...terminal.value,
      outcome: 'TIMEOUT',
      failure: { classification: 'upload_contract_invalid' },
    })
    expect(() => sink.persistTerminalResult({ terminal: wrongPair, manifest, d1: null, worker: null }))
      .toThrow(/outcome\/classification/u)

    const impossibleMutation = record({
      ...terminal.value,
      mutation_counts: { production_writes: 0, attempted: 1, confirmed: 0 },
    })
    expect(() => sink.persistTerminalResult({ terminal: impossibleMutation, manifest, d1: null, worker: null }))
      .toThrow(/mutation evidence/u)
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('atomically permits exactly one concurrent process and rejects fresh-process replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-sink-'))
    temporaryDirectories.push(root)
    const authorization = authorizationRecord()
    createTestDeliverySink(root)
    const contenderSource = `
      import { createTestDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      const record = { bytes, sha256: ${JSON.stringify(authorization.sha256)} }
      try { createTestDeliverySink(${JSON.stringify(root)}).consumeAuthorization(record) }
      catch (error) { if (/consumed/u.test(error.message)) process.exitCode = 10; else throw error }
    `
    const run = () => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contenderSource], {
        stdio: 'ignore',
        env: isolatedAuthorityChildEnvironment(),
      })
      child.once('exit', resolve)
    })
    expect((await Promise.all([run(), run()])).sort()).toEqual([0, 10])

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createTestDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      const record = { bytes, sha256: ${JSON.stringify(authorization.sha256)} }
      try {
        createTestDeliverySink(${JSON.stringify(root)}).consumeAuthorization(record)
        process.exitCode = 2
      } catch (error) {
        if (!/consumed/u.test(error instanceof Error ? error.message : String(error))) process.exitCode = 3
      }
    `], { encoding: 'utf8', env: isolatedAuthorityChildEnvironment() })

    expect(child.status, child.stderr).toBe(0)
  })

  it('rejects one Authorization replayed from a fresh linked worktree', () => {
    const repository = mkdtempSync(join(tmpdir(), 'blogman-issue-23-replay-repository-'))
    const worktree = mkdtempSync(join(tmpdir(), 'blogman-issue-23-replay-worktree-'))
    temporaryDirectories.push(repository, worktree)
    spawnSync('git', ['init', repository])
    writeFileSync(join(repository, 'tracked'), 'tracked\n')
    spawnSync('git', ['-C', repository, 'add', 'tracked'])
    spawnSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'])
    spawnSync('git', ['-C', repository, 'worktree', 'add', '--detach', worktree, 'HEAD'])
    const authorization = authorizationRecord()
    const source = `
      import { createTestDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      const record = { bytes, sha256: ${JSON.stringify(authorization.sha256)} }
      try { createTestDeliverySink(${JSON.stringify(repository)}).consumeAuthorization(record) }
      catch (error) { if (/consumed/u.test(error.message)) process.exitCode = 10; else throw error }
    `
    try {
      expect(spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: repository,
        env: isolatedAuthorityChildEnvironment(),
      }).status).toBe(0)
      expect(spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: worktree,
        env: isolatedAuthorityChildEnvironment(),
      }).status).toBe(10)
    } finally {
      spawnSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktree])
    }
  })

  it('round-trips Terminal Result, Manifest, consumed Authorization, and evidence as one identity set after a fresh process restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-result-'))
    temporaryDirectories.push(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
      marker: 'durable-result',
    })
    const authorization = record({
      ...authorizationRecord().value,
      manifest_sha256: manifest.sha256,
    })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const d1 = exactD1Record(manifest, authorization, attemptId, 'PASS')
    const worker = exactWorkerRecord(manifest, authorization, attemptId)
    const terminal = exactTerminalRecord(manifest, authorization, {
      attemptId,
      firstStage: 'worker_deploy',
      outcome: 'ERROR',
      classification: 'worker_adapter_error',
      d1,
      worker,
    })
    const sink = createTestDeliverySink(root)
    sink.consumeAuthorization(authorization)

    expect(sink.persistTerminalResult({ terminal, manifest, d1, worker })).toBe(terminal.sha256)

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createTestDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const result = createTestDeliverySink(${JSON.stringify(root)}).readTerminalEvidence(${JSON.stringify(terminal.sha256)})
      if (result.terminal.sha256 !== ${JSON.stringify(terminal.sha256)}
        || result.manifest.sha256 !== ${JSON.stringify(manifest.sha256)}
        || result.authorization.sha256 !== ${JSON.stringify(authorization.sha256)}
        || result.authorization.value.manifest_sha256 !== ${JSON.stringify(manifest.sha256)}
        || result.d1.sha256 !== ${JSON.stringify(d1.sha256)}
        || result.worker.sha256 !== ${JSON.stringify(worker.sha256)}) process.exitCode = 2
    `], { encoding: 'utf8', env: isolatedAuthorityChildEnvironment() })

    expect(child.status, child.stderr).toBe(0)
  })

  it('rejects terminal persistence when its exact Authorization was never consumed', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-missing-authorization-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'missing-authorization' })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const terminal = exactTerminalRecord(manifest, authorization)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null }))
      .toThrow(/authorization.*missing/u)
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects reusing one D1 sidecar for a different attempt identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-d1-identity-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const d1 = exactD1Record(manifest, authorization, attemptId)
    const terminal = exactTerminalRecord(manifest, authorization, {
      attemptId,
      firstStage: 'd1_identity',
      d1,
    })
    sink.consumeAuthorization(authorization)
    expect(sink.persistTerminalResult({ terminal, manifest, d1, worker: null })).toBe(terminal.sha256)

    const alternateAuthorization = record({
      ...authorizationRecord().value,
      authorization_id: 'alternate-d1-attempt-authorization',
      manifest_sha256: manifest.sha256,
    })
    sink.consumeAuthorization(alternateAuthorization)
    const alternateAttemptId = derivedAttemptId(manifest.sha256, alternateAuthorization.sha256)
    const alternateTerminal = exactTerminalRecord(manifest, alternateAuthorization, {
      attemptId: alternateAttemptId,
      firstStage: 'd1_identity',
      d1,
    })
    expect(() => sink.persistTerminalResult({
      terminal: alternateTerminal,
      manifest,
      d1,
      worker: null,
    })).toThrow(/D1|attempt|identit/u)
  })

  it('rejects reusing one Worker sidecar for a different manifest or attempt identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-worker-identity-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const worker = exactWorkerRecord(manifest, authorization, attemptId)
    const terminal = exactTerminalRecord(manifest, authorization, {
      attemptId,
      firstStage: 'worker_deploy',
      classification: 'worker_adapter_error',
      worker,
    })
    sink.consumeAuthorization(authorization)
    expect(sink.persistTerminalResult({ terminal, manifest, d1: null, worker })).toBe(terminal.sha256)

    const alternateTerminal = record({ ...terminal.value, attempt_id: 'e'.repeat(64) })
    expect(() => sink.persistTerminalResult({
      terminal: alternateTerminal,
      manifest,
      d1: null,
      worker,
    })).toThrow(/Worker|attempt|identit/u)

    const alternateManifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'f'.repeat(40) },
    })
    const alternateAuthorization = record({
      ...authorizationRecord().value,
      authorization_id: 'alternate-manifest-authorization',
      manifest_sha256: alternateManifest.sha256,
    })
    sink.consumeAuthorization(alternateAuthorization)
    const alternateManifestTerminal = record({
      ...terminal.value,
      identities: {
        manifest_sha256: alternateManifest.sha256,
        authorization_sha256: alternateAuthorization.sha256,
      },
    })
    expect(() => sink.persistTerminalResult({
      terminal: alternateManifestTerminal,
      manifest: alternateManifest,
      d1: null,
      worker,
    })).toThrow(/Worker|manifest|identit/u)
  })

  it('rejects alternate or asymmetric receipt sidecars before any durable record write', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-binding-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'binding' })
    const d1 = record({ format: 'blogman-issue-23-d1-stages/v1', marker: 'expected-d1' })
    const alternateD1 = record({ format: 'blogman-issue-23-d1-stages/v1', marker: 'alternate-d1' })
    const worker = record({ format: 'blogman-issue-23-worker-stages/v1', marker: 'worker' })
    const alternateWorker = record({ format: 'blogman-issue-23-worker-stages/v1', marker: 'alternate-worker' })
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256 },
      evidence: {
        hashes: {
          d1_stage_receipt_sha256: d1.sha256,
          worker_stage_receipt_sha256: worker.sha256,
        },
      },
    })

    for (const input of [
      { terminal, manifest, d1: alternateD1, worker },
      { terminal, manifest, d1, worker: alternateWorker },
      { terminal, manifest, d1: null, worker },
      { terminal, manifest, d1, worker: null },
    ]) {
      expect(() => sink.persistTerminalResult(input))
        .toThrow(/identities|evidence|receipt|hash/u)
    }
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])

    const noD1Terminal = record({
      ...terminal.value,
      evidence: {
        hashes: {
          d1_stage_receipt_sha256: null,
          worker_stage_receipt_sha256: worker.sha256,
        },
      },
    })
    const noWorkerTerminal = record({
      ...terminal.value,
      evidence: {
        hashes: {
          d1_stage_receipt_sha256: d1.sha256,
          worker_stage_receipt_sha256: null,
        },
      },
    })
    for (const input of [
      { terminal: noD1Terminal, manifest, d1, worker },
      { terminal: noWorkerTerminal, manifest, d1, worker },
    ]) {
      expect(() => sink.persistTerminalResult(input))
        .toThrow(/identities|evidence|receipt|hash/u)
    }
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects malformed private receipt evidence before any durable record write', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-private-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
      marker: 'private',
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const baseWorker = exactWorkerRecord(manifest, authorization, attemptId)
    const worker = record({
      ...baseWorker.value,
      evidence: { ...baseWorker.value.evidence, response_body: 'must-not-persist' },
    })
    const terminal = exactTerminalRecord(manifest, authorization, {
      attemptId,
      firstStage: 'worker_deploy',
      classification: 'worker_adapter_error',
      worker,
    })
    sink.consumeAuthorization(authorization)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker }))
      .toThrow(/private field/u)

    for (const key of ['api_key', 'credential', 'private_output', 'access_token']) {
      const unsafeWorker = record({
        ...baseWorker.value,
        evidence: { ...baseWorker.value.evidence, [key]: 'ordinary-cloudflare-value' },
      })
      const unsafeTerminal = exactTerminalRecord(manifest, authorization, {
        attemptId,
        firstStage: 'worker_deploy',
        classification: 'worker_adapter_error',
        worker: unsafeWorker,
      })
      expect(() => sink.persistTerminalResult({ terminal: unsafeTerminal, manifest, d1: null, worker: unsafeWorker }))
        .toThrow(/private field/u)
    }
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('keeps exactly one attempt slot when a conflicting terminal follows persistence', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-terminal-cas-'))
    temporaryDirectories.push(root)
    const sink = createTestDeliverySink(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'terminal-cas' })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = derivedAttemptId(manifest.sha256, authorization.sha256)
    const terminal = exactTerminalRecord(manifest, authorization, { attemptId })
    const timeoutTerminal = record({
      ...terminal.value,
      outcome: 'TIMEOUT',
      failure: { classification: 'overall_timeout' },
    })
    sink.consumeAuthorization(authorization)
    sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null })

    expect(() => sink.persistTerminalResult({ terminal: timeoutTerminal, manifest, d1: null, worker: null }))
      .toThrow(/conflicting durable bytes/u)
    expect(readdirSync(join(root, 'terminals'))).toEqual([`${attemptId}.json`])
    expect(readFileSync(join(root, 'terminals', `${attemptId}.json`))).toEqual(terminal.bytes)
  })

  it('rejects conflicting durable terminal bytes instead of replacing the first result', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-conflict-'))
    temporaryDirectories.push(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'conflict' })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const terminal = exactTerminalRecord(manifest, authorization)
    const sink = createTestDeliverySink(root)
    sink.consumeAuthorization(authorization)
    sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null })
    const forged = record({ ...terminal.value, marker: 'forged' })
    const terminalPath = join(root, 'terminals', `${terminal.value.attempt_id}.json`)
    writeFileSync(terminalPath, forged.bytes)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null }))
      .toThrow(/conflicting durable bytes/u)
    expect(readFileSync(terminalPath)).toEqual(forged.bytes)
  })
})
