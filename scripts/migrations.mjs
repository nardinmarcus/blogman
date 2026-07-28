#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const defaultMigrationsDirectory = join(repoRoot, 'db', 'ledger-migrations')
const defaultWranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const schemaGuardName = '__blogman_migration_schema_guard'
const persistentWriteOpcodes = new Set([
  'OpenWrite',
  'CreateBtree',
  'Destroy',
  'Clear',
  'SetCookie',
  'ParseSchema',
  'DropTable',
  'DropIndex',
  'DropTrigger',
  'VUpdate',
  'Vacuum',
])
const privatePlanTimeoutMs = 300_000
const remoteBaselineReplacementContracts = new Map([
  ['001:001_initial_schema', {
    migrationNumber: 1,
    migrationName: '001_initial_schema',
    baselineSha256: 'b3f61982cc36ff2c88d7b4330dd304ef075b5c5c34debf4499671c33ae2b6540',
    replacementSha256: '90c94ce79e77d3ca3ab22fc67f702243e7305bcd1860f3d1feb2026fb56b4a03',
    groups: [
      {
        statementOrdinal: 1,
        statementSha256: '2c4d1aa391172c16b128c08a593e252f9e09b4fc151642ce738ae47882c38491',
        replacementStatementCount: 3,
      },
      {
        statementOrdinal: 3,
        statementSha256: 'c61b390568cafc468c6adbbff5b78d08dd5d18a544d917fbc06c043393e3c7bd',
        replacementStatementCount: 3,
      },
    ],
  }],
])
const remoteBaselineFingerprintSql = `
SELECT type, name, tbl_name, coalesce(sql, '') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%'
ORDER BY type, name, tbl_name, sql
`
const remoteBaselineIssueAllowlist = new Set([
  ...Object.entries({
    table: [
      'posts', 'posts_fts', 'categories', 'site_settings', 'ai_actions',
      'ai_provider_profiles', 'ai_post_generators', 'api_tokens',
    ],
    index: [
      'idx_posts_slug', 'idx_posts_category', 'idx_posts_published', 'idx_api_tokens_token',
    ],
    trigger: ['posts_ai', 'posts_au', 'posts_ad'],
  }).flatMap(([type, names]) => names.map((name) => `missing ${type} ${name}`)),
  ...Object.entries({
  ai_provider_profiles: [
    'id', 'name', 'provider', 'provider_name', 'provider_type', 'provider_category',
    'api_key_url', 'base_url', 'model', 'temperature', 'max_tokens', 'api_key_encrypted',
    'api_key_masked', 'is_default', 'created_at', 'updated_at',
  ],
  ai_post_generators: [
    'id', 'target_key', 'label', 'description', 'prompt', 'provider_mode', 'text_profile_id',
    'image_profile_id', 'workers_model', 'temperature', 'max_tokens', 'aspect_ratio',
    'resolution', 'is_enabled', 'is_builtin', 'created_at', 'updated_at',
  ],
  api_tokens: ['id', 'token', 'name', 'created_at', 'last_used_at', 'is_active'],
  }).flatMap(([table, columns]) => (
  columns.map((column) => `column ${table}.${column} semantic drift`)
  )),
])
const ledgerSchemaObjects = [
  {
    type: 'table',
    name: 'migration_ledger',
    sql: `CREATE TABLE migration_ledger (
  number INTEGER PRIMARY KEY CHECK(number > 0),
  name TEXT UNIQUE NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0)
) STRICT`,
  },
  {
    type: 'trigger',
    name: 'migration_ledger_no_update',
    sql: `CREATE TRIGGER migration_ledger_no_update
BEFORE UPDATE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  },
  {
    type: 'trigger',
    name: 'migration_ledger_no_delete',
    sql: `CREATE TRIGGER migration_ledger_no_delete
BEFORE DELETE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  },
  {
    type: 'trigger',
    name: 'migration_ledger_no_replace',
    sql: `CREATE TRIGGER migration_ledger_no_replace
BEFORE INSERT ON migration_ledger
WHEN EXISTS (
  SELECT 1 FROM migration_ledger
  WHERE number = NEW.number OR name = NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  },
]

function fail(message) {
  throw new Error(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function classifiedFailure(message, details) {
  const error = new Error(message)
  error.failureDetails = details
  return error
}

function schemaContractFail(message) {
  throw classifiedFailure(message, {
    failureDomain: 'schema_contract',
    failureHint: 'none',
    phase: 'schema_validation',
    exitClass: 'runner_error',
  })
}

function remoteBaselineContractFail(message) {
  throw classifiedFailure(message, {
    failureDomain: 'schema_contract',
    failureHint: 'none',
    phase: 'runner_initialization',
    exitClass: 'runner_error',
  })
}

function classifyChildFailureHint(output) {
  const auth = /\b(unauthorized|forbidden|authentication|api token|oauth|login)\b/i.test(output)
  const network = /\b(fetch failed|network|econn\w*|etimedout|enotfound|dns|socket hang up)\b/i.test(output)
  if (auth && network) return 'ambiguous'
  if (auth) return 'auth'
  if (network) return 'network_api'
  return 'none'
}

function classifyChildFailureDomain(stdout) {
  let response
  try {
    response = JSON.parse(stdout)
  } catch {
    return 'wrangler_command'
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || Object.keys(response).length !== 1 || !Object.hasOwn(response, 'error')
    || !response.error || typeof response.error !== 'object' || Array.isArray(response.error)
    || typeof response.error.text !== 'string') {
    return 'wrangler_command'
  }
  const knownErrorKeys = new Set([
    'name', 'text', 'notes', 'location', 'kind', 'code', 'accountTag',
  ])
  if (Object.keys(response.error).some((key) => !knownErrorKeys.has(key))) {
    return 'wrangler_command'
  }
  if (response.error.text === 'Received a malformed response from the API') {
    return 'malformed_response'
  }
  if (response.error.name === 'APIError'
    && /^A request to the Cloudflare API \([^\r\n()]+\) failed\.$/.test(response.error.text)) {
    return 'cloudflare_api'
  }
  return 'wrangler_command'
}

const childFailureClassRules = [
  {
    failureClass: 'auth',
    signal: 'auth_denied',
    pattern: /\b(?:unauthorized|forbidden|authentication (?:failed|required)|invalid api token|api token (?:invalid|expired))\b/i,
  },
  {
    failureClass: 'config',
    signal: 'config_invalid',
    pattern: /\b(?:configuration error|invalid wrangler\.toml|missing (?:d1 )?(?:binding|configuration)|could not resolve configuration)\b/i,
  },
  {
    failureClass: 'api',
    signal: 'api_request_failed',
    pattern: /\b(?:cloudflare api request failed|a request to the cloudflare api|received a malformed response from the api|api request failed)\b/i,
  },
  {
    failureClass: 'sql',
    signal: 'sql_rejected',
    pattern: /\b(?:d1_error|sql(?:ite)? (?:error|syntax error)|no such (?:table|column)|constraint failed)\b/i,
  },
]
const childFailureInspectionLimit = 65_536

function classifyChildFailure(stdout, stderr, failureDomain) {
  const halfLimit = childFailureInspectionLimit / 2
  const trustedStdout = failureDomain === 'wrangler_command' && stdout.trimStart().startsWith('{')
    ? ''
    : stdout
  const output = `${trustedStdout}\n${stderr}`
  const inspected = output.length <= childFailureInspectionLimit
    ? output
    : `${output.slice(0, halfLimit)}\n${output.slice(-halfLimit)}`
  const matches = childFailureClassRules.filter(({ pattern }) => pattern.test(inspected))
  if (['cloudflare_api', 'malformed_response'].includes(failureDomain)
    && !matches.some(({ failureClass }) => failureClass === 'api')) {
    matches.push(...childFailureClassRules.filter(({ failureClass }) => failureClass === 'api'))
  }
  const classes = new Set(matches.map(({ failureClass }) => failureClass))
  const failureClass = classes.size === 1 ? [...classes][0] : 'unknown'
  const signals = matches.length > 0
    ? matches.map(({ signal }) => signal).sort()
    : ['unclassified']
  const failureFingerprint = sha256([
    'blogman-wrangler-child-failure/v1',
    failureClass,
    ...signals,
  ].join('\0'))
  return { failureClass, failureFingerprint }
}

function destroyPrivateTree(path) {
  let failure = null
  try {
    if (!existsSync(path)) return
    const metadata = lstatSync(path)
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path)) destroyPrivateTree(join(path, name))
      rmdirSync(path)
      return
    }
    if (metadata.isFile()) {
      let descriptor = null
      try {
        descriptor = openSync(path, 'r+')
        const zeros = Buffer.alloc(Math.min(65_536, Math.max(metadata.size, 1)))
        let offset = 0
        while (offset < metadata.size) {
          const length = Math.min(zeros.length, metadata.size - offset)
          writeSync(descriptor, zeros, 0, length, offset)
          offset += length
        }
        fsyncSync(descriptor)
      } finally {
        if (descriptor !== null) closeSync(descriptor)
      }
    }
    unlinkSync(path)
  } catch (error) {
    failure = error
  } finally {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  }
  if (failure || existsSync(path)) fail('Private Wrangler output cleanup failed')
}

function runPrivateWrangler(executable, arguments_, spawnOptions, rawParent, timeout) {
  const rawDirectory = mkdtempSync(join(rawParent, '.migration-plan-raw-'))
  try {
    chmodSync(rawDirectory, 0o700)
    const stdoutPath = join(rawDirectory, 'wrangler.stdout')
    const stderrPath = join(rawDirectory, 'wrangler.stderr')
    const debugPath = join(rawDirectory, 'wrangler-debug.log')
    for (const path of [stdoutPath, stderrPath, debugPath]) {
      let file = null
      try {
        file = openSync(path, 'wx', 0o600)
        fchmodSync(file, 0o600)
      } finally {
        if (file !== null) closeSync(file)
      }
    }
    let stdoutDescriptor = null
    let stderrDescriptor = null
    try {
      stdoutDescriptor = openSync(stdoutPath, 'r+')
      stderrDescriptor = openSync(stderrPath, 'r+')
      const result = spawnSync(executable, arguments_, {
        ...spawnOptions,
        env: { ...process.env, WRANGLER_LOG: 'log', WRANGLER_LOG_PATH: debugPath },
        stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
        timeout,
        killSignal: 'SIGKILL',
      })
      closeSync(stdoutDescriptor)
      stdoutDescriptor = null
      closeSync(stderrDescriptor)
      stderrDescriptor = null
      return {
        ...result,
        stdout: readFileSync(stdoutPath, 'utf8'),
        stderr: readFileSync(stderrPath, 'utf8'),
      }
    } finally {
      if (stdoutDescriptor !== null) closeSync(stdoutDescriptor)
      if (stderrDescriptor !== null) closeSync(stderrDescriptor)
    }
  } finally {
    destroyPrivateTree(rawDirectory)
  }
}

function createFailureReporter(options) {
  if (!options.failureReport) return null
  let descriptor = null
  try {
    descriptor = openSync(options.failureReport, 'wx', 0o600)
    fchmodSync(descriptor, 0o600)
  } catch {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {}
      descriptor = null
    }
    fail('Failure report path must be fresh and writable')
  }

  let phase = 'runner_initialization'
  let queryOrdinal = 0
  const rawParent = dirname(options.failureReport)
  const requestedTestTimeout = Number(process.env.BLOGMAN_MIGRATION_TEST_TIMEOUT_MS)
  const timeout = process.env.NODE_ENV === 'test'
    && Number.isInteger(requestedTestTimeout)
    && requestedTestTimeout > 0
    ? Math.min(requestedTestTimeout, privatePlanTimeoutMs)
    : privatePlanTimeoutMs
  function injectTestFailure(point) {
    if (process.env.NODE_ENV === 'test'
      && process.env.BLOGMAN_MIGRATION_TEST_REPORT_FAILURE === point) {
      fail(`Injected report ${point} failure`)
    }
  }
  function closeReport() {
    if (descriptor === null) return
    const current = descriptor
    descriptor = null
    let failure = null
    try {
      injectTestFailure('close')
    } catch (error) {
      failure = error
    }
    try {
      closeSync(current)
    } catch (error) {
      failure ??= error
    }
    if (failure) throw failure
  }
  return {
    setPhase(value) {
      phase = value
    },
    setQueryOrdinal(value) {
      queryOrdinal = value
    },
    runWrangler(executable, arguments_, spawnOptions) {
      return runPrivateWrangler(executable, arguments_, spawnOptions, rawParent, timeout)
    },
    record(error) {
      if (descriptor === null) return
      const details = error?.failureDetails ?? {}
      const report = {
        format: 'blogman-migration-failure/v2',
        state: 'failed',
        command: 'plan',
        mode: 'remote',
        failure_domain: details.failureDomain
          ?? 'unknown',
        failure_hint: details.failureHint ?? 'none',
        failure_class: details.failureClass ?? 'none',
        failure_fingerprint: details.failureFingerprint ?? 'none',
        phase: details.phase ?? phase,
        query_ordinal: details.queryOrdinal ?? queryOrdinal,
        exit_class: details.exitClass ?? 'runner_error',
      }
      try {
        injectTestFailure('write')
        writeSync(descriptor, `${JSON.stringify(report, null, 2)}\n`)
        injectTestFailure('fsync')
        fsyncSync(descriptor)
      } finally {
        closeReport()
      }
    },
    complete() {
      closeReport()
      injectTestFailure('unlink')
      unlinkSync(options.failureReport)
    },
  }
}

function stripLeadingSqlComments(source) {
  let remaining = source.trimStart()
  while (remaining) {
    if (remaining.startsWith('--')) {
      const lineEnd = remaining.indexOf('\n')
      if (lineEnd === -1) return ''
      remaining = remaining.slice(lineEnd + 1).trimStart()
      continue
    }
    if (remaining.startsWith('/*')) {
      const commentEnd = remaining.indexOf('*/', 2)
      if (commentEnd === -1) fail('Unterminated SQL block comment in sidecar query')
      remaining = remaining.slice(commentEnd + 2).trimStart()
      continue
    }
    break
  }
  return remaining
}

function splitSqlStatements(source) {
  const statements = []
  let statementStart = 0
  let quote = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      const closing = quote === '[' ? ']' : quote
      if (character === closing) {
        if (quote !== '[' && next === closing) {
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (character === '-' && next === '-') {
      lineComment = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character
      continue
    }
    if (character === ';') {
      const statement = source.slice(statementStart, index).trim()
      if (stripLeadingSqlComments(statement)) statements.push(statement)
      statementStart = index + 1
    }
  }

  if (quote || blockComment) fail('Unterminated SQL literal or comment in sidecar query')
  const tail = source.slice(statementStart).trim()
  if (stripLeadingSqlComments(tail)) statements.push(tail)
  return statements
}

function validateReadOnlySidecarQueries(source, context, singleStatement = false) {
  const statements = splitSqlStatements(source)
  if (statements.length === 0) fail(`${context} must contain a read-only query`)
  if (singleStatement && statements.length !== 1) {
    fail(`${context} must contain exactly one read-only query`)
  }
  for (const statement of statements) {
    const executable = stripLeadingSqlComments(statement)
    if (!/^(select|with)\b/i.test(executable)) {
      fail(`${context} must be a read-only SELECT or WITH query`)
    }
  }
  return statements
}

function loadRemoteBaselineReplacement({
  migrationNumber,
  migrationName,
  migrationPath,
  baselineSql,
  mode,
}) {
  const contract = remoteBaselineReplacementContracts.get(
    `${String(migrationNumber).padStart(3, '0')}:${migrationName}`,
  )
  if (!contract) {
    const matchingSource = [...remoteBaselineReplacementContracts.values()].find((candidate) => (
      baselineSql !== null && sha256(baselineSql) === candidate.baselineSha256
    ))
    if (matchingSource && mode === '--remote') {
      remoteBaselineContractFail(`Remote baseline replacement migration identity drift in ${migrationName}`)
    }
    return null
  }

  const replacementPath = migrationPath.replace(/\.sql$/, '.remote.baseline.sql')
  let source = null
  try {
    source = readFileSync(replacementPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (source === null && mode !== '--remote') return null
  if (source === null) {
    remoteBaselineContractFail(`Remote baseline replacement is required for ${migrationName}`)
  }
  if (migrationNumber !== contract.migrationNumber || migrationName !== contract.migrationName) {
    remoteBaselineContractFail(`Remote baseline replacement migration identity drift in ${migrationName}`)
  }
  if (baselineSql === null || sha256(baselineSql) !== contract.baselineSha256) {
    remoteBaselineContractFail(`Remote baseline replacement source drift in ${migrationName}`)
  }

  const baselineStatements = validateReadOnlySidecarQueries(
    baselineSql,
    `Migration baseline ${migrationName}`,
  )
  for (const group of contract.groups) {
    const sourceStatement = baselineStatements[group.statementOrdinal - 1]
    if (!sourceStatement || sha256(sourceStatement) !== group.statementSha256) {
      remoteBaselineContractFail(`Remote baseline replacement statement drift in ${migrationName}`)
    }
  }
  if (sha256(source) !== contract.replacementSha256) {
    remoteBaselineContractFail(`Remote baseline replacement content drift in ${migrationName}`)
  }

  const lineEnd = source.indexOf('\n')
  const expectedHeader = [
    '-- migration-remote-baseline-replacements:',
    `migration_number=${String(contract.migrationNumber).padStart(3, '0')}`,
    `migration=${contract.migrationName}`,
    `baseline_sha256=${contract.baselineSha256}`,
    `groups=${contract.groups.map((group) => (
      `${group.statementOrdinal}:${group.statementSha256}:${group.replacementStatementCount}`
    )).join('|')}`,
  ].join(' ')
  if (lineEnd === -1 || source.slice(0, lineEnd).trim() !== expectedHeader) {
    remoteBaselineContractFail(`Remote baseline replacement header drift in ${migrationName}`)
  }
  const statements = validateReadOnlySidecarQueries(
    source.slice(lineEnd + 1),
    `Remote baseline replacement ${migrationName}`,
  )
  const replacementStatementCount = contract.groups.reduce(
    (total, group) => total + group.replacementStatementCount,
    0,
  )
  if (statements.length !== replacementStatementCount) {
    remoteBaselineContractFail(`Remote baseline replacement statement count drift in ${migrationName}`)
  }
  let replacementOffset = 0
  return {
    groups: contract.groups.map((group) => {
      const replacementStatements = statements.slice(
        replacementOffset,
        replacementOffset + group.replacementStatementCount,
      )
      replacementOffset += group.replacementStatementCount
      return {
        sourceStatementOrdinal: group.statementOrdinal,
        sourceStatementSha256: group.statementSha256,
        statements: replacementStatements,
      }
    }),
  }
}

function parseArguments(argv) {
  const [command, ...tokens] = argv
  if (!['catalog', 'plan', 'apply', 'status', 'verify'].includes(command)) {
    fail('Usage: migrations.mjs <catalog|plan|apply|status|verify> [options]')
  }

  const options = {
    command,
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    migrationsDirectory: defaultMigrationsDirectory,
    mode: null,
    persistTo: null,
    candidate: null,
    failureReport: null,
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--local' || token === '--remote') {
      if (options.mode) fail('Choose exactly one of --local or --remote')
      options.mode = token
      continue
    }

    const value = tokens[index + 1]
    if (!value || value.startsWith('--')) fail(`Missing value for ${token}`)
    index += 1

    if (token === '--database') options.database = value
    else if (token === '--config') options.config = resolve(value)
    else if (token === '--persist-to') options.persistTo = resolve(value)
    else if (token === '--candidate') options.candidate = value
    else if (token === '--migrations-dir') options.migrationsDirectory = resolve(value)
    else if (token === '--failure-report') options.failureReport = value
    else fail(`Unknown option: ${token}`)
  }

  if (command !== 'catalog' && !options.mode) fail('Choose exactly one of --local or --remote')
  if (command === 'catalog' && options.mode) fail('catalog does not accept --local or --remote')
  if (options.mode === '--remote' && options.persistTo) {
    fail('--persist-to can only be used with --local')
  }
  if (command === 'apply' && !options.candidate?.trim()) {
    fail('apply requires a non-empty --candidate identity')
  }
  if (options.failureReport) {
    if (command !== 'plan' || options.mode !== '--remote') {
      fail('--failure-report is only available for plan --remote')
    }
    if (!isAbsolute(options.failureReport)) fail('--failure-report requires an absolute path')
  }

  return options
}

function loadMigrations(directory, mode = null) {
  const directoryEntries = readdirSync(directory)
  const fileNames = directoryEntries
    .filter((name) => (
      name.endsWith('.sql')
      && !name.endsWith('.baseline.sql')
      && !name.endsWith('.preflight.sql')
    ))
    .sort()
  if (fileNames.length === 0) fail(`No migrations found in ${directory}`)

  for (const replacementName of directoryEntries.filter((name) => (
    name.endsWith('.remote.baseline.sql')
  ))) {
    const mainName = replacementName.replace(/\.remote\.baseline\.sql$/, '')
    const match = /^(\d{3})_([a-z0-9_]+)$/.exec(mainName)
    const key = match ? `${match[1]}:${mainName}` : null
    if (!key || !remoteBaselineReplacementContracts.has(key)
      || !fileNames.includes(`${mainName}.sql`)) {
      remoteBaselineContractFail(`Unknown remote baseline replacement: ${replacementName}`)
    }
  }

  return fileNames.map((fileName, index) => {
    const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(fileName)
    if (!match) fail(`Invalid migration filename: ${fileName}`)

    const number = Number(match[1])
    const expectedNumber = index + 1
    if (number !== expectedNumber) {
      fail(`Migration sequence must be contiguous: expected ${String(expectedNumber).padStart(3, '0')}, found ${match[1]}`)
    }

    const name = fileName.replace(/\.sql$/, '')
    const path = join(directory, fileName)
    const sql = readFileSync(path, 'utf8')
    const baselinePath = path.replace(/\.sql$/, '.baseline.sql')
    let baselineSql = null
    try {
      baselineSql = readFileSync(baselinePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const preflightPath = path.replace(/\.sql$/, '.preflight.sql')
    let preflightSql = null
    try {
      preflightSql = readFileSync(preflightPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const dataModulePath = path.replace(/\.sql$/, '.data.mjs')
    let dataModuleSource = null
    try {
      dataModuleSource = readFileSync(dataModulePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const declaration = /^-- migration-number: (\d{3})$/m.exec(sql)
    if (!declaration || Number(declaration[1]) !== number) {
      fail(`Migration declaration does not match filename: ${fileName}`)
    }

    const checksum = createHash('sha256')
      .update(sql)
      .update(baselineSql === null ? '' : `\0${baselineSql}`)
    if (preflightSql !== null) checksum.update(`\0preflight\0${preflightSql}`)
    if (dataModuleSource !== null) checksum.update(`\0data\0${dataModuleSource}`)
    const remoteBaselineReplacement = loadRemoteBaselineReplacement({
      migrationNumber: number,
      migrationName: name,
      migrationPath: path,
      baselineSql,
      mode,
    })

    return {
      number,
      name,
      checksum: checksum.digest('hex'),
      sql,
      baselineSql,
      remoteBaselineReplacement,
      preflightSql,
      dataModuleSource,
    }
  })
}

function createD1Client(options, failureReporter) {
  const commonArguments = [
    'd1',
    'execute',
    options.database,
    options.mode,
    '--config',
    options.config,
    '--json',
  ]
  if (options.persistTo) commonArguments.push('--persist-to', options.persistTo)
  let queryOrdinal = 0

  function execute(arguments_, privateOutput = false) {
    queryOrdinal += 1
    failureReporter?.setQueryOrdinal(queryOrdinal)
    if (failureReporter || privateOutput) {
      const result = failureReporter
        ? failureReporter.runWrangler(
            defaultWranglerPath,
            [...commonArguments, ...arguments_],
            { cwd: repoRoot },
          )
        : runPrivateWrangler(
            defaultWranglerPath,
            [...commonArguments, ...arguments_],
            { cwd: repoRoot },
            tmpdir(),
            privatePlanTimeoutMs,
          )
      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()
      if (result.error?.code === 'ETIMEDOUT') {
        throw classifiedFailure('Wrangler command timed out', {
          failureDomain: 'wrangler_command',
          failureHint: 'none',
          phase: 'wrangler_execute',
          queryOrdinal,
          exitClass: 'timeout',
        })
      }
      if (result.error) {
        throw classifiedFailure(result.error.message, {
          failureDomain: 'wrangler_command',
          failureHint: 'none',
          phase: 'wrangler_execute',
          queryOrdinal,
          exitClass: 'spawn_error',
        })
      }
      if (result.signal) {
        throw classifiedFailure('Wrangler command terminated by signal', {
          failureDomain: 'wrangler_command',
          failureHint: 'none',
          phase: 'wrangler_execute',
          queryOrdinal,
          exitClass: 'signal',
        })
      }
      if (result.status !== 0) {
        const failureDomain = classifyChildFailureDomain(stdout)
        const childFailure = classifyChildFailure(stdout, stderr, failureDomain)
        throw classifiedFailure('Wrangler command failed', {
          failureDomain,
          failureHint: classifyChildFailureHint(`${stdout}\n${stderr}`),
          ...childFailure,
          phase: 'wrangler_execute',
          queryOrdinal,
          exitClass: 'child_nonzero',
        })
      }
      return result.stdout
    }
    try {
      return execFileSync(defaultWranglerPath, [...commonArguments, ...arguments_], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const stdout = error?.stdout?.toString().trim()
      if (stdout) {
        let response = null
        try {
          response = JSON.parse(stdout)
        } catch {}
        if (response?.error?.text) {
          throw classifiedFailure(response.error.text, {
            failureDomain: classifyChildFailureDomain(stdout),
            failureHint: classifyChildFailureHint(response.error.text),
            phase: 'wrangler_execute',
            queryOrdinal,
            exitClass: 'child_nonzero',
          })
        }
      }
      const stderr = error?.stderr?.toString().trim()
      const message = stderr || error.message
      const commandStartFailure = error?.code === 'ENOENT' || error?.code === 'EACCES'
      throw classifiedFailure(message, {
        failureDomain: 'wrangler_command',
        failureHint: commandStartFailure ? 'none' : classifyChildFailureHint(`${stdout ?? ''}\n${stderr ?? ''}`),
        phase: 'wrangler_execute',
        queryOrdinal,
        exitClass: commandStartFailure ? 'spawn_error' : 'child_nonzero',
      })
    }
  }

  function decodeResponse(output) {
    let response
    try {
      response = JSON.parse(output)
    } catch {
      throw classifiedFailure('Wrangler returned malformed JSON', {
        failureDomain: 'malformed_response',
        failureHint: 'none',
        phase: 'response_decode',
        queryOrdinal,
        exitClass: 'invalid_json',
      })
    }
    if (!Array.isArray(response)
      || response.length !== 1
      || !response[0]
      || typeof response[0] !== 'object'
      || Array.isArray(response[0])
      || response[0].success !== true
      || !Array.isArray(response[0].results)) {
      throw classifiedFailure('Wrangler returned an invalid response envelope', {
        failureDomain: 'malformed_response',
        failureHint: 'none',
        phase: 'response_decode',
        queryOrdinal,
        exitClass: 'invalid_shape',
      })
    }
    return response
  }

  function executeFile(sql) {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'blogman-migration-query-'))
    const path = join(temporaryDirectory, 'query.sql')
    try {
      writeFileSync(path, sql, { mode: 0o600 })
      return execute(['--file', path])
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  function executeQuery(sql, privateOutput = false) {
    if (options.mode === '--remote') return execute(['--command', sql], privateOutput)
    return executeFile(sql)
  }

  function queryReadOnly(sql, context, singleStatement = false, privateOutput = false) {
    const statements = validateReadOnlySidecarQueries(sql, context, singleStatement)
    try {
      for (const statement of statements) {
        const explainResponse = decodeResponse(executeQuery(`EXPLAIN ${statement};`, privateOutput))
        const writeOpcode = explainResponse
          .flatMap((result) => result.results ?? [])
          .find((row) => persistentWriteOpcodes.has(row.opcode))
        if (writeOpcode) {
          fail(`${context} must be read-only: SQLite opcode ${writeOpcode.opcode}`)
        }
      }
      return statements.flatMap((statement) => {
        const response = decodeResponse(executeQuery(`${statement};`, privateOutput))
        return response.flatMap((result) => result.results ?? [])
      })
    } catch (error) {
      if (error?.failureDetails) {
        throw classifiedFailure(`${context} must be read-only: ${error.message}`, error.failureDetails)
      }
      fail(`${context} must be read-only: ${error.message}`)
    }
  }

  return {
    isRemote: options.mode === '--remote',
    query(sql) {
      const response = decodeResponse(executeQuery(sql))
      return response.flatMap((statement) => statement.results ?? [])
    },
    executeBatch(sql) {
      executeFile(sql)
    },
    queryReadOnly(sql, context, singleStatement = false) {
      return queryReadOnly(sql, context, singleStatement)
    },
    queryPrivateReadOnly(sql, context, singleStatement = false) {
      return queryReadOnly(sql, context, singleStatement, true)
    },
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function ledgerArtifactsExist(client) {
  const rows = client.query(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE lower(name) IN ('migration_ledger', 'migration_ledger_no_update', 'migration_ledger_no_delete', 'migration_ledger_no_replace')",
  )
  return Number(rows[0]?.count) > 0
}

function normalizeSchemaSql(sql) {
  const source = sql.trim().replace(/;$/, '')
  let normalized = ''
  let inStringLiteral = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "'") {
      normalized += character
      if (inStringLiteral && source[index + 1] === "'") {
        normalized += source[index + 1]
        index += 1
      } else {
        inStringLiteral = !inStringLiteral
      }
    } else if (inStringLiteral) {
      normalized += character
    } else if (!/\s/.test(character)) {
      normalized += character.toLowerCase()
    }
  }

  return normalized
}

function validateLedgerContract(client) {
  const actualObjects = client.query(`
SELECT type, name, sql
FROM sqlite_schema
WHERE name IN ('migration_ledger', 'migration_ledger_no_update', 'migration_ledger_no_delete', 'migration_ledger_no_replace')
`)

  for (const expected of ledgerSchemaObjects) {
    const actual = actualObjects.find(
      (object) => object.type === expected.type && object.name === expected.name,
    )
    if (!actual || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) {
      schemaContractFail(`Migration ledger contract drift: ${expected.type} ${expected.name}`)
    }
  }
}

function readLedger(client, initialized) {
  if (!initialized) return []
  return client.query(
    'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
  )
}

function ledgerCreationSql() {
  return ledgerSchemaObjects.map(({ sql }) => `${sql};`).join('\n')
}

function hasBusinessSchema(client) {
  const rows = client.query(`
SELECT COUNT(*) AS count
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%'
  AND name NOT LIKE 'migration_ledger%'
`)
  return Number(rows[0]?.count) > 0
}

function ledgerInsertSql(migration, candidate) {
  return `
INSERT INTO migration_ledger (number, name, checksum, candidate_id)
VALUES (${migration.number}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.checksum)}, ${sqlLiteral(candidate)});
`
}

function parseBaselineCompatibility(migration) {
  const marker = '-- migration-baseline-compatibility'
  const directive = /^-- migration-baseline-allow-issues: (.+)$/gm
  const allowedIssueSets = [...migration.sql.matchAll(directive)].map((match) => (
    [...new Set(match[1].split(' | ').map((issue) => issue.trim()))].sort()
  ))
  const hasMarker = migration.sql.includes(marker)

  if (allowedIssueSets.length === 0) {
    if (hasMarker) fail(`Baseline compatibility marker has no allowed issues in ${migration.name}`)
    return null
  }

  if (!hasMarker) fail(`Baseline compatibility issues require a marker in ${migration.name}`)
  if (!migration.baselineSql) fail(`Baseline compatibility requires a sidecar in ${migration.name}`)
  return allowedIssueSets
}

function sameIssues(actual, expected) {
  return actual.length === expected.length
    && actual.every((issue, index) => issue === expected[index])
}

function readRemoteBaselineFingerprint(client, context) {
  const rows = client.queryPrivateReadOnly(remoteBaselineFingerprintSql, context, true)
  const normalized = rows.map((row) => {
    if (!row || typeof row !== 'object'
      || Object.keys(row).sort().join(',') !== 'name,sql,tbl_name,type'
      || typeof row.type !== 'string'
      || typeof row.name !== 'string'
      || typeof row.tbl_name !== 'string'
      || typeof row.sql !== 'string') {
      schemaContractFail('Remote baseline schema fingerprint response is invalid')
    }
    return [row.type, row.name, row.tbl_name, row.sql]
  })
  return sha256(JSON.stringify(normalized))
}

function validateRemoteBaselineIssueRows(rows, migrationName) {
  for (const row of rows) {
    if (!row || typeof row !== 'object'
      || Object.keys(row).length !== 1
      || !Object.hasOwn(row, 'issue')
      || typeof row.issue !== 'string'
      || !remoteBaselineIssueAllowlist.has(row.issue)) {
      schemaContractFail(`Remote baseline replacement response is invalid in ${migrationName}`)
    }
  }
}

function readCanonicalBaselineIssues(client, migration) {
  const context = `Migration baseline ${migration.name}`
  const replacement = client.isRemote ? migration.remoteBaselineReplacement : null
  if (!replacement) return client.queryReadOnly(migration.baselineSql, context)

  const sourceStatements = validateReadOnlySidecarQueries(migration.baselineSql, context)
  const replacementGroups = new Map(replacement.groups.map((group) => (
    [group.sourceStatementOrdinal, group]
  )))

  const issues = []
  for (const [index, statement] of sourceStatements.entries()) {
    const group = replacementGroups.get(index + 1)
    if (!group) {
      issues.push(...client.queryReadOnly(statement, context, true))
      continue
    }
    if (sha256(statement) !== group.sourceStatementSha256) {
      schemaContractFail(`Remote baseline replacement identity drift in ${migration.name}`)
    }

    const before = readRemoteBaselineFingerprint(
      client,
      `Remote baseline schema fingerprint before ${migration.name}`,
    )
    for (const probe of group.statements) {
      const probeIssues = client.queryPrivateReadOnly(
        probe,
        `Remote baseline replacement ${migration.name}`,
        true,
      )
      validateRemoteBaselineIssueRows(probeIssues, migration.name)
      issues.push(...probeIssues)
    }
    const after = readRemoteBaselineFingerprint(
      client,
      `Remote baseline schema fingerprint after ${migration.name}`,
    )
    if (before !== after) schemaContractFail(`Remote baseline schema drift in ${migration.name}`)
  }
  return issues
}

function validateCurrentSchema(client, migrations) {
  const canonical = migrations[0]
  if (!canonical.baselineSql) {
    schemaContractFail(`Existing schema cannot be baselined by migration ${canonical.name}`)
  }
  const canonicalIssues = readCanonicalBaselineIssues(client, canonical)
  const actualIssues = canonicalIssues.map((row) => String(row.issue)).sort()
  const identityFailures = []
  let audited = false
  for (const migration of migrations.slice(1)) {
    const allowedIssueSets = parseBaselineCompatibility(migration)
    if (!allowedIssueSets) continue
    if (actualIssues.length > 0
      && !allowedIssueSets.some((allowedIssues) => sameIssues(actualIssues, allowedIssues))) continue

    audited = true
    const compatibilityIssues = client.queryReadOnly(
      migration.baselineSql,
      `Migration baseline compatibility ${migration.name}`,
    )
    identityFailures.push(...compatibilityIssues.map((row) => String(row.issue)))
  }

  if (identityFailures.length > 0) {
    schemaContractFail(`Existing schema identity does not match: ${[...new Set(identityFailures)].sort().join(', ')}`)
  }
  if (actualIssues.length === 0 || audited) return
  schemaContractFail(`Existing schema does not match ${canonical.name}: ${actualIssues.join(', ')}`)
}

function validateMigrationPreflight(client, migration) {
  if (!migration.preflightSql) return
  const issues = client.queryReadOnly(
    migration.preflightSql,
    `Migration preflight ${migration.name}`,
  )
  if (issues.length > 0) {
    schemaContractFail(`Migration preflight failed for ${migration.name}: ${issues.map((row) => row.issue).join(', ')}`)
  }
}

function parseConditionalColumns(migration) {
  const directive = /^-- migration-add-column-if-table-exists: ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) \| ([^;\r\n]+)$/gm
  const columns = []
  let match
  while ((match = directive.exec(migration.sql)) !== null) {
    columns.push({ table: match[1], column: match[2], definition: match[3].trim() })
  }
  return columns
}

function resolveMigrationSql(client, migration) {
  const marker = '-- migration-conditional-schema'
  const conditionalColumns = parseConditionalColumns(migration)
  const hasMarker = migration.sql.includes(marker)
  if (conditionalColumns.length === 0) {
    if (hasMarker) fail(`Conditional schema marker has no directives in ${migration.name}`)
    return migration.sql
  }
  if (!hasMarker) fail(`Conditional schema directives require a marker in ${migration.name}`)

  const statements = []
  for (const conditional of conditionalColumns) {
    const tableExists = client.query(
      `SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ${sqlLiteral(conditional.table)}`,
    )
    if (Number(tableExists[0]?.count) === 0) continue

    const columns = client.query(`SELECT name FROM pragma_table_info(${sqlLiteral(conditional.table)})`)
    if (columns.some((column) => column.name === conditional.column)) continue
    statements.push(
      `ALTER TABLE "${conditional.table}" ADD COLUMN "${conditional.column}" ${conditional.definition};`,
    )
  }

  return migration.sql.replace(marker, statements.join('\n'))
}

async function prepareDataMigrationSql(client, migration) {
  if (migration.dataModuleSource === null) return ''
  const encodedSource = Buffer.from(migration.dataModuleSource, 'utf8').toString('base64')
  const moduleUrl = `data:text/javascript;base64,${encodedSource}#${migration.checksum}`
  const dataMigration = await import(moduleUrl)
  if (typeof dataMigration.prepare !== 'function') {
    fail(`Data migration must export prepare(): ${migration.name}`)
  }

  const sql = await dataMigration.prepare({
    env: process.env,
    query(statement) {
      return client.queryReadOnly(
        String(statement),
        `Data migration query ${migration.name}`,
        true,
      )
    },
  })
  if (typeof sql !== 'string') fail(`Data migration prepare() must return SQL: ${migration.name}`)
  return sql.trim()
}

