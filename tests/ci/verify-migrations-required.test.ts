import { describe, expect, it, vi } from 'vitest'
import {
  classifyMigrationVerification,
  findTrustedBaseline,
  isDocsOnlyPath,
  isMigrationVerificationPath,
  parseChangedPaths,
  selectEventRange,
} from '../../scripts/verify-migrations-required.mjs'

const baseSha = '1'.repeat(40)
const headSha = '2'.repeat(40)
const oldSha = '3'.repeat(40)

describe('verify-migrations change classifier', () => {
  it('selects pull request base and head SHAs', () => {
    expect(selectEventRange('pull_request', {
      pull_request: { base: { sha: baseSha }, head: { sha: headSha } },
    })).toEqual({ baseSha, headSha })
  })

  it('selects push before and after SHAs', () => {
    expect(selectEventRange('push', { before: baseSha, after: headSha }))
      .toEqual({ baseSha, headSha })
  })

  it('checks both sides of renames and keeps deleted paths', () => {
    const diff = Buffer.from(
      `R100\0db/ledger-migrations/007_old.sql\0docs/007_old.sql\0D\0scripts/migrations.mjs\0`,
    )

    expect(parseChangedPaths(diff)).toEqual([
      'db/ledger-migrations/007_old.sql',
      'docs/007_old.sql',
      'scripts/migrations.mjs',
    ])
  })

  it.each([
    'db/ledger-migrations/007_add_post_versions.sql',
    'db/schema.sql',
    'db/seed-template.sql',
    'db/migrations/002_add_ai_actions.sql',
    'db/migrations/004_add_ai_provider_profiles.sql',
    'db/issue-23-clean-start-reset.sql',
    'scripts/migrations.mjs',
    'tests/migrations/migration-runner.test.ts',
    'lib/ai-provider-profiles.ts',
    'lib/ai-post-generator/constants.ts',
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'tsconfig.json',
    'wrangler.toml',
  ])('runs for %s', (path) => {
    expect(isMigrationVerificationPath(path)).toBe(true)
  })

  it.each([
    'docs/issue-23-phase-b-runbook.md',
    'docs/agents/issue-tracker.md',
    'docs/nested/notes.txt',
    'README.md',
    'README.zh-CN.md',
    'CONTRIBUTING.md',
    'LICENSE',
  ])('treats %s as docs-only', (path) => {
    expect(isDocsOnlyPath(path)).toBe(true)
  })

  it.each([
    'app/page.tsx',
    'README.tsx',
    'sub/README.md',
    'LICENSES',
  ])('does not treat %s as docs-only', (path) => {
    expect(isDocsOnlyPath(path)).toBe(false)
  })

  it.each([
    '.github/workflows/verify.yml',
    'scripts/verify-migrations-required.mjs',
    'tests/ci/verify-migrations-required.test.ts',
  ])('does not classify %s as a migration input', (path) => {
    expect(isMigrationVerificationPath(path)).toBe(false)
  })

  it('runs for a migration diff without consulting the baseline', async () => {
    const runGit = vi.fn(() => Buffer.from('M\0scripts/migrations.mjs\0'))
    const runApi = vi.fn()

    await expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit,
      runApi,
    })).resolves.toEqual({ required: true, reason: 'matched:scripts/migrations.mjs' })
    expect(runApi).not.toHaveBeenCalled()
  })
})

