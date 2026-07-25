import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const rolloutSafetyUrl = new URL('../../scripts/rollout-safety.mjs', import.meta.url).href
const temporaryDirectories: string[] = []

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-private-export-test-'))
  temporaryDirectories.push(directory)
  const fakeWrangler = join(directory, 'fake-wrangler.mjs')
  const fakeExport = join(directory, 'fake-export.sql')
  const harness = join(directory, 'harness.mjs')
  const tables = ['posts','categories','site_settings','ai_actions','ai_provider_profiles','ai_post_generators','api_tokens']
  const sourceSchema = readFileSync(join(repoRoot, 'db', 'schema.sql'), 'utf8')
  writeFileSync(fakeExport, tables.map((table) => {
    const match = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table} \\([\\s\\S]*?\\n\\);`).exec(sourceSchema)
    if (!match) throw new Error(`Missing test schema for ${table}`)
    return match[0]
  }).join('\n'))
  writeFileSync(fakeWrangler, `
import { chmodSync, fstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
const mode = process.argv[2]
const counter = process.argv[3]
const pidPath = process.argv[4]
const schemaPath = process.argv[5]
let calls = 0
try { calls = Number.parseInt(readFileSync(counter, 'utf8'), 10) } catch {}
writeFileSync(counter, String(calls + 1))
writeFileSync(pidPath, String(process.pid))
const outputIndex = process.argv.indexOf('--output')
const output = process.argv[outputIndex + 1]
const tables = ['posts','categories','site_settings','ai_actions','ai_provider_profiles','ai_post_generators','api_tokens']
const args = process.argv.slice(6)
const tableArgs = args.flatMap((value, index) => value === '--table' ? [args[index + 1]] : [])
if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify(['d1','export','DB','--remote','--skip-confirmation'])
  || JSON.stringify(tableArgs) !== JSON.stringify(tables)
  || args.filter((value) => value === '--output').length !== 1
  || args.filter((value) => value === '--config').length !== 1
  || args[args.indexOf('--config') + 1] !== '/private/wrangler.toml'
  || args.includes('--local')) process.exit(8)
if ((fstatSync(1).mode & 0o777) !== 0o600
  || (fstatSync(2).mode & 0o777) !== 0o600
  || (statSync(process.env.WRANGLER_LOG_PATH).mode & 0o777) !== 0o600
  || (statSync(output).mode & 0o777) !== 0o600) process.exit(9)
writeFileSync(process.env.WRANGLER_LOG_PATH, 'https://debug.example/export?raw_token=debug-secret\\n')
if (mode === 'child-failure') {
  process.stdout.write('https://signed.example/export?token=failed-child-secret\\n')
  process.stderr.write('failed-child-raw-response\\n')
  process.exit(7)
}
if (mode === 'empty') writeFileSync(output, '')
else if (mode === 'malformed') writeFileSync(output, 'not valid sql with raw-response-secret')
else {
  let schema = readFileSync(schemaPath, 'utf8')
  if (mode === 'wrong-schema') schema = schema.replace(/CREATE TABLE(?: IF NOT EXISTS)? api_tokens \\([\\s\\S]*?\\n\\);/, '')
  if (mode === 'wrong-columns') schema = schema.replace('slug TEXT UNIQUE NOT NULL', 'slug INTEGER UNIQUE NOT NULL')
  if (mode === 'extra-column') schema = schema.replace(
    '  view_count INTEGER DEFAULT 0\\n);',
    '  view_count INTEGER DEFAULT 0,\\n  incident_extra TEXT\\n);',
  )
  if (mode === 'allowed-variant-b') {
    schema = schema.replace('  profile_id INTEGER,\\n', '')
      .replace('max_tokens INTEGER NOT NULL DEFAULT 2000', 'max_tokens INTEGER NOT NULL DEFAULT 1200')
  }
  if (mode === 'allowed-variant-c' || mode === 'invalid-variant-c-2000') {
    schema = schema.replace('  profile_id INTEGER,\\n', '')
      .replace(
        "  updated_at INTEGER DEFAULT (strftime('%s', 'now'))\\n);",
        "  updated_at INTEGER DEFAULT (strftime('%s', 'now')),\\n  profile_id INTEGER\\n);",
      )
    if (mode === 'allowed-variant-c') {
      schema = schema.replace('max_tokens INTEGER NOT NULL DEFAULT 2000', 'max_tokens INTEGER NOT NULL DEFAULT 1200')
    }
  }
  if (mode === 'invalid-variant-a-1200') {
    schema = schema.replace('max_tokens INTEGER NOT NULL DEFAULT 2000', 'max_tokens INTEGER NOT NULL DEFAULT 1200')
  }
  writeFileSync(output, schema)
}
chmodSync(output, 0o600)
if (mode === 'bad-permissions') chmodSync(output, 0o644)
process.stdout.write('https://signed.example/export?token=must-not-reach-parent\\n')
process.stderr.write('raw-wrangler-response-must-not-reach-parent\\n')
if (mode === 'timeout') setInterval(() => {}, 60_000)
`)
  writeFileSync(harness, `
import { capturePrivateD1Export, disposePrivateD1Export } from ${JSON.stringify(rolloutSafetyUrl)}
try {
  const report = process.argv[2] === 'dispose'
    ? disposePrivateD1Export({ runRoot: process.argv[3] })
    : capturePrivateD1Export({
        runRoot: process.argv[3],
        database: 'DB',
        config: '/private/wrangler.toml',
        command: process.execPath,
        commandArgsPrefix: [process.argv[4], process.argv[2], process.argv[5], process.argv[6], process.argv[7]],
        ...(process.argv[8] ? { timeoutMs: Number(process.argv[8]) } : {}),
      })
  process.stdout.write(JSON.stringify(report) + '\\n')
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'private export failed') + '\\n')
  process.exitCode = 1
}
`)
  return {
    directory,
    fakeWrangler,
    harness,
    counter: join(directory, 'calls.txt'),
    pid: join(directory, 'child.pid'),
    fakeExport,
    defaultDebug: join(directory, 'forbidden-default-wrangler.log'),
  }
}

function runExport(
  fixture: ReturnType<typeof createFixture>,
  runRoot: string,
  mode = 'success',
  timeoutMs?: number,
) {
  return spawnSync(process.execPath, [
    fixture.harness,
    mode,
    runRoot,
    fixture.fakeWrangler,
    fixture.counter,
    fixture.pid,
    fixture.fakeExport,
    ...(timeoutMs ? [String(timeoutMs)] : []),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_LOG_PATH: fixture.defaultDebug },
  })
}

function runDispose(fixture: ReturnType<typeof createFixture>, runRoot: string) {
  return spawnSync(process.execPath, [fixture.harness, 'dispose', runRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function allFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? allFiles(path) : [path]
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('private D1 export capture', () => {
  it('prevents signed URLs and raw Wrangler responses from reaching parent output', () => {
    const fixture = createFixture()
    const runRoot = join(fixture.directory, 'run-r1')
    const result = runExport(fixture, runRoot)

    expect(result.status, result.stderr).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/signed\.example|token=|raw-wrangler-response/)
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: 'blogman-d1-private-export/v1',
      state: 'captured',
      attempt_count: 1,
    })
    expect(readFileSync(join(runRoot, 'export-report.json'), 'utf8')).toBe(result.stdout)
    expect(statSync(runRoot).mode & 0o777).toBe(0o700)
    expect(statSync(join(runRoot, 'backup', 'regular-tables.sql')).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(runRoot, 'private'))).toEqual([])
    expect(existsSync(fixture.defaultDebug)).toBe(false)
    const retained = allFiles(runRoot).map((path) => readFileSync(path, 'utf8')).join('\n')
    expect(retained).not.toMatch(/signed\.example|token=|raw-wrangler-response/)
  })

  it.each([
    'child-failure',
    'empty',
    'malformed',
    'wrong-schema',
    'wrong-columns',
    'extra-column',
    'invalid-variant-a-1200',
    'invalid-variant-c-2000',
    'bad-permissions',
  ])(
    'fails closed for %s and removes every raw artifact',
    (mode) => {
      const fixture = createFixture()
      const runRoot = join(fixture.directory, `run-${mode}`)
      const result = runExport(fixture, runRoot, mode)

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toMatch(/signed\.example|token=|raw-response|raw-wrangler/)
      expect(JSON.parse(readFileSync(join(runRoot, 'export-report.json'), 'utf8'))).toEqual({
        format: 'blogman-d1-private-export/v1',
        state: 'failed',
        attempt_count: 1,
      })
      expect(readdirSync(join(runRoot, 'private'))).toEqual([])
      expect(existsSync(fixture.defaultDebug)).toBe(false)
      expect(existsSync(join(runRoot, 'backup', 'regular-tables.sql'))).toBe(false)
      expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    },
  )

  it.each(['allowed-variant-b', 'allowed-variant-c'])(
    'accepts the frozen Issue #21 %s column contract',
    (mode) => {
      const fixture = createFixture()
      const runRoot = join(fixture.directory, `run-${mode}`)

      const result = runExport(fixture, runRoot, mode)

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).state).toBe('captured')
      expect(readdirSync(join(runRoot, 'private'))).toEqual([])
      expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    },
  )

  it('securely disposes the accepted raw SQL only at the explicit lifecycle boundary', () => {
    const fixture = createFixture()
    const runRoot = join(fixture.directory, 'run-dispose')
    expect(runExport(fixture, runRoot).status).toBe(0)
    expect(existsSync(join(runRoot, 'backup', 'regular-tables.sql'))).toBe(true)
    mkdirSync(join(runRoot, 'private', 'nested'), { mode: 0o700 })
    writeFileSync(join(runRoot, 'private', 'validation.sqlite-journal'), 'raw-sidecar-secret', { mode: 0o600 })
    writeFileSync(join(runRoot, 'private', 'nested', 'debug.log'), 'raw-debug-secret', { mode: 0o600 })

    const disposed = runDispose(fixture, runRoot)

    expect(disposed.status, disposed.stderr).toBe(0)
    expect(JSON.parse(disposed.stdout)).toEqual({
      format: 'blogman-d1-private-export-disposal/v1',
      state: 'disposed',
      attempt_count: 1,
      raw_artifacts_remaining: 0,
    })
    expect(existsSync(join(runRoot, 'backup', 'regular-tables.sql'))).toBe(false)
    expect(allFiles(join(runRoot, 'private'))).toEqual([])
  })

  it('refuses to certify disposal while the child terminal state is unknown', () => {
    const fixture = createFixture()
    const runRoot = join(fixture.directory, 'run-started')
    mkdirSync(join(runRoot, 'backup'), { recursive: true, mode: 0o700 })
    mkdirSync(join(runRoot, 'private'), { mode: 0o700 })
    writeFileSync(join(runRoot, 'export-report.json'), JSON.stringify({
      format: 'blogman-d1-private-export/v1',
      state: 'started',
      attempt_count: 1,
    }), { mode: 0o600 })
    writeFileSync(join(runRoot, 'private', 'wrangler.debug'), 'raw-live-secret', { mode: 0o600 })

    const disposed = runDispose(fixture, runRoot)

    expect(disposed.status).not.toBe(0)
    expect(disposed.stdout).toBe('')
    expect(disposed.stderr).toBe('Private D1 export report cannot be disposed\n')
    expect(existsSync(join(runRoot, 'dispose-report.json'))).toBe(false)
    expect(readFileSync(join(runRoot, 'private', 'wrangler.debug'), 'utf8')).toBe('raw-live-secret')
  })

  it('refuses a duplicate run root before starting a second child attempt', () => {
    const fixture = createFixture()
    const runRoot = join(fixture.directory, 'run-duplicate')
    expect(runExport(fixture, runRoot).status).toBe(0)

    const duplicate = runExport(fixture, runRoot)

    expect(duplicate.status).not.toBe(0)
    expect(duplicate.stderr).toBe('Private D1 export run root already exists; retries are forbidden\n')
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    expect(JSON.parse(readFileSync(join(runRoot, 'export-report.json'), 'utf8')).attempt_count).toBe(1)
  })

  it('kills a timed-out child and preserves one-attempt private cleanup', () => {
    const fixture = createFixture()
    const runRoot = join(fixture.directory, 'run-timeout')

    const timedOut = runExport(fixture, runRoot, 'timeout', 100)

    expect(timedOut.status).not.toBe(0)
    expect(timedOut.stdout).toBe('')
    expect(timedOut.stderr).toBe('Private D1 export subprocess failed\n')
    expect(JSON.parse(readFileSync(join(runRoot, 'export-report.json'), 'utf8'))).toEqual({
      format: 'blogman-d1-private-export/v1',
      state: 'failed',
      attempt_count: 1,
    })
    expect(readdirSync(join(runRoot, 'private'))).toEqual([])
    expect(existsSync(join(runRoot, 'backup', 'regular-tables.sql'))).toBe(false)
    expect(existsSync(fixture.defaultDebug)).toBe(false)
    const childPid = Number.parseInt(readFileSync(fixture.pid, 'utf8'), 10)
    expect(() => process.kill(childPid, 0)).toThrow()

    const duplicate = runExport(fixture, runRoot)
    expect(duplicate.status).not.toBe(0)
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
  })

  it('makes the private wrapper and disposal path mandatory in the Phase B runbook', () => {
    const runbook = readFileSync(join(repoRoot, 'docs', 'issue-23-phase-b-runbook.md'), 'utf8')

    expect(runbook).toContain('node scripts/rollout-safety.mjs backup export')
    expect(runbook).toContain('node scripts/rollout-safety.mjs backup dispose')
    expect(runbook).not.toMatch(/^\.\/node_modules\/\.bin\/wrangler d1 export/m)
  })
})
