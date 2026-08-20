/**
 * B8-04 — mobile schedule management read model (issue #63).
 *
 * Pure, framework-free model for the mobile schedule manager. All actions
 * (改期 / 取消 / 立即发布 / 暂停 / 对暂停或过期待办重新确认) reuse the B4-02
 * (#41) schedule-control commands and their operation-ledger idempotency —
 * this module never invents a second write path and never creates a schedule
 * fact table. Everything here is free of React / Next so it unit-tests in
 * plain node with no browser.
 *
 *   - time:  ALL schedule times are displayed fixed in Asia/Shanghai. Because
 *            Asia/Shanghai has no DST it is exactly UTC+8, so the wall-clock
 *            rendering is deterministic no matter the runtime timezone.
 *   - 幂等:  each action maps to a deterministic `operationId` for the shared
 *            kernel — the SAME (action, schedule, seed) always replays the
 *            first recorded result; a change of seed (a new reschedule target
 *            time, a new re-confirm version) is a fresh, auditable operation.
 *   - 状态机: the set of reachable actions depends on `publish_schedules.status`
 *            (pending / paused / stale / claimed are actionable in different
 *            ways; fired / cancelled are terminal and offer no actions).
 *   - 阻挡: 未保存 / 本机稿 (an unconfirmed device draft for the article) and
 *           版本漂移 (the article's latest saved version no longer equals the
 *           schedule's bound version) block unsafe actions; the server kernel
 *           re-evaluates every precondition against D1 so no result depends on
 *           client-optimistic state.
 */

/** 移动端排期一律固定显示 Asia/Shanghai。 */
export const SCHEDULE_DISPLAY_TIMEZONE = 'Asia/Shanghai' as const

/** The four mobile actions that map 1:1 onto B4-02 (#41) kernel commands. */
export type MobileScheduleAction = 'reschedule' | 'cancel' | 'publish_now' | 'reconfirm' | 'pause'

export type ScheduleViewStatus =
  | 'pending'
  | 'paused'
  | 'stale'
  | 'claimed'
  | 'fired'
  | 'cancelled'

const ACTION_LABELS: Record<MobileScheduleAction, string> = {
  reschedule: '改期',
  cancel: '取消排期',
  publish_now: '立即发布',
  reconfirm: '重新确认',
  pause: '暂停',
}

const STATUS_LABELS: Record<ScheduleViewStatus, string> = {
  pending: '已排期',
  paused: '已暂停',
  stale: '需处理',
  claimed: '处理中',
  fired: '已发布',
  cancelled: '已取消',
}

export function scheduleActionLabel(action: MobileScheduleAction): string {
  return ACTION_LABELS[action]
}

export function scheduleStatusLabel(status: ScheduleViewStatus): string {
  return STATUS_LABELS[status]
}

/* ------------------------------------------------------------------ */
/* time — fixed Asia/Shanghai display                                 */
/* ------------------------------------------------------------------ */

const SHANGHAI_UTC_OFFSET_SEC = 8 * 3600

/**
 * Format an epoch second to the Asia/Shanghai wall clock as
 * `YYYY-MM-DD HH:mm`. Asia/Shanghai is a fixed UTC+8 (no DST), so this is
 * exact regardless of the runtime timezone and fully deterministic in tests.
 */
