import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runPreflight,
  uploadToolchainPath,
} from '../../scripts/issue-23-delivery-worker-upload.mjs'
const temporaryDirectories: string[] = []
const sharedTemporaryDirectory = realpathSync('/tmp')
const crossRootTemporaryDirectory = realpathSync(
  existsSync('/Users/Shared') ? '/Users/Shared'
    : existsSync('/dev/shm') ? '/dev/shm' : process.cwd(),
)
const workerUploadPath = join(
  process.cwd(),
  'scripts',
  'issue-23-delivery-worker-upload.mjs',
)

function bindUploadAssetsDirectory(configPath: string, uploadSourceDirectory: string) {
  return spawnSync(process.execPath, [
    workerUploadPath,
    'bind-upload-assets-directory',
    '--config', configPath,
    '--upload-source-directory', uploadSourceDirectory,
  ], { encoding: 'utf8' })
}

function uploadSourceSnapshot(
  command: 'create-upload-source-snapshot' | 'verify-upload-source-snapshot',
  args: string[],
  env?: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, [workerUploadPath, command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

type UploadSourceSnapshotProof = {
  tree_sha256: string
  identity_sha256?: string
}

function snapshotVerificationArgs(directory: string, proof: UploadSourceSnapshotProof) {
  const args = ['--directory', directory, '--tree-sha256', proof.tree_sha256]
  if (proof.identity_sha256) {
    args.push('--identity-sha256', proof.identity_sha256)
  }
  return args
}

function uploadSourceSnapshotFixture() {
  const directory = realpathSync(mkdtempSync(join(
    sharedTemporaryDirectory,
    'blogman-upload-source-snapshot-',
  )))
  temporaryDirectories.push(directory)
  const source = join(directory, 'snapshot-repository', '.open-next')
  const asset = join(source, 'assets', 'asset.txt')
  const destination = join(directory, 'private-evidence', 'upload-source-snapshot')
  mkdirSync(dirname(destination), { recursive: true })
  chmodSync(dirname(destination), 0o700)
  mkdirSync(dirname(asset), { recursive: true })
  writeFileSync(join(source, 'worker.js'), 'sealed worker\n')
  writeFileSync(asset, 'sealed asset\n')
  return { asset, destination, directory, source }
}

function sealedBuildArchive(_directory: string, source: string) {
  const archive = join(source, 'open-next-build.zip')
  const zipped = spawnSync('/usr/bin/zip', [
    '-X', '-q', archive, 'worker.js', 'assets/asset.txt',
  ], { cwd: source, encoding: 'utf8' })
  expect(zipped.status, zipped.stderr).toBe(0)
  return {
    archive,
    archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  }
}

function uploadSourceLifecycleFixture(
  parentDirectory = sharedTemporaryDirectory,
  sourceParentDirectory?: string,
) {
  const directory = realpathSync(mkdtempSync(join(
    parentDirectory,
    'blogman-upload-lifecycle-',
  )))
  temporaryDirectories.push(directory)
  const top = join(directory, 'swappable-top')
  const project = join(top, 'candidate')
  const sourceRoot = sourceParentDirectory
    ? realpathSync(mkdtempSync(join(sourceParentDirectory, '.blogman-upload-source-')))
    : join(project, 'snapshot-repository')
  if (sourceParentDirectory) temporaryDirectories.push(sourceRoot)
  const source = join(sourceRoot, '.open-next')
  const destination = join(project, 'private-evidence', 'upload-source-snapshot')
  const reportDirectory = dirname(destination)
  const operatorDirectory = join(project, 'operator')
  const config = join(operatorDirectory, 'wrangler.toml')
  const proofBefore = join(reportDirectory, 'upload-source-snapshot.json')
  const proofAfter = join(reportDirectory, 'upload-source-snapshot-after.json')
  const buildProof = join(reportDirectory, 'upload-build-directory-proof.json')
  const uploadOutput = join(reportDirectory, 'upload-private.jsonl')
  const uploadChildStdout = join(reportDirectory, 'upload-child-stdout.log')
  const uploadChildStderr = join(reportDirectory, 'upload-child-stderr.log')
  const counter = join(directory, 'upload-count.txt')
  const fakeBin = join(directory, 'fake-bin')
  const archive = join(source, 'open-next-build.zip')
  mkdirSync(join(source, 'assets'), { recursive: true })
  mkdirSync(reportDirectory, { recursive: true })
  chmodSync(reportDirectory, 0o700)
  mkdirSync(operatorDirectory)
  mkdirSync(fakeBin)
  writeFileSync(join(source, 'worker.js'), 'sealed worker\n')
  writeFileSync(join(source, 'assets', 'asset.txt'), 'sealed asset\n')
  const configBytes = `[assets]\ndirectory = ${JSON.stringify(join(source, 'assets'))}\n`
  writeFileSync(config, configBytes)
  const configSha256 = createHash('sha256').update(configBytes).digest('hex')
  for (const path of [proofBefore, proofAfter, buildProof, uploadOutput, uploadChildStdout, uploadChildStderr]) {
    writeFileSync(path, '')
    chmodSync(path, 0o600)
  }
  writeFileSync(counter, '0')
  chmodSync(counter, 0o600)
  const zipped = spawnSync('/usr/bin/zip', [
    '-X', '-q', archive, 'worker.js', 'assets/asset.txt',
  ], { cwd: source, encoding: 'utf8' })
  expect(zipped.status, zipped.stderr).toBe(0)
  const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  return {
    archive,
    archiveSha256,
    buildProof,
    config,
    configSha256,
    counter,
    destination,
    directory,
    fakeBin,
    proofAfter,
    proofBefore,
    project,
    reportDirectory,
    source,
    top,
    uploadChildStderr,
    uploadChildStdout,
    uploadOutput,
  }
}

function installCountingUpload(fixture: ReturnType<typeof uploadSourceLifecycleFixture>) {
  writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
const count = Number(fs.readFileSync(process.env.UPLOAD_COUNTER, 'utf8')) + 1
fs.writeFileSync(process.env.UPLOAD_COUNTER, String(count))
fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
  type: 'version-upload', version: 1, version_id: 'fixture-version',
}) + '\\n')
`)
  chmodSync(join(fixture.fakeBin, 'npm'), 0o755)
}

function lifecycleToolchainArgs(fakeBin: string, workingDirectory = process.cwd()) {
  const npmPath = join(fakeBin, 'npm')
  const hash = createHash('sha256').update(readFileSync(npmPath)).digest('hex')
  return [
    '--node-path', process.execPath,
    '--node-sha256', createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
    '--npm-path', npmPath, '--npm-sha256', hash,
    '--open-next-path', npmPath, '--open-next-sha256', hash,
    '--working-directory', workingDirectory,
  ]
}

function runCurrentUploadLifecycle(
  fixture: ReturnType<typeof uploadSourceLifecycleFixture>,
  environment: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
) {
  return spawnSync(process.execPath, [
    workerUploadPath,
    'run-upload-source-lifecycle',
    ...lifecycleToolchainArgs(fixture.fakeBin),
    '--config', fixture.config,
    '--source', fixture.source,
    '--destination', fixture.destination,
    '--operation-id', `issue-23-${'a'.repeat(40)}-upload-1`,
    '--proof-before', fixture.proofBefore,
    '--proof-after', fixture.proofAfter,
    '--archive', fixture.archive,
    '--archive-sha256', fixture.archiveSha256,
    '--build-proof', fixture.buildProof,
    '--expected-config-sha256', fixture.configSha256,
  ], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}${delimiter}${process.env.PATH}`,
      WRANGLER_OUTPUT_FILE_PATH: fixture.uploadOutput,
      UPLOAD_STDOUT_FILE_PATH: fixture.uploadChildStdout,
      UPLOAD_STDERR_FILE_PATH: fixture.uploadChildStderr,
      UPLOAD_COUNTER: fixture.counter,
      ...environment,
    },
  })
}

