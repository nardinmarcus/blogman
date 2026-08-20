/**
 * B8-04 — mobile schedule management model tests (issue #63).
 *
 * Pure node tests (no browser, no D1): fixed Asia/Shanghai time rendering,
 * action availability per schedule status, and the 未保存/本机稿/版本漂移
 * blockers that gate unsafe actions.
 */

import { describe, expect, it } from 'vitest'
import {
  availableScheduleActions,
  BLOCKER_LABELS,
  deterministicActionOperationId,
  formatScheduleDate,
  formatScheduleTime,
  parseScheduleDatetime,
  scheduleBlocker,
  scheduleStatusLabel,
  SCHEDULE_DISPLAY_TIMEZONE,
  shanghaiToEpoch,
  terminalReason,
  toDatetimeLocalValue,
} from '@/lib/mobile-schedule'

describe('mobile-schedule model — fixed Asia/Shanghai time', () => {
  it('renders epoch seconds in Asia/Shanghai regardless of runtime timezone', () => {
    // 1700000000 == 2023-11-14 22:13:20 UTC == 2023-11-15 06:13 Asia/Shanghai.
    expect(SCHEDULE_DISPLAY_TIMEZONE).toBe('Asia/Shanghai')
    expect(formatScheduleTime(1700000000)).toBe('2023-11-15 06:13')
    expect(formatScheduleTime(1700086400)).toBe('2023-11-16 06:13')
    expect(formatScheduleDate(1700000000)).toBe('2023-11-15')
  })

  it('round-trips a datetime-local value through the Shanghai wall clock', () => {
    // 2026-08-21 10:30 Asia/Shanghai == 02:30 UTC == epoch 1787279400.
    expect(toDatetimeLocalValue(1787279400)).toBe('2026-08-21T10:30')
    expect(parseScheduleDatetime('2026-08-21T10:30')).toBe(1787279400)
    expect(shanghaiToEpoch(2026, 8, 21, 10, 30)).toBe(1787279400)
    // midnight / end-of-day boundaries
    expect(parseScheduleDatetime('2026-08-21T00:00')).toBe(shanghaiToEpoch(2026, 8, 21, 0, 0))
  })

  it('rejects malformed or out-of-range datetimes', () => {
    expect(parseScheduleDatetime('')).toBeNull()
    expect(parseScheduleDatetime('2026-08-21')).toBeNull()
    expect(parseScheduleDatetime('2026-13-21T10:30')).toBeNull()
    expect(parseScheduleDatetime('2026-08-32T10:30')).toBeNull()
    expect(parseScheduleDatetime('2026-08-21T24:00')).toBeNull()
    expect(shanghaiToEpoch(2026, 8, 21, -1, 0)).toBeNull()
  })
})

describe('mobile-schedule model — action availability', () => {
  it('pending offers reschedule / cancel / publish-now (no manual pause)', () => {
    expect(availableScheduleActions('pending')).toEqual(['reschedule', 'cancel', 'publish_now'])
  })
  it('paused offers re-confirm and the reschedule/cancel/publish-now family', () => {
    expect(availableScheduleActions('paused')).toEqual(['reconfirm', 'reschedule', 'cancel', 'publish_now'])
  })
  it('stale requires re-confirm before publish-now', () => {
    expect(availableScheduleActions('stale')).toEqual(['reconfirm', 'reschedule', 'cancel'])
  })
  it('claimed / fired / cancelled are terminal with no actions', () => {
    expect(availableScheduleActions('claimed')).toEqual([])
    expect(availableScheduleActions('fired')).toEqual([])
    expect(availableScheduleActions('cancelled')).toEqual([])
    expect(terminalReason('fired')).toContain('已发布')
    expect(terminalReason('cancelled')).toContain('已取消')
    expect(terminalReason('claimed')).not.toBeNull()
  })
  it('provides Chinese status/action labels', () => {
    expect(scheduleStatusLabel('pending')).toBe('已排期')
    expect(availableScheduleActions('pending').length).toBeGreaterThan(0)
    expect(BLOCKER_LABELS['unsaved-local-draft']).toContain('未保存')
  })
})

describe('mobile-schedule model — blockers (未保存/本机稿/版本漂移)', () => {
  const base = {
    scheduleStatus: 'pending' as const,
    hasUnsavedLocalDraft: false,
    latestVersion: 2,
    scheduleVersion: 2,
  }

  it('an unconfirmed device draft blocks every action', () => {
    for (const action of ['reschedule', 'cancel', 'publish_now', 'reconfirm'] as const) {
      expect(scheduleBlocker({ ...base, hasUnsavedLocalDraft: true }, action)).toBe('unsaved-local-draft')
    }
  })

  it('version drift blocks publish-now but keeps re-confirm (the fix) and cancel/reschedule open', () => {
    const drifted = { ...base, latestVersion: 3, scheduleVersion: 2 }
    expect(scheduleBlocker(drifted, 'publish_now')).toBe('version-drift')
    expect(scheduleBlocker(drifted, 'reconfirm')).toBeNull()
    expect(scheduleBlocker(drifted, 'cancel')).toBeNull()
    expect(scheduleBlocker(drifted, 'reschedule')).toBeNull()
  })

  it('in-sync schedule has no blockers', () => {
    expect(scheduleBlocker(base, 'publish_now')).toBeNull()
    expect(scheduleBlocker(base, 'cancel')).toBeNull()
  })
})

describe('mobile-schedule model — deterministic operation ids', () => {
  it('keys pause / cancel / publish-now by (action, schedule)', () => {
    expect(deterministicActionOperationId('s1', 'cancel')).toBe('b8-04:cancel:s1')
    expect(deterministicActionOperationId('s1', 'pause')).toBe('b8-04:pause:s1')
    expect(deterministicActionOperationId('s1', 'publish_now')).toBe('b8-04:publish_now:s1')
    // stable across calls
    expect(deterministicActionOperationId('s1', 'cancel')).toBe(deterministicActionOperationId('s1', 'cancel'))
    // different schedule → different id
    expect(deterministicActionOperationId('s2', 'cancel')).not.toBe(deterministicActionOperationId('s1', 'cancel'))
  })

  it('seeds reschedule by target time and reconfirm by bound version', () => {
    expect(deterministicActionOperationId('s1', 'reschedule', 1787279400)).toBe('b8-04:reschedule:s1:1787279400')
    // same target → same (idempotent replay); new target → fresh operation
    expect(deterministicActionOperationId('s1', 'reschedule', 1787279400))
      .toBe(deterministicActionOperationId('s1', 'reschedule', 1787279400))
    expect(deterministicActionOperationId('s1', 'reschedule', 1787280000))
      .not.toBe(deterministicActionOperationId('s1', 'reschedule', 1787279400))
    expect(deterministicActionOperationId('s1', 'reconfirm', 3)).toBe('b8-04:reconfirm:s1:3')
  })
})
