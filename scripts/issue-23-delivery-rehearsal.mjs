import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildLocalEntryReceipt,
  buildLocalRehearsalCommands,
  parseLocalCommandResult,
} from './issue-23-delivery-entry.mjs'

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

export function runLocalRehearsal({
  repositoryPath = repoRoot,
  runnerPath,
  migrationRunnerPath,
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
  if (!Number.isSafeInteger(childTimeoutMs) || childTimeoutMs <= 0) {
    throw new Error('Issue #23 local rehearsal child timeout is invalid')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('Issue #23 local rehearsal output bound is invalid')
  }
  const runnerAbsolutePath = resolveConfiguredRunner(repositoryPath, configuredRunnerPath)
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
    })
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
