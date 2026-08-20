/**
 * B7-01 — Chrome 剪藏 URL 规范化属性测试 (issue #57).
 *
 * Pure, no DB — fast. Proves that clipping the SAME physical page via tracking
 * parameters / fragments / equivalent URLs converges onto ONE idempotent
 * identity (追踪参数/锚点/等价 URL 去重) and one stable creation id, while
 * semantic variants stay distinct (never guessed).
 */

import { describe, expect, it } from 'vitest'
import { normalizeSourceUrl } from '@/lib/source-identity/url'
import { clipCreationId, clipSlug } from '@/lib/clip/kernel'

describe('lib/clip — URL 规范化幂等 (追踪参数/锚点/等价去重)', () => {
  it('tracking params + fragment + case + default port collapse to ONE clip identity', () => {
    const a = normalizeSourceUrl('https://news.example.com/tech?utm_source=tw&utm_medium=social&id=5#section')
    const b = normalizeSourceUrl('https://NEWS.example.com:443/tech?id=5')
    const c = normalizeSourceUrl('https://news.example.com/tech?id=5&utm_campaign=launch')
    expect(a?.identitySha256).toBe(b?.identitySha256)
    expect(a?.identitySha256).toBe(c?.identitySha256)
    expect(clipCreationId(a!.canonicalUrl)).toBe(`clip:${a!.identitySha256}`)
    // the strongest guarantee: the derived creation id is URL-stable — two URLs
    // that differ ONLY by tracking params / fragment map to one clip id.
    expect(clipCreationId('https://news.example.com/tech?utm_source=tw#x')).toBe(
      clipCreationId('https://news.example.com/tech?utm_campaign=launch'),
    )
  })

  it('query parameter reordering keeps one stable clip creation id', () => {
    const x = clipCreationId('https://example.com/a?b=2&a=1&utm_source=g')
    const y = clipCreationId('https://example.com/a?a=1&b=2')
    expect(x).not.toBeNull()
    expect(x).toBe(y)
  })

  it('empty path and one trailing slash are the same clip identity', () => {
    expect(clipCreationId('https://example.com')).toBe(clipCreationId('https://example.com/'))
  })

  it('semantic variants stay DISTINCT (http vs https, www, trailing slash — no guessing)', () => {
    const http = clipCreationId('http://example.com/path')
    const https = clipCreationId('https://example.com/path')
    const www = clipCreationId('https://www.example.com/path')
    const trailing = clipCreationId('https://example.com/path/')
    expect(https).not.toBe(http)
    expect(https).not.toBe(www)
    expect(https).not.toBe(trailing)
  })

  it('clipSlug is stable and derived from the canonical identity', () => {
    const a = clipSlug('HTTPS://Example.com/p?utm_source=x')
    const b = clipSlug('https://example.com/p')
    expect(a).toBe(b)
    expect(a).toMatch(/^clip-[0-9a-f]{12}$/)
  })

  it('rejects non-http(s) / unparseable URLs — no clip identity is guessed', () => {
    expect(clipCreationId('')).toBeNull()
    expect(clipCreationId('example.com/path')).toBeNull()
    expect(clipCreationId('ftp://example.com/x')).toBeNull()
    expect(clipCreationId('not a url')).toBeNull()
  })
})
