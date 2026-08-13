import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('round-trips Terminal Result and evidence from canonical bytes after a fresh process restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-result-'))
    temporaryDirectories.push(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'durable-result' })
    const d1 = record({ format: 'blogman-issue-23-d1-stages/v1', marker: 'd1' })
    const worker = record({ format: 'blogman-issue-23-worker-stages/v1', marker: 'worker' })
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
    const sink = createRepositoryDeliverySink(root)

    expect(sink.persistTerminalResult({ terminal, manifest, d1, worker })).toBe(terminal.sha256)

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createRepositoryDeliverySink } from ${JSON.stringify(sinkModuleUrl)}
      const result = createRepositoryDeliverySink(${JSON.stringify(root)}).readTerminalEvidence(${JSON.stringify(terminal.sha256)})
      if (result.terminal.sha256 !== ${JSON.stringify(terminal.sha256)}
        || result.manifest.sha256 !== ${JSON.stringify(manifest.sha256)}
        || result.d1.sha256 !== ${JSON.stringify(d1.sha256)}
        || result.worker.sha256 !== ${JSON.stringify(worker.sha256)}) process.exitCode = 2
    `], { encoding: 'utf8' })

    expect(child.status, child.stderr).toBe(0)
  })

  it('rejects conflicting durable terminal bytes instead of replacing the first result', () => {
    const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-durable-conflict-'))
    temporaryDirectories.push(root)
    const manifest = record({ format: 'blogman-issue-23-canonical-frozen-manifest/v1', marker: 'conflict' })
    const terminal = record({
      format: 'blogman-issue-23-terminal-result/v1',
      identities: { manifest_sha256: manifest.sha256 },
      evidence: { hashes: { d1_stage_receipt_sha256: null, worker_stage_receipt_sha256: null } },
    })
    const sink = createRepositoryDeliverySink(root)
    sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null })
    const forged = record({ ...terminal.value, marker: 'forged' })
    writeFileSync(join(root, 'terminals', `${terminal.sha256}.json`), forged.bytes)

    expect(() => sink.persistTerminalResult({ terminal, manifest, d1: null, worker: null }))
      .toThrow(/conflicting durable bytes/u)
    expect(readFileSync(join(root, 'terminals', `${terminal.sha256}.json`))).toEqual(forged.bytes)
  })
})
