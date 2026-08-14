import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRepositoryDeliverySink,
  repositoryDeliverySink,
  repositoryDeliverySinkRoot,
} from '../../scripts/issue-23-delivery-evidence-sink.mjs'
import {
  PROTECTED_AUTHORITY_ROOT,
  TEST_AUTHORITY_ROOT,
  authoritySnapshot,
  isolatedAuthorityChildEnvironment,
} from '../helpers/issue-23-authority-isolation'

const temporaryDirectories: string[] = []
const sinkModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/issue-23-delivery-evidence-sink.mjs')).href

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Issue #23 durable delivery records', () => {
  it('accepts a benign embedded task path while rejecting credential tokens and arbitrary Authorization fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-boundary-'))
    temporaryDirectories.push(root)
    const sink = createRepositoryDeliverySink(root)

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

  it('uses only the test-owned canonical authority and leaves the protected authority unchanged', () => {
    const before = authoritySnapshot()
    const authorization = record({
      ...authorizationRecord().value,
      authorization_id: `isolated-authority-${process.pid}`,
    })
    const authorizationPath = join(TEST_AUTHORITY_ROOT, 'authorizations', `${authorization.sha256}.json`)

    expect(repositoryDeliverySinkRoot()).toBe(TEST_AUTHORITY_ROOT)
    expect(repositoryDeliverySinkRoot()).not.toBe(PROTECTED_AUTHORITY_ROOT)
    try {
      expect(repositoryDeliverySink.consumeAuthorization(authorization)).toBe(authorization.sha256)
      expect(readFileSync(authorizationPath)).toEqual(authorization.bytes)
      expect(authoritySnapshot()).toBe(before)
    } finally {
      rmSync(authorizationPath, { force: true })
    }
  })

  it('does not let PATH or Git environment redirect the canonical production sink root', () => {
    const expected = repositoryDeliverySinkRoot()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { repositoryDeliverySinkRoot } from ${JSON.stringify(sinkModuleUrl)}
      process.stdout.write(repositoryDeliverySinkRoot())
    `], {
      encoding: 'utf8',
      env: isolatedAuthorityChildEnvironment({
        PATH: '/definitely-not-a-bin',
        GIT_DIR: '/tmp/redirected',
        GIT_COMMON_DIR: '/tmp/redirected-common',
      }),
    })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe(expected)
  })

  it('rejects the same production Authorization from independent clone roots', () => {
    const firstClone = mkdtempSync(join(tmpdir(), 'blogman-issue-23-clone-a-'))
    const secondClone = mkdtempSync(join(tmpdir(), 'blogman-issue-23-clone-b-'))
    temporaryDirectories.push(firstClone, secondClone)
    const authorization = record({
      ...authorizationRecord().value,
      authorization_id: `clone-independent-${process.pid}`,
    })
    const source = `
      import { repositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      try { repositoryDeliverySink.consumeAuthorization({ bytes, sha256: ${JSON.stringify(authorization.sha256)} }) }
      catch (error) { if (/consumed/u.test(error.message)) process.exitCode = 10; else throw error }
    `
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: firstClone,
      env: isolatedAuthorityChildEnvironment(),
    }).status).toBe(0)
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: secondClone,
      env: isolatedAuthorityChildEnvironment(),
    }).status).toBe(10)
    rmSync(join(repositoryDeliverySinkRoot(), 'authorizations', `${authorization.sha256}.json`), { force: true })
  })

  it('uses one clone-independent canonical production sink root', () => {
    const commonRoot = repositoryDeliverySinkRoot()
    const worktree = mkdtempSync(join(tmpdir(), 'blogman-issue-23-worktree-'))
    temporaryDirectories.push(worktree)
    spawnSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { encoding: 'utf8' })
    try {
      expect(repositoryDeliverySinkRoot()).toBe(commonRoot)
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', worktree], { encoding: 'utf8' })
    }
  })

  it('rejects a symlinked canonical ancestor in a disposable preloaded child without writing the target', () => {
    const parent = mkdtempSync(join(tmpdir(), 'blogman-issue-23-canonical-ancestor-'))
    temporaryDirectories.push(parent)
    const home = join(parent, 'home')
    const target = join(parent, 'redirect-target')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, join(home, '.local'))
    const authorization = authorizationRecord()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { repositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      try {
        repositoryDeliverySink.consumeAuthorization({ bytes, sha256: ${JSON.stringify(authorization.sha256)} })
        process.exitCode = 2
      } catch (error) {
        if (!/canonical|symlink/u.test(error instanceof Error ? error.message : String(error))) process.exitCode = 3
      }
    `], {
      encoding: 'utf8',
      env: isolatedAuthorityChildEnvironment({ BLOGMAN_TEST_AUTHORITY_HOME: home }),
    })

    expect(child.status, child.stderr).toBe(0)
    expect(readdirSync(target)).toEqual([])
  })

  it('rejects symlink, owner/mode, and root identity drift', () => {
    const parent = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-integrity-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'sink')
    const sink = createRepositoryDeliverySink(root)
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
    const source = readFileSync(join(process.cwd(), 'scripts/issue-23-delivery-evidence-sink.mjs'), 'utf8')
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
    const sink = createRepositoryDeliverySink(root)
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

  it('forwards a rejecting Authorization deadline through the canonical facade without publication', () => {
    const authorization = record({
      ...authorizationRecord().value,
      authorization_id: `deadline-authorization-${process.pid}`,
    })
    const authorizationPath = join(
      repositoryDeliverySinkRoot(),
      'authorizations',
      `${authorization.sha256}.json`,
    )

    try {
      expect(() => repositoryDeliverySink.consumeAuthorization(authorization, () => false))
        .toThrow(/deadline/u)
      expect(() => readFileSync(authorizationPath)).toThrow()
    } finally {
      rmSync(authorizationPath, { force: true })
    }
  })

  it('forwards a rejecting Terminal deadline through the canonical facade without publication', () => {
    const root = repositoryDeliverySinkRoot()
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      marker: `deadline-forwarding-${process.pid}`,
    })
    const authorization = record({
      ...authorizationRecord().value,
      authorization_id: `deadline-terminal-authorization-${process.pid}`,
      manifest_sha256: manifest.sha256,
    })
    const attemptId = createHash('sha256').update(`deadline-attempt-${process.pid}`).digest('hex')
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      attempt_id: attemptId,
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: null } },
    })
    const authorizationPath = join(root, 'authorizations', `${authorization.sha256}.json`)
    const manifestPath = join(root, 'records', `${manifest.sha256}.json`)
    const terminalPath = join(root, 'terminals', `${attemptId}.json`)

    repositoryDeliverySink.consumeAuthorization(authorization)
    try {
      expect(() => repositoryDeliverySink.persistTerminalResult(
        { terminal, manifest, d1: null, worker: null },
        () => false,
      )).toThrow(/deadline/u)
      expect(() => readFileSync(manifestPath)).toThrow()
      expect(() => readFileSync(terminalPath)).toThrow()
    } finally {
      rmSync(authorizationPath, { force: true })
      rmSync(manifestPath, { force: true })
      rmSync(terminalPath, { force: true })
    }
  })

  it('atomically permits exactly one concurrent process and rejects fresh-process replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-sink-'))
    temporaryDirectories.push(root)
    const authorization = authorizationRecord()
    createRepositoryDeliverySink(root)
    const contenderSource = `
      import { createRepositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      const record = { bytes, sha256: ${JSON.stringify(authorization.sha256)} }
      try { createRepositoryDeliverySink(${JSON.stringify(root)}).consumeAuthorization(record) }
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
      import { createRepositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      const record = { bytes, sha256: ${JSON.stringify(authorization.sha256)} }
      try {
        createRepositoryDeliverySink(${JSON.stringify(root)}).consumeAuthorization(record)
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
      import { createRepositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const bytes = Buffer.from(${JSON.stringify(authorization.bytes.toString('base64'))}, 'base64')
      const record = { bytes, sha256: ${JSON.stringify(authorization.sha256)} }
      try { createRepositoryDeliverySink(${JSON.stringify(repository)}).consumeAuthorization(record) }
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
    const attemptId = 'd'.repeat(64)
    const d1 = record({
      format: 'blogman-issue-23-d1-stages/v1',
      evidence: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorization.sha256,
        attempt_id: attemptId,
        candidate_id: manifest.value.repository.commit,
      },
      marker: 'd1',
    })
    const worker = record({
      format: 'blogman-issue-23-worker-stages/v1',
      evidence: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorization.sha256,
        attempt_id: attemptId,
        candidate_id: manifest.value.repository.commit,
      },
      marker: 'worker',
    })
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorization.sha256,
      },
      attempt_id: attemptId,
      evidence: {
        hashes: {
          d1_stage_receipt_sha256: d1.sha256,
          worker_stage_receipt_sha256: worker.sha256,
        },
      },
    })
    const sink = createRepositoryDeliverySink(root)
    sink.consumeAuthorization(authorization)

    expect(sink.persistTerminalResult({ terminal, manifest, d1, worker })).toBe(terminal.sha256)

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createRepositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const result = createRepositoryDeliverySink(${JSON.stringify(root)}).readTerminalEvidence(${JSON.stringify(terminal.sha256)})
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
    const sink = createRepositoryDeliverySink(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'missing-authorization' })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: null } },
    })

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null }))
      .toThrow(/authorization.*missing/u)
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
  })

  it('rejects reusing one D1 sidecar for a different attempt identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-d1-identity-'))
    temporaryDirectories.push(root)
    const sink = createRepositoryDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = 'd'.repeat(64)
    const d1 = record({
      format: 'blogman-issue-23-d1-stages/v1',
      evidence: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorization.sha256,
        attempt_id: attemptId,
        candidate_id: manifest.value.repository.commit,
      },
    })
    const terminalValue = {
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      attempt_id: attemptId,
      evidence: { hashes: { d1_stage_receipt_sha256: d1.sha256, worker_stage_receipt_sha256: null } },
    }
    const terminal = record(terminalValue)
    sink.consumeAuthorization(authorization)
    expect(sink.persistTerminalResult({ terminal, manifest, d1, worker: null })).toBe(terminal.sha256)

    const alternateTerminal = record({ ...terminalValue, attempt_id: 'e'.repeat(64) })
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
    const sink = createRepositoryDeliverySink(root)
    const manifest = record({
      format: 'blogman-issue-23-canonical-frozen-manifest/v1',
      repository: { commit: 'c'.repeat(40) },
    })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = 'd'.repeat(64)
    const worker = record({
      format: 'blogman-issue-23-worker-stages/v1',
      evidence: {
        manifest_sha256: manifest.sha256,
        authorization_sha256: authorization.sha256,
        attempt_id: attemptId,
        candidate_id: manifest.value.repository.commit,
      },
    })
    const terminalValue = {
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      attempt_id: attemptId,
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: worker.sha256 } },
    }
    const terminal = record(terminalValue)
    sink.consumeAuthorization(authorization)
    expect(sink.persistTerminalResult({ terminal, manifest, d1: null, worker })).toBe(terminal.sha256)

    const alternateTerminal = record({ ...terminalValue, attempt_id: 'e'.repeat(64) })
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
      ...terminalValue,
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
    const sink = createRepositoryDeliverySink(root)
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
    const sink = createRepositoryDeliverySink(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'private' })
    const worker = record({
      format: 'blogman-issue-23-worker-stages/v1',
      evidence: { response_body: 'must-not-persist' },
    })
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256 },
      evidence: {
        hashes: {
          d1_stage_receipt_sha256: null,
          worker_stage_receipt_sha256: worker.sha256,
        },
      },
    })

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker }))
      .toThrow(/private field/u)

    for (const key of ['api_key', 'credential', 'private_output', 'access_token']) {
      const unsafeWorker = record({
        format: 'blogman-issue-23-worker-stages/v1',
        evidence: { [key]: 'ordinary-cloudflare-value' },
      })
      const unsafeTerminal = record({
        ...terminal.value,
        evidence: {
          hashes: {
            d1_stage_receipt_sha256: null,
            worker_stage_receipt_sha256: unsafeWorker.sha256,
          },
        },
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
    const sink = createRepositoryDeliverySink(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'terminal-cas' })
    const authorization = record({ ...authorizationRecord().value, manifest_sha256: manifest.sha256 })
    const attemptId = 'f'.repeat(64)
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      attempt_id: attemptId,
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: null } },
    })
    const timeoutTerminal = record({ ...terminal.value, outcome: 'TIMEOUT' })
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
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256, authorization_sha256: authorization.sha256 },
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: null } },
    })
    const sink = createRepositoryDeliverySink(root)
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
