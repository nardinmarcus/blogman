import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepositoryDeliverySink } from '../../scripts/issue-23-delivery-evidence-sink.mjs'

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

  it('atomically rejects the same serialized Authorization after a fresh process restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-sink-'))
    temporaryDirectories.push(root)
    const authorization = authorizationRecord()
    const sink = createRepositoryDeliverySink(root)

    expect(sink.consumeAuthorization(authorization)).toBe(authorization.sha256)

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
    `], { encoding: 'utf8' })

    expect(child.status, child.stderr).toBe(0)
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
    const d1 = record({ format: 'blogman-issue-23-d1-stages/v1', marker: 'd1' })
    const attemptId = 'd'.repeat(64)
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
    `], { encoding: 'utf8' })

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
    expect(readdirSync(join(root, 'records'))).toEqual([])
    expect(readdirSync(join(root, 'terminals'))).toEqual([])
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
    writeFileSync(join(root, 'terminals', `${terminal.sha256}.json`), forged.bytes)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null }))
      .toThrow(/conflicting durable bytes/u)
    expect(readFileSync(join(root, 'terminals', `${terminal.sha256}.json`))).toEqual(forged.bytes)
  })
})
