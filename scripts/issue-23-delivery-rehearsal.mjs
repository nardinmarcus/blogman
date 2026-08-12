import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildLocalEntryReceipt,
  buildLocalRehearsalCommands,
  parseLocalCommandResult,
} from './issue-23-delivery-entry.mjs'
import { createD1Transport } from './issue-23-delivery-d1-transport.mjs'
import { runD1Stages } from './issue-23-delivery-d1-stages.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCAL_REHEARSAL_CHILD_TIMEOUT_MS = 120_000
const LOCAL_REHEARSAL_SUPERVISOR_GRACE_MS = 5_000
const LOCAL_REHEARSAL_MAX_OUTPUT_BYTES = 1024 * 1024
const LOCAL_REHEARSAL_OUTER_MAX_BUFFER = 16 * 1024 * 1024
const LOCAL_REHEARSAL_NETWORK_PROBE_TIMEOUT_MS = 5_000
const LOCAL_REHEARSAL_CLEANUP_SETTLE_MS = 100
const MACOS_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec'
const MACOS_SANDBOX_PROFILE = '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))'
const NETWORK_PROBE_SOURCE = [
  '(async () => {',
  "  try { await fetch('https://example.com'); process.exit(1) }",
  "  catch { process.stdout.write('blocked') }",
  '})()',
].join('\n')
const LOCAL_REHEARSAL_NETWORK_GUARD_SOURCE = `
    const net = require('node:net')
    const tls = require('node:tls')
    const dns = require('node:dns')
    const local = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const hostFrom = (value) => {
      if (typeof value === 'number') return '127.0.0.1'
      if (typeof value === 'string') return value
      if (value && typeof value === 'object') return value.hostname || value.host
      return undefined
    }
    const urlHost = (value) => {
      try { return new URL(typeof value === 'string' ? value : value?.url).hostname } catch { return undefined }
    }
    const blocked = () => { throw new Error('network disabled during local rehearsal') }
    const originalConnect = net.connect
    net.connect = (...args) => {
      if (!local(hostFrom(args[0]))) return blocked()
      return originalConnect(...args)
    }
    net.createConnection = net.connect
    const originalTlsConnect = tls.connect
    tls.connect = (...args) => {
      if (!local(hostFrom(args[0]))) return blocked()
      return originalTlsConnect(...args)
    }
    const originalLookup = dns.lookup
    dns.lookup = (host, ...args) => local(host) ? originalLookup(host, ...args) : blocked()
    for (const name of ['resolve', 'resolve4', 'resolve6', 'reverse', 'lookupService']) dns[name] = blocked
    if (dns.promises) {
      for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse', 'lookupService']) dns.promises[name] = blocked
    }
    if (globalThis.fetch) {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, ...args) => local(urlHost(input)) ? originalFetch(input, ...args) : blocked()
    }
  `
