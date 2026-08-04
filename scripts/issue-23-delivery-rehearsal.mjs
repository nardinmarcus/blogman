import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildLocalEntryReceipt,
  buildLocalRehearsalCommands,
  parseLocalCommandResult,
} from './issue-23-delivery-entry.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCAL_REHEARSAL_CHILD_TIMEOUT_MS = 60_000
const LOCAL_REHEARSAL_SUPERVISOR_SOURCE = [
  "import { spawn } from 'node:child_process'",
  'const [runnerPath, ...runnerArgs] = process.argv.slice(1)',
  'let stdout = \'\'\nlet stderr = \'\'',
  'const child = spawn(process.execPath, [runnerPath, ...runnerArgs], { stdio: [\'ignore\', \'pipe\', \'pipe\'] })',
  'child.stdout.on(\'data\', (chunk) => { stdout += chunk })',
  'child.stderr.on(\'data\', (chunk) => { stderr += chunk })',
  'const killGroup = () => { try { process.kill(-process.pid, \'SIGKILL\') } catch { try { child.kill(\'SIGKILL\') } catch {} } }',
  'process.once(\'SIGTERM\', killGroup)',
  'process.once(\'SIGINT\', killGroup)',
  'child.on(\'error\', () => killGroup())',
  'child.on(\'close\', (code, signal) => {',
  '  if (code !== 0 || signal) { killGroup(); return }',
  '  process.stdout.write(stdout)',
  '  process.stderr.write(stderr)',
  '  process.exit(0)',
  '})',
].join('\n')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function runLocalRehearsal({
  repositoryPath = repoRoot,
  runnerPath,
  migrationRunnerPath,
  manifestDraftSha256,
  productionWriteAdapter = { calls: 0 },
  childTimeoutMs = LOCAL_REHEARSAL_CHILD_TIMEOUT_MS,
  environment = {},
} = {}) {
  const configuredRunnerPath = runnerPath ?? migrationRunnerPath
  if (typeof configuredRunnerPath !== 'string' || configuredRunnerPath.length === 0) {
    throw new Error('Issue #23 local rehearsal requires a configured migration runner')
  }
  const stateDirectory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-rehearsal-'))
  const stateToken = stateDirectory
  const guardPath = join(stateDirectory, 'network-disabled.cjs')
  writeFileSync(guardPath, `
    const net = require('node:net')
    const dns = require('node:dns')
    const local = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const hostFrom = (value) => {
      if (typeof value === 'number') return '127.0.0.1'
      if (typeof value === 'string') return value
      if (value && typeof value === 'object') return value.hostname || value.host
      return undefined
    }
    const urlHost = (value) => {
      try {
        return new URL(typeof value === 'string' ? value : value?.url).hostname
      } catch {
        return undefined
      }
    }
    const blocked = () => { throw new Error('network disabled during local rehearsal') }
    const originalConnect = net.connect
    net.connect = (...args) => {
      if (!local(hostFrom(args[0]))) return blocked()
      return originalConnect(...args)
    }
    net.createConnection = net.connect
    const originalLookup = dns.lookup
    dns.lookup = (host, ...args) => local(host) ? originalLookup(host, ...args) : blocked()
    dns.resolve = blocked
    dns.resolve4 = blocked
    dns.resolve6 = blocked
    dns.reverse = blocked
    if (globalThis.fetch) {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, ...args) => local(urlHost(input)) ? originalFetch(input, ...args) : blocked()
    }
  `)
  chmodSync(guardPath, 0o600)
  const env = { ...process.env, ...environment }
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${guardPath}`.trim()
  const commands = buildLocalRehearsalCommands({
    runnerPath: configuredRunnerPath,
    configPath: 'wrangler.toml',
    stateToken,
    candidate: 'issue-23-local-rehearsal',
  })
  const run = ({ argv }) => spawnSync(process.execPath, [
    '-e',
    LOCAL_REHEARSAL_SUPERVISOR_SOURCE,
    resolve(repositoryPath, argv[0]),
    ...argv.slice(1),
  ], {
    cwd: repositoryPath,
    env,
    detached: true,
    timeout: childTimeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  })
  const outputs = []
  const adapterCallsBefore = productionWriteAdapter.calls
  try {
    for (const command of commands) {
      const result = run(command)
      outputs.push({ name: command.name, value: parseLocalCommandResult(result, command.name) })
    }
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true })
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
    disposableState: {
      identity: sha256(Buffer.from('disposable-state')),
      created: true,
      cleaned: true,
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
