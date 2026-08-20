/**
 * B6-02 — pure helper tests (issue #51).
 *
 * The sync's deterministic transforms: URL/asset key derivation (path-agnostic,
 * content-only), title normalisation, Markdown reference rewriting and the
 * render/metadata-immune baseline fingerprint.
 */

import { describe, expect, it } from 'vitest'
import {
  assetUrlFor,
  baselineFingerprint,
  buildR2Key,
  normalizeTitle,
  rewriteMarkdownRefs,
  sha256Hex,
} from '@/lib/source-sync'

describe('source-sync pure helpers', () => {
  it('builds a path-agnostic content-identity R2 key', () => {
    const sha = 'a'.repeat(64)
    expect(buildR2Key(sha)).toBe(`source-media/${sha}`)
    expect(assetUrlFor(buildR2Key(sha))).toBe(`/api/images/source-media/${sha}`)
  })

  it('trims, collapses whitespace and strips heading/emphasis markdown from a title', () => {
    expect(normalizeTitle('  新款\t手机\n  评测  ')).toBe('新款 手机 评测')
    expect(normalizeTitle('# 标题')).toBe('标题')
    expect(normalizeTitle('**加粗标题**')).toBe('加粗标题')
  })

  it('rewrites referenced media tokens to asset URLs', () => {
    const rewritten = rewriteMarkdownRefs('![主图](assets/hero.png)\n\n正文', {
      'assets/hero.png': '/api/images/source-media/abc',
    })
    expect(rewritten).toContain('![主图](/api/images/source-media/abc)')
    expect(rewritten).toContain('正文')
  })

  it('baseline fingerprint is deterministic and ordered by ref', () => {
    const media = [
      { ref: 'b.png', contentSha256: 'b'.repeat(64), r2Key: '', assetUrl: '', reused: false },
      { ref: 'a.png', contentSha256: 'a'.repeat(64), r2Key: '', assetUrl: '', reused: false },
    ]
    const fp1 = baselineFingerprint('标题', '# 正文', media)
    const fp2 = baselineFingerprint('标题', '# 正文', [...media].reverse())
    expect(fp1).toBe(fp2)
    expect(fp1).toHaveLength(64)
    // Renderer / post metadata never enter the fingerprint.
    expect(baselineFingerprint('标题', '# 正文', media)).toBe(fp1)
  })

  it('sha256Hex handles strings and ArrayBuffers', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex(Buffer.from('hello', 'utf8')))
    expect(sha256Hex(new ArrayBuffer(0))).toHaveLength(64)
  })
})