const LOCAL_REHEARSAL_SUPERVISOR_SOURCE = [
  "import { spawn } from 'node:child_process'",
  'const [runnerPath, timeoutText, maxOutputText, ...runnerArgs] = process.argv.slice(1)',
  'const timeoutMs = Number(timeoutText)',
  'const maxOutputBytes = Number(maxOutputText)',
  'let stdout = \'\'\nlet stderr = \'\'\nlet stdoutBytes = 0\nlet stderrBytes = 0',
  'let outputOverflow = false\nlet timedOut = false\nlet childError = null\nlet emitted = false',
  'let child',
  'const killGroup = (signal = \'SIGKILL\') => { if (!child?.pid) return; try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} } }',
  'const append = (kind, chunk) => { const text = chunk.toString(\'utf8\'); const bytes = Buffer.byteLength(text); if (kind === \'stdout\') { stdoutBytes = Math.min(maxOutputBytes + 1, stdoutBytes + bytes); if (stdoutBytes > maxOutputBytes) outputOverflow = true; else stdout += text } else { stderrBytes = Math.min(maxOutputBytes + 1, stderrBytes + bytes); if (stderrBytes > maxOutputBytes) outputOverflow = true; else stderr += text }; if (outputOverflow) killGroup() }',
  'const hasResidualProcessGroup = () => { if (!child?.pid) return false; try { process.kill(-child.pid, 0); return true } catch { return false } }',
  'const emit = (status, residualProcessGroup = false, code = null, signal = null) => { if (emitted) return; emitted = true; process.stdout.write(JSON.stringify({ format: \'blogman-issue-23-supervisor/v1\', status, child_status: code, child_signal: signal, child_error: childError?.code || null, stdout, stderr, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, residual_process_group: residualProcessGroup }), () => process.exit(0)) }',
  'const finish = (code, signal) => { const residual = hasResidualProcessGroup(); if (timedOut || outputOverflow || residual || code !== 0 || signal) killGroup(); const settleMs = timedOut || outputOverflow || residual ? 25 : 0; setTimeout(() => { const residualAfterKill = residual && hasResidualProcessGroup(); if (timedOut) emit(\'timed_out\', residualAfterKill, code, signal); else if (outputOverflow) emit(\'output_overflow\', residualAfterKill, code, signal); else if (residual) emit(\'residual_process_group\', residualAfterKill, code, signal); else if (code === 0 && !signal && !childError) emit(\'completed\', false, code, signal); else emit(\'failed\', residualAfterKill, code, signal) }, settleMs) }',
  'try { child = spawn(process.execPath, [runnerPath, ...runnerArgs], { detached: true, stdio: [\'ignore\', \'pipe\', \'pipe\'] }) } catch (error) { childError = error; emit(\'failed\') }',
  'if (child) { child.stdout.on(\'data\', (chunk) => append(\'stdout\', chunk)); child.stderr.on(\'data\', (chunk) => append(\'stderr\', chunk)); child.on(\'error\', (error) => { childError = error; killGroup() }); child.on(\'close\', finish); setTimeout(() => { timedOut = true; killGroup() }, timeoutMs) }',
  'process.once(\'SIGTERM\', () => { timedOut = true; killGroup() })',
  'process.once(\'SIGINT\', () => { timedOut = true; killGroup() })',
].join('\n')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isActualMacOS() {
  if (process.platform !== 'darwin') return false
  try {
    return execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim() === 'Darwin'
  } catch {
    return false
  }
}

function resolveConfiguredRunner(repositoryPath, configuredRunnerPath) {
  const lexicalRoot = resolve(repositoryPath)
  const lexicalRunner = resolve(lexicalRoot, configuredRunnerPath)
  if (lexicalRunner !== lexicalRoot && !lexicalRunner.startsWith(`${lexicalRoot}${sep}`)) {
    throw new Error('Issue #23 local rehearsal runner escapes repository')
  }
  try {
    const canonicalRoot = realpathSync(lexicalRoot)
    const canonicalRunner = realpathSync(lexicalRunner)
    if (canonicalRunner !== canonicalRoot && !canonicalRunner.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error('Issue #23 local rehearsal runner escapes repository')
    }
    return canonicalRunner
  } catch (error) {
    if (error.message === 'Issue #23 local rehearsal runner escapes repository') throw error
    throw new Error('Issue #23 local rehearsal runner could not be resolved')
  }
}

function resolveMigrationCatalogDirectory(repositoryPath, configuredCatalogPath) {
  const lexicalRoot = resolve(repositoryPath)
  const lexicalCatalog = resolve(lexicalRoot, configuredCatalogPath)
  if (lexicalCatalog !== lexicalRoot && !lexicalCatalog.startsWith(`${lexicalRoot}${sep}`)) {
    throw new Error('Issue #23 local rehearsal migration catalog escapes repository')
  }

  let canonicalRoot
  let canonicalCatalog
  try {
    canonicalRoot = realpathSync(lexicalRoot)
    canonicalCatalog = realpathSync(lexicalCatalog)
  } catch {
    throw new Error('Issue #23 local rehearsal migration catalog could not be resolved')
  }
  if (canonicalCatalog === canonicalRoot || !canonicalCatalog.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error('Issue #23 local rehearsal migration catalog escapes repository')
  }

  let isDirectory
  try {
    isDirectory = statSync(canonicalCatalog).isDirectory()
  } catch {
    throw new Error('Issue #23 local rehearsal migration catalog could not be resolved')
  }
  if (!isDirectory) {
    throw new Error('Issue #23 local rehearsal migration catalog is not a directory')
  }
  return relative(canonicalRoot, canonicalCatalog).split(sep).join('/')
}

