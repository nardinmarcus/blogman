import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORMAL_RUNTIME_RECEIPT_FORMAT = 'blogman-issue-23-formal-rehearsal-runtime-receipt/v1'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hashFile(path) {
  return sha256(readFileSync(path))
}

function npmCliPath(nodePath) {
  return join(dirname(dirname(nodePath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function version(executable, args, expression, label) {
  const output = execFileSync(executable, args, { encoding: 'utf8', timeout: 15_000 })
  const value = output.match(expression)?.[1]
  if (!value) throw new Error(`Issue #23 formal runtime: ${label} identity is incomplete`)
  return value
}

/** Canonical, hash-bound target runtime receipt. */
export function buildFormalRuntimeReceipt() {
  const nodePath = realpathSync(process.execPath)
  const npmPath = realpathSync(npmCliPath(nodePath))
  const wranglerPath = realpathSync(resolve(REPOSITORY_ROOT, 'node_modules/.bin/wrangler'))
  const openNextPath = realpathSync(resolve(REPOSITORY_ROOT, 'node_modules/.bin/opennextjs-cloudflare'))
  const curlPath = realpathSync('/usr/bin/curl')
  const entryPath = realpathSync(resolve(REPOSITORY_ROOT, 'scripts/issue-23-delivery-entry.mjs'))
  const lockfile = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package-lock.json'), 'utf8'))
  const openNextVersion = lockfile.packages?.['node_modules/@opennextjs/cloudflare']?.version
  if (typeof openNextVersion !== 'string' || openNextVersion.length === 0) {
    throw new Error('Issue #23 formal runtime: OpenNext identity is incomplete')
  }
  const value = {
    format: FORMAL_RUNTIME_RECEIPT_FORMAT,
    os: 'macos',
    arch: arch(),
    node: { version: process.versions.node, identity_sha256: hashFile(nodePath) },
    npm: { version: version(nodePath, [npmPath, '--version'], /^v?(.+)\s*$/mu, 'npm'), identity_sha256: hashFile(npmPath) },
    wrangler: { version: version(wranglerPath, ['--version'], /([0-9]+\.[0-9]+\.[0-9]+)/u, 'Wrangler'), identity_sha256: hashFile(wranglerPath) },
    opennextjs_cloudflare: { version: openNextVersion, identity_sha256: hashFile(openNextPath) },
    curl: { version: version(curlPath, ['--version'], /^curl ([0-9]+(?:\.[0-9]+){1,2})\b/mu, 'curl'), identity_sha256: hashFile(curlPath) },
    entry: { path: 'scripts/issue-23-delivery-entry.mjs', identity_sha256: hashFile(entryPath) },
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return Object.freeze({ value: Object.freeze(value), bytes, sha256: sha256(bytes) })
}
