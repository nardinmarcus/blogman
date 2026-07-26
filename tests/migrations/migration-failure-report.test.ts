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
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
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
  if (process.env.FAKE_ENV_OBSERVATION) {
    writeFileSync(process.env.FAKE_ENV_OBSERVATION, JSON.stringify({
      wranglerLog: process.env.WRANGLER_LOG,
      debugBasename: basename(process.env.WRANGLER_LOG_PATH),
      debugMode: statSync(process.env.WRANGLER_LOG_PATH).mode & 0o777,
    }))
  }
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
const hadApplyWrite = mode === 'apply-stop-after-write'
  && process.env.FAKE_APPLY_STATE
  && existsSync(process.env.FAKE_APPLY_STATE)
const fileIndex = process.argv.indexOf('--file')
const commandIndex = process.argv.indexOf('--command')
const transport = commandIndex >= 0 ? 'command' : 'file'
const sql = commandIndex >= 0
  ? process.argv[commandIndex + 1]
  : readFileSync(process.argv[fileIndex + 1], 'utf8')
if (process.env.FAKE_TRANSPORT_OBSERVATION) {
  appendFileSync(process.env.FAKE_TRANSPORT_OBSERVATION, JSON.stringify({
    transport,
    sql,
    arguments: process.argv.slice(2),
  }) + '\\n')
}
if (hadApplyWrite) {
  process.stderr.write('stop after first write')
  process.exit(1)
}
if (mode === 'apply-stop-after-write' && transport === 'file' && process.env.FAKE_APPLY_STATE) {
  writeFileSync(process.env.FAKE_APPLY_STATE, 'written')
}
const emit = (value) => {
  if (!process.env.FAKE_REQUIRE_LOG_LEVEL || process.env.WRANGLER_LOG === 'log') {
    process.stdout.write(value)
  }
}
if (sql.includes("WHERE lower(name) IN")) {
  emit(JSON.stringify([{ results: [{ count: 0 }] }]))
} else if (sql.includes("name NOT LIKE 'sqlite_%'")) {
  emit(JSON.stringify([{ results: [{ count: ['schema-contract', 'business-schema'].includes(mode) ? 1 : 0 }] }]))
} else if (mode === 'schema-contract') {
  emit(JSON.stringify([{ results: [{ issue: 'sensitive schema detail' }] }]))
} else {
  emit(JSON.stringify([{ results: [] }]))
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

function runApply(
  fixture: ReturnType<typeof createFixture>,
  mode: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [
    fixture.runner,
    'apply',
    '--candidate',
    'transport-regression',
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
    env: { ...process.env, NODE_ENV: 'test', FAKE_WRANGLER_MODE: mode, ...environment },
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
  it('sends every remote plan read through Wrangler command transport', () => {
    const fixture = createFixture(true)
    const report = join(fixture.root, 'command-transport-success.json')
    const observation = join(fixture.root, 'command-transport-argv.jsonl')
    const result = runPlan(fixture, report, 'business-schema', {
      FAKE_TRANSPORT_OBSERVATION: observation,
    })

    expect(result.status).toBe(0)
    const calls = readFileSync(observation, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { transport: string; sql: string; arguments: string[] })
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.transport).toBe('command')
      expect(call.arguments).toContain('--command')
      expect(call.arguments).not.toContain('--file')
    }
    expect(calls.some((call) => call.sql.startsWith('EXPLAIN '))).toBe(true)
    expect(calls.some((call) => call.sql.includes("SELECT 'sensitive schema detail' AS issue"))).toBe(true)
  })

  it('keeps a remote apply write batch on file transport and does not retry it', () => {
    const fixture = createFixture()
    const observation = join(fixture.root, 'apply-transport-argv.jsonl')
    const applyState = join(fixture.root, 'apply-state')
    const result = runApply(fixture, 'apply-stop-after-write', {
      FAKE_TRANSPORT_OBSERVATION: observation,
      FAKE_APPLY_STATE: applyState,
    })

    expect(result.status).toBe(1)
    const calls = readFileSync(observation, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { transport: string; sql: string; arguments: string[] })
    const writes = calls.filter((call) => call.transport === 'file')
    expect(writes).toHaveLength(1)
    expect(writes[0].arguments).toContain('--file')
    expect(writes[0].arguments).not.toContain('--command')
    expect(writes[0].sql).toContain('CREATE TABLE migration_ledger')
    expect(writes[0].sql).toContain('CREATE TABLE sample')
    expect(calls.filter((call) => call.transport === 'command').length).toBeGreaterThan(0)
  })

  it.each(['error', 'none'])('forces private Wrangler JSON output when the parent log level is %s', (parentLogLevel) => {
    const fixture = createFixture()
    const report = join(fixture.root, `${parentLogLevel}-success.json`)
    const observation = join(fixture.root, `${parentLogLevel}-child-env.json`)
    const result = runPlan(fixture, report, 'success', {
      WRANGLER_LOG: parentLogLevel,
      FAKE_REQUIRE_LOG_LEVEL: '1',
      FAKE_ENV_OBSERVATION: observation,
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'pending' })
    expect(existsSync(report)).toBe(false)
    expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({
      wranglerLog: 'log',
      debugBasename: 'wrangler-debug.log',
      debugMode: 0o600,
    })
    expectRawOutputDestroyed(fixture.root)
  })

  it('uses and destroys a private mode-0600 debug log after child failure', () => {
    const fixture = createFixture()
    const report = join(fixture.root, 'debug-log-child-failure.json')
    const observation = join(fixture.root, 'debug-log-child-failure-env.json')
    const result = runPlan(fixture, report, 'child-nonzero', {
      WRANGLER_LOG: 'none',
      FAKE_ENV_OBSERVATION: observation,
    })

    expect(result.status).toBe(1)
    expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({
      wranglerLog: 'log',
      debugBasename: 'wrangler-debug.log',
      debugMode: 0o600,
    })
    expectRawOutputDestroyed(fixture.root)
  })

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
