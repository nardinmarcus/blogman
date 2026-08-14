import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, vi } from 'vitest'

const authorityTestState = vi.hoisted(() => {
  const temporaryParent = (process.env.TMPDIR ?? '/tmp').replace(/\/$/u, '')
  const token = globalThis.crypto.randomUUID()
  return { testHome: `${temporaryParent}/blogman-issue-23-vitest-home-${process.pid}-${token}` }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => ({
      ...actual.userInfo(...args),
      homedir: authorityTestState.testHome,
    }),
  }
})

const previousTestHome = process.env.BLOGMAN_TEST_AUTHORITY_HOME
const previousProtectedRoot = process.env.BLOGMAN_PROTECTED_AUTHORITY_ROOT
const previousPreload = process.env.BLOGMAN_TEST_AUTHORITY_PRELOAD
const protectedRoot = join(
  process.env.HOME ?? '',
  '.local',
  'state',
  'blogman',
  'issue-23-production-authority-v1',
)

mkdirSync(authorityTestState.testHome, { mode: 0o700 })
authorityTestState.testHome = realpathSync(authorityTestState.testHome)
process.env.BLOGMAN_TEST_AUTHORITY_HOME = authorityTestState.testHome
process.env.BLOGMAN_PROTECTED_AUTHORITY_ROOT = protectedRoot
process.env.BLOGMAN_TEST_AUTHORITY_PRELOAD = fileURLToPath(
  new URL('../helpers/issue-23-authority-preload.mjs', import.meta.url),
)

const { authoritySnapshot } = await import('../helpers/issue-23-authority-isolation.ts')
const protectedSnapshot = authoritySnapshot()

afterAll(() => {
  try {
    expect(authoritySnapshot()).toBe(protectedSnapshot)
  } finally {
    rmSync(authorityTestState.testHome, { recursive: true, force: true })
    if (previousTestHome === undefined) delete process.env.BLOGMAN_TEST_AUTHORITY_HOME
    else process.env.BLOGMAN_TEST_AUTHORITY_HOME = previousTestHome
    if (previousProtectedRoot === undefined) delete process.env.BLOGMAN_PROTECTED_AUTHORITY_ROOT
    else process.env.BLOGMAN_PROTECTED_AUTHORITY_ROOT = previousProtectedRoot
    if (previousPreload === undefined) delete process.env.BLOGMAN_TEST_AUTHORITY_PRELOAD
    else process.env.BLOGMAN_TEST_AUTHORITY_PRELOAD = previousPreload
  }
})
