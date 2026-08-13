import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildLocalEntryReceipt,
  buildLocalRehearsalCommands,
  execute,
  parseLocalCommandResult,
} from '../../scripts/issue-23-delivery-entry.mjs'

const draft = 'a'.repeat(64)

function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function commands() {
  return buildLocalRehearsalCommands({
    runnerPath: 'scripts/migrations.mjs',
    configPath: 'wrangler.toml',
    stateToken: '<disposable-state>',
    candidate: 'candidate',
  })
}

describe('Issue #23 formal entry contracts', () => {
  it('keeps execute at the approved two-argument public seam', () => {
    expect(execute).toHaveLength(2)
    expect(() => execute({}, {}, { override: true })).toThrow(/two arguments/u)
  })

  it('constructs fixed local rehearsal commands and rejects command mutation', () => {
    const first = commands()
    const changed = buildLocalRehearsalCommands({
      runnerPath: 'scripts/migrations.mjs',
      configPath: 'wrangler.toml',
      stateToken: '<disposable-state>',
      candidate: 'different-candidate',
    })

    expect(first.map(({ name, args }) => ({ name, args }))).not.toEqual(
      changed.map(({ name, args }) => ({ name, args })),
    )
    expect(() => buildLocalRehearsalCommands({
      runnerPath: 'scripts/migrations.mjs',
      configPath: 'wrangler.toml',
      stateToken: 'bad\ninput',
      candidate: 'candidate',
    })).toThrow(/single-line/u)
  })

  it('parses only bounded successful JSON command results', () => {
    expect(parseLocalCommandResult({ status: 0, stdout: '{"state":"current"}', stderr: '' }, 'verify'))
      .toEqual({ state: 'current' })
    expect(() => parseLocalCommandResult({ status: 1, stdout: '', stderr: '' }, 'apply'))
      .toThrow(/did not complete successfully/u)
    expect(() => parseLocalCommandResult({ status: 0, stdout: 'not-json', stderr: '' }, 'apply'))
      .toThrow(/did not return JSON/u)
    expect(() => parseLocalCommandResult({
      status: 0,
      stdout: JSON.stringify({
        format: 'blogman-issue-23-supervisor/v1',
        status: 'timed_out',
        stdout: '',
        stderr: '',
      }),
      stderr: '',
    }, 'apply')).toThrow(/timed out/u)
  })

  it('binds local rehearsal evidence to canonical inputs and cleanup proof', () => {
    const input = {
      commands: commands().map(({ name, args }) => ({ name, args })),
      outputs: [
        { name: 'catalog', value: { migrations: ['001'] } },
        { name: 'apply', value: { state: 'current' } },
        { name: 'verify', value: { state: 'verified' } },
      ],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '20.20.2' },
      network: 'disabled',
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: true, observed_absent: true },
      networkEvidence: { boundary: 'node-guard-only', external_probe: 'blocked' },
      adapterOutputs: [{ name: 'production-write', calls: 0 }],
    }
    const first = buildLocalEntryReceipt({ manifestDraftSha256: draft, ...input })
    const changed = buildLocalEntryReceipt({ manifestDraftSha256: 'c'.repeat(64), ...input })

    expect(first.sha256).not.toBe(changed.sha256)
    expect(first.value.manifest_draft_sha256).toBe(draft)
    expect(first.value.disposable_state.cleaned).toBe(true)
    expect(first.bytes).toEqual(Buffer.from(`${JSON.stringify(first.value, null, 2)}\n`, 'utf8'))
    expect(first.sha256).toBe(hash(first.bytes))
  })

  it('fails closed when network or disposable cleanup proof is absent', () => {
    expect(() => buildLocalEntryReceipt({
      manifestDraftSha256: draft,
      commands: [],
      outputs: [],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '20.20.2' },
      network: 'enabled',
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: false },
    })).toThrow(/evidence is incomplete/u)
  })
})
