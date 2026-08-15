import { describe, expect, it } from 'vitest'
import * as transport from '../../scripts/issue-23-delivery-d1-transport.mjs'

describe('Issue #23 remote D1 ownership', () => {
  it('does not expose a caller-assembled remote production transport', () => {
    expect(transport).not.toHaveProperty('createD1Transport')
    expect(Object.values(transport.D1_COMMAND_CONTRACT).some((value) => (
      typeof value === 'function' && /runBoundedChild|spawn(?:Sync)?\s*\(/u.test(Function.prototype.toString.call(value))
    ))).toBe(false)
  })
})
