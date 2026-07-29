import { spawnSync } from 'node:child_process'
import {
  chmodSync,
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
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PHASE_B_STAGES,
  runPhaseBSequence,
  type PhaseBBindings,
  type PhaseBStage,
} from '../../scripts/phase-b-sequence.mjs'

const bindings: Readonly<PhaseBBindings> = Object.freeze({
  candidateId: 'a'.repeat(40),
  approvalPacketSha256: 'b'.repeat(64),
  buildArchiveSha256: 'c'.repeat(64),
  baselineDeploymentId: 'deployment-before',
  baselineVersionId: 'version-before',
  baselineD1DatabaseId: '22222222-3333-4444-8555-666666666666',
  deliveryMode: 'clean-start',
  cleanStartResetSqlSha256: 'd'.repeat(64),
  historicalDataDisposition: Object.freeze({
    productionExport: 'NOT_APPLICABLE',
    doubleRestore: 'NOT_APPLICABLE',
    historicalBaselineQueries: 'NOT_APPLICABLE',
  }),
})
const temporaryDirectories: string[] = []
const wranglerFilePrefix = '\u251c Checking if file needs uploading\n\u2502\n'
const successfulFileEnvelope = [{
  results: [{
    'Total queries executed': 3,
    'Rows read': 0,
    'Rows written': 9,
    'Database size (MB)': '0.25',
  }],
  success: true,
  finalBookmark: 'synthetic-bookmark',
  meta: { rows_read: 0, rows_written: 9, size_after: 250_000 },
}]
const duplicateSuccessEnvelope = String.raw`[{"results":[{"Total queries executed":3,"Rows read":0,"Rows written":9,"Database size (MB)":"0.25"}],"success":false,"\u0073uccess":true,"finalBookmark":"synthetic-bookmark","meta":{"rows_read":0,"rows_written":9,"size_after":250000}}]`
const duplicateQueryCountEnvelope = String.raw`[{"results":[{"Total queries executed":0,"\u0054otal queries executed":3,"Rows read":0,"Rows written":9,"Database size (MB)":"0.25"}],"success":true,"finalBookmark":"synthetic-bookmark","meta":{"rows_read":0,"rows_written":9,"size_after":250000}}]`
const duplicateMetaRowsEnvelope = String.raw`[{"results":[{"Total queries executed":3,"Rows read":0,"Rows written":9,"Database size (MB)":"0.25"}],"success":true,"finalBookmark":"synthetic-bookmark","meta":{"rows_read":0,"rows_written":8,"\u0072ows_written":9,"size_after":250000}}]`
const parserPath = join(process.cwd(), 'scripts', 'phase-b-sequence.mjs')

function validateWranglerD1FileResponse(stdout: string) {
  return spawnSync(process.execPath, [parserPath, 'validate-wrangler-d1-file-response'], {
    encoding: 'utf8', input: stdout,
  })
}

