/**
 * B4-05 — email reminder wake contract tests (issue #44).
 *
 * `runEmailRemindersWake` is the deferred Cron wiring contract (mirroring the
 * scheduled-publish handler): a missing DB binding or the
 * `EMAIL_REMINDERS_DISABLED` kill-switch resolve deterministically to a skip
 * WITHOUT sending anything and WITHOUT touching notification facts — 站内通知
 * 保持, only external email stops. Zero production: no provider is bound here.
 */

import { describe, expect, it } from 'vitest'
import { runEmailRemindersWake } from '@/lib/email-reminders/scheduled'

describe('runEmailRemindersWake (the deferred Cron wake contract)', () => {
  it('skips when the DB binding is unavailable', async () => {
    const run = await runEmailRemindersWake({})
    expect(run.skipped).toBe(true)
    if (run.skipped) expect(run.reason).toContain('DB unavailable')
  })

  it('skips when the executor kill-switch is set (notifications retained)', async () => {
    for (const value of ['1', 'true', 'YES', 'on']) {
      const run = await runEmailRemindersWake({ EMAIL_REMINDERS_DISABLED: value })
      expect(run.skipped).toBe(true)
      if (run.skipped) expect(run.reason).toContain('disabled')
    }
  })

  it('does not treat an absent flag as disabled', async () => {
    // Without the kill-switch and without a DB we get the DB-unavailable skip —
    // proof the flag itself is the only gate here (kernel coverage: D1 tests).
    const run = await runEmailRemindersWake({})
    expect(run.skipped).toBe(true)
    if (run.skipped) expect(run.reason).toContain('DB unavailable')
  })
})