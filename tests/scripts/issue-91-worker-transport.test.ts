import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkerTransport } from '../../scripts/issue-23-delivery-worker-transport.mjs'

const smoke = { requests: [
  { path: '/api/search', status: 200 }, { path: '/api/settings/appearance', status: 200 },
  { path: '/api/settings/tokens', status: 200 }, { path: '/api/settings/ai-provider', status: 200 },
  { path: '/api/settings/ai-generators', status: 200 }, { path: '/api/admin/articles/__blogman_smoke_absent__', status: 404 },
] }
const candidate = 'a'.repeat(40)
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const roots: string[] = []
const servers: ReturnType<typeof spawn>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'blogman-issue-91-worker-transport-'))
  roots.push(root)
  const config = join(root, 'wrangler.toml')
  const archive = join(root, 'build.zip')
  const source = join(root, 'source')
  const expected = join(root, 'expected.json')
  const log = join(root, 'calls.log')
  const wrangler = join(root, 'wrangler')
  const rollout = join(root, 'rollout.mjs')
  writeFileSync(config, 'name = "test"\n')
  writeFileSync(archive, 'fake archive\n')
  writeFileSync(expected, '{}\n')
  writeFileSync(log, '')
  writeFileSync(source, '')
  writeFileSync(wrangler, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(process.env.WORKER_FAKE_LOG, process.argv.slice(2).join(' ') + '\\n')
if (process.argv.includes('deployments')) process.stdout.write(JSON.stringify({ id: 'deployment-new', versions: [{ version_id: 'version-new', percentage: 100 }] }))
else if (process.argv.includes('d1')) process.stdout.write(JSON.stringify({ uuid: 'd1-id' }))
else if (process.argv.includes('versions')) process.stdout.write('{}')
else process.exitCode = 1
`)
  writeFileSync(rollout, `
const fs = await import('node:fs')
fs.appendFileSync(process.env.WORKER_FAKE_LOG, process.argv.slice(2).join(' ') + '\\n')
if (process.argv.includes('controls-status')) console.log(JSON.stringify({ state: 'captured', producer: 'disabled', authority: 'disabled', executors: { scheduler: 'disabled' } }))
else console.log(JSON.stringify({ state: 'matched', checks: { schema: 'matched', migration_ledger: 'matched', post_count: 'matched', post_status: 'matched', post_content: 'matched' } }))
`)
  chmodSync(wrangler, 0o755)
  return { root, config, archive, source, expected, log, wrangler, rollout }
}

async function localServer(root: string) {
  const portFile = join(root, 'port')
  const server = spawn(process.execPath, ['-e', `
const http = require('node:http')
const fs = require('node:fs')
const server = http.createServer((request, response) => {
  response.statusCode = request.url.startsWith('/api/admin/articles/') ? 404 : 200
  response.end('body must not be retained')
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[1], String(server.address().port)))
`, portFile], { stdio: 'ignore' })
  servers.push(server)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return Number(readFileSync(portFile, 'utf8')) } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  throw new Error('local test server did not start')
}

function bindings(fixture: ReturnType<typeof fixture>, port: number) {
  return {
    config_path: fixture.config, config_sha256: hash(fixture.config),
    artifact_archive_path: fixture.archive, artifact_archive_sha256: hash(fixture.archive),
    artifact_source_path: fixture.source, artifact_sha256: 'b'.repeat(64),
    candidate_id: candidate, worker_name: 'worker-name', d1_database_id: 'd1-id', database: 'DB',
    rollout_safety_path: fixture.rollout, rollout_safety_sha256: hash(fixture.rollout),
    expected_reconciliation_path: fixture.expected,
    wrangler_path: fixture.wrangler, wrangler_sha256: hash(fixture.wrangler),
    origin: `http://127.0.0.1:${port}`, smoke,
    baseline: { deployment_id: 'deployment-new', version_id: 'version-new', d1_database_id: 'd1-id', traffic: [{ version_id: 'version-new', percentage: 100 }] },
  }
}

describe('Issue #91 private smoke_control_t0 adapter', () => {
  it('uses only fake executables and a loopback server for bounded pre/post, six GETs, controls, and reconciliation', async () => {
    const current = fixture()
    const port = await localServer(current.root)
    const originalLog = process.env.WORKER_FAKE_LOG
    process.env.WORKER_FAKE_LOG = current.log
    try {
      const transport = createWorkerTransport(bindings(current, port))
      const result = transport.execute({ operation: 'smoke_control_t0', stage: 'smoke_control_t0', timeout_ms: 300000, elapsed_ms: 0, version_id: 'version-new', deployment_id: 'deployment-new' })
      expect(JSON.parse(result.stdout)).toEqual({
        before: { deployment_id: 'deployment-new', version_id: 'version-new', d1_database_id: 'd1-id', traffic: [{ version_id: 'version-new', percentage: 100 }] },
        after: { deployment_id: 'deployment-new', version_id: 'version-new', d1_database_id: 'd1-id', traffic: [{ version_id: 'version-new', percentage: 100 }] },
        checks: Object.fromEntries(smoke.requests.map(({ path, status }) => [path, status])),
        controls: { producer: 'disabled', authority: 'disabled', executors: { scheduler: 'disabled' } },
        reconciliation: { state: 'matched', checks: { schema: 'matched', migration_ledger: 'matched', post_count: 'matched', post_status: 'matched', post_content: 'matched' } },
      })
      const calls = readFileSync(current.log, 'utf8').trim().split('\n')
      expect(calls.filter((call) => call.startsWith('deployments status'))).toHaveLength(2)
      expect(calls.filter((call) => call.startsWith('d1 info'))).toHaveLength(2)
      expect(calls).toContain('rollout controls-status --database DB --remote --config ' + current.config)
      expect(calls).toContain('reconcile compare --expected ' + current.expected + ' --database DB --remote --config ' + current.config)
    } finally {
      if (originalLog === undefined) delete process.env.WORKER_FAKE_LOG
      else process.env.WORKER_FAKE_LOG = originalLog
    }
  }, 30000)

  it('returns live drift before any fake production command', async () => {
    const current = fixture()
    const port = await localServer(current.root)
    const originalLog = process.env.WORKER_FAKE_LOG
    process.env.WORKER_FAKE_LOG = current.log
    try {
      const value = bindings(current, port)
      const transport = createWorkerTransport(value)
      writeFileSync(current.config, 'drift\n')
      expect(transport.livePreconditions()).toMatchObject({ outcome: 'NON_PASS', classification: 'Manifest Drift' })
      expect(readFileSync(current.log, 'utf8')).toBe('')
    } finally {
      if (originalLog === undefined) delete process.env.WORKER_FAKE_LOG
      else process.env.WORKER_FAKE_LOG = originalLog
    }
  }, 30000)
})
