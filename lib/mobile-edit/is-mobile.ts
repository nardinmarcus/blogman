/**
 * B8-02 — mobile user-agent detection (issue #61).
 *
 * Tiny, pure server/request helper used by the editor route to choose the
 * mobile small-edit surface vs. the full desktop editor. Kept framework-free
 * and unit-testable. A handoff `?desktop=1` hint lets the "在电脑上继续" link
 * force the full editor even on a phone (it still carries only identity).
 */

const MOBILE_UA = /android|iphone|ipad|ipod|mobile|phone|kindle|silk|opera mini|iemobile/i

export function isMobileUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return MOBILE_UA.test(userAgent)
}

/** Whether a request explicitly asked for the full desktop editor via ?desktop=1. */
export function wantsDesktop(desktopParam: string | null | undefined): boolean {
  return desktopParam === '1' || desktopParam === 'true'
}