describe('trusted migration-test baseline', () => {
  const verifyRun = (id, sha, extra = {}) => ({
    id,
    head_sha: sha,
    path: '.github/workflows/verify.yml',
    status: 'completed',
    run_attempt: 1,
    ...extra,
  })
  const greenJobs = () => ({
    jobs: [{
      name: 'verify-migrations',
      status: 'completed',
      conclusion: 'success',
      steps: [
        { name: 'Classify migration changes', conclusion: 'success' },
        { name: 'Run long migration verification', conclusion: 'success' },
      ],
    }],
  })

  it('trusts only a completed Verify run whose migration test step succeeded', async () => {
    const runApi = vi.fn(async (path) => {
      if (path.includes('/actions/runs?head_sha=')) {
        return { workflow_runs: [verifyRun(11, headSha, { conclusion: 'success' })] }
      }
      return {
        jobs: [{
          name: 'verify-migrations',
          status: 'completed',
          conclusion: 'success',
          steps: [{ name: 'Run long migration verification', conclusion: 'skipped' }],
        }],
      }
    })

    await expect(findTrustedBaseline({
      headSha,
      runApi,
      runRevList: () => [headSha],
      owner: 'o',
      repo: 'r',
    })).resolves.toBeNull()

    const skippedApi = vi.fn(async (path) => {
      if (path.includes('/actions/runs?head_sha=')) {
        return { workflow_runs: [verifyRun(11, headSha, { conclusion: 'skipped' })] }
      }
      return { jobs: [] }
    })
    await expect(findTrustedBaseline({
      headSha,
      runApi: skippedApi,
      runRevList: () => [headSha],
      owner: 'o',
      repo: 'r',
    })).resolves.toBeNull()

    const greenApi = vi.fn(async (path) => {
      if (path.includes('/actions/runs?head_sha=')) {
        return { workflow_runs: [verifyRun(11, headSha, { conclusion: 'success' })] }
      }
      return greenJobs()
    })
    await expect(findTrustedBaseline({
      headSha,
      runApi: greenApi,
      runRevList: () => [headSha],
      owner: 'o',
      repo: 'r',
    })).resolves.toBe(headSha)
  })

  it('walks past cancelled ancestors to the nearest green one', async () => {
    const runApi = vi.fn(async (path) => {
      if (path.includes(`head_sha=${headSha}`)) return { workflow_runs: [] }
      if (path.includes(`head_sha=${baseSha}`)) {
        return { workflow_runs: [verifyRun(12, baseSha, { conclusion: 'cancelled' })] }
      }
      if (path.includes(`head_sha=${oldSha}`)) {
        return { workflow_runs: [verifyRun(13, oldSha, { conclusion: 'success' })] }
      }
      if (path.includes('/runs/12/')) {
        return { jobs: [{ name: 'verify-migrations', status: 'completed', conclusion: 'cancelled', steps: [] }] }
      }
      return greenJobs()
    })

    await expect(findTrustedBaseline({
      headSha,
      runApi,
      runRevList: () => [headSha, baseSha, oldSha],
      owner: 'o',
      repo: 'r',
    })).resolves.toBe(oldSha)
  })

  it('stops at the search limit and reports no baseline', async () => {
    const shas = Array.from({ length: 40 }, (_, i) => String(i + 10).repeat(40))
    const runApi = vi.fn(async () => ({ workflow_runs: [] }))

    await expect(findTrustedBaseline({
      headSha,
      runApi,
      runRevList: () => shas,
      owner: 'o',
      repo: 'r',
    })).resolves.toBeNull()
    expect(runApi).toHaveBeenCalledTimes(25)
  })
})

