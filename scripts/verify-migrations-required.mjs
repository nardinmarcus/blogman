#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const zeroSha = '0'.repeat(40)
const exactPaths = new Set([
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

export function classifyMigrationVerification({
  eventName,
  event,
  repoRoot = process.cwd(),
  runGit = (baseSha, headSha) => gitDiff(baseSha, headSha, repoRoot),
}) {
  const { baseSha, headSha } = selectEventRange(eventName, event)
  if (!isUsableSha(baseSha) || !isUsableSha(headSha)) {
    return { required: true, reason: 'indeterminate-range' }
  }

  try {
    const paths = parseChangedPaths(runGit(baseSha, headSha))
    const matchedPath = paths.find(isMigrationVerificationPath)
    return matchedPath
      ? { required: true, reason: `matched:${matchedPath}` }
      : { required: false, reason: 'not-required' }
  } catch {
    return { required: true, reason: 'diff-failed' }
  }
}

function outputLine(name, value) {
  return `${name}=${String(value).replace(/[\r\n]/g, ' ')}`
}

function main() {
  let result = { required: true, reason: 'event-unavailable' }
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    result = classifyMigrationVerification({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
    })
  } catch {}

  process.stdout.write(`${outputLine('required', result.required)}\n`)
  process.stdout.write(`${outputLine('reason', result.reason)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
