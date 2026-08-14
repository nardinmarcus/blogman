import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const authoritySuffix = ['.local', 'state', 'blogman', 'issue-23-production-authority-v1']

export const TEST_AUTHORITY_HOME = process.env.BLOGMAN_TEST_AUTHORITY_HOME ?? ''
export const TEST_AUTHORITY_ROOT = join(TEST_AUTHORITY_HOME, ...authoritySuffix)
export const PROTECTED_AUTHORITY_ROOT = process.env.BLOGMAN_PROTECTED_AUTHORITY_ROOT ?? ''

if (!isAbsolute(TEST_AUTHORITY_HOME) || !isAbsolute(PROTECTED_AUTHORITY_ROOT)) {
  throw new Error('Issue #23 test authority isolation was not installed before test import')
}

export function isolatedAuthorityChildEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const preload = process.env.BLOGMAN_TEST_AUTHORITY_PRELOAD
  if (typeof preload !== 'string' || !isAbsolute(preload)) {
    throw new Error('Issue #23 test authority preload is unavailable')
  }
  return {
    ...process.env,
    ...overrides,
    BLOGMAN_TEST_AUTHORITY_HOME: overrides.BLOGMAN_TEST_AUTHORITY_HOME ?? TEST_AUTHORITY_HOME,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
      .filter(Boolean)
      .join(' '),
  }
}

export function authoritySnapshot(root = PROTECTED_AUTHORITY_ROOT) {
  const rows: Array<Record<string, unknown>> = []
  const visit = (path: string, relativePath: string) => {
    let value
    try {
      value = lstatSync(path, { bigint: true })
    } catch (error) {
      if (relativePath === '' && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        rows.push({ path: '.', kind: 'absent' })
        return
      }
      throw error
    }
    const row: Record<string, unknown> = {
      path: relativePath || '.',
      kind: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'dir' : value.isFile() ? 'file' : 'other',
      dev: value.dev.toString(),
      ino: value.ino.toString(),
      mode: Number(value.mode & 0o777n),
      uid: value.uid.toString(),
      gid: value.gid.toString(),
      size: value.size.toString(),
      mtime_ns: value.mtimeNs.toString(),
      ctime_ns: value.ctimeNs.toString(),
    }
    if (value.isSymbolicLink()) row.target = readlinkSync(path)
    if (value.isFile()) row.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    rows.push(row)
    if (value.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath ? `${relativePath}/${name}` : name)
      }
    }
  }
  visit(root, '')
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