describe('candidate classification against the trusted baseline', () => {
  const greenBaselineApi = () => async (path) => {
    if (path.includes('/actions/runs?head_sha=')) {
      return { workflow_runs: [{ id: 13, head_sha: oldSha, path: '.github/workflows/verify.yml', status: 'completed', conclusion: 'success', run_attempt: 1 }] }
    }
    return {
      jobs: [{
        name: 'verify-migrations',
        status: 'completed',
        conclusion: 'success',
        steps: [{ name: 'Run long migration verification', conclusion: 'success' }],
      }],
    }
  }

  it('skips a proven-unrelated diff only when a green baseline covers it', async () => {
    const classify = (runGit, runApi = greenBaselineApi()) => classifyMigrationVerification({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: baseSha }, head: { sha: headSha } } },
      runGit,
      runApi,
      runRevList: () => [headSha, oldSha],
    })

    await expect(classify(() => Buffer.from('M\0docs/runbook.md\0')))
      .resolves.toEqual({ required: false, reason: `docs-only-since:${oldSha.slice(0, 12)}` })

    await expect(classify(() => Buffer.from('M\0app/feed.tsx\0')))
      .resolves.toEqual({ required: true, reason: 'changed-since-success:app/feed.tsx' })

    await expect(classify(() => Buffer.from('M\0docs/a.md\0M\0db/schema.sql\0')))
      .resolves.toEqual({ required: true, reason: 'matched:db/schema.sql' })
  })

  it('runs when no trusted baseline exists', async () => {
    await expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit: () => Buffer.from('M\0docs/runbook.md\0'),
      runApi: async () => ({ workflow_runs: [] }),
      runRevList: () => [headSha, baseSha],
    })).resolves.toEqual({ required: true, reason: 'baseline-unresolved' })
  })

  it('fails closed when the baseline query fails', async () => {
    await expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit: () => Buffer.from('M\0docs/runbook.md\0'),
      runApi: async () => { throw new Error('rate limited') },
      runRevList: () => [headSha],
    })).resolves.toEqual({ required: true, reason: 'baseline-query-failed' })
  })

  it('fails closed when the covered diff cannot be computed', async () => {
    const runGit = vi.fn((from) => {
      if (from === baseSha) return Buffer.from('M\0docs/runbook.md\0')
      throw new Error('bad object')
    })

    await expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit,
      runApi: greenBaselineApi(),
      runRevList: () => [headSha, oldSha],
    })).resolves.toEqual({ required: true, reason: 'diff-failed' })
  })

  it.each([
    ['missing PR head', 'pull_request', { pull_request: { base: { sha: baseSha } } }],
    ['all-zero push before', 'push', { before: '0'.repeat(40), after: headSha }],
    ['unsupported event', 'workflow_dispatch', {}],
  ])('fails closed for %s', async (_name, eventName, event) => {
    const runGit = vi.fn()

    await expect(classifyMigrationVerification({ eventName, event, runGit }))
      .resolves.toEqual({ required: true, reason: 'indeterminate-range' })
    expect(runGit).not.toHaveBeenCalled()
  })

  it('fails closed when git diff fails', async () => {
    await expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit: () => { throw new Error('bad object') },
    })).resolves.toEqual({ required: true, reason: 'diff-failed' })
  })

  it('fails closed for malformed git diff output', async () => {
    await expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit: () => Buffer.from('Z\0docs/readme.md\0'),
    })).resolves.toEqual({ required: true, reason: 'diff-failed' })
  })

  it('recognizes relevant renames and deletions through a real git diff', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const repository = mkdtempSync(join(tmpdir(), 'blogman-migration-classifier-'))
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
    try {
      git('init', '--quiet')
      git('config', 'user.name', 'Blogman CI Test')
      git('config', 'user.email', 'ci-test@example.invalid')

      mkdirSync(join(repository, 'db', 'ledger-migrations'), { recursive: true })
      mkdirSync(join(repository, 'docs'))
      writeFileSync(join(repository, 'db', 'ledger-migrations', '007_old.sql'), 'SELECT 1;\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'baseline')
      const renameBase = git('rev-parse', 'HEAD')

      git('mv', 'db/ledger-migrations/007_old.sql', 'docs/007_old.sql')
      git('commit', '--quiet', '-m', 'rename migration')
      const renameHead = git('rev-parse', 'HEAD')
      await expect(classifyMigrationVerification({
        eventName: 'push',
        event: { before: renameBase, after: renameHead },
        repoRoot: repository,
        runApi: async () => ({ workflow_runs: [] }),
      })).resolves.toEqual({
        required: true,
        reason: 'matched:db/ledger-migrations/007_old.sql',
      })

      mkdirSync(join(repository, 'scripts'))
      writeFileSync(join(repository, 'scripts', 'migrations.mjs'), '// runner\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'add runner')
      const deleteBase = git('rev-parse', 'HEAD')
      git('rm', 'scripts/migrations.mjs')
      git('commit', '--quiet', '-m', 'delete runner')
      const deleteHead = git('rev-parse', 'HEAD')
      await expect(classifyMigrationVerification({
        eventName: 'push',
        event: { before: deleteBase, after: deleteHead },
        repoRoot: repository,
        runApi: async () => ({ workflow_runs: [] }),
      })).resolves.toEqual({ required: true, reason: 'matched:scripts/migrations.mjs' })
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })
})
