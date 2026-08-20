/**
 * B4-05 — email reminder policy (issue #44).
 *
 * Pure, clock-driven gates — no DB, no provider — so the threshold / quiet
 * hours / cooldown rules are unit-testable in isolation and the kernel stays
 * a thin deterministic orchestrator over them.
 *
 *   - threshold     `now - created_at >= thresholdSeconds` (已未解决且未已知晓),
 *   - quiet hours   minute-of-day in the policy timezone; overnight windows are
 *                   startMinute > endMinute; start == end means "no window",
 *   - cooldown      a successfully sent source is not re-sent within
 *                   `cooldownSeconds` (重复来源不轰炸).
 */

import type { DigestItem, EmailReminderPolicy } from './types'

/** Minute-of-day (0..1439) for an epoch second in the policy's timezone. */
export function minuteOfDay(nowSeconds: number, utcOffsetMinutes: number): number {
  const shifted = nowSeconds + utcOffsetMinutes * 60
  const normalized = ((shifted % 86400) + 86400) % 86400
  return Math.floor(normalized / 60)
}

/** True when `now` falls inside the quiet window. `null`/empty window → false. */
export function isQuietHours(nowSeconds: number, policy: EmailReminderPolicy): boolean {
  const quiet = policy.quietHours
  if (!quiet) return false
  if (quiet.startMinute === quiet.endMinute) return false
  const minute = minuteOfDay(nowSeconds, policy.utcOffsetMinutes)
  if (quiet.startMinute < quiet.endMinute) {
    return minute >= quiet.startMinute && minute < quiet.endMinute
  }
  // Overnight window: wraps past midnight.
  return minute >= quiet.startMinute || minute < quiet.endMinute
}

/** The item must have stayed open (unresolved, unacknowledged) ≥ threshold. */
export function thresholdMet(createdAt: number, nowSeconds: number, policy: EmailReminderPolicy): boolean {
  return nowSeconds - createdAt >= policy.thresholdSeconds
}

/** A successful send suppresses re-sends within the cooldown window. */
export function inCooldown(lastSentAt: number | null, nowSeconds: number, policy: EmailReminderPolicy): boolean {
  if (lastSentAt === null || lastSentAt <= 0) return false
  return nowSeconds - lastSentAt < policy.cooldownSeconds
}

/* ------------------------------------------------------------------ */
/* digest merging (同源通知聚合 / 合并)                                   */
/* ------------------------------------------------------------------ */

/** One digest email per recipient merging EVERY eligible source. */
export function buildDigestSubject(itemCount: number): string {
  return `【Blogman】${itemCount} 项未处理待办提醒`
}

export function buildDigestText(items: DigestItem[], now: number): string {
  const lines = items.map((item, index) => {
    const detail = item.detail?.trim() ? `\n   详情：${item.detail.trim()}` : ''
    return `${index + 1}. [${item.sourceType}] ${item.title}\n   来源：${item.sourceType}:${item.sourceId}${detail}`
  })
  return [
    `你有一批重要未解决事项提醒。以下 ${items.length} 项仍未解决且未被标记「已知晓」：「已知晓」只停止外部提醒，不会将事项标记为解决。`,
    '',
    ...lines,
    '',
    `生成时间（UTC）：${new Date(now * 1000).toISOString()}`,
    '请登录后台确认处理。',
  ].join('\n')
}