function validateLedger(migrations, ledger) {
  if (ledger.length > migrations.length) fail('Ledger contains unknown migration numbers')
  for (let index = 0; index < ledger.length; index += 1) {
    const applied = ledger[index]
    const migration = migrations[index]
    if (Number(applied.number) !== migration.number || applied.name !== migration.name) {
      fail(`Applied migrations are out of order at number ${applied.number}`)
    }
    if (applied.checksum !== migration.checksum) {
      fail(`Checksum drift detected for migration ${migration.name}`)
    }
  }
}

function buildStatus(migrations, ledger, state, baselineFirst = false) {
  return {
    state,
    applied: ledger,
    pending: migrations.slice(ledger.length).map(({ number, name, checksum }, index) => ({
      number,
      name,
      checksum,
      action: baselineFirst && index === 0 ? 'baseline' : 'apply',
    })),
  }
}

function validateBeforeWrites(client, migrations, ledger) {
  const shouldBaseline = ledger.length === 0 && hasBusinessSchema(client)
  if (shouldBaseline) validateCurrentSchema(client, migrations)

  const pendingStart = ledger.length + (shouldBaseline ? 1 : 0)
  for (const migration of migrations.slice(pendingStart)) {
    validateMigrationPreflight(client, migration)
  }

  return shouldBaseline
}

