#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'


const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
// The measured production response was 1,554,995 bytes; 4 MiB keeps headroom bounded.
export const D1_EVIDENCE_MAX_BUFFER_BYTES = 4 * 1024 * 1024
export const D1_PRIVATE_EXPORT_TIMEOUT_MS = 300_000
export const D1_PRIVATE_EXPORT_TABLES = [
  'posts',
  'categories',
  'site_settings',
  'ai_actions',
  'ai_provider_profiles',
  'ai_post_generators',
  'api_tokens',
]

function fail(message) {
  throw new Error(message)
}

function parseOptions(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (!name.startsWith('--')) fail(`Unexpected argument: ${name}`)
    if (name === '--local' || name === '--remote') {
      options.set(name.slice(2), true)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) fail(`Missing value for ${name}`)
    options.set(name.slice(2), value)
    index += 1
  }
  return options
}

function required(options, name) {
  const value = options.get(name)
  if (!value) fail(`Missing required option --${name}`)
  return value
}

function assertOnlyOptions(options, allowedNames) {
  for (const name of options.keys()) {
    if (!allowedNames.includes(name)) fail(`Unsupported option --${name}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value) {
  return sha256(JSON.stringify(value))
}

const forbiddenEvidenceFields = new Set([
  'body',
  'content',
  'html',
  'token',
  'password',
  'credential',
  'credentials',
  'bridgecredential',
  'bridgecredentials',
  'apikey',
  'aiapikey',
  'secret',
  'rawresponse',
  'responsebody',
])

const credentialPattern = /(?:sk-[a-z0-9_-]{4,}|nm_[a-z0-9_-]{4,}|(?:token|password|api[_ -]?key|credential|secret)\s*[:=]\s*\S+)/i

function assertNoSensitiveFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item)
    return
  }
  if (typeof value === 'string') {
    if (credentialPattern.test(value)) fail('Evidence contains a forbidden sensitive value')
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
    if (forbiddenEvidenceFields.has(normalized)) {
      fail('Evidence contains a forbidden sensitive field')
    }
    assertNoSensitiveFields(child)
  }
}

function d1CommandArgs(options) {
  const database = required(options, 'database')
  const config = resolve(required(options, 'config'))
  const local = Boolean(options.get('local'))
  const remote = Boolean(options.get('remote'))
  if (local === remote) fail('D1 evidence requires exactly one of --local or --remote')
  if (local) {
    const persistToValue = required(options, 'persist-to')
    if (!isAbsolute(persistToValue)) fail('Local D1 evidence requires an absolute --persist-to directory')
    return [database, '--local', '--persist-to', resolve(persistToValue), '--config', config]
  }
  if (options.get('persist-to')) fail('Remote D1 evidence cannot use --persist-to')
  return [database, '--remote', '--config', config]
}

function queryD1(options, sql, evidenceName) {
  return runD1EvidenceQuery(wranglerPath, [
    'd1', 'execute', ...d1CommandArgs(options), '--command', sql, '--json',
  ], evidenceName)
}

export function runD1EvidenceQuery(command, args, evidenceName) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: D1_EVIDENCE_MAX_BUFFER_BYTES,
  })
  if (result.status !== 0) fail(`Unable to capture ${evidenceName} evidence`)
  return parseD1QueryResponse(result.stdout, evidenceName)
}

export function parseD1QueryResponse(stdout, evidenceName) {
  let response
  try {
    response = JSON.parse(stdout)
  } catch {
    fail(`Invalid ${evidenceName} evidence response`)
  }
  const queryResult = Array.isArray(response) ? response.at(-1) : response
  if (
    !queryResult
    || typeof queryResult !== 'object'
    || Array.isArray(queryResult)
    || queryResult.success !== true
    || !Array.isArray(queryResult.results)
  ) {
    fail(`Invalid ${evidenceName} evidence response`)
  }
  return queryResult.results
}

function verifiedBackup(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath)
  const manifestDirectory = realpathSync(dirname(absoluteManifestPath))
  let manifest
  try {
    manifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8'))
  } catch {
    fail('Backup manifest is not valid JSON')
  }
  assertNoSensitiveFields(manifest)
  if (manifest?.format !== 'blogman-d1-backup/v1') {
    fail('Unsupported backup manifest format')
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('Backup manifest must contain at least one artifact')
  }
  if (!Array.isArray(manifest.required_tables) || manifest.required_tables.length === 0) {
    fail('Backup manifest must declare required tables')
  }
  const requiredTables = [...new Set(manifest.required_tables)]
  if (
    requiredTables.length !== manifest.required_tables.length
    || requiredTables.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name))
  ) {
    fail('Backup manifest contains invalid required tables')
  }

  const identity = createHash('sha256')
  const seenPaths = new Set()
  const artifacts = manifest.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact.path !== 'string' || !artifact.path.endsWith('.sql')) {
      fail(`Backup artifact ${index + 1} must be a relative SQL file`)
    }
    if (isAbsolute(artifact.path) || seenPaths.has(artifact.path)) {
      fail(`Backup artifact ${index + 1} has an invalid path`)
    }
    seenPaths.add(artifact.path)
    const artifactPath = realpathSync(resolve(manifestDirectory, artifact.path))
    if (relative(manifestDirectory, artifactPath).startsWith(`..${sep}`)) {
      fail(`Backup artifact ${index + 1} escapes its package directory`)
    }
    const bytes = readFileSync(artifactPath)
    const digest = sha256(bytes)
    if (statSync(artifactPath).size !== artifact.bytes || digest !== artifact.sha256) {
      fail(`Backup artifact ${index + 1} failed integrity verification`)
    }
    identity.update(bytes)
    return { path: artifactPath }
  })

  const backupId = `sha256:${identity.digest('hex')}`
  if (manifest.backup_id !== backupId) fail('Backup identity does not match its artifacts')
  return { backupId, artifacts, requiredTables }
}

function verifyBackup(options) {
  const backup = verifiedBackup(required(options, 'manifest'))
  return {
    state: 'verified',
    backup_id: backup.backupId,
    artifact_count: backup.artifacts.length,
  }
}

function assertPrivateRunRoot(runRootValue) {
  if (!isAbsolute(runRootValue)) fail('Private D1 export requires an absolute --run-root')
  const runRoot = resolve(runRootValue)
  const relativeToRepo = relative(repoRoot, runRoot)
  if (relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    fail('Private D1 export run root must be outside the repository')
  }
  return runRoot
}

function secureDeleteFile(path) {
  if (!existsSync(path)) return
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!entry.isFile()) fail('Private D1 export cleanup found a non-file entry')
  const size = statSync(path).size
  const descriptor = openSync(path, 'r+')
  try {
    const zeroes = Buffer.alloc(Math.min(Math.max(size, 1), 64 * 1024))
    for (let offset = 0; offset < size; offset += zeroes.length) {
      writeSync(descriptor, zeroes, 0, Math.min(zeroes.length, size - offset), offset)
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  unlinkSync(path)
}

function privateFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? privateFiles(path) : [path]
  })
}

function secureDeletePrivateFiles(privateDirectory) {
  const files = privateFiles(privateDirectory)
  return secureDeleteFiles(files) && privateFiles(privateDirectory).length === 0
}

function secureDeleteFiles(paths) {
  let failed = false
  for (const path of paths) {
    try {
      secureDeleteFile(path)
    } catch {
      failed = true
    }
  }
  return !failed
}

function writeExportReport(path, report) {
  assertNoSensitiveFields(report)
  writeFileSync(path, `${JSON.stringify(report)}\n`, { flag: 'w', mode: 0o600 })
}

function classifyPrivateExportFailure(result, paths) {
  if (result.error?.code === 'ETIMEDOUT') {
    return { phase: 'wrangler_export', exit_class: 'timeout', hint: 'timeout' }
  }
  if (result.error) {
    return { phase: 'wrangler_export', exit_class: 'spawn_error', hint: 'unknown' }
  }
  if (result.signal) {
    return { phase: 'wrangler_export', exit_class: 'signal', hint: 'unknown' }
  }

  let raw = ''
  try {
    raw = paths.map((path) => readFileSync(path, 'utf8')).join('\n')
  } catch {}
  let hint = 'unknown'
  const auth = /\b(unauthorized|forbidden|authentication|api token|oauth|login)\b/i.test(raw)
  const network = /\b(fetch failed|network|econn\w*|etimedout|enotfound|dns|socket hang up)\b/i.test(raw)
  const remoteRejection = /\b(cloudflare api|api request failed|invalid request|request rejected|error code \d+|wrangler error)\b/i.test(raw)
  if ([auth, network, remoteRejection].filter(Boolean).length === 1) {
    if (auth) hint = 'auth'
    else if (network) hint = 'network'
    else hint = 'remote_api_or_cli_rejection'
  }
  return { phase: 'wrangler_export', exit_class: 'child_nonzero', hint }
}

function runPrivately(command, args, {
  stdin = 'ignore',
  stdoutPath,
  stderrPath,
  env = process.env,
  timeout,
}) {
  const stdout = openSync(stdoutPath, 'wx', 0o600)
  const stderr = openSync(stderrPath, 'wx', 0o600)
  const input = stdin === 'ignore' ? 'ignore' : openSync(stdin, 'r')
  try {
    return spawnSync(command, args, {
      cwd: repoRoot,
      env,
      ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
      stdio: [input, stdout, stderr],
    })
  } finally {
    if (typeof input === 'number') closeSync(input)
    closeSync(stdout)
    closeSync(stderr)
  }
}

function validatePrivateExport(sqlPath, privateDirectory, expectedTables) {
  const databasePath = join(privateDirectory, 'validation.sqlite')
  const referencePath = join(privateDirectory, 'reference.sqlite')
  const importStdout = join(privateDirectory, 'validation-import.stdout')
  const importStderr = join(privateDirectory, 'validation-import.stderr')
  const schemaStdout = join(privateDirectory, 'validation-schema.stdout')
  const schemaStderr = join(privateDirectory, 'validation-schema.stderr')
  writeFileSync(databasePath, '', { flag: 'wx', mode: 0o600 })
  writeFileSync(referencePath, '', { flag: 'wx', mode: 0o600 })
  const imported = runPrivately('sqlite3', ['-bail', databasePath], {
    stdin: sqlPath,
    stdoutPath: importStdout,
    stderrPath: importStderr,
  })
  if (imported.status !== 0) fail('Private D1 export SQL is malformed')
  const referenced = runPrivately('sqlite3', ['-bail', referencePath], {
    stdin: join(repoRoot, 'db', 'schema.sql'),
    stdoutPath: join(privateDirectory, 'reference-import.stdout'),
    stderrPath: join(privateDirectory, 'reference-import.stderr'),
  })
  if (referenced.status !== 0) fail('Private D1 export reference schema validation failed')
  const tableQuery = "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  const schema = runPrivately('sqlite3', ['-noheader', databasePath, tableQuery], {
    stdoutPath: schemaStdout,
    stderrPath: schemaStderr,
  })
  if (schema.status !== 0) fail('Private D1 export schema validation failed')
  const actualTables = readFileSync(schemaStdout, 'utf8').trim().split('\n').filter(Boolean)
  const requiredTables = [...expectedTables].sort()
  if (JSON.stringify(actualTables) !== JSON.stringify(requiredTables)) {
    fail('Private D1 export schema does not match the required tables')
  }

  const columnQuery = `
SELECT tables.name, columns.cid, columns.name, upper(columns.type), columns."notnull",
       coalesce(columns.dflt_value, '<NULL>'), columns.pk, columns.hidden
FROM pragma_table_list AS tables
JOIN pragma_table_xinfo(tables.name) AS columns
WHERE tables.type = 'table'
  AND tables.name IN (${expectedTables.map((table) => `'${table}'`).join(', ')})
ORDER BY tables.name, columns.cid`
  const actualColumnsPath = join(privateDirectory, 'validation-columns.stdout')
  const actualColumnsErrorPath = join(privateDirectory, 'validation-columns.stderr')
  const referenceColumnsPath = join(privateDirectory, 'reference-columns.stdout')
  const referenceColumnsErrorPath = join(privateDirectory, 'reference-columns.stderr')
  const actualColumnResult = runPrivately('sqlite3', ['-noheader', databasePath, columnQuery], {
    stdoutPath: actualColumnsPath,
    stderrPath: actualColumnsErrorPath,
  })
  const referenceColumnResult = runPrivately('sqlite3', ['-noheader', referencePath, columnQuery], {
    stdoutPath: referenceColumnsPath,
    stderrPath: referenceColumnsErrorPath,
  })
  if (actualColumnResult.status !== 0 || referenceColumnResult.status !== 0) {
    fail('Private D1 export column validation failed')
  }
  const parseColumns = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => line.split('|'))
  const actualColumns = parseColumns(actualColumnsPath)
  const referenceColumns = parseColumns(referenceColumnsPath)
  const semantic = (column) => column.slice(2)
  const referenceColumnNames = new Set(referenceColumns.map((column) => `${column[0]}\0${column[2]}`))
  for (const actual of actualColumns) {
    if (!referenceColumnNames.has(`${actual[0]}\0${actual[2]}`)) {
      fail('Private D1 export schema has an unexpected column')
    }
  }
  const actionColumnNames = actualColumns
    .filter((column) => column[0] === 'ai_actions')
    .map((column) => column[2])
  const actionVariantA = referenceColumns
    .filter((column) => column[0] === 'ai_actions')
    .map((column) => column[2])
  const actionVariantB = actionVariantA.filter((name) => name !== 'profile_id')
  const actionVariantC = [...actionVariantB, 'profile_id']
  const actionVariant = [
    ['A', actionVariantA],
    ['B', actionVariantB],
    ['C', actionVariantC],
  ].find(([, columns]) => JSON.stringify(columns) === JSON.stringify(actionColumnNames))?.[0]
  if (!actionVariant) {
    fail('Private D1 export text AI column variant is not approved')
  }
  for (const reference of referenceColumns) {
    const [table, , name] = reference
    if (table === 'ai_actions' && name === 'profile_id') continue
    const actual = actualColumns.find((column) => column[0] === table && column[2] === name)
    if (!actual) fail('Private D1 export schema is missing a required column')
    if (table === 'ai_provider_profiles' && name === 'max_tokens') {
      if (JSON.stringify(semantic(actual).toSpliced(3, 1, '<ALLOWED>'))
        !== JSON.stringify(semantic(reference).toSpliced(3, 1, '<ALLOWED>'))
        || !['1200', '2000'].includes(actual[5])) {
        fail('Private D1 export column semantics do not match the migration baseline')
      }
    } else if (JSON.stringify(semantic(actual)) !== JSON.stringify(semantic(reference))) {
      fail('Private D1 export column semantics do not match the migration baseline')
    }
  }
  const profile = actualColumns.find((column) => column[0] === 'ai_actions' && column[2] === 'profile_id')
  const maxTokens = actualColumns.find(
    (column) => column[0] === 'ai_provider_profiles' && column[2] === 'max_tokens',
  )
  const referenceProfile = referenceColumns.find(
    (column) => column[0] === 'ai_actions' && column[2] === 'profile_id',
  )
  if (profile && JSON.stringify(semantic(profile)) !== JSON.stringify(semantic(referenceProfile))) {
    fail('Private D1 export column semantics do not match the migration baseline')
  }
  const expectedMaxTokensDefault = actionVariant === 'A' ? '2000' : '1200'
  if (maxTokens?.[5] !== expectedMaxTokensDefault) {
    fail('Private D1 export text AI column variant is not approved')
  }
}

export function capturePrivateD1Export({
  runRoot: runRootValue,
  database,
  config,
  command = wranglerPath,
  commandArgsPrefix = [],
  expectedTables = D1_PRIVATE_EXPORT_TABLES,
  timeoutMs = D1_PRIVATE_EXPORT_TIMEOUT_MS,
}) {
  if (!database || typeof database !== 'string') fail('Private D1 export requires a database')
  if (!config || !isAbsolute(config)) fail('Private D1 export requires an absolute config path')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > D1_PRIVATE_EXPORT_TIMEOUT_MS) {
    fail('Private D1 export timeout must be within the fixed maximum')
  }
  const runRoot = assertPrivateRunRoot(runRootValue)
  try {
    mkdirSync(runRoot, { mode: 0o700 })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('Private D1 export run root already exists; retries are forbidden')
    }
    fail('Unable to create the private D1 export run root')
  }
  chmodSync(runRoot, 0o700)
  const backupDirectory = join(runRoot, 'backup')
  const privateDirectory = join(runRoot, 'private')
  mkdirSync(backupDirectory, { mode: 0o700 })
  mkdirSync(privateDirectory, { mode: 0o700 })
  const sqlPath = join(backupDirectory, 'regular-tables.sql')
  const stdoutPath = join(privateDirectory, 'wrangler.stdout')
  const stderrPath = join(privateDirectory, 'wrangler.stderr')
  const debugPath = join(privateDirectory, 'wrangler.debug')
  const reportPath = join(runRoot, 'export-report.json')
  writeExportReport(reportPath, {
    format: 'blogman-d1-private-export/v1',
    state: 'started',
    attempt_count: 1,
  })

  let captured = false
  let failure = null
  try {
    writeFileSync(sqlPath, '', { flag: 'wx', mode: 0o600 })
    writeFileSync(debugPath, '', { flag: 'wx', mode: 0o600 })
    const result = runPrivately(command, [
      ...commandArgsPrefix,
      'd1', 'export', database, '--remote', '--skip-confirmation',
      ...expectedTables.flatMap((table) => ['--table', table]),
      '--output', sqlPath,
      '--config', resolve(config),
    ], {
      stdoutPath,
      stderrPath,
      env: { ...process.env, WRANGLER_LOG_PATH: debugPath },
      timeout: timeoutMs,
    })
    const debug = statSync(debugPath)
    if (!debug.isFile() || (debug.mode & 0o777) !== 0o600) {
      fail('Private D1 export debug log permissions are not 0600')
    }
    if (result.error || result.signal || result.status !== 0) {
      failure = classifyPrivateExportFailure(result, [stdoutPath, stderrPath, debugPath])
      fail('Private D1 export subprocess failed')
    }
    const sql = statSync(sqlPath)
    if (!sql.isFile() || sql.size === 0) fail('Private D1 export did not create non-empty SQL')
    if ((sql.mode & 0o777) !== 0o600) fail('Private D1 export SQL permissions are not 0600')
    validatePrivateExport(sqlPath, privateDirectory, expectedTables)
    const report = {
      format: 'blogman-d1-private-export/v1',
      state: 'captured',
      attempt_count: 1,
      artifact: {
        path: 'backup/regular-tables.sql',
        bytes: sql.size,
        sha256: sha256(readFileSync(sqlPath)),
      },
      required_tables: [...expectedTables],
    }
    writeExportReport(reportPath, report)
    captured = true
    return report
  } catch (error) {
    writeExportReport(reportPath, {
      format: 'blogman-d1-private-export/v1',
      state: 'failed',
      attempt_count: 1,
      ...(failure ? { failure } : {}),
    })
    throw error
  } finally {
    const capturesDeleted = secureDeletePrivateFiles(privateDirectory)
    const sqlDeleted = captured && capturesDeleted ? true : secureDeleteFiles([sqlPath])
    if (!capturesDeleted || !sqlDeleted) fail('Private D1 export cleanup failed')
  }
}

export function disposePrivateD1Export({ runRoot: runRootValue }) {
  const runRoot = assertPrivateRunRoot(runRootValue)
  let runRootStat
  let exportReport
  try {
    runRootStat = statSync(runRoot)
    exportReport = JSON.parse(readFileSync(join(runRoot, 'export-report.json'), 'utf8'))
  } catch {
    fail('Private D1 export run root is not disposable')
  }
  if (!runRootStat.isDirectory() || (runRootStat.mode & 0o777) !== 0o700) {
    fail('Private D1 export run root is not mode 0700')
  }
  assertNoSensitiveFields(exportReport)
  if (
    exportReport?.format !== 'blogman-d1-private-export/v1'
    || exportReport?.attempt_count !== 1
    || !['captured', 'failed'].includes(exportReport?.state)
  ) {
    fail('Private D1 export report cannot be disposed')
  }
  const privateDirectory = join(runRoot, 'private')
  const privateDeleted = secureDeletePrivateFiles(privateDirectory)
  const sqlDeleted = secureDeleteFiles([join(runRoot, 'backup', 'regular-tables.sql')])
  if (!privateDeleted
    || !sqlDeleted
    || privateFiles(privateDirectory).length > 0
    || existsSync(join(runRoot, 'backup', 'regular-tables.sql'))) {
    fail('Private D1 export disposal failed')
  }
  const report = {
    format: 'blogman-d1-private-export-disposal/v1',
    state: 'disposed',
    attempt_count: 1,
    raw_artifacts_remaining: 0,
  }
  writeFileSync(join(runRoot, 'dispose-report.json'), `${JSON.stringify(report)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  return report
}

function findWranglerD1Files(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...findWranglerD1Files(path))
    } else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
      files.push(path)
    }
  }
  return files
}

