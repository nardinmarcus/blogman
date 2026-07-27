import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliPath = process.env.ISSUE_23_RESEAL_CLI_PATH
  ?? join(projectRoot, 'scripts', 'issue-23-reseal.mjs')

type QuickCiMutableInput = {
  github_evidence: {
    quick: {
      build_static_pages: number
      head_tree: string
      test_files_passed: number
      tests_passed: number
    }
  }
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(path: string) {
  return sha256(readFileSync(path))
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createSealFixture() {
  const root = mkdtempSync(join(tmpdir(), 'blogman-issue-23-seal-'))
  const repository = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  const migrations = join(repository, 'db', 'ledger-migrations')
  mkdirSync(join(repository, 'docs'), { recursive: true })
  mkdirSync(join(repository, 'lib', 'ai-post-generator'), { recursive: true })
  mkdirSync(join(repository, 'scripts'), { recursive: true })
  mkdirSync(join(repository, 'tests', 'migrations'), { recursive: true })
  mkdirSync(migrations, { recursive: true })
  mkdirSync(artifacts)

  const lockfilePath = join(repository, 'package-lock.json')
  copyFileSync(join(projectRoot, 'package-lock.json'), lockfilePath)
  const runbookPath = join(repository, 'docs', 'issue-23-phase-b-runbook.md')
  copyFileSync(
    join(projectRoot, 'docs', 'issue-23-phase-b-runbook.md'),
    runbookPath,
  )
  const canonicalMigrations = join(projectRoot, 'db', 'ledger-migrations')
  for (const name of readdirSync(canonicalMigrations)) {
    copyFileSync(join(canonicalMigrations, name), join(migrations, name))
  }
  copyFileSync(
    join(projectRoot, 'db', 'schema.sql'),
    join(repository, 'db', 'schema.sql'),
  )
  copyFileSync(
    join(projectRoot, 'db', 'seed-template.sql'),
    join(repository, 'db', 'seed-template.sql'),
  )
  cpSync(
    join(projectRoot, 'db', 'migrations'),
    join(repository, 'db', 'migrations'),
    { recursive: true },
  )
  copyFileSync(
    join(projectRoot, 'wrangler.toml'),
    join(repository, 'wrangler.toml'),
  )
  copyFileSync(
    join(projectRoot, 'lib', 'ai-provider-profiles.ts'),
    join(repository, 'lib', 'ai-provider-profiles.ts'),
  )
  copyFileSync(
    join(projectRoot, 'lib', 'ai-post-generator', 'constants.ts'),
    join(repository, 'lib', 'ai-post-generator', 'constants.ts'),
  )
  copyFileSync(
    join(projectRoot, 'scripts', 'migrations.mjs'),
    join(repository, 'scripts', 'migrations.mjs'),
  )
  copyFileSync(
    join(projectRoot, 'tests', 'migrations', 'migration-runner.test.ts'),
    join(repository, 'tests', 'migrations', 'migration-runner.test.ts'),
  )
  const migrationSql = readFileSync(join(migrations, '001_initial_schema.sql'), 'utf8')
  const baselineSql = readFileSync(
    join(migrations, '001_initial_schema.baseline.sql'),
    'utf8',
  )
  const remoteBaselineSql = readFileSync(
    join(migrations, '001_initial_schema.remote.baseline.sql'),
    'utf8',
  )

  git(repository, 'init', '--quiet')
  git(repository, 'config', 'user.name', 'Blogman Test')
  git(repository, 'config', 'user.email', 'blogman-test@example.invalid')
  git(repository, 'add', '.')
  git(repository, 'commit', '--quiet', '-m', 'fixture')
  const candidate = git(repository, 'rev-parse', 'HEAD')
  const tree = git(repository, 'rev-parse', 'HEAD^{tree}')

  const workerPath = join(artifacts, 'worker.js')
  writeFileSync(workerPath, 'export default { fetch() { return new Response("ok") } }\n')
  mkdirSync(join(artifacts, 'assets', '_next'), { recursive: true })
  writeFileSync(join(artifacts, 'assets', '_next', 'chunk.js'), 'chunk\n')
  writeFileSync(join(artifacts, 'assets', 'BUILD_ID'), 'build\n')
  const treeManifestPath = join(artifacts, 'open-next-source-manifest.json')
  const treeManifest = [
    'worker.js',
    'assets/_next/chunk.js',
    'assets/BUILD_ID',
  ].map((path) => ({
    path,
    bytes: readFileSync(join(artifacts, path)).byteLength,
    sha256: fileSha256(join(artifacts, path)),
  })).sort((left, right) => left.path.localeCompare(right.path))
  writeFileSync(treeManifestPath, `${JSON.stringify(treeManifest, null, 2)}\n`)
  const archivePath = join(artifacts, 'open-next-build.zip')
  execFileSync('zip', [
    '-X',
    '-q',
    archivePath,
    'worker.js',
    'assets/_next/chunk.js',
    'assets/BUILD_ID',
  ], { cwd: artifacts })

  const migrationMembers = readdirSync(migrations)
    .filter((name) => /^\d{3}_.+\.(?:sql|data\.mjs)$/.test(name))
    .sort()
    .map((name) => ({
      name,
      sha256: fileSha256(join(migrations, name)),
    }))
  const migrationSetSha256 = sha256(JSON.stringify(migrationMembers))
  const migrationLedgerChecksum = sha256(`${migrationSql}\0${baselineSql}`)
  const input = {
    format: 'blogman-issue-23-local-reseal-request/v2',
    produced_at: '2026-07-27T10:00:00.000Z',
    candidate: {
      commit: candidate,
      tree,
    },
    repository: {
      lockfile: {
        path: 'package-lock.json',
        sha256: fileSha256(lockfilePath),
      },
      runbook: {
        path: 'docs/issue-23-phase-b-runbook.md',
        sha256: fileSha256(runbookPath),
      },
      migrations: {
        directory: 'db/ledger-migrations',
        set_sha256: migrationSetSha256,
        migration_001_sql_sha256: sha256(migrationSql),
        migration_001_ledger_checksum: migrationLedgerChecksum,
        migration_001_baseline_sha256: sha256(baselineSql),
        remote_baseline_companion_sha256: sha256(remoteBaselineSql),
      },
    },
    build: {
      archive_path: 'open-next-build.zip',
      archive_sha256: fileSha256(archivePath),
      worker_path: 'worker.js',
      worker_sha256: fileSha256(workerPath),
      tree_manifest_path: 'open-next-source-manifest.json',
      tree_manifest_sha256: fileSha256(treeManifestPath),
    },
    local_gates: {
      affected_phase_b: {
        passed: 72,
        failed: 0,
      },
      static_gates: 'passed',
      open_next_build: {
        state: 'passed',
        static_pages: 38,
      },
      reviews: {
        standards: {
          state: 'passed',
          blockers: 0,
        },
        spec: {
          state: 'passed',
          blockers: 0,
        },
      },
    },
    github_evidence: {
      quick: {
        run_id: 30260000001,
        job_id: 89940000001,
        head_sha: candidate,
        head_tree: tree,
        status: 'completed',
        conclusion: 'success',
        test_files_passed: 47,
        test_files_total: 47,
        tests_passed: 300,
        tests_total: 300,
        build_static_pages: 38,
        raw_job_log_sha256: '9'.repeat(64),
      },
      canonical_long_migration_runner: {
        run_id: 30251479781,
        job_id: 89930265069,
        head_sha: '31f60ffffa42dc38454c829420fc310e5924068b',
        head_tree: 'daeb1009a53743422b972eedb3d3bd142f4c5561',
        status: 'completed',
        conclusion: 'success',
        test_files_passed: 1,
        test_files_total: 1,
        tests_passed: 46,
        tests_total: 46,
        raw_job_log_sha256: 'f1e9a3e4b4f08fb3f22a8e5fbf8fff8cb6e31265f793a90abb9b139a0c9191ec',
        coverage: {
          migration_runner_source_blob: '2208c47157618c35484670f72b6b18837d28b33d',
          migration_runner_test_blob: '6151348a3030676ca6718737393e29962c0b81d6',
          ledger_migrations_tree: 'aecf5d95f3e96084e67aaf9018d35ce85b9000cc',
          package_lock_blob: '18c04f636fa0d4a0dd54eafbecfb083cad024428',
          schema_blob: '9585b5fdc67811d8f3b70b1fad3c0afbf42496f9',
          seed_template_blob: '14beef7572457a5c85ad571ba1d0edc37f1f1f64',
          historical_migrations_tree: '349ae025fa89f487bb7e65870c1c423fcf122650',
          wrangler_config_blob: 'bc57f24fa1ce2a5699ea340256eb24593421463f',
          ai_provider_profiles_blob: '9d1f521268875f2a984de6d52e4caf8dbd77708b',
          ai_post_generator_constants_blob: 'd34700c62cf1f2dcaef1ee6d6a28d3d51b4767c1',
        },
      },
    },
    expected_production_baseline: {
      deployment_id: '92422ae1-e7ce-45b7-95ab-bac8cc69f808',
      version_id: 'bf8666ae-996f-496d-a090-4c779ad57c3a',
      d1_database_id: '5d1cadcf-e10e-4245-b07d-16c64754f00d',
    },
  }
  const inputPath = join(root, 'reseal-input.json')
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`)
  const output = join(root, 'sealed-reservation', 'sealed')
  if (process.env.ISSUE_23_RESEAL_PRECREATE_OUTPUT_PARENT === '1') {
    mkdirSync(dirname(output))
  }

  return {
    artifacts,
    inputPath,
    output,
    repository,
    root,
  }
}

interface CandidateBoundInput {
  candidate: {
    commit: string
    tree: string
  }
  github_evidence: {
    quick: {
      head_sha: string
      head_tree: string
    }
  }
}

type SealFixture = ReturnType<typeof createSealFixture>

function bindInputToCurrentGit(fixture: SealFixture, input: CandidateBoundInput) {
  input.candidate.commit = git(fixture.repository, 'rev-parse', 'HEAD')
  input.candidate.tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
  input.github_evidence.quick.head_sha = input.candidate.commit
  input.github_evidence.quick.head_tree = input.candidate.tree
}

function runSeal(fixture: SealFixture, environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [
    cliPath,
    'seal',
    '--input',
    fixture.inputPath,
    '--repo',
    fixture.repository,
    '--artifacts',
    fixture.artifacts,
    '--output',
    fixture.output,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
  })
}

function runVerify(
  fixture: SealFixture,
  packagePath: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(process.execPath, [
    cliPath,
    'verify',
    '--input',
    fixture.inputPath,
    '--repo',
    fixture.repository,
    '--artifacts',
    fixture.artifacts,
    '--package',
    packagePath,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
  })
}

describe('Issue #23 local reseal package generation', () => {
  it('seals a canonical local-only T0 quartet through the public CLI', () => {
    const fixture = createSealFixture()
    try {
      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readdirSync(fixture.output).sort()).toEqual([
        'approval-packet.json',
        'package-manifest.json',
        'pre-cas-bindings.json',
        'preflight-candidate.json',
      ])
      const outputParent = dirname(fixture.output)
      const outputParentStat = lstatSync(outputParent)
      expect(outputParentStat.isDirectory()).toBe(true)
      expect(outputParentStat.uid).toBe(process.geteuid?.())
      expect(outputParentStat.mode & 0o7777).toBe(0o700)
      expect(lstatSync(fixture.output).mode & 0o7777).toBe(0o700)
      for (const name of readdirSync(fixture.output)) {
        expect(lstatSync(join(fixture.output, name)).mode & 0o7777).toBe(0o400)
      }
      expect(readdirSync(outputParent)).toEqual(['sealed'])

      const verification = spawnSync(process.execPath, [
        cliPath,
        'validate',
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      expect(verification.status, verification.stderr).toBe(0)

      const preflight = JSON.parse(readFileSync(
        join(fixture.output, 'preflight-candidate.json'),
        'utf8',
      ))
      expect(preflight.tests.canonical_long_migration_runner).toEqual({
        state: 'passed',
        passed: 46,
        failed: 0,
      })
      const preCas = JSON.parse(readFileSync(
        join(fixture.output, 'pre-cas-bindings.json'),
        'utf8',
      ))
      const approval = JSON.parse(readFileSync(
        join(fixture.output, 'approval-packet.json'),
        'utf8',
      ))
      const manifest = JSON.parse(readFileSync(
        join(fixture.output, 'package-manifest.json'),
        'utf8',
      ))
      expect(approval.format).toBe('blogman-issue-23-approval-packet/v3')
      expect(approval.scope.at(-1)).toBe('T0 event acceptance')
      expect(preCas.format).toBe('blogman-issue-23-pre-cas-bindings/v3')
      expect(preCas.immutable_phase_b_bindings.baselineD1DatabaseId)
        .toBe('5d1cadcf-e10e-4245-b07d-16c64754f00d')
      expect(manifest.format).toBe('blogman-issue-23-package-manifest/v3')
      expect(preCas.production_authorization_granted).toBe(false)
      expect(new Set(Object.values(preCas.stage_counts))).toEqual(new Set([0]))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when quick CI evidence belongs to a different Git head', () => {
    const fixture = createSealFixture()
    try {
      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.github_evidence.quick.head_sha = 'a'.repeat(40)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when quick CI totals or tree do not bind to the seal inputs', () => {
    const mutations = [
      (input: QuickCiMutableInput) => {
        input.github_evidence.quick.head_tree = 'b'.repeat(40)
      },
      (input: QuickCiMutableInput) => {
        input.github_evidence.quick.test_files_passed -= 1
      },
      (input: QuickCiMutableInput) => {
        input.github_evidence.quick.tests_passed -= 1
      },
      (input: QuickCiMutableInput) => {
        input.github_evidence.quick.build_static_pages -= 1
      },
    ]

    for (const mutate of mutations) {
      const fixture = createSealFixture()
      try {
        const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
        mutate(input)
        writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

        const result = spawnSync(process.execPath, [
          cliPath,
          'seal',
          '--input',
          fixture.inputPath,
          '--repo',
          fixture.repository,
          '--artifacts',
          fixture.artifacts,
          '--output',
          fixture.output,
        ], {
          cwd: projectRoot,
          encoding: 'utf8',
        })

        expect(result.status).not.toBe(0)
        expect(existsSync(fixture.output)).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('fails closed when the build tree manifest does not describe the archive', () => {
    const fixture = createSealFixture()
    try {
      const treeManifestPath = join(fixture.artifacts, 'open-next-source-manifest.json')
      const treeManifest = JSON.parse(readFileSync(treeManifestPath, 'utf8'))
      treeManifest.push({
        path: 'missing.js',
        bytes: 1,
        sha256: sha256('x'),
      })
      writeFileSync(treeManifestPath, `${JSON.stringify(treeManifest, null, 2)}\n`)

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.build.tree_manifest_sha256 = fileSha256(treeManifestPath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects ZIP symlink entries before extraction without writing through a child path', () => {
    const fixture = createSealFixture()
    try {
      const sentinelDirectory = join(fixture.root, 'user-sentinel')
      const sentinelPath = join(sentinelDirectory, 'payload.txt')
      mkdirSync(sentinelDirectory)
      writeFileSync(sentinelPath, 'archived payload\n')
      symlinkSync(sentinelDirectory, join(fixture.artifacts, 'pivot'))

      const archivePath = join(fixture.artifacts, 'open-next-build.zip')
      unlinkSync(archivePath)
      execFileSync('zip', [
        '-X',
        '-y',
        '-q',
        archivePath,
        'worker.js',
        'pivot',
        'pivot/payload.txt',
      ], { cwd: fixture.artifacts })
      writeFileSync(sentinelPath, 'sentinel must survive\n')

      const treeManifestPath = join(fixture.artifacts, 'open-next-source-manifest.json')
      const treeManifest = [
        {
          path: 'worker.js',
          bytes: readFileSync(join(fixture.artifacts, 'worker.js')).byteLength,
          sha256: fileSha256(join(fixture.artifacts, 'worker.js')),
        },
        {
          path: 'pivot',
          bytes: sentinelDirectory.length,
          sha256: sha256(sentinelDirectory),
        },
        {
          path: 'pivot/payload.txt',
          bytes: Buffer.byteLength('archived payload\n'),
          sha256: sha256('archived payload\n'),
        },
      ].sort((left, right) => left.path.localeCompare(right.path))
      writeFileSync(treeManifestPath, `${JSON.stringify(treeManifest, null, 2)}\n`)

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.build.archive_sha256 = fileSha256(archivePath)
      input.build.tree_manifest_sha256 = fileSha256(treeManifestPath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = runSeal(fixture)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('build archive entries must be regular files')
      expect(readFileSync(sentinelPath, 'utf8')).toBe('sentinel must survive\n')
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when bound build inputs are replaced after their initial validation', () => {
    const fixture = createSealFixture()
    try {
      const replacement = join(fixture.root, 'replacement-build')
      mkdirSync(join(replacement, 'assets', '_next'), { recursive: true })
      writeFileSync(
        join(replacement, 'worker.js'),
        'export default { fetch() { return new Response("replacement") } }\n',
      )
      copyFileSync(
        join(fixture.artifacts, 'assets', '_next', 'chunk.js'),
        join(replacement, 'assets', '_next', 'chunk.js'),
      )
      copyFileSync(
        join(fixture.artifacts, 'assets', 'BUILD_ID'),
        join(replacement, 'assets', 'BUILD_ID'),
      )
      const replacementManifest = [
        'worker.js',
        'assets/_next/chunk.js',
        'assets/BUILD_ID',
      ].map((path) => ({
        path,
        bytes: readFileSync(join(replacement, path)).byteLength,
        sha256: fileSha256(join(replacement, path)),
      })).sort((left, right) => left.path.localeCompare(right.path))
      writeFileSync(
        join(replacement, 'open-next-source-manifest.json'),
        `${JSON.stringify(replacementManifest, null, 2)}\n`,
      )
      execFileSync('zip', [
        '-X',
        '-q',
        join(replacement, 'open-next-build.zip'),
        'assets/BUILD_ID',
        'assets/_next/chunk.js',
        'worker.js',
      ], { cwd: replacement })

      const fakeBin = join(fixture.root, 'fake-bin')
      const markerPath = join(fixture.root, 'build-inputs-replaced')
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      mkdirSync(fakeBin)
      const fakeGitPath = join(fakeBin, 'git')
      writeFileSync(fakeGitPath, `#!/usr/bin/env node
const { copyFileSync, existsSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (
  args[0] === 'rev-parse'
  && args[1] === 'HEAD:scripts/migrations.mjs'
  && !existsSync(${JSON.stringify(markerPath)})
) {
  writeFileSync(${JSON.stringify(markerPath)}, 'replaced\\n')
  copyFileSync(${JSON.stringify(join(replacement, 'open-next-build.zip'))}, ${JSON.stringify(join(fixture.artifacts, 'open-next-build.zip'))})
  copyFileSync(${JSON.stringify(join(replacement, 'open-next-source-manifest.json'))}, ${JSON.stringify(join(fixture.artifacts, 'open-next-source-manifest.json'))})
  copyFileSync(${JSON.stringify(join(replacement, 'worker.js'))}, ${JSON.stringify(join(fixture.artifacts, 'worker.js'))})
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
      chmodSync(fakeGitPath, 0o700)

      const result = runSeal(fixture, {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      })

      expect(existsSync(markerPath)).toBe(true)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('build archive changed after validation')
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when the repository worktree is not clean', () => {
    const fixture = createSealFixture()
    try {
      writeFileSync(join(fixture.repository, 'untracked-local-change.txt'), 'dirty\n')

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when a bound file escapes through an intermediate symlink', () => {
    const fixture = createSealFixture()
    try {
      const outside = join(fixture.root, 'outside')
      mkdirSync(outside)
      const outsideWorker = join(outside, 'worker.js')
      writeFileSync(
        outsideWorker,
        readFileSync(join(fixture.artifacts, 'worker.js')),
      )
      symlinkSync(outside, join(fixture.artifacts, 'linked'))

      const treeManifestPath = join(fixture.artifacts, 'open-next-source-manifest.json')
      const treeManifest = JSON.parse(readFileSync(treeManifestPath, 'utf8'))
      const workerEntry = treeManifest.find(
        (entry: { path: string }) => entry.path === 'worker.js',
      )
      workerEntry.path = 'linked/worker.js'
      treeManifest.sort(
        (left: { path: string }, right: { path: string }) => (
          left.path.localeCompare(right.path)
        ),
      )
      writeFileSync(treeManifestPath, `${JSON.stringify(treeManifest, null, 2)}\n`)

      const archivePath = join(fixture.artifacts, 'open-next-build.zip')
      unlinkSync(archivePath)
      execFileSync('zip', [
        '-X',
        '-q',
        archivePath,
        'linked/worker.js',
        'assets/_next/chunk.js',
        'assets/BUILD_ID',
      ], { cwd: fixture.artifacts })

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.build.archive_sha256 = fileSha256(archivePath)
      input.build.worker_path = 'linked/worker.js'
      input.build.worker_sha256 = fileSha256(outsideWorker)
      input.build.tree_manifest_sha256 = fileSha256(treeManifestPath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a sealed package that contains any extra entry', () => {
    const fixture = createSealFixture()
    try {
      const seal = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      expect(seal.status, seal.stderr).toBe(0)

      writeFileSync(join(fixture.output, 'not-in-v2.txt'), 'extra\n')
      const validation = spawnSync(process.execPath, [
        cliPath,
        'validate',
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(validation.status).not.toBe(0)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a missing output parent whose real grandparent is inside the repository', () => {
    const fixture = createSealFixture()
    try {
      const outputGrandparentLink = join(fixture.root, 'output-grandparent-link')
      symlinkSync(fixture.repository, outputGrandparentLink)
      const output = join(
        outputGrandparentLink,
        'reserved-output-parent',
        'sealed-through-link',
      )

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(join(fixture.repository, 'reserved-output-parent'))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('re-verifies a sealed package against its live Git and artifact inputs', () => {
    const fixture = createSealFixture()
    try {
      const seal = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      expect(seal.status, seal.stderr).toBe(0)

      const verification = spawnSync(process.execPath, [
        cliPath,
        'verify',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(verification.status, verification.stderr).toBe(0)
      expect(JSON.parse(verification.stdout)).toMatchObject({
        candidate_id: git(fixture.repository, 'rev-parse', 'HEAD'),
        production_authorization_granted: false,
        production_counters_all_zero: true,
        state: 'verified-local-only',
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when package documents are replaced after their first validation read', () => {
    const fixture = createSealFixture()
    try {
      const seal = runSeal(fixture)
      expect(seal.status, seal.stderr).toBe(0)

      const historicalPackage = join(fixture.root, 'historical-package')
      const historicalFixtures = join(
        projectRoot,
        'tests',
        'fixtures',
        'issue-23-reseal',
        'v2',
      )
      mkdirSync(historicalPackage)
      for (const name of [
        'approval-packet.json',
        'package-manifest.json',
        'pre-cas-bindings.json',
        'preflight-candidate.json',
      ]) {
        copyFileSync(join(historicalFixtures, name), join(historicalPackage, name))
      }

      const preloadPath = join(fixture.root, 'replace-package-after-read.cjs')
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { basename, dirname } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const originalReadFileSync = fs.readFileSync
const packagePath = ${JSON.stringify(historicalPackage)}
const packagePaths = new Set([packagePath, fs.realpathSync(packagePath)])
const replacementPath = ${JSON.stringify(fixture.output)}
const names = new Set([
  'approval-packet.json',
  'package-manifest.json',
  'pre-cas-bindings.json',
  'preflight-candidate.json',
])
let packageReads = 0
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const result = originalReadFileSync.call(this, path, ...args)
  if (packagePaths.has(dirname(String(path))) && names.has(basename(String(path)))) {
    packageReads += 1
    if (packageReads === 4) {
      for (const name of names) {
        fs.copyFileSync(
          replacementPath + '/' + name,
          packagePath + '/' + name,
        )
      }
    }
  }
  return result
}
syncBuiltinESMExports()
`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'verify',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--package',
        historicalPackage,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${preloadPath}`,
          ].filter(Boolean).join(' '),
        },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('package document changed after validation')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when a fifth package entry appears after the initial directory read', () => {
    const fixture = createSealFixture()
    try {
      const seal = runSeal(fixture)
      expect(seal.status, seal.stderr).toBe(0)

      const preloadPath = join(fixture.root, 'add-package-entry-after-read.cjs')
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { basename, dirname } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const originalReadFileSync = fs.readFileSync
const packagePath = ${JSON.stringify(fixture.output)}
const packagePaths = new Set([packagePath, fs.realpathSync(packagePath)])
const names = new Set([
  'approval-packet.json',
  'package-manifest.json',
  'pre-cas-bindings.json',
  'preflight-candidate.json',
])
let packageReads = 0
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const result = originalReadFileSync.call(this, path, ...args)
  if (packagePaths.has(dirname(String(path))) && names.has(basename(String(path)))) {
    packageReads += 1
    if (packageReads === 4) {
      fs.writeFileSync(packagePath + '/unexpected.json', '{}\\n')
    }
  }
  return result
}
syncBuiltinESMExports()
`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'verify',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${preloadPath}`,
          ].filter(Boolean).join(' '),
        },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('package directory changed after validation')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    { command: 'validate', triggerRead: 5 },
    { command: 'verify', triggerRead: 9 },
  ])(
    'fails closed when package membership changes during the final $command file recheck',
    ({ command, triggerRead }) => {
      const fixture = createSealFixture()
      try {
        const seal = runSeal(fixture)
        expect(seal.status, seal.stderr).toBe(0)

        const preloadPath = join(
          fixture.root,
          `add-package-entry-during-${command}-recheck.cjs`,
        )
        writeFileSync(preloadPath, `const fs = require('node:fs')
const { basename, dirname } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const originalReadFileSync = fs.readFileSync
const packagePath = ${JSON.stringify(fixture.output)}
const packagePaths = new Set([packagePath, fs.realpathSync(packagePath)])
const names = new Set([
  'approval-packet.json',
  'package-manifest.json',
  'pre-cas-bindings.json',
  'preflight-candidate.json',
])
let packageReads = 0
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const result = originalReadFileSync.call(this, path, ...args)
  if (packagePaths.has(dirname(String(path))) && names.has(basename(String(path)))) {
    packageReads += 1
    if (packageReads === ${triggerRead}) {
      fs.writeFileSync(packagePath + '/late-unexpected.json', '{}\\n')
    }
  }
  return result
}
syncBuiltinESMExports()
`)
        const environment = {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${preloadPath}`,
          ].filter(Boolean).join(' '),
        }
        const result = command === 'validate'
          ? spawnSync(process.execPath, [
              cliPath,
              'validate',
              '--package',
              fixture.output,
            ], {
              cwd: projectRoot,
              encoding: 'utf8',
              env: environment,
            })
          : runVerify(fixture, fixture.output, environment)

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('package directory changed after validation')
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    },
  )

  it('fails closed when a package file becomes an external symlink between lstat and realpath', () => {
    const fixture = createSealFixture()
    try {
      const seal = runSeal(fixture)
      expect(seal.status, seal.stderr).toBe(0)

      const outsideDirectory = join(fixture.root, 'outside-package')
      const outsidePreflight = join(outsideDirectory, 'preflight-candidate.json')
      const packagePreflight = join(fixture.output, 'preflight-candidate.json')
      mkdirSync(outsideDirectory)
      copyFileSync(packagePreflight, outsidePreflight)

      const preloadPath = join(fixture.root, 'swap-package-file-after-lstat.cjs')
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const originalLstatSync = fs.lstatSync
const packageFile = ${JSON.stringify(packagePreflight)}
const packageFiles = new Set([packageFile, fs.realpathSync(packageFile)])
const outsideFile = ${JSON.stringify(outsidePreflight)}
let swapped = false
fs.lstatSync = function patchedLstatSync(path, ...args) {
  const stat = originalLstatSync.call(this, path, ...args)
  if (!swapped && packageFiles.has(String(path))) {
    swapped = true
    fs.unlinkSync(packageFile)
    fs.symlinkSync(outsideFile, packageFile)
  }
  return stat
}
syncBuiltinESMExports()
`)
      const result = spawnSync(process.execPath, [
        cliPath,
        'validate',
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${preloadPath}`,
          ].filter(Boolean).join(' '),
        },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('package document real path escapes its root')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when package membership changes during the final context recheck', () => {
    const fixture = createSealFixture()
    try {
      const seal = runSeal(fixture)
      expect(seal.status, seal.stderr).toBe(0)

      const fakeBin = join(fixture.root, 'final-context-fake-bin')
      const counterPath = join(fixture.root, 'head-check-count')
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      mkdirSync(fakeBin)
      const fakeGitPath = join(fakeBin, 'git')
      writeFileSync(fakeGitPath, `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  const count = fs.existsSync(${JSON.stringify(counterPath)})
    ? Number(fs.readFileSync(${JSON.stringify(counterPath)}, 'utf8'))
    : 0
  fs.writeFileSync(${JSON.stringify(counterPath)}, String(count + 1))
  if (count + 1 === 2) {
    fs.writeFileSync(${JSON.stringify(join(fixture.output, 'late-context-entry.json'))}, '{}\\n')
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
      chmodSync(fakeGitPath, 0o700)

      const result = runVerify(fixture, fixture.output, {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      })

      expect(readFileSync(counterPath, 'utf8')).toBe('2')
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('package directory changed after validation')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when package bytes change during the final context recheck', () => {
    const fixture = createSealFixture()
    try {
      const seal = runSeal(fixture)
      expect(seal.status, seal.stderr).toBe(0)

      const packageManifest = join(fixture.output, 'package-manifest.json')
      const fakeBin = join(fixture.root, 'late-package-byte-fake-bin')
      const counterPath = join(fixture.root, 'late-package-head-check-count')
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      mkdirSync(fakeBin)
      const fakeGitPath = join(fakeBin, 'git')
      writeFileSync(fakeGitPath, `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  const count = fs.existsSync(${JSON.stringify(counterPath)})
    ? Number(fs.readFileSync(${JSON.stringify(counterPath)}, 'utf8'))
    : 0
  fs.writeFileSync(${JSON.stringify(counterPath)}, String(count + 1))
  if (count + 1 === 2) {
    fs.unlinkSync(${JSON.stringify(packageManifest)})
    fs.writeFileSync(${JSON.stringify(packageManifest)}, '{"drift":true}\\n')
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
      chmodSync(fakeGitPath, 0o700)

      const verification = runVerify(fixture, fixture.output, {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      })
      const validation = spawnSync(process.execPath, [
        cliPath,
        'validate',
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(readFileSync(counterPath, 'utf8')).toBe('2')
      expect(validation.status).not.toBe(0)
      expect(verification.status).not.toBe(0)
      expect(verification.stderr).toContain('package document changed after validation')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each(['seal', 'verify'] as const)(
    'fails closed when the requested %s input path is replaced during processing',
    (command) => {
      const fixture = createSealFixture()
      try {
        if (command === 'verify') {
          const seal = runSeal(fixture)
          expect(seal.status, seal.stderr).toBe(0)
        }

        const replacementInput = join(fixture.root, 'replacement-reseal-input.json')
        const replacement = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
        replacement.produced_at = '2026-07-27T10:00:01.000Z'
        writeFileSync(replacementInput, `${JSON.stringify(replacement, null, 2)}\n`)

        const fakeBin = join(fixture.root, `${command}-request-fake-bin`)
        const replacementMarker = join(
          fixture.root,
          `${command}-request-path-replaced`,
        )
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
        mkdirSync(fakeBin)
        const fakeGitPath = join(fakeBin, 'git')
        writeFileSync(fakeGitPath, `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const marker = ${JSON.stringify(replacementMarker)}
if (!fs.existsSync(marker) && args[0] === 'rev-parse' && args[1] === 'HEAD') {
  fs.unlinkSync(${JSON.stringify(fixture.inputPath)})
  fs.copyFileSync(${JSON.stringify(replacementInput)}, ${JSON.stringify(fixture.inputPath)})
  fs.writeFileSync(marker, 'replaced\\n')
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
        chmodSync(fakeGitPath, 0o700)

        const environment = {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
        }
        const result = command === 'seal'
          ? runSeal(fixture, environment)
          : runVerify(fixture, fixture.output, environment)

        expect(
          existsSync(replacementMarker),
          JSON.stringify({
            error: result.error?.message,
            status: result.status,
            stderr: result.stderr,
            stdout: result.stdout,
          }),
        ).toBe(true)
        expect(readFileSync(replacementMarker, 'utf8')).toBe('replaced\n')
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('request document changed after validation')
        if (command === 'seal') expect(existsSync(fixture.output)).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    },
  )

  it.each(['seal', 'verify'] as const)(
    'fails closed when an ignored migration member appears after %s enumeration',
    (command) => {
      const fixture = createSealFixture()
      try {
        if (command === 'verify') {
          const seal = runSeal(fixture)
          expect(seal.status, seal.stderr).toBe(0)
        }

        const migrationDirectory = join(
          fixture.repository,
          'db',
          'ledger-migrations',
        )
        const lateMigrationName = '999_late_hidden.sql'
        const lateMigrationPath = join(migrationDirectory, lateMigrationName)
        const excludePath = join(fixture.repository, '.git', 'info', 'exclude')
        writeFileSync(
          excludePath,
          `${readFileSync(excludePath, 'utf8')}\ndb/ledger-migrations/${lateMigrationName}\n`,
        )

        const fakeBin = join(fixture.root, `${command}-migration-fake-bin`)
        const additionMarker = join(
          fixture.root,
          `${command}-migration-member-added`,
        )
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
        mkdirSync(fakeBin)
        const fakeGitPath = join(fakeBin, 'git')
        writeFileSync(fakeGitPath, `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const marker = ${JSON.stringify(additionMarker)}
if (
  !fs.existsSync(marker)
  && args[0] === 'rev-parse'
  && args[1] === 'HEAD:scripts/migrations.mjs'
) {
  fs.writeFileSync(${JSON.stringify(lateMigrationPath)}, '-- ignored late migration\\nSELECT 1;\\n')
  fs.writeFileSync(marker, 'added\\n')
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
        chmodSync(fakeGitPath, 0o700)

        const environment = {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
        }
        const result = command === 'seal'
          ? runSeal(fixture, environment)
          : runVerify(fixture, fixture.output, environment)

        expect(
          existsSync(additionMarker),
          JSON.stringify({
            error: result.error?.message,
            status: result.status,
            stderr: result.stderr,
            stdout: result.stdout,
          }),
        ).toBe(true)
        expect(readFileSync(additionMarker, 'utf8')).toBe('added\n')
        expect(existsSync(lateMigrationPath)).toBe(true)
        expect(git(fixture.repository, 'status', '--porcelain', '--untracked-files=all')).toBe('')
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('migration directory changed after validation')
        if (command === 'seal') expect(existsSync(fixture.output)).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    },
  )

  it('admits only one cooperating seal while the first holds the parent reservation', async () => {
    const fixture = createSealFixture()
    try {
      const outputParent = join(
        realpathSync(fixture.root),
        basename(dirname(fixture.output)),
      )
      const preloadPath = join(fixture.root, 'hold-output-reservation.cjs')
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const originalChmodSync = fs.chmodSync
const outputParent = ${JSON.stringify(outputParent)}
let held = false
fs.chmodSync = function patchedChmodSync(path, mode, ...args) {
  const result = originalChmodSync.call(this, path, mode, ...args)
  if (!held && String(path) === outputParent && mode === 0o700) {
    held = true
    fs.writeSync(3, 'reserved\\n')
    fs.readSync(0, Buffer.alloc(1), 0, 1, null)
  }
  return result
}
syncBuiltinESMExports()
`)

      const args = [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ]
      const first = spawn(process.execPath, args, {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${preloadPath}`,
          ].filter(Boolean).join(' '),
        },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })

      let firstStderr = ''
      first.stderr?.setEncoding('utf8')
      first.stderr?.on('data', (chunk) => { firstStderr += chunk })
      const handshake = first.stdio[3]
      if (!handshake) throw new Error('reservation handshake pipe is unavailable')
      await new Promise<void>((resolve, reject) => {
        const onData = () => {
          first.off('exit', onExit)
          resolve()
        }
        const onExit = (code: number | null) => {
          handshake.off('data', onData)
          reject(new Error(`first seal exited before reservation handshake: ${code}`))
        }
        handshake.once('data', onData)
        first.once('exit', onExit)
      })

      expect(lstatSync(outputParent).mode & 0o7777).toBe(0o700)
      const second = runSeal(fixture)
      expect(second.status).not.toBe(0)
      expect(second.stderr).toContain('output parent reservation')

      first.stdin?.write('x')
      first.stdin?.end()
      const [firstExit] = await once(first, 'exit')
      expect(firstExit, firstStderr).toBe(0)
      expect(readdirSync(fixture.output).sort()).toEqual([
        'approval-packet.json',
        'package-manifest.json',
        'pre-cas-bindings.json',
        'preflight-candidate.json',
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    { kind: 'empty', withMarker: false },
    { kind: 'nonempty', withMarker: true },
  ])('preserves a stale $kind output-parent reservation', ({ withMarker }) => {
    const fixture = createSealFixture()
    try {
      const outputParent = dirname(fixture.output)
      mkdirSync(outputParent, { mode: 0o700 })
      const reservation = lstatSync(outputParent)
      const markerPath = join(outputParent, 'stale-marker')
      if (withMarker) writeFileSync(markerPath, 'stale\n')

      const result = runSeal(fixture)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('output parent reservation')
      const after = lstatSync(outputParent)
      expect({ dev: String(after.dev), ino: String(after.ino) }).toEqual({
        dev: String(reservation.dev),
        ino: String(reservation.ino),
      })
      expect(readdirSync(outputParent)).toEqual(withMarker ? ['stale-marker'] : [])
      if (withMarker) expect(readFileSync(markerPath, 'utf8')).toBe('stale\n')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('preserves a changed reservation parent without hiding the generation error', () => {
    const fixture = createSealFixture()
    try {
      const lockfilePath = join(fixture.repository, 'package-lock.json')
      const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))
      lockfile.packages['node_modules/wrangler'].version = 'not-semver'
      writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`)
      git(fixture.repository, 'add', 'package-lock.json')
      git(fixture.repository, 'commit', '--quiet', '-m', 'invalid tool version')

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      bindInputToCurrentGit(fixture, input)
      input.repository.lockfile.sha256 = fileSha256(lockfilePath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const outputParent = join(
        realpathSync(fixture.root),
        basename(dirname(fixture.output)),
      )
      const markerPath = join(outputParent, 'external-marker')
      const preloadPath = join(fixture.root, 'mark-reservation-before-failure.cjs')
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const originalChmodSync = fs.chmodSync
const outputParent = ${JSON.stringify(outputParent)}
const markerPath = ${JSON.stringify(markerPath)}
let marked = false
fs.chmodSync = function patchedChmodSync(path, mode, ...args) {
  const result = originalChmodSync.call(this, path, mode, ...args)
  if (!marked && String(path) === outputParent && mode === 0o700) {
    marked = true
    fs.writeFileSync(markerPath, 'preserve\\n')
  }
  return result
}
syncBuiltinESMExports()
`)

      const result = runSeal(fixture, {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--require=${preloadPath}`,
        ].filter(Boolean).join(' '),
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('mismatched long-run package lock blob binding')
      expect(result.stderr).toContain('cleanup')
      expect(readFileSync(markerPath, 'utf8')).toBe('preserve\n')
      expect(readdirSync(outputParent)).toEqual(['external-marker'])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('creates an exact 0700 reservation even under umask 0777', () => {
    const fixture = createSealFixture()
    try {
      const preloadPath = join(fixture.root, 'restrictive-umask.cjs')
      const outputParent = join(
        realpathSync(fixture.root),
        basename(dirname(fixture.output)),
      )
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const originalMkdirSync = fs.mkdirSync
const outputParent = ${JSON.stringify(outputParent)}
fs.mkdirSync = function patchedMkdirSync(path, ...args) {
  if (String(path) !== outputParent) return originalMkdirSync.call(this, path, ...args)
  const previous = process.umask(0o777)
  try {
    return originalMkdirSync.call(this, path, ...args)
  } finally {
    process.umask(previous)
  }
}
syncBuiltinESMExports()
`)

      const result = runSeal(fixture, {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--require=${preloadPath}`,
        ].filter(Boolean).join(' '),
      })

      expect(result.status, result.stderr).toBe(0)
      expect(lstatSync(dirname(fixture.output)).mode & 0o7777).toBe(0o700)
      expect(lstatSync(fixture.output).mode & 0o7777).toBe(0o700)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a repeated seal without changing the published package bytes', () => {
    const fixture = createSealFixture()
    try {
      const first = runSeal(fixture)
      expect(first.status, first.stderr).toBe(0)
      const before = new Map(
        readdirSync(fixture.output)
          .map((name) => [name, readFileSync(join(fixture.output, name))]),
      )

      const second = runSeal(fixture)

      expect(second.status).not.toBe(0)
      expect(second.stderr).toContain('output parent reservation')
      expect(readdirSync(fixture.output).sort()).toEqual([...before.keys()].sort())
      for (const [name, bytes] of before) {
        expect(readFileSync(join(fixture.output, name))).toEqual(bytes)
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('removes sibling staging output when document generation fails', () => {
    const fixture = createSealFixture()
    try {
      const lockfilePath = join(fixture.repository, 'package-lock.json')
      const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))
      lockfile.packages['node_modules/wrangler'].version = 'not-semver'
      writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`)
      git(fixture.repository, 'add', 'package-lock.json')
      git(fixture.repository, 'commit', '--quiet', '-m', 'invalid tool version')

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.candidate.commit = git(fixture.repository, 'rev-parse', 'HEAD')
      input.candidate.tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
      input.github_evidence.quick.head_sha = input.candidate.commit
      input.github_evidence.quick.head_tree = input.candidate.tree
      input.repository.lockfile.sha256 = fileSha256(lockfilePath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('produces byte-identical T0 documents for identical frozen inputs', () => {
    const fixture = createSealFixture()
    const secondOutput = join(
      fixture.root,
      'sealed-again-reservation',
      'sealed-again',
    )
    try {
      const first = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      const second = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        secondOutput,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(first.status, first.stderr).toBe(0)
      expect(second.status, second.stderr).toBe(0)
      expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout))
      for (const name of readdirSync(fixture.output)) {
        expect(readFileSync(join(secondOutput, name)))
          .toEqual(readFileSync(join(fixture.output, name)))
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('preserves an existing output and leaves no sibling staging directory', () => {
    const fixture = createSealFixture()
    try {
      mkdirSync(fixture.output, { recursive: true })
      const markerPath = join(fixture.output, 'keep.txt')
      writeFileSync(markerPath, 'do not overwrite\n')

      const result = spawnSync(process.execPath, [
        cliPath,
        'seal',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--output',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(readFileSync(markerPath, 'utf8')).toBe('do not overwrite\n')
      expect(
        readdirSync(dirname(fixture.output)).some((name) => name.startsWith('.sealed.tmp-')),
      ).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a historically valid v2 quartet as a different current lineage', () => {
    const fixture = createSealFixture()
    const historicalPackage = join(
      projectRoot,
      'tests',
      'fixtures',
      'issue-23-reseal',
      'v2',
    )
    try {
      const result = spawnSync(process.execPath, [
        cliPath,
        'verify',
        '--input',
        fixture.inputPath,
        '--repo',
        fixture.repository,
        '--artifacts',
        fixture.artifacts,
        '--package',
        historicalPackage,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('stale')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed on Git commit or tree identity drift', () => {
    for (const field of ['commit', 'tree'] as const) {
      const fixture = createSealFixture()
      try {
        const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
        input.candidate[field] = field === 'commit' ? 'a'.repeat(40) : 'b'.repeat(40)
        input.github_evidence.quick[field === 'commit' ? 'head_sha' : 'head_tree']
          = input.candidate[field]
        writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

        const result = runSeal(fixture)
        expect(result.status).not.toBe(0)
        expect(existsSync(fixture.output)).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('fails closed on lockfile, runbook, migration, or build byte drift', () => {
    const cases = [
      {
        name: 'lockfile',
        mutate(fixture: SealFixture) {
          const filePath = join(fixture.repository, 'package-lock.json')
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')} `)
          git(fixture.repository, 'add', 'package-lock.json')
          git(fixture.repository, 'commit', '--quiet', '-m', 'lockfile drift')
        },
      },
      {
        name: 'runbook',
        mutate(fixture: SealFixture) {
          const filePath = join(
            fixture.repository,
            'docs',
            'issue-23-phase-b-runbook.md',
          )
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')} `)
          git(fixture.repository, 'add', 'docs/issue-23-phase-b-runbook.md')
          git(fixture.repository, 'commit', '--quiet', '-m', 'runbook drift')
        },
      },
      {
        name: 'migration',
        mutate(fixture: SealFixture) {
          const filePath = join(
            fixture.repository,
            'db',
            'ledger-migrations',
            '001_initial_schema.sql',
          )
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')} `)
          git(fixture.repository, 'add', 'db/ledger-migrations/001_initial_schema.sql')
          git(fixture.repository, 'commit', '--quiet', '-m', 'migration drift')
        },
      },
      {
        name: 'build',
        mutate(fixture: SealFixture) {
          const filePath = join(fixture.artifacts, 'worker.js')
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')} `)
        },
      },
    ]

    for (const driftCase of cases) {
      const fixture = createSealFixture()
      try {
        driftCase.mutate(fixture)
        if (driftCase.name !== 'build') {
          const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
          bindInputToCurrentGit(fixture, input)
          writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)
        }

        const result = runSeal(fixture)
        expect(result.status, driftCase.name).not.toBe(0)
        expect(existsSync(fixture.output), driftCase.name).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('fails closed when the external worker differs from the archived worker', () => {
    const fixture = createSealFixture()
    try {
      const workerPath = join(fixture.artifacts, 'worker.js')
      writeFileSync(workerPath, 'export default { changed: true }\n')

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.build.worker_sha256 = fileSha256(workerPath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = runSeal(fixture)
      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when a migration-set member is a symlink outside its root', () => {
    const fixture = createSealFixture()
    try {
      const migrationDirectory = join(
        fixture.repository,
        'db',
        'ledger-migrations',
      )
      const migrationName = '006_add_rollout_safety_controls.sql'
      const migrationPath = join(migrationDirectory, migrationName)
      const outsideMigration = join(fixture.root, 'outside-migration.sql')
      writeFileSync(outsideMigration, readFileSync(migrationPath))
      unlinkSync(migrationPath)
      symlinkSync(outsideMigration, migrationPath)
      git(fixture.repository, 'add', `db/ledger-migrations/${migrationName}`)
      git(fixture.repository, 'commit', '--quiet', '-m', 'symlink migration')

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      bindInputToCurrentGit(fixture, input)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = runSeal(fixture)
      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed on any canonical long-runner evidence identity drift', () => {
    const mutations = [
      (evidence: Record<string, string | number>) => {
        evidence.run_id = 30251479782
      },
      (evidence: Record<string, string | number>) => {
        evidence.job_id = 89930265070
      },
      (evidence: Record<string, string | number>) => {
        evidence.head_sha = 'c'.repeat(40)
      },
      (evidence: Record<string, string | number>) => {
        evidence.head_tree = 'd'.repeat(40)
      },
      (evidence: Record<string, string | number>) => {
        evidence.raw_job_log_sha256 = 'e'.repeat(64)
      },
    ]

    for (const mutate of mutations) {
      const fixture = createSealFixture()
      try {
        const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
        mutate(input.github_evidence.canonical_long_migration_runner)
        writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

        const result = runSeal(fixture)
        expect(result.status).not.toBe(0)
        expect(existsSync(fixture.output)).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('fails closed on non-normalized relative input paths', () => {
    const fixture = createSealFixture()
    try {
      const lockfilePath = join(fixture.repository, 'package-lock.json')
      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      input.repository.runbook.path = 'docs/../package-lock.json'
      input.repository.runbook.sha256 = fileSha256(lockfilePath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = runSeal(fixture)
      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a package whose named v2 document is a symlink', () => {
    const fixture = createSealFixture()
    try {
      const seal = runSeal(fixture)
      expect(seal.status, seal.stderr).toBe(0)

      const preflightPath = join(fixture.output, 'preflight-candidate.json')
      const outsidePreflight = join(fixture.root, 'outside-preflight.json')
      writeFileSync(outsidePreflight, readFileSync(preflightPath))
      unlinkSync(preflightPath)
      symlinkSync(outsidePreflight, preflightPath)

      const validation = spawnSync(process.execPath, [
        cliPath,
        'validate',
        '--package',
        fixture.output,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
      })

      expect(validation.status).not.toBe(0)
      expect(validation.stderr).toContain('regular file')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects self-consistent drift from the frozen runbook identity', () => {
    const fixture = createSealFixture()
    try {
      const runbookPath = join(
        fixture.repository,
        'docs',
        'issue-23-phase-b-runbook.md',
      )
      writeFileSync(runbookPath, `${readFileSync(runbookPath, 'utf8')} `)
      git(fixture.repository, 'add', 'docs/issue-23-phase-b-runbook.md')
      git(fixture.repository, 'commit', '--quiet', '-m', 'self-consistent runbook drift')

      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      bindInputToCurrentGit(fixture, input)
      input.repository.runbook.sha256 = fileSha256(runbookPath)
      writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

      const result = runSeal(fixture)
      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.output)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed when the inherited long-runner coverage objects drift', () => {
    const cases = [
      {
        name: 'migration runner source',
        path: 'scripts/migrations.mjs',
        mutate(fixture: SealFixture) {
          const filePath = join(fixture.repository, 'scripts', 'migrations.mjs')
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n// drift\n`)
        },
      },
      {
        name: 'migration runner test',
        path: 'tests/migrations/migration-runner.test.ts',
        mutate(fixture: SealFixture) {
          const filePath = join(
            fixture.repository,
            'tests',
            'migrations',
            'migration-runner.test.ts',
          )
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n// drift\n`)
        },
      },
      {
        name: 'ledger migration tree',
        path: 'db/ledger-migrations/coverage-drift.txt',
        mutate(fixture: SealFixture) {
          writeFileSync(
            join(
              fixture.repository,
              'db',
              'ledger-migrations',
              'coverage-drift.txt',
            ),
            'drift\n',
          )
        },
      },
      {
        name: 'package lock',
        path: 'package-lock.json',
        mutate(fixture: SealFixture) {
          const filePath = join(fixture.repository, 'package-lock.json')
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')} `)
        },
      },
    ]

    for (const coverageCase of cases) {
      const fixture = createSealFixture()
      try {
        coverageCase.mutate(fixture)
        git(fixture.repository, 'add', coverageCase.path)
        git(fixture.repository, 'commit', '--quiet', '-m', 'coverage drift')

        const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
        bindInputToCurrentGit(fixture, input)
        if (coverageCase.name === 'package lock') {
          input.repository.lockfile.sha256 = fileSha256(
            join(fixture.repository, 'package-lock.json'),
          )
        }
        writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

        const result = runSeal(fixture)
        expect(result.status, coverageCase.name).not.toBe(0)
        expect(existsSync(fixture.output), coverageCase.name).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('fails closed when direct long-runner fixture dependencies drift', () => {
    const cases = [
      'db/schema.sql',
      'db/seed-template.sql',
      'db/migrations/coverage-drift.txt',
      'wrangler.toml',
      'lib/ai-provider-profiles.ts',
      'lib/ai-post-generator/constants.ts',
    ]

    for (const path of cases) {
      const fixture = createSealFixture()
      try {
        const filePath = join(fixture.repository, path)
        if (path === 'db/migrations/coverage-drift.txt') {
          writeFileSync(filePath, 'drift\n')
        } else {
          const comment = path.endsWith('.sql')
            ? '-- drift'
            : path === 'wrangler.toml'
              ? '# drift'
              : '// drift'
          writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n${comment}\n`)
        }
        git(fixture.repository, 'add', path)
        git(fixture.repository, 'commit', '--quiet', '-m', 'direct dependency drift')

        const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
        bindInputToCurrentGit(fixture, input)
        writeFileSync(fixture.inputPath, `${JSON.stringify(input, null, 2)}\n`)

        const result = runSeal(fixture)
        expect(result.status, path).not.toBe(0)
        expect(existsSync(fixture.output), path).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })
})
