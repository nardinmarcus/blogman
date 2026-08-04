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
const migrations = join(repoRoot, 'scripts', 'migrations.mjs')
const LOCAL_REHEARSAL_CHILD_TIMEOUT_MS = 60_000

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function runLocalRehearsal({
  repositoryPath = repoRoot,
  manifestDraftSha256,
  productionWriteAdapter = { calls: 0 },
} = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-rehearsal-'))
  const stateToken = stateDirectory
  const guardPath = join(stateDirectory, 'network-disabled.cjs')
  writeFileSync(guardPath, `
    const net = require('node:net')
    const dns = require('node:dns')
    const local = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const blocked = () => { throw new Error('network disabled during local rehearsal') }
    const originalConnect = net.connect
    net.connect = (...args) => {
      const options = typeof args[0] === 'object' ? args[0] : { host: args[0] }
      if (!local(options.host)) return blocked()
      return originalConnect(...args)
    }
    net.createConnection = net.connect
    const originalLookup = dns.lookup
    dns.lookup = (host, ...args) => local(host) ? originalLookup(host, ...args) : blocked()
    dns.resolve = blocked
  `)
  chmodSync(guardPath, 0o600)
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${guardPath}`.trim(),
  }
  const commands = buildLocalRehearsalCommands({
    runnerPath: 'scripts/migrations.mjs',
    configPath: 'wrangler.toml',
    stateToken,
    candidate: 'issue-23-local-rehearsal',
  })
  const run = ({ argv }) => spawnSync(process.execPath, [
    migrations,
    ...argv.slice(1),
  ], {
    cwd: repositoryPath,
    env,
    timeout: LOCAL_REHEARSAL_CHILD_TIMEOUT_MS,
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