function restoreBackup(options) {
  if (!options.get('local') || options.get('remote')) {
    fail('Backup restore requires --local and never accepts --remote')
  }
  const persistTo = resolve(required(options, 'persist-to'))
  if (!isAbsolute(required(options, 'persist-to'))) {
    fail('Backup restore requires an absolute --persist-to directory')
  }
  const relativeToRepo = relative(repoRoot, persistTo)
  if (relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    fail('Backup restore target must be outside the repository')
  }
  if (readdirSync(persistTo).length !== 0) {
    fail('Backup restore target must be an empty isolated directory')
  }

  const backup = verifiedBackup(required(options, 'manifest'))
  const database = required(options, 'database')
  const config = resolve(required(options, 'config'))
  const initialize = spawnSync(wranglerPath, [
    'd1', 'execute', database, '--local', '--persist-to', persistTo,
    '--config', config, '--command', 'SELECT 1', '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (initialize.status !== 0) fail('Backup restore could not initialize local D1')

  const databaseFiles = findWranglerD1Files(persistTo)
    .filter((path) => basename(path) !== 'metadata.sqlite')
  if (databaseFiles.length !== 1) {
    fail('Backup restore could not identify one isolated local D1 file')
  }
  for (const [index, artifact] of backup.artifacts.entries()) {
    const result = spawnSync('sqlite3', ['-bail', databaseFiles[0]], {
      cwd: repoRoot,
      input: readFileSync(artifact.path),
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      fail(`Backup restore failed for artifact ${index + 1}`)
    }
  }
  const tableResult = spawnSync(wranglerPath, [
    'd1', 'execute', database, '--local', '--persist-to', persistTo,
    '--config', config,
    '--command', "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (tableResult.status !== 0) fail('Backup restore completeness check failed')
  let restoredTables
  try {
    restoredTables = new Set(
      (JSON.parse(tableResult.stdout).at(-1)?.results || []).map((row) => row.name),
    )
  } catch {
    fail('Backup restore completeness check returned invalid output')
  }
  const missingTables = backup.requiredTables.filter((name) => !restoredTables.has(name))
  if (missingTables.length > 0) fail('Backup restore is missing required tables')
  return {
    state: 'restored',
    backup_id: backup.backupId,
    target: { mode: 'local', isolated: true },
  }
}

function captureReconciliation(options) {
  const schemaRows = filterReconciliationSchemaRows(queryD1(options, `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name
`, 'schema'))
  const tableNames = new Set(
    schemaRows.filter((row) => row.type === 'table').map((row) => row.name),
  )
  const ledgerRows = tableNames.has('migration_ledger')
    ? queryD1(options, `
SELECT number, name, checksum, candidate_id
FROM migration_ledger
ORDER BY number
`, 'migration ledger')
    : []
  const postCount = queryD1(
    options,
    'SELECT COUNT(*) AS count FROM posts',
    'post count',
  ).at(0)?.count
  const statusRows = queryD1(options, `
SELECT status, COUNT(*) AS count
FROM posts
GROUP BY status
ORDER BY status
`, 'post status')
  const postRows = queryD1(options, `
SELECT id, slug, title, content, html, description, category, tags, password,
       is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
FROM posts
ORDER BY id
`, 'post content')

  return {
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: canonicalHash(schemaRows) },
    migration_ledger: {
      state: tableNames.has('migration_ledger') ? 'present' : 'absent',
      row_count: ledgerRows.length,
      sha256: canonicalHash(ledgerRows),
    },
    posts: {
      count: postCount,
      status: Object.fromEntries(statusRows.map((row) => [row.status, row.count])),
      content_sha256: canonicalHash(postRows),
    },
  }
}

export function filterReconciliationSchemaRows(rows) {
  return rows.filter((row) => !(
    row?.type === 'table'
    && (
      (row.name === '_cf_KV' && row.tbl_name === '_cf_KV')
      || (row.name === '_cf_METADATA' && row.tbl_name === '_cf_METADATA')
    )
  ))
}

function compareReconciliation(options) {
  let expected
  try {
    expected = JSON.parse(readFileSync(resolve(required(options, 'expected')), 'utf8'))
  } catch {
    fail('Expected reconciliation snapshot is not valid JSON')
  }
  if (expected?.format !== 'blogman-d1-reconciliation/v1') {
    fail('Unsupported reconciliation snapshot format')
  }
  const actual = captureReconciliation(options)
  const checks = {
    schema: expected.schema?.sha256 === actual.schema.sha256 ? 'matched' : 'drift',
    migration_ledger: JSON.stringify(expected.migration_ledger) === JSON.stringify(actual.migration_ledger)
      ? 'matched'
      : 'drift',
    post_count: expected.posts?.count === actual.posts.count ? 'matched' : 'drift',
    post_status: JSON.stringify(expected.posts?.status) === JSON.stringify(actual.posts.status)
      ? 'matched'
      : 'drift',
    post_content: expected.posts?.content_sha256 === actual.posts.content_sha256
      ? 'matched'
      : 'drift',
  }
  const driftDimensions = Object.entries(checks)
    .filter(([, value]) => value === 'drift')
    .map(([name]) => name)
  return {
    state: driftDimensions.length === 0 ? 'matched' : 'drift',
    checks,
    ...(driftDimensions.length > 0 ? { drift_dimensions: driftDimensions } : {}),
  }
}

function rolloutControl(value) {
  if (value === 'producer' || value === 'authority') {
    return { key: value, kind: value }
  }
  if (/^executor:[a-z0-9][a-z0-9_-]*$/.test(value || '')) {
    return { key: value, kind: 'executor' }
  }
  fail('Rollout control must be producer, authority, or executor:<name>')
}

export function captureReadOnlyControls({ query, emergency = process.env }) {
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const exactKeys = (value, keys) => record(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  const schemaRows = query(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`, 'rollout schema')
  if (!Array.isArray(schemaRows) || schemaRows.some((row) => !record(row) || !exactKeys(row, ['name']) || typeof row.name !== 'string')) fail('Invalid rollout schema evidence')
  if (new Set(schemaRows.map((row) => row.name)).size !== schemaRows.length) fail('Duplicate rollout schema evidence')
  const rows = schemaRows.some((row) => row.name === 'rollout_controls')
    ? query(`SELECT control_key, control_kind, desired_enabled, candidate_id, evidence_sha256
FROM rollout_controls
ORDER BY control_kind, control_key`, 'rollout controls')
    : []
  if (!Array.isArray(rows)) fail('Invalid rollout controls evidence')
  const controls = new Map()
  for (const row of rows) {
    if (!record(row) || !exactKeys(row, ['candidate_id', 'control_key', 'control_kind', 'desired_enabled', 'evidence_sha256'])
      || typeof row.candidate_id !== 'string' || typeof row.evidence_sha256 !== 'string' || ![0, 1].includes(row.desired_enabled)) fail('Invalid rollout control row')
    const control = rolloutControl(row.control_key)
    if (control.kind !== row.control_kind || controls.has(control.key)) fail('Invalid rollout control row')
    controls.set(control.key, row.desired_enabled === 1)
  }
  const stateFor = (key) => {
    const emergencyState = emergencySwitchFor(key, emergency)
    if (!emergencyState.valid) fail('Invalid rollout emergency switch')
    return controls.get(key) === true && !emergencyState.disabled ? 'enabled' : 'disabled'
  }
  const executors = Object.fromEntries([...controls.keys()].filter((key) => key.startsWith('executor:')).sort()
    .map((key) => [key.slice('executor:'.length), stateFor(key)]))
  return { state: 'captured', producer: stateFor('producer'), authority: stateFor('authority'), executors }
}

function emergencySwitchFor(controlKey, environment) {
  const suffix = controlKey === 'producer' || controlKey === 'authority'
    ? controlKey.toUpperCase()
    : `EXECUTOR_${controlKey.slice('executor:'.length).toUpperCase().replaceAll('-', '_')}`
  const value = environment[`BLOGMAN_DISABLE_${suffix}`]
  if (value === undefined || value === '' || value === '0' || value === 'false') return { disabled: false, valid: true }
  if (value === '1' || value === 'true') return { disabled: true, valid: true }
  return { disabled: true, valid: false }
}

function rolloutControlsStatus(options) {
  const allowed = ['config', 'database', 'remote']
  for (const key of options.keys()) if (!allowed.includes(key)) fail('Unexpected rollout controls-status option')
  if (options.get('remote') !== 'true') fail('Rollout controls-status requires --remote')
  return captureReadOnlyControls({ query: (sql, evidenceName) => queryD1(options, sql, evidenceName) })
}

async function requestSmoke(options) {
  if (!options.get('local') || options.get('remote')) {
    fail('Representative request smoke requires --local and never accepts --remote')
  }
  const persistToValue = required(options, 'persist-to')
  if (!isAbsolute(persistToValue)) {
    fail('Representative request smoke requires an absolute --persist-to directory')
  }
  const persistTo = resolve(persistToValue)
  const relativeToRepo = relative(repoRoot, persistTo)
  if (relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    fail('Representative request smoke target must be outside the repository')
  }

  const before = captureReconciliation(options)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'blogman-restored-request-smoke-'))
  const bundlePath = join(temporaryDirectory, 'request-smoke.mjs')
  const smokeConfigPath = join(temporaryDirectory, 'wrangler.toml')
  let workerd
  try {
    const { build } = await import('esbuild')
    const contextShim = join(repoRoot, 'scripts', 'request-smoke', 'cloudflare-context.mjs')
    await build({
      entryPoints: [join(repoRoot, 'scripts', 'request-smoke', 'worker.ts')],
      outfile: bundlePath,
      absWorkingDir: repoRoot,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      define: { __dirname: '"/"' },
      logLevel: 'silent',
      plugins: [{
        name: 'restored-d1-cloudflare-context',
        setup(buildContext) {
          buildContext.onResolve(
            { filter: /^@opennextjs\/cloudflare$/ },
            () => ({ path: contextShim }),
          )
        },
      }],
    })

    const sourceConfig = readFileSync(resolve(required(options, 'config')), 'utf8')
    const database = required(options, 'database')
    const d1Blocks = [...sourceConfig.matchAll(
      /\[\[d1_databases\]\]([\s\S]*?)(?=\n\[\[|\n\[[^[]|$)/g,
    )].map((match) => match[1])
    const d1Block = d1Blocks.find((block) => {
      const binding = block.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1]
      return binding === database
    })
    const databaseName = d1Block?.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1]
    const databaseId = d1Block?.match(/^\s*database_id\s*=\s*"([^"]+)"/m)?.[1]
    if (!databaseName || !databaseId) fail('Representative request smoke D1 binding is incomplete')
    writeFileSync(smokeConfigPath, `
name = "blogman-restored-request-smoke"
main = "${bundlePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"
compatibility_date = "2026-04-14"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "${database}"
database_name = "${databaseName}"
database_id = "${databaseId}"
`)

    const port = await new Promise((resolvePort, rejectPort) => {
      const server = createServer()
      server.once('error', rejectPort)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const selectedPort = typeof address === 'object' && address ? address.port : null
        server.close((error) => error ? rejectPort(error) : resolvePort(selectedPort))
      })
    })
    if (!Number.isInteger(port)) fail('Representative request smoke could not reserve a local port')
    workerd = spawn(wranglerPath, [
      'dev', bundlePath, '--local', '--persist-to', persistTo,
      '--config', smokeConfigPath, '--ip', '127.0.0.1', '--port', String(port),
      '--log-level', 'none',
    ], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (workerd.exitCode !== null) break
      try {
        const response = await fetch(`${origin}/__smoke/health`)
        if (
          response.status === 204
          && response.headers.get('x-blogman-smoke-runtime') === 'workerd'
        ) {
          ready = true
          break
        }
      } catch {
        // Wrangler is still starting the isolated Workerd runtime.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (!ready) fail('Representative restored D1 Workerd did not become ready')

    const requests = []
    for (const request of [
      { name: 'search', path: '/api/search?q=Restored' },
      { name: 'appearance', path: '/api/settings/appearance' },
    ]) {
      const response = await fetch(`${origin}${request.path}`)
      if (
        response.status !== 200
        || response.headers.get('x-blogman-smoke-runtime') !== 'workerd'
      ) {
        fail('Representative restored D1 request smoke returned a failing response')
      }
      await response.arrayBuffer()
      requests.push({ name: request.name, status: response.status })
    }

    const after = captureReconciliation(options)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail('Representative request smoke changed restored D1 facts')
    }
    const report = {
      state: 'passed',
      target: 'external-local-d1-persist',
      runtime: 'workerd',
      requests,
      reconciliation: 'matched',
    }
    return { ...report, report_sha256: canonicalHash(report) }
  } finally {
    if (workerd && workerd.exitCode === null) {
      workerd.kill('SIGTERM')
      await Promise.race([
        new Promise((resolveExit) => workerd.once('exit', resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ])
      if (workerd.exitCode === null) workerd.kill('SIGKILL')
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function main() {
  const [domain, action, ...args] = process.argv.slice(2)
  const options = parseOptions(args)
  let report
  if (domain === 'backup') {
    if (action === 'export') {
      assertOnlyOptions(options, ['run-root', 'database', 'config', 'remote'])
      if (!options.get('remote')) fail('Private D1 export requires --remote')
    } else if (action === 'dispose') {
      assertOnlyOptions(options, ['run-root'])
    }
    report = action === 'export'
      ? capturePrivateD1Export({
          runRoot: required(options, 'run-root'),
          database: required(options, 'database'),
          config: required(options, 'config'),
        })
      : action === 'dispose'
        ? disposePrivateD1Export({ runRoot: required(options, 'run-root') })
        : action === 'verify'
          ? verifyBackup(options)
          : action === 'restore'
            ? restoreBackup(options)
            : fail('Expected backup action: export, dispose, verify, or restore')
  } else if (domain === 'reconcile') {
    report = action === 'capture'
      ? captureReconciliation(options)
      : action === 'compare'
        ? compareReconciliation(options)
        : fail('Expected reconcile action: capture or compare')
  } else if (domain === 'rollout') {
    report = action === 'controls-status'
      ? rolloutControlsStatus(options)
      : fail('Expected rollout action: controls-status')
  } else if (domain === 'request') {
    report = action === 'smoke'
      ? await requestSmoke(options)
      : fail('Expected request action: smoke')
  } else {
    fail('Expected command domain: backup, reconcile, rollout, or request')
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (
    report.state === 'drift'
    || report.state === 'invalid'
    || report.state === 'blocked'
    || report.state === 'stale'
  ) {
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Rollout safety command failed'}\n`)
    process.exitCode = 1
  }
}
