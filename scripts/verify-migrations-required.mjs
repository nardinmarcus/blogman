#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const zeroSha = '0'.repeat(40)
const exactPaths = new Set([
  'db/issue-23-clean-start-reset.sql',
  'db/migrations/002_add_ai_actions.sql',
  'db/migrations/004_add_ai_provider_profiles.sql',
  'db/schema.sql',
  'db/seed-template.sql',
  'lib/ai-post-generator/constants.ts',
  'lib/ai-provider-profiles.ts',
  'package-lock.json',
  'package.json',
  'scripts/migrations.mjs',
  'tests/migrations/migration-runner.test.ts',
  'tsconfig.json',
  'vitest.config.ts',
  'wrangler.toml',
])
const pathPrefixes = ['db/ledger-migrations/']
const DOCS_DIRECTORY_PREFIXES = ['docs/']

export const MIGRATION_JOB_NAME = 'verify-migrations'
export const MIGRATION_STEP_NAME = 'Run long migration verification'
export const MIGRATION_WORKFLOW_PATH = '.github/workflows/verify.yml'
const BASELINE_SEARCH_LIMIT = 25

export function selectEventRange(eventName, event) {
  if (eventName === 'pull_request') {
    return {
      baseSha: event?.pull_request?.base?.sha ?? '',
      headSha: event?.pull_request?.head?.sha ?? '',
    }
  }
  if (eventName === 'push') {
    return { baseSha: event?.before ?? '', headSha: event?.after ?? '' }
  }
  return { baseSha: '', headSha: '' }
}

export function parseChangedPaths(output) {
  const fields = output.toString('utf8').split('\0')
  if (fields.at(-1) === '') fields.pop()

  const paths = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    const match = /^(A|C|D|M|R|T|U|X|B)(\d{1,3})?$/.exec(status)
    if (!match) throw new Error(`Unexpected git diff status: ${status}`)

    const pathCount = match[1] === 'C' || match[1] === 'R' ? 2 : 1
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      const path = fields[index++]
      if (!path) throw new Error(`Missing path for git diff status: ${status}`)
      paths.push(path)
    }
  }
  return paths
}

export function isMigrationVerificationPath(path) {
  return exactPaths.has(path) || pathPrefixes.some((prefix) => path.startsWith(prefix))
}

export function isDocsOnlyPath(path) {
  return path === 'LICENSE'
    || DOCS_DIRECTORY_PREFIXES.some((prefix) => path.startsWith(prefix))
    || /^[^/]+\.md$/.test(path)
}

function isUsableSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) && value !== zeroSha
}

function gitDiff(baseSha, headSha, repoRoot) {
  return execFileSync(
    'git',
    ['diff', '--name-status', '-z', '--find-renames', baseSha, headSha, '--'],
    { cwd: repoRoot, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
  )
}

function gitRevList(headSha, repoRoot) {
  const output = execFileSync(
    'git',
    ['rev-list', `--max-count=${BASELINE_SEARCH_LIMIT}`, headSha],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  return output.split('\n').filter(Boolean)
}

function ghApi(path) {
  return JSON.parse(
    execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }),
  )
}

async function migrationStepSucceeded(run, runApi) {
  const jobs = await runApi(
    `/repos/${run.ghOwner}/${run.ghRepo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=50`,
  )
  return (jobs?.jobs ?? []).some((job) => job.name === MIGRATION_JOB_NAME
    && job.status === 'completed'
    && job.conclusion === 'success'
    && (job.steps ?? []).some((step) => step.name === MIGRATION_STEP_NAME && step.conclusion === 'success'))
}

/**
 * Walk from headSha through its ancestors and return the nearest commit whose
 * Verify run actually executed the migration test step to success. Runs that
 * were cancelled, failed, timed out, or whose migration step was skipped are
 * never trusted, so an aggregate-green run cannot launder skipped evidence.
 */
export async function findTrustedBaseline({ headSha, runApi, runRevList, owner, repo }) {
  for (const sha of runRevList(headSha).slice(0, BASELINE_SEARCH_LIMIT)) {
    const runs = await runApi(`/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=8`)
    const candidates = (runs?.workflow_runs ?? []).filter((run) => run.path === MIGRATION_WORKFLOW_PATH
      && run.status === 'completed'
      && run.head_sha === sha)
    for (const run of candidates) {
      const enriched = { ...run, ghOwner: owner, ghRepo: repo }
      if (await migrationStepSucceeded(enriched, runApi)) return sha
    }
  }
  return null
}

/**
 * Decide whether this candidate must execute the migration suite.
 *
 * A diff touching migration inputs always runs. Otherwise the suite may be
 * skipped only when the nearest ancestor with a proven migration-test success
 * differs from the candidate purely by documentation paths; anything else,
 * including missing baselines and lookup failures, runs the suite.
 */
export async function classifyMigrationVerification({
  eventName,
  event,
  repoRoot = process.cwd(),
  runGit = (baseSha, headSha) => gitDiff(baseSha, headSha, repoRoot),
  runApi = ghApi,
  runRevList = (headSha) => gitRevList(headSha, repoRoot),
  owner = '',
  repo = '',
}) {
  const { baseSha, headSha } = selectEventRange(eventName, event)
  if (!isUsableSha(baseSha) || !isUsableSha(headSha)) {
    return { required: true, reason: 'indeterminate-range' }
  }

  let paths
  try {
    paths = parseChangedPaths(runGit(baseSha, headSha))
  } catch {
    return { required: true, reason: 'diff-failed' }
  }
  const matchedPath = paths.find(isMigrationVerificationPath)
  if (matchedPath) return { required: true, reason: `matched:${matchedPath}` }

  let baseline
  try {
    baseline = await findTrustedBaseline({ headSha, runApi, runRevList, owner, repo })
  } catch {
    return { required: true, reason: 'baseline-query-failed' }
  }
  if (!baseline) return { required: true, reason: 'baseline-unresolved' }

  let sincePaths
  try {
    sincePaths = parseChangedPaths(runGit(baseline, headSha))
  } catch {
    return { required: true, reason: 'diff-failed' }
  }
  const changedPath = sincePaths.find((path) => !isDocsOnlyPath(path))
  if (!changedPath) {
    return { required: false, reason: `docs-only-since:${baseline.slice(0, 12)}` }
  }
  return isMigrationVerificationPath(changedPath)
    ? { required: true, reason: `matched:${changedPath}` }
    : { required: true, reason: `changed-since-success:${changedPath}` }
}

function outputLine(name, value) {
  return `${name}=${String(value).replace(/[\r\n]/g, ' ')}`
}

async function main() {
  let result = { required: true, reason: 'event-unavailable' }
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const [owner = '', repo = ''] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
    result = await classifyMigrationVerification({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      owner,
      repo,
    })
  } catch {}

  process.stdout.write(`${outputLine('required', result.required)}\n`)
  process.stdout.write(`${outputLine('reason', result.reason)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
