import { describe, expect, it } from 'vitest'
import * as transport from '../../scripts/issue-23-delivery-worker-transport.mjs'

describe('Issue #91 Worker transport public boundary', () => {
  it('exports only non-dispatching command contracts and formal no-network transport', () => {
    expect(transport).not.toHaveProperty('createWorkerTransport')
    expect(transport).toHaveProperty('createRehearsalWorkerTransport')
    expect(transport).toHaveProperty('WORKER_COMMAND_CONTRACT')
    for (const capability of ['createTransport', 'execute', 'runBoundedChild']) {
      expect(Object.keys(transport.WORKER_COMMAND_CONTRACT)).not.toContain(capability)
    }
    expect(Object.values(transport.WORKER_COMMAND_CONTRACT).some((value) => (
      typeof value === 'function' && /runBoundedChild|spawn(?:Sync)?\s*\(/u.test(Function.prototype.toString.call(value))
    ))).toBe(false)
  })
})
