import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyMigrationVerification,
  isMigrationVerificationPath,
  parseChangedPaths,
  selectEventRange,
} from '../../scripts/verify-migrations-required.mjs'

const baseSha = '1'.repeat(40)
const headSha = '2'.repeat(40)

function git(repository: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

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
    'scripts/issue-23-reseal.mjs',
    'scripts/rollout-safety.mjs',
    'tests/migrations/rollout-safety.test.ts',
    '.github/workflows/verify.yml',
    'scripts/verify-migrations-required.mjs',
    'tests/ci/verify-migrations-required.test.ts',
  ])('skips %s', (path) => {
    expect(isMigrationVerificationPath(path)).toBe(false)
  })

  it('skips a proven-unrelated diff', () => {
    const runGit = vi.fn(() => Buffer.from('M\0docs/issue-23-phase-b-runbook.md\0'))

    expect(classifyMigrationVerification({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: baseSha }, head: { sha: headSha } } },
      runGit,
    })).toEqual({ required: false, reason: 'not-required' })
    expect(runGit).toHaveBeenCalledWith(baseSha, headSha)
  })

  it('runs for a relevant rename source', () => {
    const runGit = vi.fn(() => Buffer.from(
      'R100\0scripts/migrations.mjs\0scripts/migrations-legacy.mjs\0',
    ))

    expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit,
    })).toEqual({ required: true, reason: 'matched:scripts/migrations.mjs' })
  })

  it.each([
    ['missing PR head', 'pull_request', { pull_request: { base: { sha: baseSha } } }],
    ['all-zero push before', 'push', { before: '0'.repeat(40), after: headSha }],
    ['unsupported event', 'workflow_dispatch', {}],
  ])('fails closed for %s', (_name, eventName, event) => {
    const runGit = vi.fn()

    expect(classifyMigrationVerification({ eventName, event, runGit }))
      .toEqual({ required: true, reason: 'indeterminate-range' })
    expect(runGit).not.toHaveBeenCalled()
  })

  it('fails closed when git diff fails', () => {
    const runGit = vi.fn(() => { throw new Error('bad object') })

    expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit,
    })).toEqual({ required: true, reason: 'diff-failed' })
  })

  it('fails closed for malformed git diff output', () => {
    const runGit = vi.fn(() => Buffer.from('Z\0docs/readme.md\0'))

    expect(classifyMigrationVerification({
      eventName: 'push',
      event: { before: baseSha, after: headSha },
      runGit,
    })).toEqual({ required: true, reason: 'diff-failed' })
  })

  it('recognizes relevant renames and deletions through a real git diff', () => {
    const repository = mkdtempSync(join(tmpdir(), 'blogman-migration-classifier-'))
    try {
      git(repository, 'init', '--quiet')
      git(repository, 'config', 'user.name', 'Blogman CI Test')
      git(repository, 'config', 'user.email', 'ci-test@example.invalid')

      mkdirSync(join(repository, 'db', 'ledger-migrations'), { recursive: true })
      mkdirSync(join(repository, 'docs'))
      writeFileSync(join(repository, 'db', 'ledger-migrations', '007_old.sql'), 'SELECT 1;\n')
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'baseline')
      const renameBase = git(repository, 'rev-parse', 'HEAD')

      git(repository, 'mv', 'db/ledger-migrations/007_old.sql', 'docs/007_old.sql')
      git(repository, 'commit', '--quiet', '-m', 'rename migration')
      const renameHead = git(repository, 'rev-parse', 'HEAD')
      expect(classifyMigrationVerification({
        eventName: 'push',
        event: { before: renameBase, after: renameHead },
        repoRoot: repository,
      })).toEqual({
        required: true,
        reason: 'matched:db/ledger-migrations/007_old.sql',
      })

      mkdirSync(join(repository, 'scripts'))
      writeFileSync(join(repository, 'scripts', 'migrations.mjs'), '// runner\n')
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'add runner')
      const deleteBase = git(repository, 'rev-parse', 'HEAD')
      git(repository, 'rm', 'scripts/migrations.mjs')
      git(repository, 'commit', '--quiet', '-m', 'delete runner')
      const deleteHead = git(repository, 'rev-parse', 'HEAD')
      expect(classifyMigrationVerification({
        eventName: 'push',
        event: { before: deleteBase, after: deleteHead },
        repoRoot: repository,
      })).toEqual({ required: true, reason: 'matched:scripts/migrations.mjs' })
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })
})