function verifyNetworkBoundary(env, actualMacOS) {
  if (actualMacOS && !existsSync(MACOS_SANDBOX_EXECUTABLE)) {
    throw new Error('Issue #23 local rehearsal requires macOS sandbox-exec')
  }
  const probeEnv = { ...env }
  if (actualMacOS) delete probeEnv.NODE_OPTIONS
  const executable = actualMacOS ? MACOS_SANDBOX_EXECUTABLE : process.execPath
  const args = actualMacOS
    ? ['-p', MACOS_SANDBOX_PROFILE, process.execPath, '-e', NETWORK_PROBE_SOURCE]
    : ['-e', NETWORK_PROBE_SOURCE]
  const result = spawnSync(executable, args, {
    env: probeEnv,
    encoding: 'utf8',
    timeout: LOCAL_REHEARSAL_NETWORK_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  })
  if (result.error || result.status !== 0 || result.signal || result.stdout !== 'blocked' || result.stderr !== '') {
    throw new Error('Issue #23 local rehearsal could not observe the external network as blocked')
  }
  return {
    boundary: actualMacOS ? 'macos-sandbox-exec-loopback' : 'node-guard-only',
    external_probe: 'blocked',
  }
}

function observeCleanup(directory) {
  const settle = spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${LOCAL_REHEARSAL_CLEANUP_SETTLE_MS})`], {
    stdio: 'ignore',
    timeout: LOCAL_REHEARSAL_CLEANUP_SETTLE_MS + 1_000,
  })
  return !settle.error && settle.status === 0 && !existsSync(directory)
}

function runLegacyLocalRehearsal({
  repositoryPath = repoRoot,
  runnerPath,
  migrationRunnerPath,
  migrationCatalogPath = 'db/ledger-migrations',
  manifestDraftSha256,
  productionWriteAdapter = { calls: 0 },
  childTimeoutMs = LOCAL_REHEARSAL_CHILD_TIMEOUT_MS,
  maxOutputBytes = LOCAL_REHEARSAL_MAX_OUTPUT_BYTES,
  environment = {},
} = {}) {
  const configuredRunnerPath = runnerPath ?? migrationRunnerPath
  if (typeof configuredRunnerPath !== 'string' || configuredRunnerPath.length === 0) {
    throw new Error('Issue #23 local rehearsal requires a configured migration runner')
  }
  if (typeof migrationCatalogPath !== 'string'
    || migrationCatalogPath.length === 0
    || /[\u0000\r\n]/u.test(migrationCatalogPath)) {
    throw new Error('Issue #23 local rehearsal requires a configured migration catalog')
  }
  if (!Number.isSafeInteger(childTimeoutMs) || childTimeoutMs <= 0) {
    throw new Error('Issue #23 local rehearsal child timeout is invalid')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('Issue #23 local rehearsal output bound is invalid')
  }
  const runnerAbsolutePath = resolveConfiguredRunner(repositoryPath, configuredRunnerPath)
  const canonicalMigrationCatalogPath = resolveMigrationCatalogDirectory(repositoryPath, migrationCatalogPath)
  const actualMacOS = isActualMacOS()
  let stateDirectory = ''
  let stateCreated = false
  let stateCleaned = false
  let observedAbsent = false
  let commands
  let outputs
  let networkEvidence
  const adapterCallsBefore = productionWriteAdapter.calls

  try {
    stateDirectory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-rehearsal-'))
    stateCreated = true
    const guardPath = join(stateDirectory, 'network-disabled.cjs')
    writeFileSync(guardPath, LOCAL_REHEARSAL_NETWORK_GUARD_SOURCE)
    chmodSync(guardPath, 0o600)
    const env = { ...process.env, ...environment }
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${guardPath}`.trim()
    networkEvidence = verifyNetworkBoundary(env, actualMacOS)
    commands = buildLocalRehearsalCommands({
      runnerPath: configuredRunnerPath,
      configPath: 'wrangler.toml',
      stateToken: stateDirectory,
      candidate: 'issue-23-local-rehearsal',
    }).map((command) => ({
      ...command,
      args: [command.args[0], '--migrations-dir', canonicalMigrationCatalogPath, ...command.args.slice(1)],
      argv: [configuredRunnerPath, command.args[0], '--migrations-dir', canonicalMigrationCatalogPath, ...command.args.slice(1)],
    }))
    const run = ({ argv }) => {
      const supervisorArgs = [
        runnerAbsolutePath,
        String(childTimeoutMs),
        String(maxOutputBytes),
        ...argv.slice(1),
      ]
      const executable = actualMacOS ? MACOS_SANDBOX_EXECUTABLE : process.execPath
      const args = actualMacOS
        ? ['-p', MACOS_SANDBOX_PROFILE, process.execPath, '-e', LOCAL_REHEARSAL_SUPERVISOR_SOURCE, ...supervisorArgs]
        : ['-e', LOCAL_REHEARSAL_SUPERVISOR_SOURCE, ...supervisorArgs]
      return spawnSync(executable, args, {
        cwd: repositoryPath,
        env,
        detached: true,
        timeout: childTimeoutMs + LOCAL_REHEARSAL_SUPERVISOR_GRACE_MS,
        killSignal: 'SIGTERM',
        maxBuffer: LOCAL_REHEARSAL_OUTER_MAX_BUFFER,
        encoding: 'utf8',
      })
    }
    outputs = []
    for (const command of commands) {
      const result = run(command)
      outputs.push({ name: command.name, value: parseLocalCommandResult(result, command.name) })
    }
  } finally {
    if (stateDirectory) {
      try {
        rmSync(stateDirectory, { recursive: true, force: true })
        stateCleaned = !existsSync(stateDirectory)
        observedAbsent = stateCleaned && observeCleanup(stateDirectory)
      } catch {
        stateCleaned = false
        observedAbsent = false
      }
    }
  }

  if (!stateCreated || !stateCleaned || !observedAbsent) {
    throw new Error('Issue #23 local rehearsal cleanup was not observed')
  }
  const adapterCallsAfter = productionWriteAdapter.calls
  if (adapterCallsBefore !== adapterCallsAfter || adapterCallsAfter !== 0) {
    throw new Error('Issue #23 local rehearsal observed a production-write adapter call')
  }
  const receiptCommands = commands.map((command) => ({
    ...command,
    args: command.args.map((arg) => arg === stateDirectory ? '<disposable-state>' : arg),
  }))
  const receipt = buildLocalEntryReceipt({
    manifestDraftSha256,
    commands: receiptCommands,
    outputs,
    runtime: {
      os: process.platform === 'darwin' ? 'macos' : process.platform,
      architecture: process.arch,
      node_version: process.versions.node,
    },
    network: 'disabled',
    networkEvidence,
    disposableState: {
      identity: sha256(Buffer.from('blogman-issue-23-disposable-state/v1')),
      created: stateCreated,
      cleaned: stateCleaned,
      observed_absent: observedAbsent,
    },
    adapterOutputs: [{ name: 'production-write', calls: adapterCallsAfter }],
  })
  return {
    runtime: receipt.value.runtime,
    network: 'disabled',
    status: 'PASS',
    receipt_sha256: receipt.sha256,
    production_write_adapter_calls: adapterCallsAfter,
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeExpectedReconciliation(value) {
  if (!isRecord(value)
    || Reflect.ownKeys(value).length !== 4
    || !['format', 'schema', 'migration_ledger', 'posts'].every((key) => Reflect.ownKeys(value).includes(key))
    || value.format !== 'blogman-d1-reconciliation/v1') {
    throw new Error('Issue #23 local rehearsal expected reconciliation is invalid')
  }
  if (!isRecord(value.schema)
    || Reflect.ownKeys(value.schema).length !== 1
    || !/^[a-f0-9]{64}$/u.test(value.schema.sha256)) {
    throw new Error('Issue #23 local rehearsal expected schema is invalid')
  }
  if (!isRecord(value.migration_ledger)
    || Reflect.ownKeys(value.migration_ledger).length !== 3
    || !['absent', 'present'].includes(value.migration_ledger.state)
    || !Number.isSafeInteger(value.migration_ledger.row_count)
    || value.migration_ledger.row_count < 0
    || !/^[a-f0-9]{64}$/u.test(value.migration_ledger.sha256)) {
    throw new Error('Issue #23 local rehearsal expected migration ledger is invalid')
  }
  if (!isRecord(value.posts)
    || Reflect.ownKeys(value.posts).length !== 3
    || !Number.isSafeInteger(value.posts.count)
    || value.posts.count < 0
    || !isRecord(value.posts.status)
    || !/^[a-f0-9]{64}$/u.test(value.posts.content_sha256)) {
    throw new Error('Issue #23 local rehearsal expected posts are invalid')
  }
  for (const count of Object.values(value.posts.status)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Issue #23 local rehearsal expected post status is invalid')
    }
  }
  return {
    format: value.format,
    schema: { sha256: value.schema.sha256 },
    migration_ledger: {
      state: value.migration_ledger.state,
      row_count: value.migration_ledger.row_count,
      sha256: value.migration_ledger.sha256,
    },
    posts: {
      count: value.posts.count,
      status: Object.fromEntries(Object.entries(value.posts.status).sort()),
      content_sha256: value.posts.content_sha256,
    },
  }
}

