import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const classifier = resolve('scripts/verify-migrations-required.mjs')
const workflow = readFileSync(resolve('.github/workflows/verify.yml'), 'utf8')
const owner = 'nardinmarcus'
const repo = 'blogman'

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
  const file = join(repository, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `change ${path}`)
  return git('rev-parse', 'HEAD')
}

function fixtures(entries: Record<string, unknown>) {
  const file = join(root, 'fixtures.json')
  writeFileSync(file, JSON.stringify(entries))
  return file
}

function greenRun(id: number, sha: string): Record<string, unknown> {
  return {
    [`repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=8`]: {
      workflow_runs: [{
        id, head_sha: sha, path: '.github/workflows/verify.yml',
        status: 'completed', conclusion: 'success', run_attempt: 1,
      }],
    },
    [`repos/${owner}/${repo}/actions/runs/${id}/attempts/1/jobs?per_page=50`]: {
      jobs: [{
        name: 'verify-migrations', status: 'completed', conclusion: 'success',
        steps: [{ name: 'Run long migration verification', conclusion: 'success' }],
      }],
    },
  }
}

function cancelledRun(id: number, sha: string): Record<string, unknown> {
  return {
    [`repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=8`]: {
      workflow_runs: [{
        id, head_sha: sha, path: '.github/workflows/verify.yml',
        status: 'completed', conclusion: 'cancelled', run_attempt: 1,
      }],
    },
    [`repos/${owner}/${repo}/actions/runs/${id}/attempts/1/jobs?per_page=50`]: {
      jobs: [{
        name: 'verify-migrations', status: 'completed', conclusion: 'cancelled',
        steps: [{ name: 'Run long migration verification', conclusion: 'cancelled' }],
      }],
    },
  }
}

function classify(eventName: string, event: object, fixtureEntries: Record<string, unknown>) {
  const eventPath = join(root, 'event.json')
  writeFileSync(eventPath, JSON.stringify(event))
  const output = execFileSync(process.execPath, [classifier], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      GITHUB_REPOSITORY: `${owner}/${repo}`,
      GH_FIXTURES: fixtures(fixtureEntries),
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ATTEMPT: '1',
    },
  })
  return Object.fromEntries(output.trim().split('\n').map((line) => line.split('=')))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blogman-migration-continuity-'))
  repository = join(root, 'repository')
  mkdirSync(repository)
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(root, 'bin', 'gh'),
    '#!/usr/bin/env node\n'
    + 'const fs = require("node:fs")\n'
    + 'const path = (process.argv[3] ?? "").replace(/^\\//, "")\n'
    + 'const entries = JSON.parse(fs.readFileSync(process.env.GH_FIXTURES, "utf8"))\n'
    + 'if (path in entries) { const v = entries[path]; if (v && v.__error__) process.exit(1); console.log(JSON.stringify(v)); process.exit(0) }\n'
    + 'if (path.includes("/actions/runs?head_sha=")) { console.log(JSON.stringify({ workflow_runs: [] })); process.exit(0) }\n'
    + 'console.error(`no fixture for ${path}`)\n'
    + 'process.exit(1)\n',
    { mode: 0o755 },
  )
  git('init', '--quiet')
  git('config', 'user.name', 'Blogman CI Test')
  git('config', 'user.email', 'ci-test@example.invalid')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('migration verification continuity through the real CLI', () => {
  it('requires B to run migrations when unrelated B supersedes unverified A', () => {
    const baseline = commit('README.md', 'baseline\n')
    const candidateA = commit('package.json', '{}\n')
    const candidateB = commit('README.md', 'unrelated follow-up\n')

    const result = classify('push', { before: candidateA, after: candidateB }, {
      ...greenRun(1, baseline),
      ...cancelledRun(2, candidateA),
      [`repos/${owner}/${repo}/actions/runs?head_sha=${candidateB}&per_page=8`]: { workflow_runs: [] },
    })

    // The old event-range classifier skipped here; the covered-range rule must not.
    expect(result.required).toBe('true')
    expect(['matched:package.json', 'changed-since-success:package.json']).toContain(result.reason)
  })

  it('skips a docs-only candidate covered by a proven green ancestor', () => {
    commit('README.md', 'baseline\n')
    const candidateB = commit('package.json', '{}\n')
    const candidateC = commit('docs/runbook.md', 'docs\n')

    const result = classify('push', { before: candidateB, after: candidateC }, {
      ...greenRun(3, candidateB),
      [`repos/${owner}/${repo}/actions/runs?head_sha=${candidateC}&per_page=8`]: { workflow_runs: [] },
    })

    expect(result).toEqual({ required: 'false', reason: `docs-only-since:${candidateB.slice(0, 12)}` })
  })

  it('skips a rerun of a candidate whose migration suite already succeeded', () => {
    const sha = commit('package.json', '{}\n')
    const result = classify('push', { before: sha, after: sha }, greenRun(4, sha))
    expect(result).toEqual({ required: 'false', reason: `docs-only-since:${sha.slice(0, 12)}` })
  })

  it('requires an unrelated PR to run when its history has no proven green baseline', () => {
    const base = commit('package.json', '{}\n')
    const head = commit('README.md', 'PR with no migration diff\n')
    const result = classify('pull_request', {
      pull_request: { base: { sha: base }, head: { sha: head } },
    }, { [`repos/${owner}/${repo}/actions/runs?head_sha=${head}&per_page=8`]: { workflow_runs: [] } })
    expect(result).toEqual({ required: 'true', reason: 'baseline-unresolved' })
  })

  it('runs a PR that touches migration inputs without consulting the baseline', () => {
    commit('README.md', 'baseline\n')
    const base = commit('package.json', '{}\n')
    const head = commit('db/schema.sql', 'CREATE TABLE t(id);\n')
    const result = classify('pull_request', {
      pull_request: { base: { sha: base }, head: { sha: head } },
    }, {})
    expect(result.required).toBe('true')
    expect(result.reason).toBe('matched:db/schema.sql')
  })

  it('fails closed when the GitHub API lookup fails or finds nothing', () => {
    const sha = commit('README.md', 'candidate\n')
    const failure = classify('push', { before: sha, after: sha }, {
      [`repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=8`]: { __error__: true },
    })
    expect(failure).toEqual({ required: 'true', reason: 'baseline-query-failed' })

    const empty = classify('push', { before: sha, after: sha }, {
      [`repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=8`]: { workflow_runs: [] },
    })
    expect(empty).toEqual({ required: 'true', reason: 'baseline-unresolved' })
  })

  it('requires verification when the CLI cannot read its event or git range', () => {
    const sha = commit('README.md', 'candidate\n')
    expect(classify('push', { before: 'a'.repeat(40), after: sha }, {}))
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
          CLASSIFICATION_REASON: 'docs-only-since:abc123',
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
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*"\nexit "$TEST_STATUS"\n', { mode: 0o755 })
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command!], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATUS: String(status) },
    })
    expect(result.stdout).toContain('tests/migrations/migration-runner.test.ts')
    expect(result.status).toBe(status)
  })
})
