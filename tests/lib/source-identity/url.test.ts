/**
 * B6-01 — 规范化 URL 幂等识别: pure URL normalization tests (issue #50).
 *
 * No Miniflare, no DB — fast. Proves the same source input ALWAYS maps to one
 * canonical URL + one sha256 (幂等), noise is stripped deterministically, and
 * semantic variants stay DISTINCT (never guessed/merged automatically).
 */

import { describe, expect, it } from 'vitest'
import { normalizeSourceUrl } from '@/lib/source-identity/url'

describe('lib/source-identity/url — normalizeSourceUrl', () => {
  it('maps tracking-parameter + fragment + case noise to ONE canonical identity', () => {
    const a = normalizeSourceUrl('https://Example.COM/path?utm_source=x&a=1#frag')
    const b = normalizeSourceUrl('HTTPS://example.com:443/path?a=1')
    const c = normalizeSourceUrl('https://example.com/path?utm_medium=email&a=1&utm_campaign=y')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()
    expect(a!.identitySha256).toBe(b!.identitySha256)
    expect(a!.identitySha256).toBe(c!.identitySha256)
    expect(a!.canonicalUrl).toBe('https://example.com/path?a=1')
  })

  it('is idempotent: same input always yields the same canonical url + hash', () => {
    const first = normalizeSourceUrl('https://example.com/articles/how-to?utm_source=tw&id=42')
    for (let i = 0; i < 5; i++) {
      const again = normalizeSourceUrl('https://example.com/articles/how-to?utm_source=tw&id=42')
      expect(again).toEqual(first)
    }
  })

  it('sorts query parameters for a stable identity across reorderings', () => {
    const a = normalizeSourceUrl('https://example.com/path?b=2&a=1&utm_campaign=x')
    const b = normalizeSourceUrl('https://example.com/path?a=1&b=2')
    expect(a!.canonicalUrl).toBe('https://example.com/path?a=1&b=2')
    expect(a!.identitySha256).toBe(b!.identitySha256)
  })

  it('keeps semantic variants DISTINCT (不猜身份 — explicit merge, never guessed)', () => {
    const http = normalizeSourceUrl('http://example.com/path')
    const https = normalizeSourceUrl('https://example.com/path')
    const www = normalizeSourceUrl('https://www.example.com/path')
    const trailing = normalizeSourceUrl('https://example.com/path/')
    expect(https!.identitySha256).not.toBe(http!.identitySha256)
    expect(https!.identitySha256).not.toBe(www!.identitySha256)
    expect(https!.identitySha256).not.toBe(trailing!.identitySha256)
  })

  it('normalizes the empty path to a single trailing slash (/ and "" are the same)', () => {
    expect(normalizeSourceUrl('https://example.com')!.canonicalUrl).toBe('https://example.com/')
    expect(normalizeSourceUrl('https://example.com/')!.canonicalUrl).toBe('https://example.com/')
    expect(normalizeSourceUrl('https://example.com')!.identitySha256).toBe(
      normalizeSourceUrl('https://example.com/')!.identitySha256,
    )
  })

  it('rejects non-http(s) and unparseable inputs (no identity is ever guessed)', () => {
    expect(normalizeSourceUrl('  ')).toBeNull()
    expect(normalizeSourceUrl('not a url')).toBeNull()
    expect(normalizeSourceUrl('ftp://example.com/x')).toBeNull()
    expect(normalizeSourceUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeSourceUrl('example.com/path')).toBeNull()
  })
})
