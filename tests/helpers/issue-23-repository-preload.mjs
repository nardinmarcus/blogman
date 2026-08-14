import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const originalExecFileSync = childProcess.execFileSync

childProcess.execFileSync = function issue23TestRepositoryIdentity(file, args, options) {
  if (file === '/usr/bin/git') {
    if (args?.[0] === 'rev-parse' && args?.[1] === 'HEAD') {
      return options?.encoding ? `${process.env.BLOGMAN_TEST_REPOSITORY_COMMIT}\n` : Buffer.from(`${process.env.BLOGMAN_TEST_REPOSITORY_COMMIT}\n`)
    }
    if (args?.[0] === 'rev-parse' && args?.[1] === 'HEAD^{tree}') {
      return options?.encoding ? `${process.env.BLOGMAN_TEST_REPOSITORY_TREE}\n` : Buffer.from(`${process.env.BLOGMAN_TEST_REPOSITORY_TREE}\n`)
    }
    if (args?.[0] === 'status') return options?.encoding ? '' : Buffer.alloc(0)
  }
  return originalExecFileSync.call(this, file, args, options)
}

syncBuiltinESMExports()
