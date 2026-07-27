import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const temporaryDirectories: string[] = []
const baselineSha256 = 'b3f61982cc36ff2c88d7b4330dd304ef075b5c5c34debf4499671c33ae2b6540'
const replacementSha256 = '90c94ce79e77d3ca3ab22fc67f702243e7305bcd1860f3d1feb2026fb56b4a03'

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function createFixture(includeReplacement = true) {
  const root = mkdtempSync(join(tmpdir(), 'blogman-remote-baseline-runner-'))
  temporaryDirectories.push(root)
  const runner = join(root, 'scripts', 'migrations.mjs')
  const migrations = join(root, 'migrations')
  const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
  const observation = join(root, 'calls.jsonl')
  mkdirSync(dirname(runner), { recursive: true })
  mkdirSync(migrations)
  mkdirSync(dirname(wrangler), { recursive: true })
  copyFileSync(join(repoRoot, 'scripts', 'migrations.mjs'), runner)
  for (const name of ['001_initial_schema.sql', '001_initial_schema.baseline.sql']) {
    copyFileSync(join(repoRoot, 'db', 'ledger-migrations', name), join(migrations, name))
  }
  if (includeReplacement) {
    copyFileSync(
      join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.remote.baseline.sql'),
      join(migrations, '001_initial_schema.remote.baseline.sql'),
    )
  }
  writeFileSync(join(root, 'wrangler.toml'), 'name = "fixture"\n')
  writeFileSync(wrangler, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
const commandIndex = process.argv.indexOf('--command')
const fileIndex = process.argv.indexOf('--file')
const sql = commandIndex >= 0
  ? process.argv[commandIndex + 1]
  : readFileSync(process.argv[fileIndex + 1], 'utf8')
const privateModes = process.env.WRANGLER_LOG_PATH ? {
  stdoutMode: statSync('/dev/fd/1').mode & 0o777,
  stderrMode: statSync('/dev/fd/2').mode & 0o777,
  debugMode: statSync(process.env.WRANGLER_LOG_PATH).mode & 0o777,
} : {}
appendFileSync(process.env.FAKE_OBSERVATION, JSON.stringify({
  sql,
  arguments: process.argv.slice(2),
  ...privateModes,
}) + '\\n')
const emit = (results) => process.stdout.write(JSON.stringify([{ success: true, results }]))
if (sql.includes("WHERE lower(name) IN")) {
  emit([{ count: 0 }])
} else if (sql.includes("name NOT LIKE 'sqlite_%'") && sql.includes("migration_ledger%")) {
  emit([{ count: 1 }])
} else if (process.env.FAKE_FAIL_OBJECT_TYPE
  && !sql.startsWith('EXPLAIN ')
  && sql.includes("sqlite_schema.type = '" + process.env.FAKE_FAIL_OBJECT_TYPE + "'")) {
  process.stderr.write('private remote object failure body')
  process.exit(7)
} else if (process.env.FAKE_FAIL_TABLE
  && !sql.startsWith('EXPLAIN ')
  && sql.includes("pragma_table_info('" + process.env.FAKE_FAIL_TABLE + "')")) {
  process.stderr.write('private remote failure body')
  process.exit(7)
} else if (process.env.FAKE_RESPONSE_MODE
  && !sql.startsWith('EXPLAIN ')
  && sql.includes("pragma_table_info('ai_provider_profiles')")) {
  if (process.env.FAKE_RESPONSE_MODE === 'failed') {
    process.stdout.write(JSON.stringify([{ success: false, results: [] }]))
  } else if (process.env.FAKE_RESPONSE_MODE === 'unknown') {
    process.stdout.write(JSON.stringify([{ results: [] }]))
  } else if (process.env.FAKE_RESPONSE_MODE === 'multiple') {
    process.stdout.write(JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [] },
    ]))
  } else if (process.env.FAKE_RESPONSE_MODE === 'malformed') {
    process.stdout.write('LEAK1234 private malformed response payload')
  }
} else if (sql.startsWith('EXPLAIN ')) {
  emit([])
} else if (sql.includes("coalesce(sql, '') AS sql")) {
  const state = process.env.FAKE_FINGERPRINT_STATE
  const fingerprintCall = state && existsSync(state)
    ? Number(readFileSync(state, 'utf8')) + 1
    : 1
  if (state) writeFileSync(state, String(fingerprintCall))
  const driftAt = Number(process.env.FAKE_FINGERPRINT_DRIFT_AT || 2)
  if (state && fingerprintCall >= driftAt) {
    emit([{ type: 'table', name: 'changed', tbl_name: 'changed', sql: 'CREATE TABLE changed(id)' }])
  } else {
    emit([{ type: 'table', name: 'stable', tbl_name: 'stable', sql: 'CREATE TABLE stable(id)' }])
  }
} else if (process.env.FAKE_INVALID_ISSUE_TABLE
  && sql.includes("pragma_table_info('" + process.env.FAKE_INVALID_ISSUE_TABLE + "')")) {
  emit([{ issue: 'private schema detail' }])
} else if (process.env.FAKE_MISSING_OBJECT
  && !sql.startsWith('EXPLAIN ')
  && sql.includes("('" + process.env.FAKE_MISSING_OBJECT + "')")) {
  emit([{ issue: 'missing index ' + process.env.FAKE_MISSING_OBJECT }])
} else if (process.env.FAKE_FAIL_PREFLIGHT === '1'
  && !sql.startsWith('EXPLAIN ')
  && sql.includes('later preflight failed')) {
  emit([{ issue: 'later preflight failed' }])
} else if (process.env.FAKE_DRIFT_PREFLIGHT === '1'
  && !sql.startsWith('EXPLAIN ')
  && sql.includes('later preflight failed')) {
  if (existsSync(process.env.FAKE_PREFLIGHT_STATE)) emit([{ issue: 'later preflight failed' }])
  else {
    writeFileSync(process.env.FAKE_PREFLIGHT_STATE, 'validated')
    emit([])
  }
} else if (process.env.FAKE_FAIL_WRITE === '1' && fileIndex >= 0) {
  process.stderr.write('stop at first write')
  process.exit(8)
} else {
  emit([])
}
`)
  chmodSync(wrangler, 0o755)
  return { root, runner, migrations, observation }
}

function runPlan(
  fixture: ReturnType<typeof createFixture>,
  extraEnvironment: Record<string, string> = {},
) {
  const report = join(fixture.root, 'failure.json')
  const result = spawnSync(process.execPath, [
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
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FAKE_OBSERVATION: fixture.observation,
      ...extraEnvironment,
    },
  })
  return { report, result }
}

function runLocalPlan(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(process.execPath, [
    fixture.runner,
    'plan',
    '--database',
    'DB',
    '--local',
    '--persist-to',
    join(fixture.root, 'local-state'),
    '--config',
    join(fixture.root, 'wrangler.toml'),
    '--migrations-dir',
    fixture.migrations,
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_OBSERVATION: fixture.observation,
    },
  })
}

function runRemoteApply(
  fixture: ReturnType<typeof createFixture>,
  extraEnvironment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [
    fixture.runner,
    'apply',
    '--database',
    'DB',
    '--remote',
    '--candidate',
    'test-candidate',
    '--config',
    join(fixture.root, 'wrangler.toml'),
    '--migrations-dir',
    fixture.migrations,
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_OBSERVATION: fixture.observation,
      FAKE_FAIL_WRITE: '1',
      ...extraEnvironment,
    },
  })
}

interface ObservedCall {
  sql: string
  arguments: string[]
  stdoutMode: number
  stderrMode: number
  debugMode: number
}

function calls(fixture: ReturnType<typeof createFixture>): ObservedCall[] {
  if (!existsSync(fixture.observation)) return []
  return readFileSync(fixture.observation, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ObservedCall)
}

function readFailure(report: string) {
  return JSON.parse(readFileSync(report, 'utf8'))
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('remote baseline replacement runner', () => {
  it('uses six private one-shot probes and retains ordinary EXPLAIN proofs', () => {
    const fixture = createFixture()
    const { report, result } = runPlan(fixture)

    expect(result.status).toBe(0)
    expect(existsSync(report)).toBe(false)
    const observed = calls(fixture)
    expect(observed.every((call) => (
      call.arguments.includes('--command')
      && !call.arguments.includes('--file')
      && call.stdoutMode === 0o600
      && call.stderrMode === 0o600
      && call.debugMode === 0o600
    ))).toBe(true)

    const originalLargeStatement = observed.filter((call) => (
      call.sql.includes("pragma_table_info('ai_provider_profiles')")
      && call.sql.includes("pragma_table_info('ai_post_generators')")
      && call.sql.includes("pragma_table_info('api_tokens')")
    ))
    expect(originalLargeStatement).toEqual([])

    const originalRequiredObjectsStatement = observed.filter((call) => (
      call.sql.includes("('table', 'posts')")
      && call.sql.includes("('index', 'idx_posts_slug')")
      && call.sql.includes("('trigger', 'posts_ai')")
    ))
    expect(originalRequiredObjectsStatement).toEqual([])

    for (const marker of [
      "sqlite_schema.type = 'table'",
      "sqlite_schema.type = 'index'",
      "sqlite_schema.type = 'trigger'",
    ]) {
      const objectCalls = observed.filter((call) => call.sql.includes(marker))
      expect(objectCalls).toHaveLength(2)
      expect(objectCalls.filter((call) => call.sql.startsWith('EXPLAIN '))).toHaveLength(1)
      expect(objectCalls.filter((call) => !call.sql.startsWith('EXPLAIN '))).toHaveLength(1)
    }

    for (const table of ['ai_provider_profiles', 'ai_post_generators', 'api_tokens']) {
      const tableCalls = observed.filter((call) => call.sql.includes(`pragma_table_info('${table}')`))
      expect(tableCalls).toHaveLength(2)
      expect(tableCalls.filter((call) => call.sql.startsWith('EXPLAIN '))).toHaveLength(1)
      expect(tableCalls.filter((call) => !call.sql.startsWith('EXPLAIN '))).toHaveLength(1)
    }

    const firstReplacement = observed.findIndex((call) => (
      call.sql.includes("pragma_table_info('ai_provider_profiles')")
    ))
    const lastReplacement = observed.findLastIndex((call) => (
      call.sql.includes("pragma_table_info('api_tokens')")
    ))
    const firstObjectReplacement = observed.findIndex((call) => (
      call.sql.includes("sqlite_schema.type = 'table'")
    ))
    const lastObjectReplacement = observed.findLastIndex((call) => (
      call.sql.includes("sqlite_schema.type = 'trigger'")
    ))
    const fingerprintCalls = observed
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.sql.includes("coalesce(sql, '') AS sql"))
    expect(fingerprintCalls).toHaveLength(8)
    expect(fingerprintCalls[1].index).toBeLessThan(firstObjectReplacement)
    expect(fingerprintCalls[2].index).toBeGreaterThan(lastObjectReplacement)
    expect(fingerprintCalls[5].index).toBeLessThan(firstReplacement)
    expect(fingerprintCalls[6].index).toBeGreaterThan(lastReplacement)

    const ordinaryDefinitionProbe = observed.filter((call) => (
      call.sql.includes('expected_definitions(type, name, normalized_sql)')
    ))
    expect(ordinaryDefinitionProbe).toHaveLength(2)
    expect(ordinaryDefinitionProbe[0].sql.startsWith('EXPLAIN ')).toBe(true)
  })

  it('keeps the frozen large statement and file transport for local baseline validation', () => {
    const fixture = createFixture()
    const result = runLocalPlan(fixture)

    expect(result.status).toBe(0)
    const observed = calls(fixture)
    expect(observed.every((call) => (
      call.arguments.includes('--file') && !call.arguments.includes('--command')
    ))).toBe(true)
    const originalLargeStatement = observed.filter((call) => (
      call.sql.includes("pragma_table_info('ai_provider_profiles')")
      && call.sql.includes("pragma_table_info('ai_post_generators')")
      && call.sql.includes("pragma_table_info('api_tokens')")
    ))
    expect(originalLargeStatement).toHaveLength(2)
    expect(originalLargeStatement.some((call) => call.sql.startsWith('EXPLAIN '))).toBe(true)
  })

  it('runs the replacement suite once per remote apply invocation', () => {
    const fixture = createFixture()
    const result = runRemoteApply(fixture)

    expect(result.status).toBe(1)
    const observed = calls(fixture)
    for (const table of ['ai_provider_profiles', 'ai_post_generators', 'api_tokens']) {
      expect(observed.filter((call) => call.sql.includes(`pragma_table_info('${table}')`)))
        .toHaveLength(2)
    }
    expect(observed.filter((call) => call.arguments.includes('--file'))).toHaveLength(1)
  })

  it('runs every pending preflight before the first remote apply write', () => {
    const fixture = createFixture()
    writeFileSync(
      join(fixture.migrations, '002_second.sql'),
      '-- migration-number: 002\nCREATE TABLE second_marker (id INTEGER PRIMARY KEY);\n',
    )
    writeFileSync(
      join(fixture.migrations, '003_later.sql'),
      '-- migration-number: 003\nCREATE TABLE later_marker (id INTEGER PRIMARY KEY);\n',
    )
    writeFileSync(
      join(fixture.migrations, '003_later.preflight.sql'),
      "SELECT 'later preflight failed' AS issue;\n",
    )

    const result = runRemoteApply(fixture, {
      FAKE_FAIL_WRITE: '0',
      FAKE_FAIL_PREFLIGHT: '1',
    })

    expect(result.status).toBe(1)
    expect(calls(fixture).some((call) => call.arguments.includes('--file'))).toBe(false)
  })

  it('passes allowlisted object issues into baseline compatibility matching', { timeout: 15_000 }, () => {
    const fixture = createFixture()
    writeFileSync(
      join(fixture.migrations, '002_allow_missing_index.sql'),
      [
        '-- migration-number: 002',
        '-- migration-baseline-compatibility',
        '-- migration-baseline-allow-issues: missing index idx_posts_published',
        'SELECT 1;',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(fixture.migrations, '002_allow_missing_index.baseline.sql'),
      'SELECT NULL AS issue WHERE 0;\n',
    )

    const { report, result } = runPlan(fixture, {
      FAKE_MISSING_OBJECT: 'idx_posts_published',
    })

    expect(result.status).toBe(0)
    expect(existsSync(report)).toBe(false)
  })

  it('revalidates a later preflight after an earlier migration writes', () => {
    const fixture = createFixture()
    writeFileSync(
      join(fixture.migrations, '002_second.sql'),
      '-- migration-number: 002\nCREATE TABLE second_marker (id INTEGER PRIMARY KEY);\n',
    )
    writeFileSync(
      join(fixture.migrations, '003_later.sql'),
      '-- migration-number: 003\nCREATE TABLE later_marker (id INTEGER PRIMARY KEY);\n',
    )
    writeFileSync(
      join(fixture.migrations, '003_later.preflight.sql'),
      "SELECT 'later preflight failed' AS issue;\n",
    )

    const result = runRemoteApply(fixture, {
      FAKE_FAIL_WRITE: '0',
      FAKE_DRIFT_PREFLIGHT: '1',
      FAKE_PREFLIGHT_STATE: join(fixture.root, 'preflight-state'),
    })

    expect(result.status).toBe(1)
    expect(calls(fixture).filter((call) => call.arguments.includes('--file'))).toHaveLength(1)
  })

  it.each([
    ['missing replacement', (fixture: ReturnType<typeof createFixture>) => (
      rmSync(join(fixture.migrations, '001_initial_schema.remote.baseline.sql'))
    )],
    ['replacement content drift', (fixture: ReturnType<typeof createFixture>) => {
      const path = join(fixture.migrations, '001_initial_schema.remote.baseline.sql')
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
    }],
    ['replacement header drift', (fixture: ReturnType<typeof createFixture>) => {
      const path = join(fixture.migrations, '001_initial_schema.remote.baseline.sql')
      const changed = readFileSync(path, 'utf8').replace('groups=1:', 'groups=2:')
      writeFileSync(path, changed)
      writeFileSync(
        fixture.runner,
        readFileSync(fixture.runner, 'utf8').replace(replacementSha256, sha256(changed)),
      )
    }],
    ['full baseline drift', (fixture: ReturnType<typeof createFixture>) => {
      const path = join(fixture.migrations, '001_initial_schema.baseline.sql')
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
    }],
    ['source statement drift', (fixture: ReturnType<typeof createFixture>) => {
      const path = join(fixture.migrations, '001_initial_schema.baseline.sql')
      const changed = readFileSync(path, 'utf8').replace(
        "('api_tokens', 'is_active', 'INTEGER', 0, '1', 0)",
        "('api_tokens', 'is_active', 'INTEGER', 1, '1', 0)",
      )
      writeFileSync(path, changed)
      writeFileSync(
        fixture.runner,
        readFileSync(fixture.runner, 'utf8').replace(baselineSha256, sha256(changed)),
      )
    }],
    ['source statement one drift', (fixture: ReturnType<typeof createFixture>) => {
      const path = join(fixture.migrations, '001_initial_schema.baseline.sql')
      const changed = readFileSync(path, 'utf8').replace(
        "('trigger', 'posts_ad')",
        "('trigger', 'posts_ad_drift')",
      )
      writeFileSync(path, changed)
      writeFileSync(
        fixture.runner,
        readFileSync(fixture.runner, 'utf8').replace(baselineSha256, sha256(changed)),
      )
    }],
    ['migration identity drift', (fixture: ReturnType<typeof createFixture>) => {
      for (const suffix of ['.sql', '.baseline.sql', '.remote.baseline.sql']) {
        renameSync(
          join(fixture.migrations, `001_initial_schema${suffix}`),
          join(fixture.migrations, `001_initial_schema_drift${suffix}`),
        )
      }
    }],
  ])('fails before the first Wrangler call on %s', (_name, mutate) => {
    const fixture = createFixture()
    mutate(fixture)
    const { report, result } = runPlan(fixture)

    expect(result.status).toBe(1)
    expect(calls(fixture)).toEqual([])
    expect(readFailure(report)).toMatchObject({
      failure_domain: 'schema_contract',
      phase: 'runner_initialization',
      query_ordinal: 0,
      exit_class: 'runner_error',
    })
  })

  it.each([
    ['statement one', 2],
    ['statement three', 4],
  ])('fails closed when the schema fingerprint changes across %s replacement', (_name, driftAt) => {
    const fixture = createFixture()
    const { report, result } = runPlan(fixture, {
      FAKE_FINGERPRINT_STATE: join(fixture.root, 'fingerprint-state'),
      FAKE_FINGERPRINT_DRIFT_AT: String(driftAt),
    })

    expect(result.status).toBe(1)
    expect(readFailure(report)).toMatchObject({
      failure_domain: 'schema_contract',
      phase: 'schema_validation',
      exit_class: 'runner_error',
    })
  })

  it('does not retry or fall back when a statement-one object probe fails', () => {
    const fixture = createFixture()
    const { report, result } = runPlan(fixture, {
      FAKE_FAIL_OBJECT_TYPE: 'index',
    })

    expect(result.status).toBe(1)
    const observed = calls(fixture)
    expect(observed.filter((call) => (
      !call.sql.startsWith('EXPLAIN ')
      && call.sql.includes("sqlite_schema.type = 'index'")
    ))).toHaveLength(1)
    expect(observed.some((call) => call.sql.includes("sqlite_schema.type = 'trigger'"))).toBe(false)
    expect(observed.some((call) => call.sql.includes("pragma_table_info('ai_provider_profiles')"))).toBe(false)
    expect(observed.some((call) => (
      call.sql.includes("('table', 'posts')")
      && call.sql.includes("('index', 'idx_posts_slug')")
      && call.sql.includes("('trigger', 'posts_ai')")
    ))).toBe(false)
    expect(`${result.stdout}${result.stderr}${readFileSync(report, 'utf8')}`)
      .not.toContain('private remote object failure body')
  })

  it('does not retry or fall back when a small probe fails', () => {
    const fixture = createFixture()
    const { report, result } = runPlan(fixture, {
      FAKE_FAIL_TABLE: 'ai_post_generators',
    })

    expect(result.status).toBe(1)
    const observed = calls(fixture)
    expect(observed.filter((call) => (
      !call.sql.startsWith('EXPLAIN ')
      && call.sql.includes("pragma_table_info('ai_post_generators')")
    ))).toHaveLength(1)
    expect(observed.some((call) => call.sql.includes("pragma_table_info('api_tokens')"))).toBe(false)
    expect(observed.some((call) => (
      call.sql.includes("pragma_table_info('ai_provider_profiles')")
      && call.sql.includes("pragma_table_info('ai_post_generators')")
      && call.sql.includes("pragma_table_info('api_tokens')")
    ))).toBe(false)
    expect(`${result.stdout}${result.stderr}${readFileSync(report, 'utf8')}`)
      .not.toContain('private remote failure body')
  })

  it.each(['failed', 'unknown', 'multiple'])(
    'rejects a %s Wrangler success envelope before later probes',
    (responseMode) => {
      const fixture = createFixture()
      const { report, result } = runPlan(fixture, {
        FAKE_RESPONSE_MODE: responseMode,
      })

      expect(result.status).toBe(1)
      expect(readFailure(report)).toMatchObject({
        failure_domain: 'malformed_response',
        failure_hint: 'none',
        phase: 'response_decode',
        exit_class: 'invalid_shape',
      })
      const observed = calls(fixture)
      expect(observed.some((call) => (
        call.sql.includes("pragma_table_info('ai_post_generators')")
      ))).toBe(false)
      expect(observed.some((call) => call.arguments.includes('--file'))).toBe(false)
    },
  )

  it('sanitizes malformed private probe responses during remote apply', () => {
    const fixture = createFixture()
    const result = runRemoteApply(fixture, {
      FAKE_RESPONSE_MODE: 'malformed',
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain('LEAK1234')
    const observed = calls(fixture)
    expect(observed.some((call) => (
      call.sql.includes("pragma_table_info('ai_post_generators')")
    ))).toBe(false)
    expect(observed.some((call) => call.arguments.includes('--file'))).toBe(false)
    expect(observed.some((call) => (
      call.sql.includes('expected_definitions(type, name, normalized_sql)')
    ))).toBe(false)
  })

  it('rejects an unallowlisted issue before remote apply can leak or write', () => {
    const fixture = createFixture()
    const result = runRemoteApply(fixture, {
      FAKE_INVALID_ISSUE_TABLE: 'api_tokens',
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain('private schema detail')
    const observed = calls(fixture)
    expect(observed.some((call) => call.arguments.includes('--file'))).toBe(false)
    expect(observed.some((call) => (
      call.sql.includes('expected_definitions(type, name, normalized_sql)')
    ))).toBe(false)
  })
})