function bindUploadAssetsDirectory(configPath: string, uploadSourceDirectory: string) {
  return spawnSync(process.execPath, [
    parserPath,
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
  return spawnSync(process.execPath, [parserPath, command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function uploadSourceSnapshotFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-upload-source-snapshot-')))
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

function validConfig() {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-phase-b-sequence-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'production-wrangler.toml')
  writeFileSync(path, 'name = "not-read-by-sequence"\n')
  chmodSync(path, 0o000)
  return path
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

function stageCounts() {
  return Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 0])) as Record<PhaseBStage, number>
}

describe('Issue #23 Phase B fixed sequence', () => {
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
    const proof = JSON.parse(created.stdout) as { tree_sha256: string }
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

    const verified = uploadSourceSnapshot('verify-upload-source-snapshot', [
      '--directory', fixture.destination,
      '--tree-sha256', proof.tree_sha256,
    ])
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
    const proof = JSON.parse(created.stdout) as { tree_sha256: string }
    const snapshotAsset = join(fixture.destination, 'assets', 'asset.txt')
    chmodSync(fixture.destination, 0o700)
    chmodSync(join(fixture.destination, 'assets'), 0o700)
    chmodSync(snapshotAsset, 0o600)
    writeFileSync(snapshotAsset, 'mutated upload bytes\n')
    chmodSync(snapshotAsset, 0o400)
    chmodSync(join(fixture.destination, 'assets'), 0o500)
    chmodSync(fixture.destination, 0o500)

    const verified = uploadSourceSnapshot('verify-upload-source-snapshot', [
      '--directory', fixture.destination,
      '--tree-sha256', proof.tree_sha256,
    ])
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
    const forwarded = runWrangler({
      packager: 'npm',
      monorepoRoot: process.cwd(),
    }, [
      'versions upload',
      '--config', fixture.configPath,
      '--message', 'issue-23-safe-upload-1',
      '--assets', forwardedAssets,
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

  it('stops at a failed empty-database plan after reset proof and before migrations', async () => {
    const counts = stageCounts()

    await expect(runPhaseBSequence({
      configPath: validConfig(),
      bindings,
      runStage: async (stage) => {
        counts[stage] += 1
        if (stage === 'remote_migration_plan') throw new Error('remote plan failed')
      },
    })).rejects.toThrow('remote plan failed')

    expect(counts).toEqual({
      pre_cas_local_gates: 1,
      cas1: 1,
      d1_identity: 1,
      upload: 1,
      clean_start_reset: 1,
      clean_start_empty_verify: 1,
      remote_migration_plan: 1,
      migrations_001_006: 0,
      cas2: 0,
      traffic: 0,
      smoke_reconcile: 0,
      t0: 0,
    })
  })

  it('validates absolute CONFIG and immutable bindings before running a stage', async () => {
    let stagesStarted = 0
    const runStage = async () => { stagesStarted += 1 }

    await expect(runPhaseBSequence({
      configPath: 'wrangler.toml', bindings, runStage,
    })).rejects.toThrow('absolute CONFIG')
    await expect(runPhaseBSequence({
      configPath: validConfig(), bindings: { ...bindings }, runStage,
    })).rejects.toThrow('immutable Phase B bindings')
    const missingD1 = Object.freeze({ ...bindings, baselineD1DatabaseId: '' })
    await expect(runPhaseBSequence({
      configPath: validConfig(), bindings: missingD1, runStage,
    })).rejects.toThrow('incomplete or invalid')
    const unboundAuthorization = Object.freeze({
      ...bindings,
      historicalDataDisposition: Object.freeze({
        ...bindings.historicalDataDisposition,
        productionExport: 'skip',
      }),
    })
    await expect(runPhaseBSequence({
      configPath: validConfig(), bindings: unboundAuthorization, runStage,
    })).rejects.toThrow('clean-start authorization')
    expect(stagesStarted).toBe(0)
  })

  it('runs every fixed stage exactly once without retries', async () => {
    const observed: PhaseBStage[] = []
    const counts = await runPhaseBSequence({
      configPath: validConfig(),
      bindings,
      runStage: async (stage) => { observed.push(stage) },
    })

    expect(observed).toEqual(PHASE_B_STAGES)
    expect(counts).toEqual(Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 1])))
    expect(Object.values(counts)).toEqual(PHASE_B_STAGES.map(() => 1))
  })

  it('binds the validated absolute CONFIG and immutable identities into every stage', async () => {
    const configPath = validConfig()
    const contexts: unknown[] = []
    await runPhaseBSequence({
      configPath,
      bindings,
      runStage: async (_stage, context) => { contexts.push(context) },
    })

    expect(contexts).toHaveLength(PHASE_B_STAGES.length)
    expect(new Set(contexts).size).toBe(1)
    expect(contexts[0]).toEqual({ configPath, bindings })
    expect(Object.isFrozen(contexts[0])).toBe(true)
  })

  it('fails closed at every stage without retrying or entering the suffix', async () => {
    for (const failedStage of PHASE_B_STAGES) {
      const observed: PhaseBStage[] = []
      await expect(runPhaseBSequence({
        configPath: validConfig(),
        bindings,
        runStage: async (stage) => {
          observed.push(stage)
          if (stage === failedStage) throw new Error(`failed: ${stage}`)
        },
      })).rejects.toThrow(`failed: ${failedStage}`)

      const failedIndex = PHASE_B_STAGES.indexOf(failedStage)
      expect(observed).toEqual(PHASE_B_STAGES.slice(0, failedIndex + 1))
      expect(observed.filter((stage) => stage === failedStage)).toHaveLength(1)
    }
  })

  it('uploads before reset and plans only after proving the bound D1 is empty', () => {
    expect(PHASE_B_STAGES.indexOf('upload')).toBeLessThan(PHASE_B_STAGES.indexOf('clean_start_reset'))
    expect(PHASE_B_STAGES.indexOf('clean_start_reset')).toBeLessThan(PHASE_B_STAGES.indexOf('clean_start_empty_verify'))
    expect(PHASE_B_STAGES.indexOf('clean_start_empty_verify')).toBeLessThan(PHASE_B_STAGES.indexOf('remote_migration_plan'))
    expect(PHASE_B_STAGES).not.toContain('export')
    expect(PHASE_B_STAGES).not.toContain('double_restore')
  })

  it.each([
    ['plain JSON', `${JSON.stringify(successfulFileEnvelope)}\n`],
    ['Wrangler 4.86 file prefix', `${wranglerFilePrefix}${JSON.stringify(successfulFileEnvelope)}\n`],
  ])('accepts one deterministic successful %s envelope', (_name, stdout) => {
    expect(validateWranglerD1FileResponse(stdout)).toMatchObject({
      status: 0, stdout: '{"state":"valid"}\n', stderr: '',
    })
  })

  it.each([
    ['HTML', '<html>upstream error</html>'],
    ['arbitrary log prefix', `log line\n${JSON.stringify(successfulFileEnvelope)}`],
    ['multiple JSON values', `${JSON.stringify(successfulFileEnvelope)}\n${JSON.stringify(successfulFileEnvelope)}`],
    ['truncated JSON', JSON.stringify(successfulFileEnvelope).slice(0, -1)],
    ['mixed trailing noise', `${JSON.stringify(successfulFileEnvelope)}\nlog line`],
    ['multiple envelopes', JSON.stringify([...successfulFileEnvelope, ...successfulFileEnvelope])],
    ['unsuccessful envelope', JSON.stringify([{ ...successfulFileEnvelope[0], success: false }])],
    ['empty bookmark', JSON.stringify([{ ...successfulFileEnvelope[0], finalBookmark: '' }])],
    ['missing results', JSON.stringify([{ ...successfulFileEnvelope[0], results: undefined }])],
    ['zero executed queries', JSON.stringify([{
      ...successfulFileEnvelope[0],
      results: [{ ...successfulFileEnvelope[0].results[0], 'Total queries executed': 0 }],
    }])],
    ['ambiguous result rows', JSON.stringify([{
      ...successfulFileEnvelope[0],
      results: [...successfulFileEnvelope[0].results, ...successfulFileEnvelope[0].results],
    }])],
    ['mismatched row count', JSON.stringify([{
      ...successfulFileEnvelope[0],
      results: [{ ...successfulFileEnvelope[0].results[0], 'Rows written': 8 }],
    }])],
    ['unknown top-level field', JSON.stringify([{ ...successfulFileEnvelope[0], extra: true }])],
    ['contradictory duplicate success members', duplicateSuccessEnvelope],
    ['contradictory duplicate query-count members', duplicateQueryCountEnvelope],
    ['contradictory duplicate meta rows-written members', duplicateMetaRowsEnvelope],
  ])('rejects %s without echoing stdout', (_name, stdout) => {
    const invalid = validateWranglerD1FileResponse(stdout)
    expect(invalid).toMatchObject({
      status: 1, stdout: '', stderr: 'Invalid Wrangler D1 file response\n',
    })
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(stdout)
  })
})