function expectedReconciliationBytes(value) {
  return Buffer.from(`${JSON.stringify(normalizeExpectedReconciliation(value), null, 2)}\n`, 'utf8')
}

function resolveCanonicalPath(repositoryPath, value, expected, label) {
  if (value !== expected) throw new Error(`Issue #23 local rehearsal ${label} is not canonical`)
  return resolveConfiguredRunner(repositoryPath, value)
}

function runBoundedRehearsalScript({ scriptPath, args, name, repositoryPath, env, actualMacOS, childTimeoutMs, maxOutputBytes }) {
  const supervisorArgs = [
    scriptPath,
    String(childTimeoutMs),
    String(maxOutputBytes),
    ...args,
  ]
  const executable = actualMacOS ? MACOS_SANDBOX_EXECUTABLE : process.execPath
  const supervisorSourceArgs = actualMacOS
    ? ['-p', MACOS_SANDBOX_PROFILE, process.execPath, '-e', LOCAL_REHEARSAL_SUPERVISOR_SOURCE, ...supervisorArgs]
    : ['-e', LOCAL_REHEARSAL_SUPERVISOR_SOURCE, ...supervisorArgs]
  const result = spawnSync(executable, supervisorSourceArgs, {
    cwd: repositoryPath,
    env,
    detached: true,
    timeout: childTimeoutMs + LOCAL_REHEARSAL_SUPERVISOR_GRACE_MS,
    killSignal: 'SIGTERM',
    maxBuffer: LOCAL_REHEARSAL_OUTER_MAX_BUFFER,
    encoding: 'utf8',
  })
  return parseLocalCommandResult(result, name)
}

