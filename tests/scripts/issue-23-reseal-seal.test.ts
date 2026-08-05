import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
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

function frozenTreeCounts(root: string) {
  const counts = {
    regular_file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    hardlinked_regular_file_count: 0,
    special_file_count: 0,
    realpath_escape_count: 0,
    transient_dependency_entry_count: 0,
  }
  const visit = (entryPath: string) => {
    const stat = lstatSync(entryPath)
    const relativePath = relative(root, entryPath)
    const parts = relativePath === '' ? [] : relativePath.split(sep)
    if (parts.includes('node_modules') || parts[0] === 'toolchain') {
      counts.transient_dependency_entry_count += 1
    }
    if (stat.isSymbolicLink()) {
      counts.symlink_count += 1
      return
    }
    if (stat.isDirectory()) {
      counts.directory_count += 1
      for (const name of readdirSync(entryPath)) visit(join(entryPath, name))
      return
    }
    if (stat.isFile()) {
      counts.regular_file_count += 1
      if (stat.nlink !== 1) counts.hardlinked_regular_file_count += 1
      return
    }
    counts.special_file_count += 1
  }
  visit(root)
  return counts
}

function createSealFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-23-seal-')))
  const frozenRoot = join(root, 'frozen')
  const repository = join(frozenRoot, 'snapshot')
  const artifacts = join(frozenRoot, 'artifacts')
  const migrations = join(repository, 'db', 'ledger-migrations')
  mkdirSync(frozenRoot, { mode: 0o700 })
  mkdirSync(join(repository, 'docs'), { recursive: true })
  mkdirSync(join(repository, 'schemas', 'issue-23-reseal'), { recursive: true })
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
  copyFileSync(
    join(projectRoot, 'docs', 'issue-23-local-reseal.md'),
    join(repository, 'docs', 'issue-23-local-reseal.md'),
  )
  copyFileSync(
    join(
      projectRoot,
      'schemas',
      'issue-23-reseal',
      'blogman-issue-23-input-evidence-manifest-v2.schema.json',
    ),
    join(
      repository,
      'schemas',
      'issue-23-reseal',
      'blogman-issue-23-input-evidence-manifest-v2.schema.json',
    ),
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
  copyFileSync(
    join(projectRoot, 'db', 'issue-23-clean-start-reset.sql'),
    join(repository, 'db', 'issue-23-clean-start-reset.sql'),
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
  git(repository, 'config', '--local', 'maintenance.auto', 'false')
  git(repository, 'config', 'user.name', 'Blogman Test')
  git(repository, 'config', 'user.email', 'blogman-test@example.invalid')
  git(repository, 'remote', 'add', 'origin', 'https://github.com/nardinmarcus/blogman.git')
  git(repository, 'add', '.')
  git(repository, 'commit', '--quiet', '-m', 'fixture')
  git(repository, 'commit', '--quiet', '--allow-empty', '-m', 'candidate')
  const candidate = git(repository, 'rev-parse', 'HEAD')
  const tree = git(repository, 'rev-parse', 'HEAD^{tree}')
  const parentCommits = git(repository, 'rev-list', '--parents', '-n', '1', 'HEAD')
    .split(' ')
    .slice(1)

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
  const uploadSource = join(root, '.open-next')
  mkdirSync(uploadSource)
  copyFileSync(workerPath, join(uploadSource, 'worker.js'))
  cpSync(join(artifacts, 'assets'), join(uploadSource, 'assets'), { recursive: true })

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
    format: 'blogman-issue-23-local-reseal-request/v3',
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
        run_id: 31048131997,
        job_id: 92448630134,
        head_sha: '712f7d964ca3468727f018d2308f56cf311d9b8c',
        head_tree: '6db5e3fd5ef04d1b394177d7418840f4b6eb11b8',
        status: 'completed',
        conclusion: 'success',
        test_files_passed: 1,
        test_files_total: 1,
        tests_passed: 46,
        tests_total: 46,
        raw_job_log_sha256: 'a0adee0ca544a33f3f5b8fb9ab16e1f52bfeecbd309da1ea6f15c801eb3f22b3',
        coverage: {
          migration_runner_source_blob: 'e026c61529c6f96d30f4415a0697ad70a8ba38c4',
          migration_runner_test_blob: '6151348a3030676ca6718737393e29962c0b81d6',
          ledger_migrations_tree: 'aecf5d95f3e96084e67aaf9018d35ce85b9000cc',
          package_lock_blob: 'b5801a611744ca475bead3638b5b6061ecb140fb',
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
    clean_start: {
      decision: 'discard-existing-blogman-data',
      database_strategy: 'reset-bound-d1-in-place',
      reset_sql: {
        path: 'db/issue-23-clean-start-reset.sql',
        sha256: fileSha256(join(repository, 'db', 'issue-23-clean-start-reset.sql')),
      },
      historical_data_export: 'NOT_APPLICABLE',
      double_restore: 'NOT_APPLICABLE',
      historical_baseline_queries: 'NOT_APPLICABLE',
    },
  }
  const inputPath = join(frozenRoot, 'reseal-input.json')
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`)
  chmodSync(inputPath, 0o600)
  chmodSync(repository, 0o700)
  chmodSync(artifacts, 0o700)

  const inputEvidencePath = join(frozenRoot, 'input-evidence-manifest.json')
  const inputEvidence = {
    format: 'blogman-issue-23-input-evidence-manifest/v2',
    produced_at: input.produced_at,
    repository: {
      canonical_repo: 'nardinmarcus/blogman',
      origin_url: 'https://github.com/nardinmarcus/blogman.git',
      candidate_commit: candidate,
      candidate_tree: tree,
      parent_commits: parentCommits,
      tracked_worktree_clean: true,
    },
    github: {
      main_push: {
        run_id: input.github_evidence.quick.run_id,
        event: 'push',
        head_branch: 'main',
        head_sha: candidate,
        status: 'completed',
        conclusion: 'success',
      },
    },
    contracts: {
      input_evidence_schema: {
        path: 'schemas/issue-23-reseal/blogman-issue-23-input-evidence-manifest-v2.schema.json',
        sha256: fileSha256(join(
          repository,
          'schemas',
          'issue-23-reseal',
          'blogman-issue-23-input-evidence-manifest-v2.schema.json',
        )),
      },
      reseal_request: {
        path: inputPath,
        format: input.format,
        sha256: fileSha256(inputPath),
      },
      local_reseal_runbook: {
        path: 'docs/issue-23-local-reseal.md',
        sha256: fileSha256(join(repository, 'docs', 'issue-23-local-reseal.md')),
      },
      phase_b_runbook: {
        path: 'docs/issue-23-phase-b-runbook.md',
        sha256: fileSha256(runbookPath),
      },
      build: {
        artifacts_path: artifacts,
        archive_path: input.build.archive_path,
        archive_sha256: input.build.archive_sha256,
        worker_path: input.build.worker_path,
        worker_sha256: input.build.worker_sha256,
        tree_manifest_path: input.build.tree_manifest_path,
        tree_manifest_sha256: input.build.tree_manifest_sha256,
      },
    },
    frozen_tree: {
      root_path: frozenRoot,
      snapshot_path: repository,
      manifest_path: inputEvidencePath,
      root_mode: '0700',
      snapshot_mode: '0700',
      manifest_mode: '0600',
      request_mode: '0600',
      regular_file_count: 1,
      directory_count: 2,
      symlink_count: 0,
      hardlinked_regular_file_count: 0,
      special_file_count: 0,
      realpath_escape_count: 0,
      transient_dependency_entry_count: 0,
    },
    authorization: {
      authorization_granted: false,
      authorization_consumed: false,
    },
    production_boundary: {
      formal_local_seal_invocation_count: 0,
      formal_production_entry_invocation_count: 0,
      cloudflare_read_count: 0,
      cloudflare_write_count: 0,
      d1_read_count: 0,
      d1_write_count: 0,
      phase_b_mutation_count: 0,
      stage_counts: {
        pre_cas_local_gates: 0,
        cas1: 0,
        d1_identity: 0,
        upload: 0,
        clean_start_reset: 0,
        clean_start_empty_verify: 0,
        remote_migration_plan: 0,
        migrations_001_006: 0,
        cas2: 0,
        traffic: 0,
        smoke_reconcile: 0,
        t0: 0,
      },
    },
    lineage_policy: {
      input_dependencies: [],
      denylist: [{
        path: '/private/tmp/blogman-issue23-local-reseal-20260730.Pw99oH',
        terminal_state: 'BLOCK',
        reuse_allowed: false,
      }],
      history: ['validator task 019fb1cb-f016-77d1-b003-7a3f119e1f1f'],
    },
  }
  writeFileSync(inputEvidencePath, `${JSON.stringify(inputEvidence, null, 2)}\n`)
  chmodSync(inputEvidencePath, 0o600)
  Object.assign(inputEvidence.frozen_tree, frozenTreeCounts(frozenRoot))
  writeFileSync(inputEvidencePath, `${JSON.stringify(inputEvidence, null, 2)}\n`)
  chmodSync(inputEvidencePath, 0o600)

  const output = join(root, 'sealed-reservation', 'sealed')
  if (process.env.ISSUE_23_RESEAL_PRECREATE_OUTPUT_PARENT === '1') {
    mkdirSync(dirname(output))
  }

  return {
    artifacts,
    frozenRoot,
    inputEvidencePath,
    inputPath,
    output,
    repository,
    root,
    uploadSource,
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

interface MutableBoundInputEvidence {
  authorization: {
    authorization_consumed: boolean
  }
  contracts: {
    input_evidence_schema: {
      sha256: string
    }
    reseal_request: {
      sha256: string
    }
  }
}

function bindInputToCurrentGit(fixture: SealFixture, input: CandidateBoundInput) {
  input.candidate.commit = git(fixture.repository, 'rev-parse', 'HEAD')
  input.candidate.tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
  input.github_evidence.quick.head_sha = input.candidate.commit
  input.github_evidence.quick.head_tree = input.candidate.tree
}

function rebindInputEvidence(fixture: SealFixture, { updateCounts = false } = {}) {
  const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
  const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
  evidence.repository.candidate_commit = input.candidate.commit
  evidence.repository.candidate_tree = input.candidate.tree
  evidence.repository.parent_commits = git(
    fixture.repository,
    'rev-list',
    '--parents',
    '-n',
    '1',
    'HEAD',
  ).split(' ').slice(1)
  evidence.github.main_push.run_id = input.github_evidence.quick.run_id
  evidence.github.main_push.head_sha = input.github_evidence.quick.head_sha
  evidence.github.main_push.status = input.github_evidence.quick.status
  evidence.github.main_push.conclusion = input.github_evidence.quick.conclusion
  evidence.contracts.reseal_request.path = fixture.inputPath
  evidence.contracts.reseal_request.format = input.format
  evidence.contracts.reseal_request.sha256 = fileSha256(fixture.inputPath)
  evidence.contracts.phase_b_runbook.path = input.repository.runbook.path
  evidence.contracts.phase_b_runbook.sha256 = input.repository.runbook.sha256
  evidence.contracts.build = {
    artifacts_path: fixture.artifacts,
    archive_path: input.build.archive_path,
    archive_sha256: input.build.archive_sha256,
    worker_path: input.build.worker_path,
    worker_sha256: input.build.worker_sha256,
    tree_manifest_path: input.build.tree_manifest_path,
    tree_manifest_sha256: input.build.tree_manifest_sha256,
  }
  writeFileSync(
    fixture.inputEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  chmodSync(fixture.inputEvidencePath, 0o600)
  if (updateCounts) {
    Object.assign(evidence.frozen_tree, frozenTreeCounts(fixture.frozenRoot))
    writeFileSync(
      fixture.inputEvidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
    )
    chmodSync(fixture.inputEvidencePath, 0o600)
  }
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

function runPrepare(fixture: SealFixture) {
  return spawnSync(process.execPath, [
    cliPath,
    'prepare',
    '--input',
    fixture.inputPath,
    '--repo',
    fixture.repository,
    '--artifacts',
    fixture.artifacts,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
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

// These tests launch real Git/Node children and hash the complete frozen fixture.
// The scoped budget is test-only; it does not change any reseal production timeout.
describe('Issue #23 local reseal package generation', { timeout: 15_000 }, () => {
  it('prepares a clean full frozen tree without creating a sealed output reservation', () => {
    const fixture = createSealFixture()
    try {
      expect(git(fixture.repository, 'config', '--local', '--get', 'maintenance.auto'))
        .toBe('false')
      const prepared = runPrepare(fixture)

      expect(prepared.status, prepared.stderr).toBe(0)
      expect(JSON.parse(prepared.stdout)).toEqual({
        candidate_id: git(fixture.repository, 'rev-parse', 'HEAD'),
        format: 'blogman-issue-23-input-evidence-preparation/v1',
        input_evidence_manifest_sha256: fileSha256(fixture.inputEvidencePath),
        production_authorization_granted: false,
        production_counters_all_zero: true,
        state: 'prepared-local-only',
      })
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a real linked worktree whose effective Git storage is outside the frozen root', () => {
    const fixture = createSealFixture()
    try {
      const toolWorkspace = join(fixture.root, 'tool-workspace')
      const externalRepository = join(toolWorkspace, 'repository')
      mkdirSync(toolWorkspace)
      renameSync(fixture.repository, externalRepository)
      execFileSync('git', [
        'worktree',
        'add',
        '--detach',
        fixture.repository,
        'HEAD',
      ], { cwd: externalRepository })
      chmodSync(fixture.repository, 0o700)
      rebindInputEvidence(fixture, { updateCounts: true })

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Git metadata storage escapes the frozen evidence root')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an external Git object alternate declared by repository metadata', () => {
    const fixture = createSealFixture()
    try {
      const externalObjects = join(fixture.root, 'external-objects')
      const alternatesPath = join(
        fixture.repository,
        '.git',
        'objects',
        'info',
        'alternates',
      )
      mkdirSync(externalObjects)
      mkdirSync(dirname(alternatesPath), { recursive: true })
      writeFileSync(alternatesPath, `${externalObjects}\n`)
      rebindInputEvidence(fixture, { updateCounts: true })

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Git object alternates are not allowed')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects Git storage environment overrides before trusting repository identity', () => {
    const fixture = createSealFixture()
    try {
      const externalObjects = join(fixture.root, 'environment-alternate-objects')
      mkdirSync(externalObjects)

      const result = runSeal(fixture, {
        ...process.env,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: externalObjects,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('caller Git environment is not allowed')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('discards non-semantic GIT_PAGER without executing the caller-provided pager', () => {
    const fixture = createSealFixture()
    try {
      const pagerMarker = join(fixture.root, 'caller-pager-executed')
      const pager = join(fixture.root, 'caller-pager')
      writeFileSync(pager, `#!/bin/sh\nprintf 'executed\\n' > ${JSON.stringify(pagerMarker)}\ncat\n`)
      chmodSync(pager, 0o700)

      const result = runSeal(fixture, {
        ...process.env,
        GIT_PAGER: pager,
      })

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(pagerMarker)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an external graft file before it can replace the bound raw parent list', () => {
    const fixture = createSealFixture()
    try {
      const graftPath = join(fixture.root, 'external-grafts')
      const candidate = git(fixture.repository, 'rev-parse', 'HEAD')
      const tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
      const graftedParent = git(
        fixture.repository,
        'commit-tree',
        tree,
        '-m',
        'grafted parent',
      )
      rebindInputEvidence(fixture, { updateCounts: true })
      writeFileSync(graftPath, `${candidate} ${graftedParent}\n`)
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      evidence.repository.parent_commits = [graftedParent]
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)
      const graftBytes = readFileSync(graftPath)

      const result = runSeal(fixture, {
        ...process.env,
        GIT_GRAFT_FILE: graftPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('caller Git environment is not allowed')
      expect(readFileSync(graftPath)).toEqual(graftBytes)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a repository-local graft before it can replace the bound raw parent list', () => {
    const fixture = createSealFixture()
    try {
      const candidate = git(fixture.repository, 'rev-parse', 'HEAD')
      const tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
      const graftedParent = git(
        fixture.repository,
        'commit-tree',
        tree,
        '-m',
        'local grafted parent',
      )
      const graftPath = join(fixture.repository, '.git', 'info', 'grafts')
      writeFileSync(graftPath, `${candidate} ${graftedParent}\n`)
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      evidence.repository.parent_commits = [graftedParent]
      Object.assign(evidence.frozen_tree, frozenTreeCounts(fixture.frozenRoot))
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Git grafts are not allowed')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an external shallow boundary before it can hide a bound raw parent', () => {
    const fixture = createSealFixture()
    try {
      const shallowPath = join(fixture.root, 'external-shallow')
      const candidate = git(fixture.repository, 'rev-parse', 'HEAD')
      writeFileSync(shallowPath, `${candidate}\n`)
      const shallowBytes = readFileSync(shallowPath)

      const result = runSeal(fixture, {
        ...process.env,
        GIT_SHALLOW_FILE: shallowPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('caller Git environment is not allowed')
      expect(readFileSync(shallowPath)).toEqual(shallowBytes)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a repository-local shallow boundary before raw parent trust', () => {
    const fixture = createSealFixture()
    try {
      const candidate = git(fixture.repository, 'rev-parse', 'HEAD')
      writeFileSync(join(fixture.repository, '.git', 'shallow'), `${candidate}\n`)
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      Object.assign(evidence.frozen_tree, frozenTreeCounts(fixture.frozenRoot))
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Git shallow repository state')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a replacement-ref namespace before it can replace raw commit semantics', () => {
    const fixture = createSealFixture()
    try {
      const candidate = git(fixture.repository, 'rev-parse', 'HEAD')
      const tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
      const replacementParent = git(
        fixture.repository,
        'commit-tree',
        tree,
        '-m',
        'replacement parent',
      )
      const replacement = git(
        fixture.repository,
        'commit-tree',
        tree,
        '-p',
        replacementParent,
        '-m',
        'replacement candidate commit',
      )
      git(
        fixture.repository,
        'update-ref',
        `refs/adversarial-replacements/${candidate}`,
        replacement,
      )
      rebindInputEvidence(fixture, { updateCounts: true })
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      evidence.repository.parent_commits = [replacementParent]
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)

      const result = runSeal(fixture, {
        ...process.env,
        GIT_REPLACE_REF_BASE: 'refs/adversarial-replacements',
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('caller Git environment is not allowed')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects repository-local replacement refs even though Git children disable replacement', () => {
    const fixture = createSealFixture()
    try {
      const candidate = git(fixture.repository, 'rev-parse', 'HEAD')
      const tree = git(fixture.repository, 'rev-parse', 'HEAD^{tree}')
      const replacement = git(
        fixture.repository,
        'commit-tree',
        tree,
        '-m',
        'local replacement',
      )
      git(fixture.repository, 'replace', candidate, replacement)
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      Object.assign(evidence.frozen_tree, frozenTreeCounts(fixture.frozenRoot))
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Git replacement refs are not allowed')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const)(
    'rejects root-external %s config before it can supply canonical origin evidence',
    (configVariable) => {
      const fixture = createSealFixture()
      try {
        const externalConfig = join(fixture.root, `${configVariable}.config`)
        writeFileSync(externalConfig, `[remote "origin"]\n\turl = https://github.com/nardinmarcus/blogman.git\n`)
        git(fixture.repository, 'config', '--unset-all', 'remote.origin.url')
        rebindInputEvidence(fixture, { updateCounts: true })
        const configBytes = readFileSync(externalConfig)

        const result = runSeal(fixture, {
          ...process.env,
          [configVariable]: externalConfig,
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('caller Git environment is not allowed')
        expect(readFileSync(externalConfig)).toEqual(configBytes)
        expect(existsSync(dirname(fixture.output))).toBe(false)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    },
  )

  it('rejects a local config include before root-external config can restore canonical origin', () => {
    const fixture = createSealFixture()
    try {
      const externalConfig = join(fixture.root, 'included-origin.config')
      writeFileSync(externalConfig, `[remote "origin"]\n\turl = https://github.com/nardinmarcus/blogman.git\n`)
      git(fixture.repository, 'config', '--unset-all', 'remote.origin.url')
      git(fixture.repository, 'config', '--add', 'include.path', externalConfig)
      rebindInputEvidence(fixture, { updateCounts: true })
      const configBytes = readFileSync(externalConfig)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Git config includes are not allowed')
      expect(readFileSync(externalConfig)).toEqual(configBytes)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a missing-object external promisor without hydration or frozen-root mutation', () => {
    const fixture = createSealFixture()
    try {
      const externalSource = join(fixture.root, 'external-promisor.git')
      const uploadMarker = join(fixture.root, 'external-promisor-uploaded')
      const uploadPack = join(fixture.root, 'external-git-upload-pack')
      execFileSync('git', [
        'clone',
        '--bare',
        '--no-hardlinks',
        fixture.repository,
        externalSource,
      ])
      writeFileSync(uploadPack, `#!/bin/sh\nprintf 'attempted\\n' > ${JSON.stringify(uploadMarker)}\nexec git-upload-pack "$@"\n`)
      chmodSync(uploadPack, 0o700)
      git(fixture.repository, 'config', 'core.repositoryformatversion', '1')
      git(fixture.repository, 'config', 'extensions.partialClone', 'promisor-source')
      git(fixture.repository, 'config', 'remote.promisor-source.url', externalSource)
      git(fixture.repository, 'config', 'remote.promisor-source.promisor', 'true')
      git(fixture.repository, 'config', 'remote.promisor-source.partialclonefilter', 'blob:none')
      git(fixture.repository, 'config', 'remote.promisor-source.uploadpack', uploadPack)

      const parent = git(fixture.repository, 'rev-parse', 'HEAD^')
      const missingObject = join(
        fixture.repository,
        '.git',
        'objects',
        parent.slice(0, 2),
        parent.slice(2),
      )
      expect(existsSync(missingObject)).toBe(true)
      unlinkSync(missingObject)
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      Object.assign(evidence.frozen_tree, frozenTreeCounts(fixture.frozenRoot))
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)
      const countsBefore = frozenTreeCounts(fixture.frozenRoot)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('partial-clone or promisor config is not allowed')
      expect(existsSync(uploadMarker)).toBe(false)
      expect(existsSync(missingObject)).toBe(false)
      expect(frozenTreeCounts(fixture.frozenRoot)).toEqual(countsBefore)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a locally missing bound parent object without attempting object hydration', () => {
    const fixture = createSealFixture()
    try {
      const parent = git(fixture.repository, 'rev-parse', 'HEAD^')
      const missingObject = join(
        fixture.repository,
        '.git',
        'objects',
        parent.slice(0, 2),
        parent.slice(2),
      )
      unlinkSync(missingObject)
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      Object.assign(evidence.frozen_tree, frozenTreeCounts(fixture.frozenRoot))
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)
      const countsBefore = frozenTreeCounts(fixture.frozenRoot)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('could not read Git candidate parent object')
      expect(existsSync(missingObject)).toBe(false)
      expect(frozenTreeCounts(fixture.frozenRoot)).toEqual(countsBefore)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails before output reservation when node_modules/.bin is a symlink', () => {
    const fixture = createSealFixture()
    try {
      const externalTool = join(fixture.root, 'build-workspace', 'tool')
      mkdirSync(dirname(externalTool), { recursive: true })
      writeFileSync(externalTool, '#!/bin/sh\n')
      const bin = join(fixture.frozenRoot, 'node_modules', '.bin')
      mkdirSync(bin, { recursive: true })
      symlinkSync(externalTool, join(bin, 'tool'))

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('symbolic link')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails before output reservation when the frozen tree contains a hardlink', () => {
    const fixture = createSealFixture()
    try {
      const cache = join(fixture.frozenRoot, 'cache')
      mkdirSync(cache)
      const original = join(cache, 'original.bin')
      writeFileSync(original, 'same inode\n')
      linkSync(original, join(cache, 'linked.bin'))

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('hardlinked regular file')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails before output reservation when the frozen tree contains a special file', () => {
    const fixture = createSealFixture()
    try {
      execFileSync('mkfifo', [join(fixture.frozenRoot, 'unexpected.pipe')])

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('special file')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails before output reservation when transient dependencies enter the frozen tree', () => {
    const fixture = createSealFixture()
    try {
      const dependencyPath = join(fixture.frozenRoot, 'node_modules', 'package', 'index.js')
      mkdirSync(dirname(dependencyPath), { recursive: true })
      writeFileSync(dependencyPath, 'module.exports = {}\n')

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('transient dependency or toolchain entry')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked output grandparent into the frozen root before any reservation write', () => {
    const fixture = createSealFixture()
    try {
      const outputAlias = join(fixture.root, 'output-alias')
      const frozenOutputAnchor = join(fixture.frozenRoot, 'output-anchor')
      const derivedOutputParent = join(frozenOutputAnchor, 'reservation')
      const mkdirMarker = join(fixture.root, 'frozen-output-mkdir-attempted')
      mkdirSync(frozenOutputAnchor)
      rebindInputEvidence(fixture, { updateCounts: true })
      const frozenEntries = readdirSync(fixture.frozenRoot).sort()
      symlinkSync(fixture.frozenRoot, outputAlias)
      fixture.output = join(outputAlias, 'output-anchor', 'reservation', 'sealed')

      const preloadPath = join(fixture.root, 'observe-frozen-output-mkdir.cjs')
      writeFileSync(preloadPath, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const originalMkdirSync = fs.mkdirSync
fs.mkdirSync = function patchedMkdirSync(path, ...args) {
  if (String(path) === ${JSON.stringify(derivedOutputParent)}) {
    fs.writeFileSync(${JSON.stringify(mkdirMarker)}, 'attempted\\n')
  }
  return originalMkdirSync.call(this, path, ...args)
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

      expect(result.status).toBe(1)
      expect(existsSync(mkdirMarker)).toBe(false)
      expect(existsSync(derivedOutputParent)).toBe(false)
      expect(readdirSync(fixture.frozenRoot).sort()).toEqual(frozenEntries)
      expect(result.stderr).toContain('output real path must be outside the frozen evidence root')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'schema hash mismatch',
      mutate(evidence: MutableBoundInputEvidence) {
        evidence.contracts.input_evidence_schema.sha256 = '0'.repeat(64)
      },
    },
    {
      name: 'request hash mismatch',
      mutate(evidence: MutableBoundInputEvidence) {
        evidence.contracts.reseal_request.sha256 = '1'.repeat(64)
      },
    },
    {
      name: 'authorization consumed',
      mutate(evidence: MutableBoundInputEvidence) {
        evidence.authorization.authorization_consumed = true
      },
    },
  ])('fails before output reservation on $name', ({ mutate }) => {
    const fixture = createSealFixture()
    try {
      const evidence = JSON.parse(
        readFileSync(fixture.inputEvidencePath, 'utf8'),
      ) as MutableBoundInputEvidence
      mutate(evidence)
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a terminal lineage path that overlaps the frozen inputs', () => {
    const fixture = createSealFixture()
    try {
      const evidence = JSON.parse(readFileSync(fixture.inputEvidencePath, 'utf8'))
      evidence.lineage_policy.denylist[0].path = fixture.frozenRoot
      writeFileSync(
        fixture.inputEvidencePath,
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
      chmodSync(fixture.inputEvidencePath, 0o600)

      const result = runSeal(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('terminal lineage cannot be an input dependency')
      expect(existsSync(dirname(fixture.output))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects upload-time reproof when the source mutates after a successful rehearsal', () => {
    const fixture = createSealFixture()
    try {
      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      const args = [
        cliPath,
        'verify-build-directory',
        '--archive', join(fixture.artifacts, 'open-next-build.zip'),
        '--directory', fixture.uploadSource,
        '--archive-sha256', input.build.archive_sha256,
      ]
      const verified = spawnSync(process.execPath, args, {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      expect(verified.status, verified.stderr).toBe(0)
      expect(JSON.parse(verified.stdout)).toEqual({
        format: 'blogman-build-directory-proof/v1',
        state: 'matched',
        archive_sha256: input.build.archive_sha256,
        file_count: 3,
      })

      writeFileSync(join(fixture.uploadSource, 'assets', '_next', 'chunk.js'), 'drift\n')
      const drifted = spawnSync(process.execPath, args, {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      expect(drifted.status).toBe(1)
      expect(drifted.stderr).toContain('upload source directory does not match')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('seals a canonical local-only T0 quartet through the public CLI', () => {
    const fixture = createSealFixture()
    try {
      const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8'))
      expect(input.github_evidence.canonical_long_migration_runner).toEqual({
        run_id: 31048131997,
        job_id: 92448630134,
        head_sha: '712f7d964ca3468727f018d2308f56cf311d9b8c',
        head_tree: '6db5e3fd5ef04d1b394177d7418840f4b6eb11b8',
        status: 'completed',
        conclusion: 'success',
        test_files_passed: 1,
        test_files_total: 1,
        tests_passed: 46,
        tests_total: 46,
        raw_job_log_sha256: 'a0adee0ca544a33f3f5b8fb9ab16e1f52bfeecbd309da1ea6f15c801eb3f22b3',
        coverage: {
          migration_runner_source_blob: 'e026c61529c6f96d30f4415a0697ad70a8ba38c4',
          migration_runner_test_blob: '6151348a3030676ca6718737393e29962c0b81d6',
          ledger_migrations_tree: 'aecf5d95f3e96084e67aaf9018d35ce85b9000cc',
          package_lock_blob: 'b5801a611744ca475bead3638b5b6061ecb140fb',
          schema_blob: '9585b5fdc67811d8f3b70b1fad3c0afbf42496f9',
          seed_template_blob: '14beef7572457a5c85ad571ba1d0edc37f1f1f64',
          historical_migrations_tree: '349ae025fa89f487bb7e65870c1c423fcf122650',
          wrangler_config_blob: 'bc57f24fa1ce2a5699ea340256eb24593421463f',
          ai_provider_profiles_blob: '9d1f521268875f2a984de6d52e4caf8dbd77708b',
          ai_post_generator_constants_blob: 'd34700c62cf1f2dcaef1ee6d6a28d3d51b4767c1',
        },
      })

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
      expect(approval.format).toBe('blogman-issue-23-approval-packet/v4')
      expect(approval.delivery_mode).toBe('clean-start')
      expect(approval.clean_start).toMatchObject({
        decision: 'discard-existing-blogman-data',
        database_strategy: 'reset-bound-d1-in-place',
        historical_data_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      })
      expect(approval.scope.at(-1)).toBe('T0 event acceptance')
      expect(preCas.format).toBe('blogman-issue-23-pre-cas-bindings/v4')
      expect(preCas.immutable_phase_b_bindings.deliveryMode).toBe('clean-start')
      expect(preCas.immutable_phase_b_bindings.cleanStartResetSqlSha256)
        .toBe(approval.clean_start.reset_sql_sha256)
      expect(preCas.historical_data_disposition).toEqual({
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      })
      expect(preCas.immutable_phase_b_bindings.baselineD1DatabaseId)
        .toBe('5d1cadcf-e10e-4245-b07d-16c64754f00d')
      expect(manifest.format).toBe('blogman-issue-23-package-manifest/v4')
      expect(manifest.delivery_mode).toBe('clean-start')
      expect(manifest.clean_start_reset_sql_sha256)
        .toBe(approval.clean_start.reset_sql_sha256)
      expect(manifest.historical_data_disposition).toEqual({
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      })
      expect(preCas.production_authorization_granted).toBe(false)
      expect(new Set(Object.values(preCas.stage_counts))).toEqual(new Set([0]))

      manifest.historical_data_disposition.production_export = 'SKIPPED'
      chmodSync(join(fixture.output, 'package-manifest.json'), 0o600)
      writeFileSync(
        join(fixture.output, 'package-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
      const dispositionDrift = spawnSync(process.execPath, [
        cliPath,
        'validate',
        '--package',
        fixture.output,
      ], { cwd: projectRoot, encoding: 'utf8' })
      expect(dispositionDrift.status).toBe(1)
      expect(dispositionDrift.stderr).toContain('historical_data_disposition')
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
      rebindInputEvidence(fixture)

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
  args[0] === 'ls-tree'
  && args[args.length - 1] === 'scripts/migrations.mjs'
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
if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
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
if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
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

  it('fails closed on an equal-count frozen-root entry replacement during the final context recheck', () => {
    const fixture = createSealFixture()
    try {
      const originalEntry = join(fixture.frozenRoot, 'unguarded-a.txt')
      const replacementEntry = join(fixture.frozenRoot, 'unguarded-b.txt')
      writeFileSync(originalEntry, 'original frozen entry\n')
      rebindInputEvidence(fixture, { updateCounts: true })

      const fakeBin = join(fixture.root, 'equal-count-frozen-tree-fake-bin')
      const counterPath = join(fixture.root, 'equal-count-head-check-count')
      const replacementMarker = join(fixture.root, 'equal-count-entry-replaced')
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      mkdirSync(fakeBin)
      const fakeGitPath = join(fakeBin, 'git')
      writeFileSync(fakeGitPath, `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
  const count = fs.existsSync(${JSON.stringify(counterPath)})
    ? Number(fs.readFileSync(${JSON.stringify(counterPath)}, 'utf8'))
    : 0
  fs.writeFileSync(${JSON.stringify(counterPath)}, String(count + 1))
  if (count + 1 === 2) {
    fs.unlinkSync(${JSON.stringify(originalEntry)})
    fs.writeFileSync(${JSON.stringify(replacementEntry)}, 'replacement frozen entry\\n')
    fs.writeFileSync(${JSON.stringify(replacementMarker)}, 'replaced\\n')
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
      chmodSync(fakeGitPath, 0o700)

      const result = runSeal(fixture, {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      })

      expect(readFileSync(counterPath, 'utf8')).toBe('2')
      expect(existsSync(replacementMarker)).toBe(true)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('frozen tree changed after validation')
      expect(existsSync(fixture.output)).toBe(false)
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
if (
  !fs.existsSync(marker)
  && args[0] === 'rev-parse'
  && args[1] === '--verify'
  && args[2] === 'HEAD'
) {
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
  && args[0] === 'ls-tree'
  && args[args.length - 1] === 'scripts/migrations.mjs'
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
        expect(result.stderr).toContain('Git worktree cleanliness')
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
      rebindInputEvidence(fixture, { updateCounts: true })

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

  it.each([
    'db/schema.sql',
    'db/seed-template.sql',
    'db/migrations/coverage-drift.txt',
    'wrangler.toml',
    'lib/ai-provider-profiles.ts',
    'lib/ai-post-generator/constants.ts',
  ])('fails closed when direct long-runner fixture dependency drifts: %s', (path) => {
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
  })
})
