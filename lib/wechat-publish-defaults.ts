export const WECHAT_DEFAULT_AUTHOR = 'Namoo'
export const WECHAT_DEFAULT_NEED_OPEN_COMMENT = true
export const WECHAT_DEFAULT_ONLY_FANS_CAN_COMMENT = false
export const WECHAT_DIGEST_MAX_LENGTH = 120

export function trimWechatDigest(input: string, maxLength = WECHAT_DIGEST_MAX_LENGTH) {
  const normalized = input.trim()
  const chars = Array.from(normalized)
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') : normalized
}
