import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { isAbsolute } from 'node:path'

const testHome = process.env.BLOGMAN_TEST_AUTHORITY_HOME
if (typeof testHome !== 'string' || !isAbsolute(testHome)) {
  throw new Error('Issue #23 test authority preload requires an absolute test-owned homedir')
}
const actualUserInfo = os.userInfo
os.userInfo = (...args) => ({ ...actualUserInfo(...args), homedir: testHome })
syncBuiltinESMExports()