function sanitizeRehearsalArgument(value, expectedStateDirectory, actualStateDirectory) {
  if (value === expectedStateDirectory) return '<expected-state>'
  if (value === actualStateDirectory) return '<actual-state>'
  return value
}

function runCanonicalLocalRehearsal({
  repositoryPath,
  d1,
  manifestDraftSha256,
  productionWriteAdapter,
  childTimeoutMs,
  maxOutputBytes,
  environment,
}) {
  if (!isRecord(d1)) throw new Error('Issue #23 local rehearsal requires canonical D1 facts')
  if (!/^[a-f0-9]{40}$/u.test(d1.candidate_id)) {
    throw new Error('Issue #23 local rehearsal candidate identity is invalid')
  }
  const canonicalConfig = resolveCanonicalPath(repositoryPath, d1.config_path, 'wrangler.toml', 'config path')
  const canonicalReset = resolveCanonicalPath(
    repositoryPath,
    d1.reset_sql_path,
    'db/issue-23-clean-start-reset.sql',
    'reset SQL path',
  )
  const canonicalRunner = resolveCanonicalPath(
    repositoryPath,
    d1.migration_runner_path,
    'scripts/migrations.mjs',
    'migration runner path',
  )
  const canonicalCatalog = resolveCanonicalPath(
    repositoryPath,
    d1.migration_catalog_path,
    'db/ledger-migrations',
    'migration catalog path',
  )
  const canonicalRolloutSafety = resolveCanonicalPath(
    repositoryPath,
    d1.rollout_safety_path,
    'scripts/rollout-safety.mjs',
    'rollout safety path',
  )
  const actualMacOS = isActualMacOS()
  const adapterCallsBefore = productionWriteAdapter.calls
  let expectedStateDirectory = ''
  let actualStateDirectory = ''
  let expectedSnapshotPath = ''
  let expectedSnapshot
  let expectedSnapshotSha256 = ''
  let networkEvidence
  let d1Result
  let expectedApply
  const commands = []
  let stateCreated = false
  let stateCleaned = false
  let observedAbsent = false
  try {
    expectedStateDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-expected-')))
    actualStateDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-90-actual-')))
    chmodSync(expectedStateDirectory, 0o700)
    chmodSync(actualStateDirectory, 0o700)
    stateCreated = true
    const guardPath = join(expectedStateDirectory, 'network-disabled.cjs')
    writeFileSync(guardPath, LOCAL_REHEARSAL_NETWORK_GUARD_SOURCE, { mode: 0o600 })
    chmodSync(guardPath, 0o600)
    const env = { ...process.env, ...environment }
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${guardPath}`.trim()
    env.BLOGMAN_REHEARSAL_NETWORK_SANDBOX = '1'
    networkEvidence = verifyNetworkBoundary(env, actualMacOS)

    const expectedApplyArgs = [
      'apply',
      '--database', d1.database,
      '--local',
      '--persist-to', expectedStateDirectory,
      '--config', canonicalConfig,
      '--migrations-dir', canonicalCatalog,
      '--candidate', d1.candidate_id,
    ]
    commands.push({ name: 'expected_migrations', args: [canonicalRunner, ...expectedApplyArgs] })
    expectedApply = runBoundedRehearsalScript({
      scriptPath: canonicalRunner,
      args: expectedApplyArgs,
      name: 'expected migrations',
      repositoryPath,
      env,
      actualMacOS,
      childTimeoutMs,
      maxOutputBytes,
    })
    if (!isRecord(expectedApply) || expectedApply.state !== 'current') {
      throw new Error('Issue #23 local rehearsal expected migrations did not reach current state')
    }

    const captureArgs = [
      'reconcile', 'capture',
      '--database', d1.database,
      '--local',
      '--persist-to', expectedStateDirectory,
      '--config', canonicalConfig,
    ]
    commands.push({ name: 'expected_reconciliation', args: [canonicalRolloutSafety, ...captureArgs] })
    const captured = runBoundedRehearsalScript({
      scriptPath: canonicalRolloutSafety,
      args: captureArgs,
      name: 'expected reconciliation',
      repositoryPath,
      env,
      actualMacOS,
      childTimeoutMs,
      maxOutputBytes,
    })
    expectedSnapshot = normalizeExpectedReconciliation(captured)
    const snapshotBytes = expectedReconciliationBytes(expectedSnapshot)
    expectedSnapshotSha256 = sha256(snapshotBytes)
    if (d1.expected_reconciliation_sha256 !== undefined
      && d1.expected_reconciliation_sha256 !== expectedSnapshotSha256) {
      throw new Error('Issue #23 local rehearsal expected reconciliation identity drifted')
    }
    expectedSnapshotPath = join(expectedStateDirectory, 'expected-reconciliation.json')
    writeFileSync(expectedSnapshotPath, snapshotBytes, { mode: 0o600 })
    chmodSync(expectedSnapshotPath, 0o600)

    const localBindings = {
      mode: 'local',
      persist_path: actualStateDirectory,
      database: d1.database,
      config_path: canonicalConfig,
      config_sha256: d1.config_sha256,
      wrangler_sha256: d1.wrangler_sha256,
      account_id: d1.account_id,
      d1_database_id: d1.d1_database_id,
      reset_sql_path: canonicalReset,
      reset_sql_sha256: d1.reset_sql_sha256,
      migration_runner_path: canonicalRunner,
      migration_runner_sha256: d1.migration_runner_sha256,
      migration_catalog_path: canonicalCatalog,
      migration_catalog_sha256: d1.migration_catalog_sha256,
      rollout_safety_path: canonicalRolloutSafety,
      rollout_safety_sha256: d1.rollout_safety_sha256,
      expected_reconciliation_path: expectedSnapshotPath,
      expected_reconciliation_sha256: expectedSnapshotSha256,
      candidate_id: d1.candidate_id,
      evidence_class: 'local-non-production',
      migrations: d1.migrations,
    }
    const actualCommands = [
      { name: 'd1_identity', args: ['d1_identity'] },
      { name: 'clean_start_reset', args: ['clean_start_reset'] },
      { name: 'empty_d1_proof', args: ['empty_d1_proof'] },
      { name: 'migration_catalog', args: ['migration_catalog'] },
      { name: 'migration_plan', args: ['migration_plan'] },
      { name: 'migration_apply', args: ['migration_apply'] },
      { name: 'migration_verify', args: ['migration_verify'] },
      { name: 'reconciliation', args: ['reconciliation'] },
    ]
    commands.push(...actualCommands)
    const previousNodeOptions = process.env.NODE_OPTIONS
    const previousSandbox = process.env.BLOGMAN_REHEARSAL_NETWORK_SANDBOX
    process.env.NODE_OPTIONS = env.NODE_OPTIONS
    process.env.BLOGMAN_REHEARSAL_NETWORK_SANDBOX = '1'
    try {
      const transport = createD1Transport(localBindings)
      d1Result = runD1Stages({ bindings: localBindings, transport })
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
      if (previousSandbox === undefined) delete process.env.BLOGMAN_REHEARSAL_NETWORK_SANDBOX
      else process.env.BLOGMAN_REHEARSAL_NETWORK_SANDBOX = previousSandbox
    }
  } finally {
    const directories = [expectedStateDirectory, actualStateDirectory].filter(Boolean)
    try {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
      stateCleaned = directories.every((directory) => !existsSync(directory))
      observedAbsent = stateCleaned && directories.every((directory) => observeCleanup(directory))
    } catch {
      stateCleaned = false
      observedAbsent = false
    }
  }

  if (!stateCreated || !stateCleaned || !observedAbsent) {
    throw new Error('Issue #23 local rehearsal cleanup was not observed')
  }
  const adapterCallsAfter = productionWriteAdapter.calls
  if (adapterCallsBefore !== adapterCallsAfter || adapterCallsAfter !== 0) {
    throw new Error('Issue #23 local rehearsal observed a production-write adapter call')
  }
  if (!d1Result || !expectedSnapshot) {
    throw new Error('Issue #23 local rehearsal did not produce a D1 result')
  }
  const sanitizedCommands = commands.map((command) => ({
    name: command.name,
    args: command.args.map((arg) => sanitizeRehearsalArgument(arg, expectedStateDirectory, actualStateDirectory)),
  }))
  const receipt = buildLocalEntryReceipt({
    manifestDraftSha256,
    commands: sanitizedCommands,
    outputs: commands.map(({ name }) => {
      if (name === 'expected_migrations') {
        return { name, value: { state: expectedApply.state } }
      }
      if (name === 'expected_reconciliation') {
        return { name, value: { format: expectedSnapshot.format, sha256: expectedSnapshotSha256 } }
      }
      return {
        name,
        value: {
          outcome: d1Result.value.outcome,
          first_terminal_stage: d1Result.value.first_terminal_stage,
          stage_counts: d1Result.value.stage_counts,
          stage_durations_ms: d1Result.value.stage_durations_ms,
          production: false,
          promotable: false,
        },
      }
    }),
    runtime: {
      os: process.platform === 'darwin' ? 'macos' : process.platform,
      architecture: process.arch,
      node_version: process.versions.node,
    },
    network: 'disabled',
    networkEvidence,
    disposableState: {
      identity: sha256(Buffer.from('blogman-issue-90-local-d1-rehearsal/v1')),
      created: stateCreated,
      cleaned: stateCleaned,
      observed_absent: observedAbsent,
      directory_count: 2,
    },
    adapterOutputs: [{ name: 'production-write', calls: adapterCallsAfter }],
  })
  return {
    runtime: receipt.value.runtime,
    network: 'disabled',
    status: d1Result.value.outcome === 'PASS' ? 'PASS' : 'NON_PASS',
    receipt_sha256: receipt.sha256,
    production_write_adapter_calls: adapterCallsAfter,
    expected_reconciliation: {
      value: expectedSnapshot,
      sha256: expectedSnapshotSha256,
    },
    d1: {
      outcome: d1Result.value.outcome,
      first_terminal_stage: d1Result.value.first_terminal_stage,
      production: false,
      promotable: false,
      stage_counts: d1Result.value.stage_counts,
      stage_durations_ms: d1Result.value.stage_durations_ms,
      sha256: d1Result.sha256,
    },
    cleanup: {
      created: stateCreated,
      cleaned: stateCleaned,
      observed_absent: observedAbsent,
    },
  }
}

export function runLocalRehearsal(options = {}) {
  const repositoryPath = repositoryPathOrDefault(options.repositoryPath)
  if (!isRecord(options.d1)) {
    throw new Error('Issue #23 local rehearsal requires canonical D1 facts')
  }
  const configuredRunnerPath = options.runnerPath ?? options.migrationRunnerPath
  if (configuredRunnerPath !== undefined && configuredRunnerPath !== 'scripts/migrations.mjs') {
    throw new Error('Issue #23 local rehearsal runner path is not canonical')
  }
  if (options.migrationCatalogPath !== undefined
    && options.migrationCatalogPath !== 'db/ledger-migrations') {
    throw new Error('Issue #23 local rehearsal catalog path is not canonical')
  }
  if (options.resetSqlPath !== undefined
    && options.resetSqlPath !== 'db/issue-23-clean-start-reset.sql') {
    throw new Error('Issue #23 local rehearsal reset SQL path is not canonical')
  }
  return runCanonicalLocalRehearsal({
    repositoryPath,
    d1: options.d1,
    manifestDraftSha256: options.manifestDraftSha256,
    productionWriteAdapter: options.productionWriteAdapter ?? { calls: 0 },
    childTimeoutMs: options.childTimeoutMs ?? LOCAL_REHEARSAL_CHILD_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? LOCAL_REHEARSAL_MAX_OUTPUT_BYTES,
    environment: options.environment ?? {},
  })
}

export function runLocalRehearsalForTestsOnly(options = {}) {
  return runLegacyLocalRehearsal(options)
}

function repositoryPathOrDefault(path) {
  return path ?? repoRoot
}