export function shanghaiParts(epochSec: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const d = new Date((epochSec + SHANGHAI_UTC_OFFSET_SEC) * 1000)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD HH:mm` in Asia/Shanghai. */
export function formatScheduleTime(epochSec: number): string {
  const p = shanghaiParts(epochSec)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** `YYYY-MM-DD` in Asia/Shanghai (used for the date-only picker default). */
export function formatScheduleDate(epochSec: number): string {
  const p = shanghaiParts(epochSec)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * Convert an Asia/Shanghai local wall-clock (as produced by an
 * `<input type="datetime-local">`) back to an epoch second. Shanghai = UTC+8.
 * Returns null when any component is out of range.
 */
export function shanghaiToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    !Number.isInteger(hour) || !Number.isInteger(minute)
  ) {
    return null
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  // UTC millis for the wall clock MINUS the 8h Shanghai offset → epoch seconds.
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000) - SHANGHAI_UTC_OFFSET_SEC
}

/** Parse a `YYYY-MM-DDTHH:mm` string (datetime-local value) to epoch. */
export function parseScheduleDatetime(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  return shanghaiToEpoch(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  )
}

/** `YYYY-MM-DDTHH:mm` value for an `<input type="datetime-local">` (Asia/Shanghai). */
export function toDatetimeLocalValue(epochSec: number): string {
  const p = shanghaiParts(epochSec)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/* ------------------------------------------------------------------ */
/* action availability by schedule status                            */
/* ------------------------------------------------------------------ */

/**
 * The actions reachable for a schedule status (the FOUR mobile actions; a
 * schedule pauses AUTOMATICALLY on content change, so manual pause is not a
 * mobile surface):
 *   - pending  → reschedule / cancel / publish-now
 *   - paused   → re-confirm (再武装) / reschedule / cancel / publish-now
 *   - stale    → re-confirm (绑定新版本) / reschedule / cancel (publish-now is
 *                withheld until the author re-confirms — the kernel enforces it)
 *   - claimed  → system is already processing; no further actions (avoid racing)
 *   - fired / cancelled → terminal, no actions
 */
export function availableScheduleActions(status: ScheduleViewStatus): MobileScheduleAction[] {
  switch (status) {
    case 'pending':
      return ['reschedule', 'cancel', 'publish_now']
    case 'paused':
      return ['reconfirm', 'reschedule', 'cancel', 'publish_now']
    case 'stale':
      return ['reconfirm', 'reschedule', 'cancel']
    case 'claimed':
    case 'fired':
    case 'cancelled':
      return []
  }
}

/** Human-readable "why this page has no actionable commands". */
export function terminalReason(status: ScheduleViewStatus): string | null {
  if (status === 'fired') return '该排期已发布，无需再操作。'
  if (status === 'cancelled') return '该排期已取消。'
  if (status === 'claimed') return '系统正在处理该排期，请稍后刷新。'
  return null
}

/* ------------------------------------------------------------------ */
/* blockers — 未保存 / 本机稿 / 版本漂移                                */
/* ------------------------------------------------------------------ */

export interface ScheduleBlockersInput {
  /** publish_schedules.status */
  scheduleStatus: ScheduleViewStatus
  /** true when an unconfirmed device draft exists for the article. */
  hasUnsavedLocalDraft: boolean
  /** latest saved article version (null when the article has no identity). */
  latestVersion: number | null
  /** the schedule's bound version. */
  scheduleVersion: number
}

export type ScheduleBlockerKey = 'unsaved-local-draft' | 'version-drift'

/** The human-readable reason for each blocker. */
export const BLOCKER_LABELS: Record<ScheduleBlockerKey, string> = {
  'unsaved-local-draft': '本机还有未保存/未确认的修改，请先在编辑器中保存或放弃。',
  'version-drift': '文章版本已变化，需要先重新确认到最新版本再操作。',
}

/** Computes which action is blocked and why (empty = all clear). */
export function scheduleBlocker(
  input: ScheduleBlockersInput,
  action: MobileScheduleAction,
): ScheduleBlockerKey | null {
  if (input.hasUnsavedLocalDraft) return 'unsaved-local-draft'
  const drifted = input.latestVersion !== null && input.latestVersion !== input.scheduleVersion
  // 版本漂移 blocks publish-now (an old bound version must never be force-fired
  // without re-binding) — `reconfirm` is exactly how the author resolves drift, so
  // it stays reachable; cancel / reschedule remain open too.
  if (drifted && action === 'publish_now') return 'version-drift'
  return null
}

/* ------------------------------------------------------------------ */
/* idempotent operation ids for the SHARED kernel                     */
/* ------------------------------------------------------------------ */

/**
 * Deterministic operation id for a mobile action, seeded by the action's
 * target so the SAME (action, target) replays the first recorded result while
 * a NEW target is a fresh auditable operation:
 *
 *   - pause / cancel / publish-now are keyed by (action, schedule) only — a
 *     schedule has exactly one armed intent, so repeats replay;
 *   - reschedule is seeded by the target epoch (re-arming to a different time
 *     is a new operation; the same time twice replays);
 *   - reconfirm is seeded by the bound version (re-confirming to the SAME
 *     version replays; a later drift to a newer version is a new operation).
 */
export function deterministicActionOperationId(
  scheduleId: string,
  action: MobileScheduleAction,
  seed?: number,
): string {
  if (seed == null) return `b8-04:${action}:${scheduleId}`
  return `b8-04:${action}:${scheduleId}:${seed}`
}