// Issue #168: production-isomorphic fixture. The real frozen artifact contains
// scoped-package directories ('@opentelemetry/api') and Next.js route-directory
// names ('[slug]', '(protected)', '[...key]'); this fixture seeds them into the
// source tree and reseals the archive so the frozen archive contains them too.
function seedArtifactRouteDirectories(source: string) {
  const scoped = join(source, 'server-functions', 'node_modules', '@opentelemetry', 'api')
  const dynamic = join(source, 'assets', '_next', 'static', 'chunks', 'app', '[slug]')
  const grouped = join(source, 'assets', '_next', 'static', 'chunks', 'app', 'admin', '(protected)', 'posts')
  for (const directory of [scoped, dynamic, grouped]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(scoped, 'index.js'), 'sealed scoped exporter\n')
  writeFileSync(join(dynamic, 'page.js'), 'sealed dynamic page\n')
  writeFileSync(join(grouped, 'page.js'), 'sealed grouped page\n')
  return { scoped, dynamic, grouped }
}

function uploadSourceLifecycleArtifactFixture() {
  const fixture = uploadSourceLifecycleFixture()
  seedArtifactRouteDirectories(fixture.source)
  rmSync(fixture.archive, { force: true })
  // The production sealed archive contains file entries only (no directory
  // entries); enumerate relative file paths and zip them explicitly so the
  // archived path set matches the frozen artifact grammar.
  const files: string[] = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push(relative(fixture.source, path))
    }
  }
  visit(fixture.source)
  const zipped = spawnSync('/usr/bin/zip', [
    '-X', '-q', fixture.archive, ...files,
  ], { cwd: fixture.source, encoding: 'utf8' })
  expect(zipped.status, zipped.stderr).toBe(0)
  fixture.archiveSha256 = createHash('sha256').update(readFileSync(fixture.archive)).digest('hex')
  return fixture
}

// Issue #168: the entry projects the child environment from an allowlist
// (HOME/LANG/LC_ALL/PATH/TMPDIR + the Cloudflare overrides) -- everything else
// is stripped. Mirror that exactly for the production-isomorphic harness runs.
function projectedLifecycleEnv(fixture: ReturnType<typeof uploadSourceLifecycleFixture>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowlist = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']
  return Object.assign(Object.create(null), Object.fromEntries(
    allowlist.filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]]),
  ), {
    WRANGLER_OUTPUT_FILE_PATH: fixture.uploadOutput,
    UPLOAD_STDOUT_FILE_PATH: fixture.uploadChildStdout,
    UPLOAD_STDERR_FILE_PATH: fixture.uploadChildStderr,
    UPLOAD_COUNTER: fixture.counter,
    ...extra,
  })
}

function assertWrapperFailureRecord(lifecycle: ReturnType<typeof spawnSync>, receipt: string, evidence: string, stage: string) {
  const stderr = typeof lifecycle.stderr === 'string' ? lifecycle.stderr : String(lifecycle.stderr)
  const lines = stderr.split('\n')
  const recordLine = lines.find((line) => line.includes('blogman-upload-wrapper-failure/v1'))
  expect(recordLine).toBeDefined()
  const record = JSON.parse(recordLine as string) as {
    format: string
    stage: string
    error: { name: string | null; message: string | null; stack: string | null }
    upload_stdout_sha256: string | null
    upload_stderr_sha256: string | null
  }
  expect(record.format).toBe('blogman-upload-wrapper-failure/v1')
  expect(record.stage).toBe(stage)
  expect(record.error.stack).toMatch(/[A-Za-z]/)
  expect(record.upload_stdout_sha256).toBeNull()
  expect(record.upload_stderr_sha256).toBeNull()
  const receiptBytes = readFileSync(receipt, 'utf8')
  expect(JSON.parse(receiptBytes)).toEqual(record)
  const files = readdirSync(evidence).sort()
  expect(files).toEqual([`${createHash('sha256').update(receiptBytes).digest('hex')}.wrapper-failure`])
  expect(readFileSync(join(evidence, files[0]), 'utf8')).toBe(receiptBytes)
  return record
}

