import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const ddlPath = join(repoRoot, 'scripts', 'apply-content-envelope-ddl.mjs')
const configPath = join(repoRoot, 'wrangler.toml')
const stateDirectories: string[] = []

const ENVELOPE_COLUMNS = ['content_envelope', 'content_snapshot_sha256', 'source_sync_sha256']

function createState(): string {
  const state = mkdtempSync(join(tmpdir(), 'blogman-envelope-ddl-'))
  stateDirectories.push(state)
  return state
}

function applyLedger(state: string): void {
  const result = spawnSync(process.execPath, [
    runnerPath, 'apply', '--candidate', 'a'.repeat(40), '--database', 'DB', '--local',
    '--persist-to', state, '--config', configPath,
  ], { cwd: repoRoot, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
}

function runDdl(state: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    ddlPath, '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

function columnsOf(state: string): string[] {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', state,
    '--config', configPath, '--command', 'PRAGMA table_info(posts)', '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  expect(result.status, result.stdout || result.stderr).toBe(0)
  const rows = JSON.parse(result.stdout)[0]?.results ?? []
  return rows.map((row: { name: string }) => row.name)
}

afterEach(() => {
  for (const state of stateDirectories.splice(0)) rmSync(state, { recursive: true, force: true })
})

describe('apply-content-envelope-ddl idempotency', () => {
  it('adds the envelope columns once and is a no-op on a second run', { timeout: 300_000 }, () => {
    const state = createState()
    applyLedger(state)

    // Before: canonical ledger schema has no envelope columns.
    expect(columnsOf(state)).not.toEqual(expect.arrayContaining(ENVELOPE_COLUMNS))
    expect(columnsOf(state)).toEqual(expect.arrayContaining(['content', 'html']))

    const first = runDdl(state)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('added column content_envelope')
    expect(columnsOf(state)).toEqual(expect.arrayContaining(ENVELOPE_COLUMNS))

    // Legacy authoritative columns are untouched.
    expect(columnsOf(state)).toEqual(expect.arrayContaining(['content', 'html']))

    const second = runDdl(state)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('already present')
    expect(columnsOf(state).filter((name) => ENVELOPE_COLUMNS.includes(name))).toEqual(ENVELOPE_COLUMNS)
  })
})
