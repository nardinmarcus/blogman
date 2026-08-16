import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKER_COMMAND_CONTRACT } from '../../scripts/issue-23-delivery-worker-transport.mjs'
import { comparePathSegments } from '../../scripts/issue-23-delivery-d1-contracts.mjs'

/**
 * Issue #135 — unify directory-walk order with the frozen-tree order
 * (ai/ai-actions divergence).
 *
 * #132 unified the comparator semantics but not the traversal structure:
 * prepare freezes `file_tree.files` in full-path code-unit order (so
 * `editor/ai-actions/route.js` < `editor/ai/route.js`, because `-` (0x2D) <
 * `/` (0x2F)), while the runtime `validateArtifactSource` walk and the upload
 * snapshot enumeration are per-directory depth-first (they descend into
 * `editor/ai/` before emitting `editor/ai-actions/` files, because the
 * segment name `ai` < `ai-actions`). The two orders diverge deterministically
 * whenever a directory name is a strict prefix of a sibling followed by `-`
 * (app routes `editor/ai` vs `editor/ai-actions`, `ai-image` vs
 * `ai-image-actions`). #132's BUILD_ID/_next fixture (same-directory file
 * names) could not expose this.
 *
 * These tests lock the invariant: a tree containing both the #135 divergence
 * pair and the #132 BUILD_ID/_next pair must pass the production validation
 * path when the frozen tree is in full-path code-unit order, and the upload
 * snapshot hash must be computed over the same code-unit order.
 */

const REPOSITORY_ROOT = process.cwd()
const workerUploadPath = join(REPOSITORY_ROOT, 'scripts', 'issue-23-delivery-worker-upload.mjs')
const temporaryDirectories: string[] = []

/**
 * The #135 divergence fixture: `editor/ai/route.js` + `editor/ai-actions/route.js`
 * sort in opposite directions under full-path code-unit order (`-` 0x2D < `/` 0x2F,
 * so ai-actions first) vs a per-directory DFS walk (`ai` < `ai-actions` as segment
 * names, so `ai/` is descended into first). The #132 BUILD_ID/_next pair is kept
 * so both divergence classes are exercised through the same production paths.
 */
const WALK_ORDER_FILES = [
  { path: 'editor/ai-actions/route.js', content: 'ai-actions route\n' },
  { path: 'editor/ai/route.js', content: 'ai route\n' },
  { path: 'assets/BUILD_ID', content: 'build-id\n' },
  { path: 'assets/_next/static/x.js', content: 'x\n' },
  { path: 'worker.js', content: 'worker\n' },
] as const

function makeRemovable(root: string) {
  // upload snapshots chmod directories 0500 and files 0400; restore write bits
  // so temporary-tree cleanup can remove them.
  const visit = (path: string) => {
    const metadata = lstatSync(path)
    if (metadata.isDirectory()) {
      chmodSync(path, 0o700)
      for (const name of readdirSync(path)) visit(join(path, name))
    } else {
      chmodSync(path, 0o600)
    }
  }
  if (existsSync(root)) visit(root)
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    makeRemovable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function hash(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

function walkOrderFixtureTree() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-135-walk-order-')))
  temporaryDirectories.push(directory)
  const source = join(directory, '.open-next')
  for (const file of WALK_ORDER_FILES) {
    const absolute = join(source, file.path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.content)
  }
  return { directory, source }
}

describe('Issue #135 directory-walk order vs frozen-tree order', () => {
  it('orders the ai/ai-actions pair by full-path code-unit order, diverging from per-directory DFS order', () => {
    // Full-path code-unit order: '-' (0x2D) sorts before '/' (0x2F), so
    // ai-actions precedes ai.
    expect(comparePathSegments('editor/ai-actions/route.js', 'editor/ai/route.js')).toBe(-1)
    expect(comparePathSegments('editor/ai/route.js', 'editor/ai-actions/route.js')).toBe(1)
    expect(comparePathSegments('editor/ai/route.js', 'editor/ai/route.js')).toBe(0)
    const fullPaths = [
      '.open-next/editor/ai/route.js',
      '.open-next/editor/ai-actions/route.js',
    ]
    expect([...fullPaths].sort(comparePathSegments)).toEqual([
      '.open-next/editor/ai-actions/route.js',
      '.open-next/editor/ai/route.js',
    ])
    expect([...fullPaths].sort()).toEqual([
      '.open-next/editor/ai-actions/route.js',
      '.open-next/editor/ai/route.js',
    ])
    // Per-directory segment order: the prefix name 'ai' sorts before
    // 'ai-actions', so a depth-first walker descends into ai/ first and
    // emits editor/ai/route.js before editor/ai-actions/route.js — the
    // structural divergence this fixture is designed to catch.
    expect(comparePathSegments('ai', 'ai-actions')).toBe(-1)
  })

  it('accepts a code-unit-order frozen tree through the production validation path', () => {
    const { source } = walkOrderFixtureTree()
    const archive = join(source, 'open-next-build.zip')
    writeFileSync(archive, 'archive\n')

    // prepare freezes `.open-next/**` paths in full-path code-unit order; the
    // divergence pair must sort ai-actions before ai.
    const files = WALK_ORDER_FILES
      .map((file) => ({
        path: `.open-next/${file.path}`,
        sha256: hash(file.content),
        bytes: Buffer.byteLength(file.content),
      }))
      .sort((left, right) => comparePathSegments(left.path, right.path))
    expect(files.map((file) => file.path)).toEqual([
      '.open-next/assets/BUILD_ID',
      '.open-next/assets/_next/static/x.js',
      '.open-next/editor/ai-actions/route.js',
      '.open-next/editor/ai/route.js',
      '.open-next/worker.js',
    ])

    const bindings = {
      artifact_source_path: source,
      artifact_archive_path: archive,
      artifact_file_tree_sha256: hash(JSON.stringify(files)),
      artifact_file_tree_files: files,
    }
    expect(() => WORKER_COMMAND_CONTRACT.validateArtifactSource(bindings)).not.toThrow()
  })

  it('snapshots the divergence tree in full-path code-unit order (upload tree hash matches the frozen order)', () => {
    const { directory, source } = walkOrderFixtureTree()
    const destination = join(directory, 'evidence', 'upload-source-snapshot')
    mkdirSync(dirname(destination), { mode: 0o700 })

    const result = spawnSync(process.execPath, [
      workerUploadPath,
      'create-upload-source-snapshot',
      '--source', source,
      '--destination', destination,
    ], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)

    const proof = JSON.parse(result.stdout) as { tree_sha256: string }
    const entries = WALK_ORDER_FILES
      .map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content),
        sha256: hash(file.content),
      }))
      .sort((left, right) => comparePathSegments(left.path, right.path))
    const expectedTreeSha256 = hash(`${JSON.stringify(entries)}\n`)
    expect(proof.tree_sha256).toBe(expectedTreeSha256)
  })
})
