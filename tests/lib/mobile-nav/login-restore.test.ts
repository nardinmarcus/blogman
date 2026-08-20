/**
 * B8-01 — deep-link post-login restoration tests (issue #60).
 *
 * A deep link carries only an identity (path + query). `safeRedirectTarget`
 * preserves the original target (so the landing page re-reads current state
 * after login) and rejects anything that could redirect off-site or carry a
 * command. The deep-link resolver's own no-write guarantee is covered by the
 * shared D1 suite in `tests/lib/workbench/deep-link.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { safeRedirectTarget, LOGIN_FALLBACK_TARGET } from '@/lib/mobile-nav/login-restore'

describe('safeRedirectTarget (深链登录后恢复原目标)', () => {
  it('preserves a deep-link target with its identity query', () => {
    expect(safeRedirectTarget('/admin/today?focus=schedule:abc-123')).toBe(
      '/admin/today?focus=schedule:abc-123',
    )
    expect(safeRedirectTarget('/admin/posts?status=draft')).toBe('/admin/posts?status=draft')
  })

  it('falls back to today on a missing target', () => {
    expect(safeRedirectTarget(null)).toBe(LOGIN_FALLBACK_TARGET)
    expect(safeRedirectTarget(undefined)).toBe(LOGIN_FALLBACK_TARGET)
    expect(safeRedirectTarget('')).toBe(LOGIN_FALLBACK_TARGET)
  })

  it('rejects external and off-site redirect targets', () => {
    expect(safeRedirectTarget('https://evil.example/steal')).toBe(LOGIN_FALLBACK_TARGET)
    expect(safeRedirectTarget('//evil.example/admin')).toBe(LOGIN_FALLBACK_TARGET)
    expect(safeRedirectTarget('/\\evil.example')).toBe(LOGIN_FALLBACK_TARGET)
    expect(safeRedirectTarget('javascript:alert(1)')).toBe(LOGIN_FALLBACK_TARGET)
  })
})
