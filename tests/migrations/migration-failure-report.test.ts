import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const sourceRunner = join(process.cwd(), 'scripts', 'migrations.mjs')
const temporaryDirectories: string[] = []

function createFixture(withBaseline = false, privateTimeoutMs = 300_000) {
  const root = mkdtempSync(join(tmpdir(), 'blogman-migration-failure-report-'))
  temporaryDirectories.push(root)
  const runner = join(root, 'scripts', 'migrations.mjs')
  const migrations = join(root, 'migrations')
  const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
  mkdirSync(dirname(runner), { recursive: true })
  mkdirSync(migrations)
  mkdirSync(dirname(wrangler), { recursive: true })
  const runnerSource = readFileSync(sourceRunner, 'utf8').replace(
    'const privatePlanTimeoutMs = 300_000',
    `const privatePlanTimeoutMs = ${privateTimeoutMs}`,
  )
  writeFileSync(runner, runnerSource)
  writeFileSync(
    join(migrations, '001_initial.sql'),
    '-- migration-number: 001\nCREATE TABLE sample (id INTEGER PRIMARY KEY);\n',
  )
  if (withBaseline) {
    writeFileSync(
      join(migrations, '001_initial.baseline.sql'),
      "SELECT 'sensitive schema detail' AS issue;\n",
    )
  }
  writeFileSync(wrangler, `#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const mode = process.env.FAKE_WRANGLER_MODE
if (process.env.FAKE_START_MARKER) appendFileSync(process.env.FAKE_START_MARKER, 'started\\n')
if (process.env.WRANGLER_LOG_PATH?.includes('.migration-plan-raw-')) {
  const permissions = [
    statSync(process.env.WRANGLER_LOG_PATH).mode & 0o777,
    statSync('/dev/fd/1').mode & 0o777,
    statSync('/dev/fd/2').mode & 0o777,
  ]
  if (permissions.some((value) => value !== 0o600)) process.exit(97)
  if ((statSync(dirname(process.env.WRANGLER_LOG_PATH)).mode & 0o777) !== 0o700) process.exit(98)
  writeFileSync(process.env.WRANGLER_LOG_PATH, 'secret debug URL and credential')
}
if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 10_000))
if (mode === 'signal') process.kill(process.pid, 'SIGTERM')
if (mode === 'child-nonzero') {
  process.stderr.write('secret credential and https://api.cloudflare.example/body\\n')
  process.exit(23)
}
if (mode === 'auth') {
  process.stderr.write('Unauthorized API token secret\\n')
  process.exit(1)
}
if (mode === 'network-api') {
  process.stderr.write('fetch failed ECONNRESET https://api.cloudflare.example/body\\n')
  process.exit(1)
}
if (mode === 'mixed-signals') {
  process.stderr.write('Unauthorized API token and fetch failed ECONNRESET\\n')
  process.exit(1)
}
if (mode === 'malformed-json') {
  process.stdout.write('not-json secret response body')
  process.exit(0)
}
if (mode === 'wrong-envelope') {
  process.stdout.write(JSON.stringify({ results: [] }))
  process.exit(0)
}
if (mode === 'missing-results') {
  process.stdout.write(JSON.stringify([{}]))
  process.exit(0)
}
const fileIndex = process.argv.indexOf('--file')
const sql = readFileSync(process.argv[fileIndex + 1], 'utf8')
if (sql.includes("WHERE lower(name) IN")) {
  process.stdout.write(JSON.stringify([{ results: [{ count: 0 }] }]))
} else if (sql.includes("name NOT LIKE 'sqlite_%'")) {
  process.stdout.write(JSON.stringify([{ results: [{ count: mode === 'schema-contract' ? 1 : 0 }] }]))
} else if (mode === 'schema-contract') {
  process.stdout.write(JSON.stringify([{ results: [{ issue: 'sensitive schema detail' }] }]))
} else {
  process.stdout.write(JSON.stringify([{ results: [] }]))
}
`)
  chmodSync(wrangler, 0o755)
  return { root, runner, migrations, wrangler }
}

