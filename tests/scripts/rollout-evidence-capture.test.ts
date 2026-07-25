import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const rolloutSafetyPath = join(repoRoot, 'scripts', 'rollout-safety.mjs')
const temporaryDirectories: string[] = []

function createBackupManifest() {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-evidence-capture-'))
  temporaryDirectories.push(directory)
  const sql = 'CREATE TABLE posts (id INTEGER PRIMARY KEY);\n'
  const digest = createHash('sha256').update(sql).digest('hex')
  writeFileSync(join(directory, 'backup.sql'), sql)
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({
    format: 'blogman-d1-backup/v1',
    backup_id: `sha256:${digest}`,
    source: {
      database_id: 'local-capture-fixture',
      captured_at: '2026-07-25T00:00:00.000Z',
    },
    required_tables: ['posts'],
    artifacts: [{ path: 'backup.sql', bytes: Buffer.byteLength(sql), sha256: digest }],
  })}\n`)
  return join(directory, 'manifest.json')
}

function runRolloutSafety(args: string[]) {
  return spawnSync(process.execPath, [rolloutSafetyPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('rollout evidence capture', () => {
  it('writes exactly one JSON document to stdout on success', () => {
    const result = runRolloutSafety([
      'backup', 'verify', '--manifest', createBackupManifest(),
    ])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(result.stdout).toBe(`${JSON.stringify(report)}\n`)
    expect(report).toMatchObject({ state: 'verified', artifact_count: 1 })
  })

  it('keeps failures non-zero and stderr out of captured JSON stdout', () => {
    const manifestPath = createBackupManifest()
    writeFileSync(manifestPath, '{}\n')

    const result = runRolloutSafety(['backup', 'verify', '--manifest', manifestPath])

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^Unsupported backup manifest format\n$/)
  })

  it.each([
    'docs/issue-23-phase-b-runbook.md',
    'docs/rollout-safety.md',
  ])('uses the banner-free direct entrypoint for every rollout command in %s', (path) => {
    const document = readFileSync(join(repoRoot, path), 'utf8')
    const commandLines = document
      .split('\n')
      .filter((line) => (
        line.trimStart().startsWith('npm run rollout:safety ')
        || line.trimStart().startsWith('node scripts/rollout-safety.mjs ')
      ))

    expect(commandLines.length).toBeGreaterThan(0)
    expect(commandLines.every((line) => (
      line.trimStart().startsWith('node scripts/rollout-safety.mjs ')
    ))).toBe(true)
  })
})
