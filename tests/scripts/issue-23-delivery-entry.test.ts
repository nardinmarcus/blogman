import { describe, expect, it } from 'vitest'
import {
  buildLocalEntryReceipt,
  buildLocalRehearsalCommands,
  parseLocalCommandResult,
} from '../../scripts/issue-23-delivery-entry.mjs'

const draft = 'a'.repeat(64)

function commands() {
  return buildLocalRehearsalCommands({
    runnerPath: 'scripts/migrations.mjs',
    configPath: 'wrangler.toml',
    stateToken: '<disposable-state>',
    candidate: 'candidate',
  })
}

describe('Issue #23 pure local entry seam', () => {
  it('constructs fixed local commands and rejects command mutation', () => {
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

  it('parses only successful JSON adapter responses', () => {
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
    expect(() => parseLocalCommandResult({
      status: 0,
      stdout: JSON.stringify({
        format: 'blogman-issue-23-supervisor/v1',
        status: 'output_overflow',
        stdout: '',
        stderr: '',
      }),
      stderr: '',
    }, 'catalog')).toThrow(/output exceeded/u)
  })

  it('binds receipt identity to draft, commands, outputs, adapters, and cleanup', () => {
    const input = {
      commands: commands().map(({ name, args }) => ({ name, args })),
      outputs: [
        { name: 'catalog', value: { migrations: ['001'] } },
        { name: 'apply', value: { state: 'current' } },
        { name: 'verify', value: { state: 'verified' } },
      ],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
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
  })

  it('rejects cleanup claims without a post-cleanup absence observation', () => {
    expect(() => buildLocalEntryReceipt({
      manifestDraftSha256: draft,
      commands: [],
      outputs: [],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'disabled',
      networkEvidence: { boundary: 'node-guard-only', external_probe: 'blocked' },
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: true, observed_absent: false },
    })).toThrow(/evidence is incomplete/u)
  })

  it('fails closed when network or disposable cleanup proof is absent', () => {
    expect(() => buildLocalEntryReceipt({
      manifestDraftSha256: draft,
      commands: [],
      outputs: [],
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'enabled',
      disposableState: { identity: 'b'.repeat(64), created: true, cleaned: false },
    })).toThrow(/evidence is incomplete/u)
  })
})