function runPlan(
  fixture: ReturnType<typeof createFixture>,
  report: string,
  mode: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [
    fixture.runner,
    'plan',
    '--database',
    'DB',
    '--remote',
    '--config',
    join(fixture.root, 'wrangler.toml'),
    '--migrations-dir',
    fixture.migrations,
    '--failure-report',
    report,
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', FAKE_WRANGLER_MODE: mode, ...environment },
  })
}

function runPlainPlan(fixture: ReturnType<typeof createFixture>, mode: string) {
  return spawnSync(process.execPath, [
    fixture.runner,
    'plan',
    '--database',
    'DB',
    '--remote',
    '--config',
    join(fixture.root, 'wrangler.toml'),
    '--migrations-dir',
    fixture.migrations,
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, FAKE_WRANGLER_MODE: mode },
  })
}

function readFailureReport(report: string) {
  const parsed = JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>
  expect(Object.keys(parsed).sort()).toEqual([
    'command',
    'exit_class',
    'failure_domain',
    'failure_hint',
    'format',
    'mode',
    'phase',
    'query_ordinal',
    'state',
  ])
  return parsed
}

function expectRawOutputDestroyed(root: string) {
  expect(readdirSync(root).filter((name) => name.startsWith('.migration-plan-raw-'))).toEqual([])
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('remote migration plan failure reports', () => {
  it('classifies schema contract failures without retaining schema details', () => {
    const fixture = createFixture(true)
    const report = join(fixture.root, 'schema-failure.json')
    const result = runPlan(fixture, report, 'schema-contract')

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('Migration plan failed; see sanitized failure report.\n')
    expect(`${result.stdout}${result.stderr}${readFileSync(report, 'utf8')}`)
      .not.toContain('sensitive schema detail')
    expect(readFailureReport(report)).toEqual({
      format: 'blogman-migration-failure/v1',
      state: 'failed',
      command: 'plan',
      mode: 'remote',
      failure_domain: 'schema_contract',
      failure_hint: 'none',
      phase: 'schema_validation',
      query_ordinal: 4,
      exit_class: 'runner_error',
    })
    expect(statSync(report).mode & 0o777).toBe(0o600)
    expectRawOutputDestroyed(fixture.root)
  })

  it('classifies a command that cannot start', () => {
    const fixture = createFixture()
    rmSync(fixture.wrangler)
    const report = join(fixture.root, 'command-start.json')
    const result = runPlan(fixture, report, 'success')

    expect(result.status).toBe(1)
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'wrangler_command',
      failure_hint: 'none',
      phase: 'wrangler_execute',
      query_ordinal: 1,
      exit_class: 'spawn_error',
    })
  })

  it('classifies malformed Wrangler JSON without retaining the response', () => {
    const fixture = createFixture()
    const report = join(fixture.root, 'malformed-json.json')
    const result = runPlan(fixture, report, 'malformed-json')

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}${readFileSync(report, 'utf8')}`)
      .not.toContain('secret response body')
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'malformed_response',
      failure_hint: 'none',
      phase: 'response_decode',
      query_ordinal: 1,
      exit_class: 'invalid_json',
    })
  })

  it.each(['wrong-envelope', 'missing-results'])('rejects the %s response shape', (mode) => {
    const fixture = createFixture()
    const report = join(fixture.root, `${mode}.json`)
    const result = runPlan(fixture, report, mode)

    expect(result.status).toBe(1)
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'malformed_response',
      failure_hint: 'none',
      phase: 'response_decode',
      query_ordinal: 1,
      exit_class: 'invalid_shape',
    })
    expectRawOutputDestroyed(fixture.root)
  })

  it('classifies an unrecognized child failure as unknown without retaining raw output', () => {
    const fixture = createFixture()
    const report = join(fixture.root, 'unknown.json')
    const result = runPlan(fixture, report, 'child-nonzero')

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}${readFileSync(report, 'utf8')}`)
      .not.toMatch(/credential|cloudflare\.example|response body/)
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'wrangler_command',
      failure_hint: 'none',
      phase: 'wrangler_execute',
      query_ordinal: 1,
      exit_class: 'child_nonzero',
    })
    expectRawOutputDestroyed(fixture.root)
  })

  it.each([
    ['timeout', 'timeout'],
    ['signal', 'signal'],
  ])('stops once on %s and destroys all private output', (mode, exitClass) => {
    const fixture = createFixture()
    const report = join(fixture.root, `${mode}.json`)
    const startMarker = join(fixture.root, `${mode}-starts.txt`)
    const result = runPlan(fixture, report, mode, {
      FAKE_START_MARKER: startMarker,
      BLOGMAN_MIGRATION_TEST_TIMEOUT_MS: '500',
    })

    expect(result.status).toBe(1)
    expect(readFileSync(startMarker, 'utf8')).toBe('started\n')
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'wrangler_command',
      failure_hint: 'none',
      phase: 'wrangler_execute',
      query_ordinal: 1,
      exit_class: exitClass,
    })
    expectRawOutputDestroyed(fixture.root)
  })

  it('never lets the test override exceed the hard timeout ceiling', () => {
    const fixture = createFixture(false, 500)
    const report = join(fixture.root, 'timeout-ceiling.json')
    const startMarker = join(fixture.root, 'timeout-ceiling-starts.txt')
    const result = runPlan(fixture, report, 'timeout', {
      FAKE_START_MARKER: startMarker,
      BLOGMAN_MIGRATION_TEST_TIMEOUT_MS: '999999',
    })

    expect(result.status).toBe(1)
    expect(readFileSync(startMarker, 'utf8')).toBe('started\n')
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'wrangler_command',
      failure_hint: 'none',
      phase: 'wrangler_execute',
      query_ordinal: 1,
      exit_class: 'timeout',
    })
    expectRawOutputDestroyed(fixture.root)
  })

  it.each([
    ['auth', 'auth'],
    ['network-api', 'network_api'],
    ['mixed-signals', 'ambiguous'],
  ])('records %s only as a non-confirmed failure hint', (mode, failureHint) => {
    const fixture = createFixture()
    const report = join(fixture.root, `${mode}.json`)
    const result = runPlan(fixture, report, mode)

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}${readFileSync(report, 'utf8')}`)
      .not.toMatch(/API token secret|cloudflare\.example|response body/)
    expect(readFailureReport(report)).toMatchObject({
      failure_domain: 'wrangler_command',
      failure_hint: failureHint,
      phase: 'wrangler_execute',
      query_ordinal: 1,
      exit_class: 'child_nonzero',
    })
  })

  it('removes the reserved report on success and never overwrites an existing path', () => {
    const fixture = createFixture()
    const successReport = join(fixture.root, 'success.json')
    const success = runPlan(fixture, successReport, 'success')
    expect(success.status).toBe(0)
    expect(existsSync(successReport)).toBe(false)
    expectRawOutputDestroyed(fixture.root)

    const existingReport = join(fixture.root, 'existing.json')
    const startMarker = join(fixture.root, 'starts.txt')
    writeFileSync(existingReport, 'keep-me', { mode: 0o600 })
    const duplicate = runPlan(fixture, existingReport, 'success', { FAKE_START_MARKER: startMarker })
    expect(duplicate.status).toBe(1)
    expect(readFileSync(existingReport, 'utf8')).toBe('keep-me')
    expect(existsSync(startMarker)).toBe(false)
  })

  it.each(['write', 'fsync', 'close', 'unlink'])('fails closed on report %s errors', (point) => {
    const fixture = createFixture()
    const report = join(fixture.root, `${point}.json`)
    const startMarker = join(fixture.root, `${point}-starts.txt`)
    const mode = point === 'unlink' ? 'success' : 'child-nonzero'
    const result = runPlan(fixture, report, mode, {
      FAKE_START_MARKER: startMarker,
      BLOGMAN_MIGRATION_TEST_REPORT_FAILURE: point,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('Migration plan failed; see sanitized failure report.\n')
    expect(readFileSync(startMarker, 'utf8')).toBe(point === 'unlink' ? 'started\nstarted\n' : 'started\n')
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret credential')
    expectRawOutputDestroyed(fixture.root)
  })

  it('preserves ordinary CLI stderr when the production seam is not requested', () => {
    const fixture = createFixture()
    const result = runPlainPlan(fixture, 'child-nonzero')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('secret credential')
  })
})