function readSchemaFingerprint(client) {
  const rows = client.query(`
SELECT json_group_array(json_object(
  'type', type,
  'name', name,
  'tbl_name', tbl_name,
  'sql', sql
)) AS fingerprint
FROM (
  SELECT type, name, tbl_name, sql
  FROM sqlite_schema
  WHERE lower(name) <> ${sqlLiteral(schemaGuardName)}
    AND lower(tbl_name) <> ${sqlLiteral(schemaGuardName)}
  ORDER BY type, name, tbl_name
)
`)
  return String(rows[0]?.fingerprint ?? '[]')
}

function schemaFingerprintGuardSql(expectedFingerprint) {
  return `
CREATE TABLE ${schemaGuardName} (
  fingerprint TEXT NOT NULL,
  CONSTRAINT "Database schema changed after migration preflight"
    CHECK(fingerprint = ${sqlLiteral(expectedFingerprint)})
);
INSERT INTO ${schemaGuardName} (fingerprint)
SELECT json_group_array(json_object(
  'type', type,
  'name', name,
  'tbl_name', tbl_name,
  'sql', sql
))
FROM (
  SELECT type, name, tbl_name, sql
  FROM sqlite_schema
  WHERE lower(name) <> ${sqlLiteral(schemaGuardName)}
    AND lower(tbl_name) <> ${sqlLiteral(schemaGuardName)}
  ORDER BY type, name, tbl_name
);
DROP TABLE ${schemaGuardName};
`
}

