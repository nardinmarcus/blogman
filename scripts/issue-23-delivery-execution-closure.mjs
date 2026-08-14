import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export const FORMAL_EXECUTION_CLOSURE_PATHS = Object.freeze([
  'scripts/issue-23-build-proof.mjs',
  'scripts/issue-23-delivery-d1-child.mjs',
  'scripts/issue-23-delivery-d1-contracts.mjs',
  'scripts/issue-23-delivery-d1-stages.mjs',
  'scripts/issue-23-delivery-d1-transport.mjs',
  'scripts/issue-23-delivery-entry.mjs',
  'scripts/issue-23-delivery-evidence-sink.mjs',
  'scripts/issue-23-delivery-evidence-sink-internal.mjs',
  'scripts/issue-23-delivery-execution-closure.mjs',
  'scripts/issue-23-delivery-formal-context.mjs',
  'scripts/issue-23-delivery-formal-fault-harness.mjs',
  'scripts/issue-23-delivery-formal-runtime.mjs',
  'scripts/issue-23-delivery-prepare.mjs',
  'scripts/issue-23-delivery-rehearsal.mjs',
  'scripts/issue-23-delivery-worker-stages.mjs',
  'scripts/issue-23-delivery-worker-transport.mjs',
  'scripts/issue-23-delivery-worker-upload.mjs',
])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function formalExecutionClosureSha256(repositoryRoot) {
  const canonicalRoot = realpathSync(repositoryRoot)
  const files = FORMAL_EXECUTION_CLOSURE_PATHS.map((path) => {
    const absolutePath = resolve(canonicalRoot, path)
    const metadata = lstatSync(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(absolutePath) !== absolutePath) {
      throw new Error(`formal execution closure path is unsafe: ${path}`)
    }
    return { path, sha256: sha256(readFileSync(absolutePath)) }
  })
  return sha256(Buffer.from(`${JSON.stringify(files, null, 2)}\n`, 'utf8'))
}
