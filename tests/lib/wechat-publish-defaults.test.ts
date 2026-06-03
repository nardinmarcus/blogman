import { describe, expect, it } from 'vitest'
import { WECHAT_DIGEST_MAX_LENGTH, trimWechatDigest } from '@/lib/wechat-publish-defaults'

describe('trimWechatDigest', () => {
  it('trims surrounding whitespace', () => {
    expect(trimWechatDigest('  Summary  ')).toBe('Summary')
  })

  it('limits digest by Unicode code point without splitting emoji', () => {
    const result = trimWechatDigest('🙂'.repeat(WECHAT_DIGEST_MAX_LENGTH + 1))

    expect(Array.from(result)).toHaveLength(WECHAT_DIGEST_MAX_LENGTH)
    expect(result).toBe('🙂'.repeat(WECHAT_DIGEST_MAX_LENGTH))
  })
})