async function applyMigrations(client, migrations, candidate) {
  let fingerprint = readSchemaFingerprint(client)
  const initialized = ledgerArtifactsExist(client)
  if (initialized) validateLedgerContract(client)
  const hadBusinessSchema = hasBusinessSchema(client)
  let ledger = readLedger(client, initialized)
  validateLedger(migrations, ledger)
  const shouldBaseline = ledger.length === 0 && hadBusinessSchema

  if (shouldBaseline) validateCurrentSchema(client, migrations)
  let initializationSql = initialized ? '' : ledgerCreationSql()
  let pendingStart = ledger.length
  if (shouldBaseline) {
    initializationSql += `\n${ledgerInsertSql(migrations[0], candidate)}`
    pendingStart = 1
  }

  const pending = migrations.slice(pendingStart)
  for (const migration of pending) validateMigrationPreflight(client, migration)
  if (pending.length === 0 && initializationSql) {
    client.executeBatch(`${schemaFingerprintGuardSql(fingerprint)}\n${initializationSql}`)
    initializationSql = ''
  }

  for (const [index, migration] of pending.entries()) {
    validateMigrationPreflight(client, migration)
    const resolvedSql = resolveMigrationSql(client, migration)
    const dataSql = await prepareDataMigrationSql(client, migration)
    client.executeBatch([
      schemaFingerprintGuardSql(fingerprint),
      initializationSql,
      dataSql,
      resolvedSql.trim(),
      ledgerInsertSql(migration, candidate),
    ].filter(Boolean).join('\n'))
    initializationSql = ''
    if (index + 1 < pending.length) fingerprint = readSchemaFingerprint(client)
  }

  validateLedgerContract(client)
  return buildStatus(migrations, readLedger(client, true), 'current')
}

