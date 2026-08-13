import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkerTransport } from '../../scripts/issue-23-delivery-worker-transport.mjs'

const smoke = { requests: [
  { path: '/api/search', status: 200 }, { path: '/api/settings/appearance', status: 200 },
  { path: '/api/admin/tokens', status: 200 }, { path: '/api/admin/ai-provider', status: 200 },
  { path: '/api/admin/ai-post-generators', status: 200 }, { path: '/api/admin/posts/__blogman_smoke_absent__', status: 404 },
], admin_credential_slot: 'delivery_smoke_admin' }
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
  const source = join(root, 'source')
  const archive = join(source, 'build.zip')
  const expected = join(root, 'expected.json')
  const log = join(root, 'calls.log')
  const wrangler = join(root, 'wrangler')
  const rollout = join(root, 'rollout.mjs')
  const workerUploadEntry = join(root, 'issue-23-delivery-worker-upload.mjs')
  const npm = join(root, 'npm')
  const openNext = join(root, 'opennextjs-cloudflare')
  const curl = join(root, 'curl')
  const packageJson = join(root, 'package.json')
  const lockfile = join(root, 'package-lock.json')
  writeFileSync(config, 'name = "test"\n')
  writeFileSync(expected, '{}\n')
  writeFileSync(log, '')
  mkdirSync(source)
  writeFileSync(archive, 'fake archive\n')
  writeFileSync(join(source, 'worker.js'), 'fake worker\n')
  writeFileSync(workerUploadEntry, 'process.stdout.write("{}")\n')
  writeFileSync(npm, '#!/bin/sh\nexit 0\n')
  writeFileSync(openNext, '#!/usr/bin/env node\n')
  writeFileSync(curl, `#!/usr/bin/env node
const args = process.argv.slice(2)
const headerIndex = args.indexOf('--header')
if (args[headerIndex + 1] !== 'Cookie: blogman_admin=smoke-cookie') process.exit(19)
const url = args.at(-1)
process.stdout.write(url.includes('/api/admin/posts/') ? '404' : '200')
`)
  writeFileSync(packageJson, '{}\n')
  writeFileSync(lockfile, '{}\n')
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
  chmodSync(npm, 0o755)
  chmodSync(openNext, 0o755)
  chmodSync(curl, 0o755)
  return {
    root, config, archive, source, expected, log, wrangler, rollout, workerUploadEntry, npm, openNext, curl,
    packageJson, lockfile,
  }
}