function uploadAssetsFixture(configAssetsDirectory: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-upload-assets-binding-')))
  temporaryDirectories.push(directory)
  const snapshotRepository = join(directory, 'snapshot-repository')
  const uploadSourceDirectory = join(snapshotRepository, '.open-next')
  const uploadAssetsDirectory = join(uploadSourceDirectory, 'assets')
  const operatorDirectory = join(directory, 'operator')
  const configPath = join(operatorDirectory, 'wrangler.toml')
  mkdirSync(uploadAssetsDirectory, { recursive: true })
  mkdirSync(join(operatorDirectory, '.open-next', 'assets'), { recursive: true })
  writeFileSync(configPath, `[assets]\ndirectory = ${JSON.stringify(configAssetsDirectory)}\n`)
  return { configPath, uploadAssetsDirectory, uploadSourceDirectory }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const makeRemovable = (path: string) => {
      const stat = lstatSync(path)
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        chmodSync(path, 0o700)
        for (const name of readdirSync(path)) makeRemovable(join(path, name))
      } else if (!stat.isSymbolicLink()) {
        chmodSync(path, 0o600)
      }
    }
    makeRemovable(directory)
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Issue #23 Worker upload entry', () => {
  it('binds an absolute config asset directory to a separate snapshot upload source', () => {
    const fixture = uploadAssetsFixture('placeholder')
    writeFileSync(
      fixture.configPath,
      `[assets]\ndirectory = ${JSON.stringify(fixture.uploadAssetsDirectory)}\n`,
    )

    const result = bindUploadAssetsDirectory(
      fixture.configPath,
      fixture.uploadSourceDirectory,
    )

    expect(result).toMatchObject({
      status: 0,
      stdout: `${fixture.uploadAssetsDirectory}\n`,
      stderr: '',
    })
  })

  it('rejects config-relative assets resolved outside the separate snapshot repository', () => {
    const fixture = uploadAssetsFixture('.open-next/assets')

    const result = bindUploadAssetsDirectory(
      fixture.configPath,
      fixture.uploadSourceDirectory,
    )

    expect(result).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload assets binding\n',
    })
    expect(resolve(dirname(fixture.configPath), '.open-next/assets'))
      .not.toBe(fixture.uploadAssetsDirectory)
  })

  it('copies the proven source into an exclusive snapshot isolated from later source mutation', () => {
    const fixture = uploadSourceSnapshotFixture()
    const created = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', fixture.source,
      '--destination', fixture.destination,
    ])

    expect(created.status, created.stderr).toBe(0)
    const proof = JSON.parse(created.stdout) as UploadSourceSnapshotProof
    expect(proof.identity_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(statSync(fixture.destination).mode & 0o777).toBe(0o500)
    expect(statSync(join(fixture.destination, 'assets', 'asset.txt')).mode & 0o777).toBe(0o400)
    const repeated = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', fixture.source,
      '--destination', fixture.destination,
    ])
    expect(repeated).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload source snapshot\n',
    })
    writeFileSync(fixture.asset, 'mutated source\n')

    const verified = uploadSourceSnapshot(
      'verify-upload-source-snapshot',
      snapshotVerificationArgs(fixture.destination, proof),
    )
    expect(verified.status, verified.stderr).toBe(0)
    expect(readFileSync(join(fixture.destination, 'assets', 'asset.txt'), 'utf8'))
      .toBe('sealed asset\n')
  })

  it('rejects snapshot content mutation before upload evidence is accepted', () => {
    const fixture = uploadSourceSnapshotFixture()
    const created = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', fixture.source,
      '--destination', fixture.destination,
    ])
    expect(created.status, created.stderr).toBe(0)
    const proof = JSON.parse(created.stdout) as UploadSourceSnapshotProof
    const snapshotAsset = join(fixture.destination, 'assets', 'asset.txt')
    chmodSync(fixture.destination, 0o700)
    chmodSync(join(fixture.destination, 'assets'), 0o700)
    chmodSync(snapshotAsset, 0o600)
    writeFileSync(snapshotAsset, 'mutated upload bytes\n')
    chmodSync(snapshotAsset, 0o400)
    chmodSync(join(fixture.destination, 'assets'), 0o500)
    chmodSync(fixture.destination, 0o500)

    const verified = uploadSourceSnapshot(
      'verify-upload-source-snapshot',
      snapshotVerificationArgs(fixture.destination, proof),
    )
    expect(verified).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload source snapshot\n',
    })
  })

  it('rejects restored metadata-only changes to a snapshot file', () => {
    const fixture = uploadSourceSnapshotFixture()
    const created = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', fixture.source,
      '--destination', fixture.destination,
    ])
    expect(created.status, created.stderr).toBe(0)
    const proof = JSON.parse(created.stdout) as UploadSourceSnapshotProof
    const snapshotWorker = join(fixture.destination, 'worker.js')
    chmodSync(snapshotWorker, 0o600)
    chmodSync(snapshotWorker, 0o400)

    const verified = uploadSourceSnapshot(
      'verify-upload-source-snapshot',
      snapshotVerificationArgs(fixture.destination, proof),
    )
    expect(verified).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload source snapshot\n',
    })
  })

  it('rejects a source file swapped to a symlink after directory enumeration', () => {
    const fixture = uploadSourceSnapshotFixture()
    const outside = join(fixture.directory, 'outside.txt')
    const preload = join(fixture.directory, 'swap-after-enumeration.cjs')
    writeFileSync(outside, 'sealed asset\n')
    writeFileSync(preload, String.raw`
const fs = require('node:fs')
const original = fs.readdirSync
fs.readdirSync = function (path, ...args) {
  const entries = original.call(this, path, ...args)
  if (path === process.env.SWAP_DIRECTORY && !process.env.SWAP_DONE) {
    process.env.SWAP_DONE = '1'
    fs.unlinkSync(process.env.SWAP_PATH)
    fs.symlinkSync(process.env.SWAP_TARGET, process.env.SWAP_PATH)
  }
  return entries
}
`)

    const created = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', fixture.source,
      '--destination', fixture.destination,
    ], {
      NODE_OPTIONS: `--require=${preload}`,
      SWAP_DIRECTORY: dirname(fixture.asset),
      SWAP_PATH: fixture.asset,
      SWAP_TARGET: outside,
    })
    expect(created).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload source snapshot\n',
    })
    expect(lstatSync(fixture.asset).isSymbolicLink()).toBe(true)
  })

  it('forwards safe bound paths as one Wrangler argv and rejects shell-unsafe paths first', async () => {
    const fixture = uploadAssetsFixture('placeholder')
    writeFileSync(
      fixture.configPath,
      `[assets]\ndirectory = ${JSON.stringify(fixture.uploadAssetsDirectory)}\n`,
    )
    const bound = bindUploadAssetsDirectory(fixture.configPath, fixture.uploadSourceDirectory)
    expect(bound.status, bound.stderr).toBe(0)
    const snapshot = uploadSourceSnapshotFixture()
    const created = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', snapshot.source,
      '--destination', snapshot.destination,
    ])
    expect(created.status, created.stderr).toBe(0)
    const forwardedAssets = join(snapshot.destination, 'assets')
    const forwardedWorker = join(snapshot.destination, 'worker.js')
    const unsafeDestination = join(dirname(snapshot.destination), 'unsafe snapshot;meta')
    const rejectedDestination = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', snapshot.source,
      '--destination', unsafeDestination,
    ])
    expect(rejectedDestination).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload source snapshot\n',
    })

    const fakeBin = join(dirname(fixture.configPath), 'fake-bin')
    const argvPath = join(dirname(fixture.configPath), 'wrangler-argv.json')
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'npm'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.shift() !== 'exec' || args.shift() !== 'wrangler') process.exit(90)
const passthrough = args.indexOf('--')
if (passthrough < 0) process.exit(91)
args.splice(passthrough, 1)
const result = spawnSync('wrangler', args, { env: process.env, stdio: 'inherit' })
process.exit(result.status ?? 92)
`)
    writeFileSync(join(fakeBin, 'wrangler'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.WRANGLER_ARGV_PATH, JSON.stringify(process.argv.slice(2)))
`)
    chmodSync(join(fakeBin, 'npm'), 0o755)
    chmodSync(join(fakeBin, 'wrangler'), 0o755)
    const runWranglerPath = join(
      process.cwd(),
      'node_modules', '@opennextjs', 'cloudflare', 'dist',
      'cli', 'commands', 'utils', 'run-wrangler.js',
    )
    const { runWrangler } = await import(pathToFileURL(runWranglerPath).href)
    const wranglerArgsPath = join(
      process.cwd(),
      'node_modules', '@opennextjs', 'cloudflare', 'dist',
      'cli', 'commands', 'utils', 'utils.js',
    )
    const { withWranglerPassthroughArgs } = await import(pathToFileURL(wranglerArgsPath).href)
    const wranglerArgs = withWranglerPassthroughArgs({
      config: fixture.configPath,
      args: [
        forwardedWorker,
        '--message', 'issue-23-safe-upload-1',
        '--assets', forwardedAssets,
      ],
    }).wranglerArgs
    const forwarded = runWrangler({
      packager: 'npm',
      monorepoRoot: process.cwd(),
    }, [
      'versions upload',
      ...wranglerArgs,
    ], {
      logging: 'none',
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
        WRANGLER_ARGV_PATH: argvPath,
      },
    })
    expect(forwarded.success).toBe(true)
    expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual([
      'versions', 'upload',
      '--config', fixture.configPath,
      forwardedWorker,
      '--message', 'issue-23-safe-upload-1',
      '--assets', forwardedAssets,
    ])

    const unsafeSource = join(dirname(fixture.uploadSourceDirectory), 'unsafe source;meta', '.open-next')
    const unsafeAssets = join(unsafeSource, 'assets')
    mkdirSync(unsafeAssets, { recursive: true })
    writeFileSync(
      fixture.configPath,
      `[assets]\ndirectory = ${JSON.stringify(unsafeAssets)}\n`,
    )
    const unsafe = bindUploadAssetsDirectory(fixture.configPath, unsafeSource)
    expect(unsafe).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload assets binding\n',
    })
  })

  it('rejects a Worker swap-read-restore performed inside the real upload forwarding window', async () => {
    const snapshot = uploadSourceSnapshotFixture()
    const created = uploadSourceSnapshot('create-upload-source-snapshot', [
      '--source', snapshot.source,
      '--destination', snapshot.destination,
    ])
    expect(created.status, created.stderr).toBe(0)
    const proof = JSON.parse(created.stdout) as UploadSourceSnapshotProof
    const worker = join(snapshot.destination, 'worker.js')
    const savedWorker = join(snapshot.destination, 'worker.saved')
    const capturedWorker = join(snapshot.directory, 'captured-worker.txt')
    const fakeBin = join(snapshot.directory, 'swap-fake-bin')
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'npm'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.shift() !== 'exec' || args.shift() !== 'wrangler') process.exit(90)
const passthrough = args.indexOf('--')
if (passthrough < 0) process.exit(91)
args.splice(passthrough, 1)
const result = spawnSync('wrangler', args, { env: process.env, stdio: 'inherit' })
process.exit(result.status ?? 92)
`)
    writeFileSync(join(fakeBin, 'wrangler'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== 'versions' || args[1] !== 'upload' || args[2] !== process.env.SNAPSHOT_WORKER) {
  process.exit(93)
}
fs.chmodSync(process.env.SNAPSHOT_ROOT, 0o700)
fs.renameSync(process.env.SNAPSHOT_WORKER, process.env.SAVED_WORKER)
fs.writeFileSync(process.env.SNAPSHOT_WORKER, 'malicious worker\\n')
fs.writeFileSync(process.env.CAPTURED_WORKER, fs.readFileSync(process.env.SNAPSHOT_WORKER))
fs.unlinkSync(process.env.SNAPSHOT_WORKER)
fs.renameSync(process.env.SAVED_WORKER, process.env.SNAPSHOT_WORKER)
fs.chmodSync(process.env.SNAPSHOT_WORKER, 0o400)
fs.chmodSync(process.env.SNAPSHOT_ROOT, 0o500)
`)
    chmodSync(join(fakeBin, 'npm'), 0o755)
    chmodSync(join(fakeBin, 'wrangler'), 0o755)
    const runWranglerPath = join(
      process.cwd(),
      'node_modules', '@opennextjs', 'cloudflare', 'dist',
      'cli', 'commands', 'utils', 'run-wrangler.js',
    )
    const { runWrangler } = await import(pathToFileURL(runWranglerPath).href)
    const forwarded = runWrangler({
      packager: 'npm',
      monorepoRoot: process.cwd(),
    }, [
      'versions upload',
      worker,
      '--assets', join(snapshot.destination, 'assets'),
    ], {
      logging: 'none',
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
        SNAPSHOT_ROOT: snapshot.destination,
        SNAPSHOT_WORKER: worker,
        SAVED_WORKER: savedWorker,
        CAPTURED_WORKER: capturedWorker,
      },
    })
    expect(forwarded.success).toBe(true)
    expect(readFileSync(capturedWorker, 'utf8')).toBe('malicious worker\n')
    expect(readFileSync(worker, 'utf8')).toBe('sealed worker\n')

    const verified = uploadSourceSnapshot(
      'verify-upload-source-snapshot',
      snapshotVerificationArgs(snapshot.destination, proof),
    )
    expect(verified).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'Invalid Issue #23 upload source snapshot\n',
    })
  })

  it('holds one snapshot lifecycle across a successful upload without evidence self-trigger', () => {
    const snapshot = uploadSourceSnapshotFixture()
    const sealed = sealedBuildArchive(snapshot.directory, snapshot.source)
    const reportDirectory = dirname(snapshot.destination)
    const proofBefore = join(reportDirectory, 'upload-source-snapshot.json')
    const proofAfter = join(reportDirectory, 'upload-source-snapshot-after.json')
    const buildProof = join(reportDirectory, 'upload-build-directory-proof.json')
    const uploadOutput = join(reportDirectory, 'upload-private.jsonl')
    const uploadChildStdout = join(reportDirectory, 'upload-child-stdout.log')
    const uploadChildStderr = join(reportDirectory, 'upload-child-stderr.log')
    const forwardedArgs = join(snapshot.directory, 'forwarded-lifecycle-args.json')
    const operatorDirectory = join(snapshot.directory, 'operator')
    const config = join(operatorDirectory, 'wrangler.toml')
    const fakeBin = join(snapshot.directory, 'lifecycle-fake-bin')
    mkdirSync(operatorDirectory)
    writeFileSync(config, `[assets]\ndirectory = ${JSON.stringify(join(snapshot.source, 'assets'))}\n`)
    const configSha256 = createHash('sha256').update(readFileSync(config)).digest('hex')
    for (const path of [proofBefore, proofAfter, buildProof, uploadOutput, uploadChildStdout, uploadChildStderr, forwardedArgs]) {
      writeFileSync(path, '')
      chmodSync(path, 0o600)
    }
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'npm'), `#!/usr/bin/env node
require('node:fs').writeFileSync(
  process.env.FORWARDED_ARGS,
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    path: process.env.PATH,
  }),
)
require('node:fs').appendFileSync(
  process.env.WRANGLER_OUTPUT_FILE_PATH,
  JSON.stringify({ type: 'version-upload', version: 1, version_id: 'fixture-version' }) + '\\n',
)
process.stdout.write('OpenNext upload log\\n')
`)
    chmodSync(join(fakeBin, 'npm'), 0o755)

    const lifecycle = spawnSync(process.execPath, [
      workerUploadPath,
      'run-upload-source-lifecycle',
      ...lifecycleToolchainArgs(fakeBin),
      '--config', config,
      '--source', snapshot.source,
      '--destination', snapshot.destination,
      '--operation-id', `issue-23-${'a'.repeat(40)}-upload-1`,
      '--proof-before', proofBefore,
      '--proof-after', proofAfter,
      '--archive', sealed.archive,
      '--archive-sha256', sealed.archiveSha256,
      '--build-proof', buildProof,
      '--expected-config-sha256', configSha256,
    ], {
      cwd: snapshot.directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
        WRANGLER_OUTPUT_FILE_PATH: uploadOutput,
        UPLOAD_STDOUT_FILE_PATH: uploadChildStdout,
        UPLOAD_STDERR_FILE_PATH: uploadChildStderr,
        FORWARDED_ARGS: forwardedArgs,
      },
    })
    expect(lifecycle).toMatchObject({ status: 0, stderr: '' })
    expect(JSON.parse(lifecycle.stdout)).toMatchObject({
      format: 'blogman-upload-source-lifecycle-acceptance/v1',
      state: 'accepted',
      version_id: 'fixture-version',
      upload_stdout_sha256: createHash('sha256').update('OpenNext upload log\n').digest('hex'),
      upload_stderr_sha256: createHash('sha256').update('').digest('hex'),
    })
    expect(readFileSync(uploadChildStdout, 'utf8')).toBe('OpenNext upload log\n')
    expect(readFileSync(uploadChildStderr, 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(forwardedArgs, 'utf8'))).toEqual({
      argv: [
        'upload', '-c', config, '--', join(snapshot.destination, 'worker.js'),
        '--message', `issue-23-${'a'.repeat(40)}-upload-1`,
        '--assets', join(snapshot.destination, 'assets'),
      ],
      cwd: process.cwd(),
      path: `${fakeBin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
    })
    const before = JSON.parse(readFileSync(proofBefore, 'utf8')) as UploadSourceSnapshotProof
      & { state: string }
    const after = JSON.parse(readFileSync(proofAfter, 'utf8')) as UploadSourceSnapshotProof
      & { state: string }
    expect(before.state).toBe('created')
    expect(after).toMatchObject({
      state: 'matched',
      tree_sha256: before.tree_sha256,
      identity_sha256: before.identity_sha256,
    })
  })

  it('captures the upload child stdout and stderr into held evidence on a nonzero exit', () => {
    const fixture = uploadSourceLifecycleFixture()
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
process.stdout.write('OpenNext upload progress\\n')
process.stderr.write('wrangler GET /accounts/account-id/r2/buckets failed: 10000 Authentication error\\n')
process.exitCode = 9
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture)

    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.uploadChildStdout, 'utf8')).toBe('OpenNext upload progress\n')
    expect(readFileSync(fixture.uploadChildStderr, 'utf8'))
      .toBe('wrangler GET /accounts/account-id/r2/buckets failed: 10000 Authentication error\n')
    expect(readFileSync(fixture.proofAfter, 'utf8')).toBe('')
  })

  it('appends system bin directories after the bound upload toolchain in PATH order', () => {
    const boundNpmBin = '/repo/node_modules/.bin'
    const boundNodeBin = '/repo/node/bin'

    const path = uploadToolchainPath(boundNpmBin, boundNodeBin)
    const segments = path.split(delimiter)

    // The manifest-bound toolchain stays authoritative: its directories precede
    // every system bin directory, so node/npm cannot be shadowed by /usr/bin:/bin.
    expect(segments.slice(0, 2)).toEqual([boundNpmBin, boundNodeBin])
    expect(segments).toContain('/usr/bin')
    expect(segments).toContain('/bin')
    expect(segments.indexOf('/usr/bin')).toBeGreaterThan(segments.indexOf(boundNodeBin))
    expect(segments.indexOf('/bin')).toBeGreaterThan(segments.indexOf(boundNodeBin))
    // De-duplicated while preserving first-occurrence order.
    expect(new Set(segments).size).toBe(segments.length)
  })

  it('resolves bash from the constructed upload PATH but not from the bound-only PATH', () => {
    const boundNpmBin = join(sharedTemporaryDirectory, `blogman-bash-resolve-${process.pid}`)
    mkdirSync(boundNpmBin)
    temporaryDirectories.push(boundNpmBin)
    const boundNodeBin = dirname(process.execPath)
    const boundOnly = [boundNpmBin, boundNodeBin].join(delimiter)
    const withSystemBins = uploadToolchainPath(boundNpmBin, boundNodeBin)

    // Restricted PATH reproduces the diagnosed restricted environment: bash is
    // not under the bound toolchain directories, so the child cannot spawn it.
    const restricted = spawnSync('bash', ['-c', 'exit 0'], {
      env: { HOME: tmpdir(), LC_ALL: 'C', PATH: boundOnly },
    })
    expect(restricted.error?.code).toBe('ENOENT')

    // The constructed upload PATH appends /usr/bin:/bin, so bash resolves.
    const resolved = spawnSync('bash', ['-c', 'exit 0'], {
      env: { HOME: tmpdir(), LC_ALL: 'C', PATH: withSystemBins },
    })
    expect(resolved.error).toBeUndefined()
    expect(resolved.status).toBe(0)
  })

  it('persists bounded upload child stdout/stderr into the durable evidence directory on failure', () => {
    const fixture = uploadSourceLifecycleFixture()
    const durableDir = join(fixture.directory, 'durable-upload-evidence')
    mkdirSync(durableDir, { mode: 0o700 })
    const failurePath = join(fixture.reportDirectory, 'upload-child-failure.json')
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
process.stdout.write('OpenNext upload progress\\n')
process.stderr.write('wrangler GET /accounts/account-id/r2/buckets failed: 10000 Authentication error\\n')
process.exitCode = 9
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture, {
      UPLOAD_EVIDENCE_DIR: durableDir,
      UPLOAD_FAILURE_PATH: failurePath,
    })

    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    const stdoutBytes = Buffer.from('OpenNext upload progress\n')
    const stderrBytes = Buffer.from(
      'wrangler GET /accounts/account-id/r2/buckets failed: 10000 Authentication error\n',
    )
    const stdoutSha = createHash('sha256').update(stdoutBytes).digest('hex')
    const stderrSha = createHash('sha256').update(stderrBytes).digest('hex')
    expect(readFileSync(join(durableDir, `${stdoutSha}.stdout`))).toEqual(stdoutBytes)
    expect(readFileSync(join(durableDir, `${stderrSha}.stderr`))).toEqual(stderrBytes)
    const failure = JSON.parse(readFileSync(failurePath, 'utf8'))
    expect(failure).toMatchObject({
      format: 'blogman-upload-child-failure/v1',
      child_status: 9,
      upload_stdout_sha256: stdoutSha,
      upload_stderr_sha256: stderrSha,
    })
  })

  it('persists bounded upload child stdout/stderr into the durable evidence directory on success', () => {
    const fixture = uploadSourceLifecycleFixture()
    const durableDir = join(fixture.directory, 'durable-upload-evidence-success')
    mkdirSync(durableDir, { mode: 0o700 })
    installCountingUpload(fixture)

    const lifecycle = runCurrentUploadLifecycle(fixture, {
      UPLOAD_EVIDENCE_DIR: durableDir,
    })

    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    const acceptance = JSON.parse(lifecycle.stdout)
    expect(acceptance.upload_stdout_sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(acceptance.upload_stderr_sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(readdirSync(durableDir).sort()).toEqual([
      `${acceptance.upload_stderr_sha256}.stderr`,
      `${acceptance.upload_stdout_sha256}.stdout`,
    ])
    expect(readFileSync(join(durableDir, `${acceptance.upload_stdout_sha256}.stdout`)).byteLength).toBe(0)
    expect(readFileSync(join(durableDir, `${acceptance.upload_stderr_sha256}.stderr`)).byteLength).toBe(0)
  })

  it('bounds the captured upload child output at the frozen evidence limit', () => {
    const fixture = uploadSourceLifecycleFixture()
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
process.stderr.write('E'.repeat(256 * 1024))
process.exitCode = 9
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture)

    expect(lifecycle.status).toBe(1)
    expect(statSync(fixture.uploadChildStderr).size).toBeGreaterThan(0)
    expect(statSync(fixture.uploadChildStderr).size).toBeLessThanOrEqual(64 * 1024)
    expect(statSync(fixture.uploadChildStdout).size).toBe(0)
  })

  it('hashes the captured upload child output into the acceptance evidence on success', () => {
    const fixture = uploadSourceLifecycleFixture()
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
process.stdout.write('OpenNext upload log\\n')
process.stderr.write('experimental warning: asset metadata\\n')
fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
  type: 'version-upload', version: 1, version_id: 'fixture-version',
}) + '\\n')
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture)

    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    const acceptance = JSON.parse(lifecycle.stdout)
    expect(acceptance.upload_stdout_sha256)
      .toBe(createHash('sha256').update('OpenNext upload log\n').digest('hex'))
    expect(acceptance.upload_stderr_sha256)
      .toBe(createHash('sha256').update('experimental warning: asset metadata\n').digest('hex'))
    expect(acceptance.wrangler_output_sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(acceptance.version_id).toBe('fixture-version')
  })

  it('excludes only the direct configured archive and retains a nested same-basename file', () => {
    const fixture = uploadSourceLifecycleFixture()
    const nested = join(fixture.source, 'nested', 'open-next-build.zip')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, 'nested deployable bytes\n')
    rmSync(fixture.archive)
    const zipped = spawnSync('/usr/bin/zip', [
      '-X', '-q', fixture.archive, 'worker.js', 'assets/asset.txt', 'nested/open-next-build.zip',
    ], { cwd: fixture.source, encoding: 'utf8' })
    expect(zipped.status, zipped.stderr).toBe(0)
    fixture.archiveSha256 = createHash('sha256').update(readFileSync(fixture.archive)).digest('hex')
    installCountingUpload(fixture)

    const lifecycle = runCurrentUploadLifecycle(fixture)

    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    expect(existsSync(join(fixture.destination, 'open-next-build.zip'))).toBe(false)
    expect(readFileSync(join(fixture.destination, 'nested', 'open-next-build.zip'), 'utf8'))
      .toBe('nested deployable bytes\n')
    expect(JSON.parse(readFileSync(fixture.buildProof, 'utf8'))).toMatchObject({ state: 'matched' })
  })

  it('rejects an archive proof that omits a nested file sharing the archive basename', () => {
    const fixture = uploadSourceLifecycleFixture()
    const nested = join(fixture.source, 'nested', 'open-next-build.zip')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, 'nested unsealed bytes\n', { flag: 'wx' })
    installCountingUpload(fixture)

    const lifecycle = runCurrentUploadLifecycle(fixture)

    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
  })

  it('rejects an archive path outside the exact direct upload source location', () => {
    const fixture = uploadSourceLifecycleFixture()
    const outsideArchive = join(fixture.directory, 'outside-open-next-build.zip')
    writeFileSync(outsideArchive, readFileSync(fixture.archive))
    fixture.archive = outsideArchive
    fixture.archiveSha256 = createHash('sha256').update(readFileSync(outsideArchive)).digest('hex')
    installCountingUpload(fixture)

    const lifecycle = runCurrentUploadLifecycle(fixture)

    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
  })

  it('rejects a complete report-directory swap-read-restore across the upload window', () => {
    const snapshot = uploadSourceSnapshotFixture()
    const sealed = sealedBuildArchive(snapshot.directory, snapshot.source)
    const reportDirectory = dirname(snapshot.destination)
    const savedReportDirectory = `${reportDirectory}.saved`
    const worker = join(snapshot.destination, 'worker.js')
    const assets = join(snapshot.destination, 'assets')
    const capturedUpload = join(snapshot.directory, 'captured-report-swap.json')
    const proofBefore = join(reportDirectory, 'upload-source-snapshot.json')
    const proofAfter = join(reportDirectory, 'upload-source-snapshot-after.json')
    const buildProof = join(reportDirectory, 'upload-build-directory-proof.json')
    const uploadOutput = join(reportDirectory, 'upload-private.jsonl')
    const uploadChildStdout = join(reportDirectory, 'upload-child-stdout.log')
    const uploadChildStderr = join(reportDirectory, 'upload-child-stderr.log')
    const operatorDirectory = join(snapshot.directory, 'operator')
    const config = join(operatorDirectory, 'wrangler.toml')
    const fakeBin = join(snapshot.directory, 'report-swap-fake-bin')
    mkdirSync(operatorDirectory)
    writeFileSync(config, `[assets]\ndirectory = ${JSON.stringify(join(snapshot.source, 'assets'))}\n`)
    const configSha256 = createHash('sha256').update(readFileSync(config)).digest('hex')
    for (const path of [capturedUpload, proofBefore, proofAfter, buildProof, uploadOutput, uploadChildStdout, uploadChildStderr]) {
      writeFileSync(path, '')
      chmodSync(path, 0o600)
    }
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args.shift() !== 'upload') process.exit(90)
const passthrough = args.indexOf('--')
if (passthrough < 0) process.exit(91)
if (args[passthrough + 1] !== process.env.SNAPSHOT_WORKER) process.exit(92)
fs.renameSync(process.env.REPORT_DIRECTORY, process.env.SAVED_REPORT_DIRECTORY)
fs.mkdirSync(path.join(process.env.SNAPSHOT_ROOT, 'assets'), { recursive: true })
fs.writeFileSync(process.env.SNAPSHOT_WORKER, 'malicious parent worker\\n')
fs.writeFileSync(path.join(process.env.SNAPSHOT_ROOT, 'assets', 'asset.txt'), 'malicious parent asset\\n')
fs.writeFileSync(process.env.CAPTURED_UPLOAD, JSON.stringify({
  worker: fs.readFileSync(process.env.SNAPSHOT_WORKER, 'utf8'),
  asset: fs.readFileSync(path.join(process.env.SNAPSHOT_ROOT, 'assets', 'asset.txt'), 'utf8'),
}))
fs.rmSync(process.env.REPORT_DIRECTORY, { recursive: true, force: true })
fs.renameSync(process.env.SAVED_REPORT_DIRECTORY, process.env.REPORT_DIRECTORY)
fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
  type: 'version-upload', version: 1, version_id: 'malicious-version',
}) + '\\n')
`)
    chmodSync(join(fakeBin, 'npm'), 0o755)
    const lifecycle = spawnSync(process.execPath, [
      workerUploadPath,
      'run-upload-source-lifecycle',
      ...lifecycleToolchainArgs(fakeBin),
      '--config', config,
      '--source', snapshot.source,
      '--destination', snapshot.destination,
      '--operation-id', `issue-23-${'a'.repeat(40)}-upload-1`,
      '--proof-before', proofBefore,
      '--proof-after', proofAfter,
      '--archive', sealed.archive,
      '--archive-sha256', sealed.archiveSha256,
      '--build-proof', buildProof,
      '--expected-config-sha256', configSha256,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
        WRANGLER_OUTPUT_FILE_PATH: uploadOutput,
        UPLOAD_STDOUT_FILE_PATH: uploadChildStdout,
        UPLOAD_STDERR_FILE_PATH: uploadChildStderr,
        REPORT_DIRECTORY: reportDirectory,
        SAVED_REPORT_DIRECTORY: savedReportDirectory,
        SNAPSHOT_ROOT: snapshot.destination,
        SNAPSHOT_WORKER: worker,
        CAPTURED_UPLOAD: capturedUpload,
      },
    })
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(JSON.parse(readFileSync(capturedUpload, 'utf8'))).toEqual({
      worker: 'malicious parent worker\n',
      asset: 'malicious parent asset\n',
    })
    expect(readFileSync(worker, 'utf8')).toBe('sealed worker\n')
    expect(readFileSync(join(assets, 'asset.txt'), 'utf8')).toBe('sealed asset\n')
    expect(readFileSync(proofAfter, 'utf8')).toBe('')
  })

  it('rejects an owner-replaceable ancestor above the common input root', () => {
    const fixture = uploadSourceLifecycleFixture()
    const topCtimeBefore = statSync(fixture.top, { bigint: true }).ctimeNs
    const savedTop = `${fixture.top}.saved`
    const capturedUpload = join(fixture.directory, 'captured-higher-ancestor.json')
    writeFileSync(capturedUpload, '')
    chmodSync(capturedUpload, 0o600)
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const count = Number(fs.readFileSync(process.env.UPLOAD_COUNTER, 'utf8')) + 1
fs.writeFileSync(process.env.UPLOAD_COUNTER, String(count))
fs.renameSync(process.env.SWAPPABLE_TOP, process.env.SAVED_TOP)
fs.mkdirSync(path.join(process.env.SNAPSHOT_ROOT, 'assets'), { recursive: true })
fs.writeFileSync(path.join(process.env.SNAPSHOT_ROOT, 'worker.js'), 'malicious ancestor worker\\n')
fs.writeFileSync(path.join(process.env.SNAPSHOT_ROOT, 'assets', 'asset.txt'), 'malicious ancestor asset\\n')
fs.writeFileSync(process.env.CAPTURED_UPLOAD, JSON.stringify({
  worker: fs.readFileSync(path.join(process.env.SNAPSHOT_ROOT, 'worker.js'), 'utf8'),
  asset: fs.readFileSync(path.join(process.env.SNAPSHOT_ROOT, 'assets', 'asset.txt'), 'utf8'),
}))
fs.appendFileSync(process.env.SAVED_UPLOAD_OUTPUT, JSON.stringify({
  type: 'version-upload', version: 1, version_id: 'malicious-version',
}) + '\\n')
fs.rmSync(process.env.SWAPPABLE_TOP, { recursive: true, force: true })
fs.renameSync(process.env.SAVED_TOP, process.env.SWAPPABLE_TOP)
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture, {
      SWAPPABLE_TOP: fixture.top,
      SAVED_TOP: savedTop,
      SNAPSHOT_ROOT: fixture.destination,
      CAPTURED_UPLOAD: capturedUpload,
      SAVED_UPLOAD_OUTPUT: fixture.uploadOutput.replace(fixture.top, savedTop),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    expect(statSync(fixture.top, { bigint: true }).ctimeNs).not.toBe(topCtimeBefore)
    expect(JSON.parse(readFileSync(capturedUpload, 'utf8'))).toEqual({
      worker: 'malicious ancestor worker\n',
      asset: 'malicious ancestor asset\n',
    })
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.proofAfter, 'utf8')).toBe('')
    expect(readFileSync(fixture.uploadOutput, 'utf8')).toContain('malicious-version')
  })

  it('allows shared ancestor churn when upload inputs have only root in common', () => {
    const sharedTemp = realpathSync('/tmp')
    const fixture = uploadSourceLifecycleFixture(sharedTemp, crossRootTemporaryDirectory)
    expect(fixture.source.split('/')[1]).not.toBe(fixture.reportDirectory.split('/')[1])
    const sharedCtimeBefore = statSync(sharedTemp, { bigint: true }).ctimeNs
    const unrelated = join(
      sharedTemp,
      `blogman-unrelated-${process.pid}-${Date.now()}`,
    )
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
const count = Number(fs.readFileSync(process.env.UPLOAD_COUNTER, 'utf8')) + 1
fs.writeFileSync(process.env.UPLOAD_COUNTER, String(count))
fs.mkdirSync(process.env.UNRELATED_SHARED_ENTRY)
fs.rmSync(process.env.UNRELATED_SHARED_ENTRY, { recursive: true })
fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
  type: 'version-upload', version: 1, version_id: 'fixture-version',
}) + '\\n')
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    let lifecycle
    try {
      lifecycle = runCurrentUploadLifecycle(fixture, {
        UNRELATED_SHARED_ENTRY: unrelated,
      })
    } finally {
      rmSync(unrelated, { recursive: true, force: true })
    }
    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    expect(statSync(sharedTemp, { bigint: true }).ctimeNs).not.toBe(sharedCtimeBefore)
    expect(JSON.parse(lifecycle.stdout)).toMatchObject({
      state: 'accepted',
      version_id: 'fixture-version',
    })
  })

  // Issue #175: the report directory is a mkdtemp root directly under the
  // system temp root (execute() materializes blogman-issue-91-upload-* via
  // mkdtempSync(join(tmpdir(), ...))). macOS legitimately updates the system
  // TMPDIR mtime/ctime during the upload window (periodic tmp cleanup); the
  // held chain must stop at our mkdtemp root and never freeze the public
  // TMPDIR ancestor. Root-below strict hold semantics are unchanged. macOS
  // refuses unprivileged utimes on the real TMPDIR, so the test substitutes
  // an equivalent private temp root we own (0700 self-owned, same shape) and
  // churns its timestamps the way the cleanup daemon churns the real one.
  it('accepts system temp-root churn when the report directory is a mkdtemp root under TMPDIR (Issue #175)', () => {
    const fakeSystemTempRoot = realpathSync(mkdtempSync(join(
      sharedTemporaryDirectory,
      'blogman-issue-175-tmpdir-',
    )))
    chmodSync(fakeSystemTempRoot, 0o700)
    temporaryDirectories.push(fakeSystemTempRoot)
    const fixture = uploadSourceLifecycleFixture(fakeSystemTempRoot)
    // De-register the nested mkdtemp root (it lives inside fakeSystemTempRoot)
    // so afterEach cleans the outermost temp root once, recursively.
    temporaryDirectories.splice(temporaryDirectories.indexOf(fixture.directory), 1)
    const tmpMtimeBefore = statSync(fakeSystemTempRoot, { bigint: true }).mtimeNs
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
const count = Number(fs.readFileSync(process.env.UPLOAD_COUNTER, 'utf8')) + 1
fs.writeFileSync(process.env.UPLOAD_COUNTER, String(count))
const before = fs.statSync(process.env.SYSTEM_TMP_ROOT, { bigint: true })
fs.utimesSync(
  process.env.SYSTEM_TMP_ROOT,
  new Date(Number(before.atimeNs) / 1e6 + 10_000),
  new Date(Number(before.mtimeNs) / 1e6 + 10_000),
)
fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
  type: 'version-upload', version: 1, version_id: 'fixture-version',
}) + '\\n')
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture, {
      SYSTEM_TMP_ROOT: fakeSystemTempRoot,
      TMPDIR: fakeSystemTempRoot,
    })
    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    expect(statSync(fakeSystemTempRoot, { bigint: true }).mtimeNs).not.toBe(tmpMtimeBefore)
    expect(JSON.parse(lifecycle.stdout)).toMatchObject({
      state: 'accepted',
      version_id: 'fixture-version',
    })
  })

  it('proves the frozen snapshot against the sealed archive before invoking upload', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    writeFileSync(join(fixture.source, 'worker.js'), 'malicious unsealed worker\n')
    writeFileSync(join(fixture.source, 'assets', 'asset.txt'), 'malicious unsealed asset\n')

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
    expect(readFileSync(fixture.proofAfter, 'utf8')).toBe('')
  })

  it('rejects a hardlinked prepared evidence file before invoking upload', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    linkSync(fixture.proofBefore, join(fixture.directory, 'proof-before-hardlink'))

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
  })

  it('rejects a preloaded fake version before invoking upload', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    writeFileSync(fixture.uploadOutput, '{"type":"version-upload","version":1,"version_id":"fake"}\n')

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
  })

  it('rejects config mutation during archive proof before invoking upload', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    const mutator = join(fixture.directory, 'mutate-config.mjs')
    const mutationMarker = join(fixture.directory, 'config-mutated')
    writeFileSync(mutator, `
import { existsSync, writeFileSync } from 'node:fs'
const wait = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(process.env.SNAPSHOT_ROOT)) Atomics.wait(wait, 0, 0, 1)
writeFileSync(
  process.env.CONFIG_PATH,
  'name = "malicious-upload-target"\\n[assets]\\ndirectory = '
    + JSON.stringify(process.env.ASSETS_DIRECTORY) + '\\n',
)
writeFileSync(process.env.MUTATION_MARKER, 'mutated\\n')
`)
    const mutation = spawn(process.execPath, [mutator], {
      env: {
        ...process.env,
        ASSETS_DIRECTORY: join(fixture.source, 'assets'),
        CONFIG_PATH: fixture.config,
        MUTATION_MARKER: mutationMarker,
        SNAPSHOT_ROOT: fixture.destination,
      },
      stdio: 'ignore',
    })

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(readFileSync(mutationMarker, 'utf8')).toBe('mutated\n')
    expect(readFileSync(fixture.config, 'utf8')).toContain('malicious-upload-target')
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
    mutation.unref()
  })

  it('rejects config changed after the PRE-CAS hash before lifecycle starts', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    expect(createHash('sha256').update(readFileSync(fixture.config)).digest('hex'))
      .toBe(fixture.configSha256)
    writeFileSync(
      fixture.config,
      `name = "malicious-upload-target"\n[assets]\ndirectory = ${JSON.stringify(join(fixture.source, 'assets'))}\n`,
    )

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
  })

  it('ignores a spoofed archive helper pathname and rejects unsealed snapshot bytes', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    writeFileSync(join(fixture.source, 'worker.js'), 'malicious unsealed worker\n')
    const spoofedCwd = join(fixture.directory, 'spoofed-helper-cwd')
    const spoofedScripts = join(spoofedCwd, 'scripts')
    const spoofedHelperMarker = join(fixture.directory, 'spoofed-helper-ran')
    mkdirSync(spoofedScripts, { recursive: true })
    writeFileSync(join(spoofedScripts, 'issue-23-build-proof.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.SPOOFED_HELPER_MARKER, 'ran\\n')
process.stdout.write(JSON.stringify({
  format: 'blogman-build-directory-proof/v1',
  state: 'matched',
  archive_sha256: ${JSON.stringify(fixture.archiveSha256)},
  file_count: 2,
}) + '\\n')
`)

    const lifecycle = runCurrentUploadLifecycle(fixture, {
      SPOOFED_HELPER_MARKER: spoofedHelperMarker,
    }, spoofedCwd)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('0')
    expect(existsSync(spoofedHelperMarker)).toBe(false)
  })

  it('returns the accepted version and evidence digests before releasing held FDs', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    const accepted = JSON.parse(lifecycle.stdout) as Record<string, string>
    const acceptedUploadBytes = readFileSync(fixture.uploadOutput)
    const acceptedProofAfterBytes = readFileSync(fixture.proofAfter)
    expect(accepted).toMatchObject({
      format: 'blogman-upload-source-lifecycle-acceptance/v1',
      state: 'accepted',
      version_id: 'fixture-version',
      upload_operation_id: `issue-23-${'a'.repeat(40)}-upload-1`,
      wrangler_output_sha256: createHash('sha256').update(acceptedUploadBytes).digest('hex'),
      snapshot_proof_after_sha256: createHash('sha256')
        .update(acceptedProofAfterBytes).digest('hex'),
    })

    writeFileSync(
      fixture.uploadOutput,
      '{"type":"version-upload","version":1,"version_id":"replaced-version"}\n',
    )
    writeFileSync(fixture.proofAfter, '{"state":"replaced"}\n')
    expect(accepted.version_id).toBe('fixture-version')
    expect(accepted.wrangler_output_sha256).not.toBe(
      createHash('sha256').update(readFileSync(fixture.uploadOutput)).digest('hex'),
    )
    expect(accepted.snapshot_proof_after_sha256).not.toBe(
      createHash('sha256').update(readFileSync(fixture.proofAfter)).digest('hex'),
    )
  })

  it('rejects duplicate version-upload records before returning acceptance', () => {
    const fixture = uploadSourceLifecycleFixture()
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.UPLOAD_COUNTER, '1')
for (const versionId of ['first-version', 'second-version']) {
  fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
    type: 'version-upload', version: 1, version_id: versionId,
  }) + '\\n')
}
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
  })

  it('rejects a valid and malformed duplicate version-upload record', () => {
    const fixture = uploadSourceLifecycleFixture()
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.UPLOAD_COUNTER, '1')
for (const versionId of ['fixture-version', '']) {
  fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
    type: 'version-upload', version: 1, version_id: versionId,
  }) + '\\n')
}
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
  })

  it('rejects two malformed version-upload records after the child writes them', () => {
    const fixture = uploadSourceLifecycleFixture()
    writeFileSync(join(fixture.fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.UPLOAD_COUNTER, '1')
for (const versionId of ['', ' invalid ']) {
  fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
    type: 'version-upload', version: 1, version_id: versionId,
  }) + '\\n')
}
`)
    chmodSync(join(fixture.fakeBin, 'npm'), 0o755)

    const lifecycle = runCurrentUploadLifecycle(fixture)
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    expect(lifecycle).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining('Invalid Issue #23 upload source lifecycle'),
    })
  })

  // Issue #168: the seventh production attempt failed inside the wrapper
  // preflight with upload-evidence empty because the real frozen artifact tree
  // contains route-group directories ('[slug]', '(protected)') and scoped
  // packages ('@opentelemetry') that the argv-facing shell-safe path rule
  // rejected. This test reproduces the production shape (projected child env +
  // archive sealed with those directories) and guards the fix: the lifecycle
  // must accept the tree and complete offline against the intercepted spawn.
  it('accepts a source tree with route groups and scoped packages under a projected environment without network (Issue #168)', () => {
    const fixture = uploadSourceLifecycleArtifactFixture()
    installCountingUpload(fixture)
    const evidence = join(fixture.directory, 'projected-evidence')
    const receipt = join(fixture.directory, 'projected-failure.json')
    mkdirSync(evidence, { mode: 0o700 })

    const lifecycle = spawnSync(process.execPath, [
      workerUploadPath,
      'run-upload-source-lifecycle',
      ...lifecycleToolchainArgs(fixture.fakeBin, realpathSync(process.cwd())),
      '--config', fixture.config,
      '--source', fixture.source,
      '--destination', fixture.destination,
      '--operation-id', `issue-23-${'a'.repeat(40)}-upload-1`,
      '--proof-before', fixture.proofBefore,
      '--proof-after', fixture.proofAfter,
      '--archive', fixture.archive,
      '--archive-sha256', fixture.archiveSha256,
      '--build-proof', fixture.buildProof,
      '--expected-config-sha256', fixture.configSha256,
    ], {
      cwd: realpathSync(process.cwd()),
      encoding: 'utf8',
      env: projectedLifecycleEnv(fixture, {
        UPLOAD_EVIDENCE_DIR: evidence,
        UPLOAD_FAILURE_PATH: receipt,
        CLOUDFLARE_API_TOKEN: 'repro-placeholder-token-not-a-credential',
        CLOUDFLARE_ACCOUNT_ID: 'repro-placeholder-account',
      }),
    })

    expect(lifecycle.status, lifecycle.stderr).toBe(0)
    expect(lifecycle.stderr).toBe('')
    expect(JSON.parse(lifecycle.stdout)).toMatchObject({
      format: 'blogman-upload-source-lifecycle-acceptance/v1',
      state: 'accepted',
      version_id: 'fixture-version',
    })
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1')
    const emptySha = createHash('sha256').update('').digest('hex')
    expect(readdirSync(evidence).sort()).toEqual([
      `${emptySha}.stderr`,
      `${emptySha}.stdout`,
    ])
    expect(existsSync(receipt)).toBe(false)
  })

  // Issue #168: when the wrapper itself fails in preflight, its stderr (and the
  // durable sink) must leak the failing stage and stack instead of collapsing
  // to a bare nonzero exit -- the missing diagnostics that kept five attempts
  // behind the same wall.
  it('persists a wrapper-failure record with stage and stack on a projected preflight failure (Issue #168)', () => {
    const fixture = uploadSourceLifecycleFixture()
    installCountingUpload(fixture)
    const evidence = join(fixture.directory, 'wrapper-evidence')
    const receipt = join(fixture.directory, 'wrapper-failure.json')
    mkdirSync(evidence, { mode: 0o700 })

    const lifecycle = spawnSync(process.execPath, [
      workerUploadPath,
      'run-upload-source-lifecycle',
      ...lifecycleToolchainArgs(fixture.fakeBin, realpathSync(process.cwd())),
      '--config', fixture.config,
      '--source', fixture.source,
      '--destination', fixture.destination,
      '--operation-id', `issue-23-${'a'.repeat(40)}-upload-1`,
      '--proof-before', fixture.proofBefore,
      '--proof-after', fixture.proofAfter,
      '--archive', fixture.archive,
      '--archive-sha256', fixture.archiveSha256,
      '--build-proof', fixture.buildProof,
      // Deliberately wrong config identity: the preflight config gate throws.
      '--expected-config-sha256', '0'.repeat(64),
    ], {
      cwd: realpathSync(process.cwd()),
      encoding: 'utf8',
      env: projectedLifecycleEnv(fixture, {
        UPLOAD_EVIDENCE_DIR: evidence,
        UPLOAD_FAILURE_PATH: receipt,
        CLOUDFLARE_API_TOKEN: 'repro-placeholder-token-not-a-credential',
        CLOUDFLARE_ACCOUNT_ID: 'repro-placeholder-account',
      }),
    })

    expect(lifecycle.status).toBe(1)
    expect(lifecycle.stdout).toBe('')
    expect(existsSync(receipt)).toBe(true)
    const record = assertWrapperFailureRecord(lifecycle, receipt, evidence, 'preflight')
    expect(record.error.message).toBe('')
    expect(record.error.name).toBe('Error')
  })

  // Issue #173: production preflight replay with REAL toolchain bindings. The
  // entry binds open_next_path to realpath(node_modules/.bin/opennextjs-cloudflare)
  // — a scoped-package path containing '@' that the shellSafeAbsolutePath gate
  // rejected in verifyBoundExecutable (the shared root cause of the third,
  // fifth, seventh, and eighth production burns). Rehearsal never runs
  // runPreflight (it synthesizes the acceptance envelope), so this in-process
  // replay is the CI nail: real node/npm/openNext paths + live shas + the
  // realpath'd temp staging (macOS /var → /private/var symlink avoided) + the
  // projected child environment. runPreflight stops exactly before the
  // upload-child spawn, so the replay is zero-network by construction.
  function realToolchainBindings(workingDirectory: string) {
    const nodePath = realpathSync(process.execPath)
    const npmPath = realpathSync(join(
      dirname(dirname(nodePath)),
      'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js',
    ))
    const openNextPath = realpathSync(resolve(
      workingDirectory,
      'node_modules/.bin/opennextjs-cloudflare',
    ))
    // The point of this fixture: the real scoped-package path must contain '@'
    // so the gate under test actually sees the production shape.
    expect(openNextPath).toContain('@')
    const shaOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    return {
      nodePath,
      nodeSha256: shaOf(nodePath),
      npmPath,
      npmSha256: shaOf(npmPath),
      openNextPath,
      openNextSha256: shaOf(openNextPath),
    }
  }

  // runPreflight reads the three upload evidence paths from process.env; the
  // replay sets them exactly like the entry's projected child environment and
  // restores the caller's process.env afterwards.
  function replayPreflightEnvironment(fixture: ReturnType<typeof uploadSourceLifecycleFixture>) {
    const replays = {
      WRANGLER_OUTPUT_FILE_PATH: fixture.uploadOutput,
      UPLOAD_STDOUT_FILE_PATH: fixture.uploadChildStdout,
      UPLOAD_STDERR_FILE_PATH: fixture.uploadChildStderr,
    }
    const prior = Object.fromEntries(Object.keys(replays).map((name) => [name, process.env[name]]))
    for (const [name, value] of Object.entries(replays)) process.env[name] = value
    return prior
  }

  it('accepts the real production openNext scoped-package path through the preflight gate under a projected environment (Issue #173)', async () => {
    const fixture = uploadSourceLifecycleFixture()
    const prior = replayPreflightEnvironment(fixture)
    const bindings = realToolchainBindings(realpathSync(process.cwd()))
    let staged: Awaited<ReturnType<typeof runPreflight>> | undefined
    try {
      staged = await runPreflight({
        ...bindings,
        workingDirectory: realpathSync(process.cwd()),
        config: fixture.config,
        source: fixture.source,
        destination: fixture.destination,
        operationId: `issue-23-${'a'.repeat(40)}-upload-1`,
        proofBeforePath: fixture.proofBefore,
        proofAfterPath: fixture.proofAfter,
        buildProofPath: fixture.buildProof,
        archive: fixture.archive,
        archiveSha256: fixture.archiveSha256,
        expectedConfigSha256: fixture.configSha256,
      })
      // verifyFrozenSnapshotAgainstArchive already threw unless the sealed
      // archive matched the frozen destination; parse its JSON proof bytes.
      expect(JSON.parse(staged.buildProof.toString('utf8')).state).toBe('matched')
      expect(staged.before.file_count).toBe(2)
      // The preflight-built upload PATH must lead with the real bound toolchain
      // directories: the npm bin resolution ran against the real npm binding.
      expect(staged.uploadEnvironment.PATH.split(delimiter).slice(0, 2))
        .toEqual(expect.arrayContaining([dirname(bindings.nodePath)]))
    } finally {
      if (staged) {
        for (const entry of staged.held) closeSync(entry.descriptor)
        for (const entry of staged.evidence) closeSync(entry.descriptor)
      }
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('rejects shell-unsafe openNext paths through the preflight gate after admitting @ (Issue #173 fail-closed)', async () => {
    const fixture = uploadSourceLifecycleFixture()
    const prior = replayPreflightEnvironment(fixture)
    const bindings = realToolchainBindings(realpathSync(process.cwd()))
    try {
      // Space and semicolon are real shell metacharacters: the path-shape gate
      // must keep rejecting them even after '@' is admitted. The bogus sha
      // never matters — the character-class gate throws first.
      for (const illegalComponent of ['unused space.js', 'unused;semicolon.js']) {
        await expect(runPreflight({
          ...bindings,
          openNextPath: join(bindings.openNextPath, illegalComponent),
          openNextSha256: '0'.repeat(64),
          workingDirectory: realpathSync(process.cwd()),
          config: fixture.config,
          source: fixture.source,
          destination: fixture.destination,
          operationId: `issue-23-${'a'.repeat(40)}-upload-1`,
          proofBeforePath: fixture.proofBefore,
          proofAfterPath: fixture.proofAfter,
          buildProofPath: fixture.buildProof,
          archive: fixture.archive,
          archiveSha256: fixture.archiveSha256,
          expectedConfigSha256: fixture.configSha256,
        })).rejects.toThrow()
      }
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

})