let activeFailureReporter = null

async function main() {
  const options = parseArguments(process.argv.slice(2))
  activeFailureReporter = createFailureReporter(options)
  const migrations = loadMigrations(options.migrationsDirectory, options.mode)
  if (options.command === 'catalog') {
    process.stdout.write(`${JSON.stringify({
      format: 'blogman-migration-catalog/v1',
      migrations: migrations.map(({ number, name, checksum }) => ({ number, name, checksum })),
    }, null, 2)}\n`)
    return
  }
  const client = createD1Client(options, activeFailureReporter)
  activeFailureReporter?.setPhase('ledger_validation')
  const initialized = ledgerArtifactsExist(client)
  if (initialized) validateLedgerContract(client)
  const ledger = readLedger(client, initialized)
  validateLedger(migrations, ledger)

  let baselineFirst = false
  if (options.command === 'plan') {
    activeFailureReporter?.setPhase('schema_validation')
    baselineFirst = validateBeforeWrites(client, migrations, ledger)
  }

  let result
  if (options.command === 'apply') {
    result = await applyMigrations(client, migrations, options.candidate)
  } else if (options.command === 'verify') {
    const pending = migrations.slice(ledger.length)
    if (pending.length > 0) {
      fail(`Pending migrations: ${pending.map((migration) => migration.name).join(', ')}`)
    }
    result = buildStatus(migrations, ledger, 'verified')
  } else if (options.command === 'status') {
    const state = !initialized ? 'uninitialized' : ledger.length === migrations.length ? 'current' : 'pending'
    result = buildStatus(migrations, ledger, state)
  } else {
    const state = ledger.length === migrations.length ? 'current' : 'pending'
    result = buildStatus(migrations, ledger, state, baselineFirst)
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  activeFailureReporter?.complete()
  activeFailureReporter = null
}

try {
  await main()
} catch (error) {
  if (activeFailureReporter) {
    try {
      activeFailureReporter.record(error)
    } catch {}
    activeFailureReporter = null
    process.stderr.write('Migration plan failed; see sanitized failure report.\n')
  } else {
    process.stderr.write(`${error.message}\n`)
  }
  process.exitCode = 1
}
