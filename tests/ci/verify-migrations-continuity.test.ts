import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const classifier = resolve('scripts/verify-migrations-required.mjs')
const workflow = readFileSync(resolve('.github/workflows/verify.yml'), 'utf8')

// Extract the repository-owned shell entry, not a reimplementation of its logic.
function stepScript(name: string) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0]
  const run = step?.match(/        run: \|\n((?:          .*\n?)+)/)?.[1]
  if (!run) throw new Error(`Missing shell entry for ${name}`)
  return run.split('\n').map((line) => line.replace(/^          /, '')).join('\n')
}
let root: string
let repository: string

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function commit(path: string, content: string) {
  writeFileSync(join(repository, path), content)
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `change ${path}`)
  return git('rev-parse', 'HEAD')
}

function classify(eventName: string, event: object, attempt = '1') {
  const eventPath = join(root, 'event.json')
  writeFileSync(eventPath, JSON.stringify(event))
  const output = execFileSync(process.execPath, [classifier], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ATTEMPT: attempt,
    },
  })
  return Object.fromEntries(output.trim().split('\n').map((line) => line.split('=')))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blogman-migration-continuity-'))
  repository = join(root, 'repository')
  mkdirSync(repository)
  git('init', '--quiet')
  git('config', 'user.name', 'Blogman CI Test')
  git('config', 'user.email', 'ci-test@example.invalid')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('migration verification continuity through the real CLI', () => {
  it('requires B to run migrations when unrelated B supersedes unverified A', () => {
    const baseline = commit('README.md', 'baseline\n')
    const candidateA = commit('package.json', '{}\n')
    expect(classify('push', { before: baseline, after: candidateA }).required).toBe('true')

    // A has not completed verification. B will cancel A under Verify concurrency.
    const candidateB = commit('README.md', 'unrelated follow-up\n')
    expect(classify('push', { before: candidateA, after: candidateB }).required).toBe('true')

    // Repeated supersession cannot erase the obligation, even after empty commits.
    const candidateC = commit('README.md', 'second unrelated follow-up\n')
    expect(classify('push', { before: candidateB, after: candidateC }).required).toBe('true')
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'retry')
    const candidateD = git('rev-parse', 'HEAD')
    expect(classify('push', { before: candidateC, after: candidateD }).required).toBe('true')
  })

  it('requires an unrelated PR to run even when its base has unverified migrations', () => {
    commit('README.md', 'baseline\n')
    const base = commit('package.json', '{}\n')
    const head = commit('README.md', 'PR with no migration diff\n')
    expect(classify('pull_request', {
      pull_request: { base: { sha: base }, head: { sha: head } },
    }).required).toBe('true')
  })

  it('does not treat an empty diff or a repeat attempt as passing evidence', () => {
    const sha = commit('README.md', 'unchanged candidate\n')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // No prior job status is trusted: running/failed/cancelled/timed-out,
      // success-with-skipped-tests, and even actual success all require a new run.
      expect(classify('push', { before: sha, after: sha }, String(attempt)).required).toBe('true')
    }
  })

  it('requires verification when the CLI cannot read its event or git range', () => {
    expect(classify('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }))
      .toEqual({ required: 'true', reason: 'diff-failed' })
    const output = execFileSync(process.execPath, [classifier], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(root, 'missing') },
    })
    expect(output).toBe('required=true\nreason=event-unavailable\n')
  })

  it.each(['success', 'skipped', 'cancelled', 'failure', '', 'timed_out'])(
    'reports the actual %j test outcome rather than treating job completion as a pass',
    (outcome) => {
      const sha = commit('README.md', 'report candidate\n')
      const summary = join(root, 'summary.md')
      const output = execFileSync('bash', ['-euo', 'pipefail', '-c', stepScript('Report actual migration verification outcome')], {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLASSIFICATION_REASON: 'candidate-verification-required',
          MIGRATION_OUTCOME: outcome,
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'nardinmarcus/blogman',
          GITHUB_RUN_ID: '12345',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_STEP_SUMMARY: summary,
        },
      })
      expect(output).toContain(`Candidate: \`${sha}\``)
      expect(output).toContain('/actions/runs/12345/attempts/2')
      expect(output).toContain('Job: `verify-migrations`')
      expect(output).toContain(`Actual test step outcome: \`${outcome || 'not-executed'}\``)
      expect(output).toContain('Only `success` is passing test evidence')
      expect(readFileSync(summary, 'utf8')).toBe(output)
    },
  )

  it.each([0, 37])('preserves migration runner exit status %i at the workflow shell boundary', (status) => {
    const step = workflow.split('      - name: Run long migration verification\n')[1]?.split('\n      - name:')[0]
    const command = step?.match(/^        run: (.+)$/m)?.[1]
    expect(command).toBe('npm run test:run -- tests/migrations/migration-runner.test.ts --reporter=verbose')
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*"\nexit "$TEST_STATUS"\n', { mode: 0o755 })
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command!], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATUS: String(status) },
    })
    expect(result.stdout).toContain('tests/migrations/migration-runner.test.ts')
    expect(result.status).toBe(status)
  })
})