async function localServer(root: string) {
  const portFile = join(root, 'port')
  const server = spawn(process.execPath, ['-e', `
const http = require('node:http')
const fs = require('node:fs')
const server = http.createServer((request, response) => {
  response.statusCode = request.url.startsWith('/api/admin/posts/') ? 404 : 200
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
  const artifactFileTree = [{
    path: '.open-next/worker.js', sha256: hash(join(fixture.source, 'worker.js')),
    bytes: readFileSync(join(fixture.source, 'worker.js')).byteLength,
  }]
  return {
    config_path: fixture.config, config_sha256: hash(fixture.config),
    artifact_archive_path: fixture.archive, artifact_archive_sha256: hash(fixture.archive),
    artifact_source_path: fixture.source,
    artifact_file_tree_sha256: createHash('sha256').update(JSON.stringify(artifactFileTree)).digest('hex'),
    artifact_file_tree_files: artifactFileTree,
    artifact_sha256: 'b'.repeat(64),
    candidate_id: candidate, worker_name: 'worker-name', d1_database_id: 'd1-id', database: 'DB',
    rollout_safety_path: fixture.rollout, rollout_safety_sha256: hash(fixture.rollout),
    expected_reconciliation_path: fixture.expected, expected_reconciliation_sha256: hash(fixture.expected),
    worker_upload_entry_path: fixture.workerUploadEntry,
    worker_upload_entry_sha256: hash(fixture.workerUploadEntry),
    wrangler_path: fixture.wrangler, wrangler_sha256: hash(fixture.wrangler),
    node_path: process.execPath, node_sha256: hash(process.execPath),
    npm_path: fixture.npm, npm_sha256: hash(fixture.npm),
    open_next_path: fixture.openNext, open_next_sha256: hash(fixture.openNext),
    curl_path: fixture.curl, curl_sha256: hash(fixture.curl),
    package_json_path: fixture.packageJson, package_json_sha256: hash(fixture.packageJson),
    lockfile_path: fixture.lockfile, lockfile_sha256: hash(fixture.lockfile),
    origin: `http://127.0.0.1:${port}`, smoke,
    baseline: { deployment_id: 'deployment-new', version_id: 'version-new', d1_database_id: 'd1-id', traffic: [{ version_id: 'version-new', percentage: 100 }] },
  }
}

describe('Issue #91 private smoke_control_t0 adapter', () => {
  it('uses only fake executables and a loopback server for bounded pre/post, six GETs, controls, and reconciliation', async () => {
    const current = fixture()
    const port = await localServer(current.root)
    const originalLog = process.env.WORKER_FAKE_LOG
    const originalSmokeCredential = process.env.DELIVERY_SMOKE_ADMIN
    process.env.WORKER_FAKE_LOG = current.log
    process.env.DELIVERY_SMOKE_ADMIN = 'smoke-cookie'
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
      if (originalSmokeCredential === undefined) delete process.env.DELIVERY_SMOKE_ADMIN
      else process.env.DELIVERY_SMOKE_ADMIN = originalSmokeCredential
    }
  }, 30000)

  it('passes the transport-created unique Wrangler output path into the integrated upload entry', () => {
    const current = fixture()
    const capturedPath = join(current.root, 'captured-output-path')
    const capturedContent = join(current.root, 'captured-output-content')
    writeFileSync(current.workerUploadEntry, `
const fs = await import('node:fs')
const outputPath = process.env.WRANGLER_OUTPUT_FILE_PATH
if (!outputPath) process.exit(17)
fs.writeFileSync(process.env.WORKER_OUTPUT_PATH_CAPTURE, outputPath)
const output = JSON.stringify({ type: 'version-upload', version: 1, version_id: 'fixture-version' }) + '\\n'
fs.writeFileSync(outputPath, output)
fs.writeFileSync(process.env.WORKER_OUTPUT_CONTENT_CAPTURE, output)
process.stdout.write(JSON.stringify({ accepted: true }))
`)
    const value = bindings(current, 1)
    value.worker_upload_entry_sha256 = hash(current.workerUploadEntry)
    const originalOutputPath = process.env.WRANGLER_OUTPUT_FILE_PATH
    const originalCapturePath = process.env.WORKER_OUTPUT_PATH_CAPTURE
    const originalContentCapture = process.env.WORKER_OUTPUT_CONTENT_CAPTURE
    delete process.env.WRANGLER_OUTPUT_FILE_PATH
    process.env.WORKER_OUTPUT_PATH_CAPTURE = capturedPath
    process.env.WORKER_OUTPUT_CONTENT_CAPTURE = capturedContent
    try {
      const transport = createWorkerTransport(value)
      transport.execute({
        operation: 'worker_deploy',
        stage: 'worker_deploy',
        timeout_ms: 600000,
        elapsed_ms: 0,
        version_id: undefined,
        deployment_id: undefined,
      })
      const outputPath = readFileSync(capturedPath, 'utf8')
      expect(outputPath).toMatch(/upload\.jsonl$/u)
      expect(readFileSync(capturedContent, 'utf8')).toContain('fixture-version')
    } finally {
      if (originalOutputPath === undefined) delete process.env.WRANGLER_OUTPUT_FILE_PATH
      else process.env.WRANGLER_OUTPUT_FILE_PATH = originalOutputPath
      if (originalCapturePath === undefined) delete process.env.WORKER_OUTPUT_PATH_CAPTURE
      else process.env.WORKER_OUTPUT_PATH_CAPTURE = originalCapturePath
      if (originalContentCapture === undefined) delete process.env.WORKER_OUTPUT_CONTENT_CAPTURE
      else process.env.WORKER_OUTPUT_CONTENT_CAPTURE = originalContentCapture
    }
  }, 30_000)

  it.each([
    ['config', (current: ReturnType<typeof fixture>) => writeFileSync(current.config, 'drift\n')],
    ['artifact archive', (current: ReturnType<typeof fixture>) => writeFileSync(current.archive, 'drift\n')],
    ['complete artifact source', (current: ReturnType<typeof fixture>) => writeFileSync(join(current.source, 'worker.js'), 'drift\n')],
    ['upload lifecycle script', (current: ReturnType<typeof fixture>) => {
      writeFileSync(current.workerUploadEntry, 'drift\n')
    }],
  ])('returns manifest drift for %s before D1 selection or any fake production command', async (_name, drift) => {
    const current = fixture()
    const port = await localServer(current.root)
    const originalLog = process.env.WORKER_FAKE_LOG
    process.env.WORKER_FAKE_LOG = current.log
    try {
      const value = bindings(current, port)
      const transport = createWorkerTransport(value)
      drift(current)
      expect(transport.livePreconditions()).toMatchObject({ outcome: 'NON_PASS', classification: 'Manifest Drift' })
      expect(readFileSync(current.log, 'utf8')).toBe('')
    } finally {
      if (originalLog === undefined) delete process.env.WORKER_FAKE_LOG
      else process.env.WORKER_FAKE_LOG = originalLog
    }
  }, 30000)

  it.each([
    '/absolute.js',
    '.open-next/../worker.js',
    '../worker.js',
    '.open-next\\worker.js',
    '.open-next/control\nworker.js',
  ])('rejects artifact file-tree path %j before source enumeration', (path) => {
    const current = fixture()
    const value = bindings(current, 1)
    value.artifact_file_tree_files = [{
      path,
      sha256: hash(join(current.source, 'worker.js')),
      bytes: readFileSync(join(current.source, 'worker.js')).byteLength,
    }]
    value.artifact_file_tree_sha256 = createHash('sha256')
      .update(JSON.stringify(value.artifact_file_tree_files))
      .digest('hex')

    expect(createWorkerTransport(value).livePreconditions()).toMatchObject({
      outcome: 'NON_PASS',
      classification: 'Manifest Drift',
    })
    expect(readFileSync(current.log, 'utf8')).toBe('')
  })

  it('accepts a direct archive binding that is absent from the upload source manifest', () => {
    const current = fixture()
    const value = bindings(current, 1)
    const originalLog = process.env.WORKER_FAKE_LOG
    process.env.WORKER_FAKE_LOG = current.log
    try {
      expect(value.artifact_file_tree_files.map(({ path }) => path)).not.toContain('.open-next/build.zip')
      expect(createWorkerTransport(value).livePreconditions()).toMatchObject({ outcome: 'PASS' })
    } finally {
      if (originalLog === undefined) delete process.env.WORKER_FAKE_LOG
      else process.env.WORKER_FAKE_LOG = originalLog
    }
  })

  it('rejects an archive binding outside the exact direct source location', () => {
    const current = fixture()
    const outsideArchive = join(current.root, 'outside-build.zip')
    writeFileSync(outsideArchive, readFileSync(current.archive))
    const value = bindings(current, 1)
    value.artifact_archive_path = outsideArchive
    value.artifact_archive_sha256 = hash(outsideArchive)

    expect(createWorkerTransport(value).livePreconditions()).toMatchObject({
      outcome: 'NON_PASS',
      classification: 'Manifest Drift',
    })
  })

  it('includes a nested file with the archive basename and rejects its manifest omission', () => {
    const current = fixture()
    const nested = join(current.source, 'nested', 'build.zip')
    mkdirSync(join(current.source, 'nested'), { recursive: true })
    writeFileSync(nested, 'nested archive-named deployable\n')
    const value = bindings(current, 1)
    const nestedEntry = {
      path: '.open-next/nested/build.zip',
      sha256: hash(nested),
      bytes: readFileSync(nested).byteLength,
    }
    value.artifact_file_tree_files = [...value.artifact_file_tree_files, nestedEntry]
      .sort((left, right) => left.path.localeCompare(right.path))
    value.artifact_file_tree_sha256 = createHash('sha256')
      .update(JSON.stringify(value.artifact_file_tree_files))
      .digest('hex')

    const originalLog = process.env.WORKER_FAKE_LOG
    process.env.WORKER_FAKE_LOG = current.log
    try {
      expect(createWorkerTransport(value).livePreconditions()).toMatchObject({ outcome: 'PASS' })

      value.artifact_file_tree_files = value.artifact_file_tree_files.filter(({ path }) => path !== nestedEntry.path)
      value.artifact_file_tree_sha256 = createHash('sha256')
        .update(JSON.stringify(value.artifact_file_tree_files))
        .digest('hex')
      expect(createWorkerTransport(value).livePreconditions()).toMatchObject({
        outcome: 'NON_PASS',
        classification: 'Manifest Drift',
      })
    } finally {
      if (originalLog === undefined) delete process.env.WORKER_FAKE_LOG
      else process.env.WORKER_FAKE_LOG = originalLog
    }
  })

  it('accepts @ in an artifact file-tree path', () => {
    const current = fixture()
    const sourcePath = join(current.source, '@fixture', 'runtime', 'worker.js')
    mkdirSync(join(current.source, '@fixture', 'runtime'), { recursive: true })
    writeFileSync(sourcePath, 'scoped worker\n')
    const value = bindings(current, 1)
    rmSync(join(current.source, 'worker.js'))
    value.artifact_file_tree_files = [{
      path: '.open-next/@fixture/runtime/worker.js',
      sha256: hash(sourcePath),
      bytes: readFileSync(sourcePath).byteLength,
    }]
    value.artifact_file_tree_sha256 = createHash('sha256')
      .update(JSON.stringify(value.artifact_file_tree_files))
      .digest('hex')
    const originalLog = process.env.WORKER_FAKE_LOG
    process.env.WORKER_FAKE_LOG = current.log
    try {
      expect(createWorkerTransport(value).livePreconditions()).toMatchObject({ outcome: 'PASS' })
    } finally {
      if (originalLog === undefined) delete process.env.WORKER_FAKE_LOG
      else process.env.WORKER_FAKE_LOG = originalLog
    }
  })
})
