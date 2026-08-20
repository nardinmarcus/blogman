/**
 * B4-05 — email reminder executor test suite (issue #44), D1-backed.
 *
 * Consumes the real #43 notification kernel and proves the #44 contract:
 *
 *   - 阈值       only items open ≥ threshold are reminded; younger items skip,
 *   - 静默时段   inside the window nothing is sent; after it, eligible items
 *                are picked up (补发) — never silently dropped,
 *   - 去重聚合   all eligible sources MERGE into ONE digest email per recipient
 *                and a successful send within the cooldown is never re-sent
 *                (重复来源不轰炸),
 *   - 失败重试   外发失败不丢事实 — provider rejection/throw records a failed
 *                delivery row, the notification fact stays untouched, and the
 *                next run retries (idempotent, no double-count),
 *   - 已知晓     acknowledged silences EXTERNAL reminder only; the fact stays
 *                open,
 *   - 未配置     明确仅站内 — no config / no recipients / no adapter → never
 *                sends and never throws,
 *   - 竞态       concurrent runs converge on one claimed send per source.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { acknowledgeNotification, recordNotification } from '@/lib/notifications'
import {
  getEmailRemindersConfig,
  isQuietHours,
  listEmailDeliveries,
  minuteOfDay,
  runEmailReminders,
  setEmailRemindersConfig,
} from '@/lib/email-reminders'
import { defaultPolicy, MockEmailProvider, bootstrapB405State, createDatabase, query } from './helpers'

let state: string
/** 22:13:20 UTC — minute-of-day 1333; quiet windows are chosen against this. */
const T0 = 1_700_000_000
const SOURCE = { sourceType: 'schedule', sourceId: 'sched-1' }
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b405-email-reminders-'))
  cleanup.push(state)
  await bootstrapB405State(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  const db = createDatabase()
  await db.prepare('DELETE FROM activity_notifications').run()
  await db.prepare('DELETE FROM email_deliveries').run()
  await db.prepare('DELETE FROM email_reminder_config').run()
})

async function recordEligible(now: number, overrides: Partial<Parameters<typeof recordNotification>[1]> = {}) {
  const db = createDatabase()
  await recordNotification(db, {
    notificationId: `n-${Math.random().toString(36).slice(2)}`,
    ...SOURCE,
    title: '版本漂移',
    now,
    ...overrides,
  })
}

describe('minute-of-day / quiet window helpers (policy)', () => {
  it('computes minute-of-day with the policy timezone offset', () => {
    expect(minuteOfDay(T0, 0)).toBe(1333)
    expect(minuteOfDay(T0 + 600, 0)).toBe(1343)
    expect(minuteOfDay(T0, -480)).toBe(853) // UTC-8 → 14:13
  })

  it('handles overnight (wrapping) quiet windows', () => {
    const policy = defaultPolicy({ quietHours: { startMinute: 1330, endMinute: 1300 }, utcOffsetMinutes: 0 })
    // 22:13 inside 22:10 → next-day 21:40 window.
    expect(isQuietHours(T0, policy)).toBe(true)
    expect(isQuietHours(T0 + 60 * 60 * 14, policy)).toBe(true) // ~12:13 next day
    expect(isQuietHours(T0 + 60 * 60 * 23 + 60 * 30, policy)).toBe(false) // ~21:43 next day (gap 21:40–22:10)
  })
})

describe('threshold (阈值触发/不触发)', () => {
  it('an item younger than the threshold is never emailed', async () => {
    const db = createDatabase()
    // Item created 1000s ago; threshold 3600s.
    await recordEligible(T0 - 1000, { now: T0 - 1000 })
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ thresholdSeconds: 3600 }), now: T0 })

    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('ran')
    if (run.outcome === 'ran') {
      expect(run.summary.thresholdSkipped).toBe(1)
      expect(run.summary.eligible).toBe(0)
      expect(run.summary.sent).toBe(0)
    }
    expect(provider.totalCalls).toBe(0)
  })

  it('an item open past the threshold IS emailed', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ thresholdSeconds: 3600 }), now: T0 })

    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('ran')
    if (run.outcome === 'ran') {
      expect(run.summary.thresholdSkipped).toBe(0)
      expect(run.summary.eligible).toBe(1)
      expect(run.summary.sent).toBe(1)
    }
    expect(provider.sent).toHaveLength(1)
    expect(provider.sent[0]?.text).toContain('版本漂移')
  })
})

describe('quiet hours (静默时段抑制 + 过后补发)', () => {
  it('inside the window nothing is sent and the item stays eligible', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, {
      enabled: true,
      policy: defaultPolicy({ quietHours: { startMinute: 1330, endMinute: 1340 } }),
      now: T0,
    })

    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 }) // minute 1333 → quiet
    expect(run.outcome).toBe('quiet-hours')
    if (run.outcome === 'quiet-hours') {
      expect(run.summary.quietSkipped).toBe(1)
      expect(run.summary.sent).toBe(0)
    }
    expect(provider.totalCalls).toBe(0)
    // Notification fact untouched.
    const row = (await query<{ status: string; acknowledged: number }>(
      `SELECT status, acknowledged FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.status).toBe('open')
    expect(row.acknowledged).toBe(0)
  })

  it('after quiet hours the eligible item is picked up (补发, not dropped)', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, {
      enabled: true,
      policy: defaultPolicy({ quietHours: { startMinute: 1330, endMinute: 1340 } }),
      now: T0,
    })

    const provider = new MockEmailProvider()
    const quiet = await runEmailReminders(db, { provider, now: T0 })
    expect(quiet.outcome).toBe('quiet-hours')
    expect(provider.totalCalls).toBe(0)

    // 600s later (minute 1343) the window has ended → send happens.
    const after = await runEmailReminders(db, { provider, now: T0 + 600 })
    expect(after.outcome).toBe('ran')
    if (after.outcome === 'ran') {
      expect(after.summary.quietSkipped).toBe(0)
      expect(after.summary.sent).toBe(1)
    }
    expect(provider.sent).toHaveLength(1)
  })
})

describe('dedup aggregation (同源通知聚合 / 重复来源不轰炸)', () => {
  it('merges every eligible source into ONE digest email per recipient', async () => {
    const db = createDatabase()
    const sources = [
      { sourceType: 'schedule', sourceId: 's-1', title: '排期漂移 A' },
      { sourceType: 'schedule', sourceId: 's-2', title: '排期漂移 B' },
      { sourceType: 'article', sourceId: 'a-9', title: '草稿遗留 C' },
    ]
    for (const s of sources) {
      await recordNotification(db, { notificationId: `n-${s.sourceId}`, ...s, now: T0 - 7200 })
    }
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy(), now: T0 })

    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('ran')
    if (run.outcome === 'ran') {
      expect(run.summary.eligible).toBe(3)
      expect(run.summary.sent).toBe(3)
      expect(run.summary.digestEmails).toBe(1) // ONE merged email, not three
    }
    expect(provider.sent).toHaveLength(1)
    const text = provider.sent[0]?.text ?? ''
    expect(text).toContain('排期漂移 A')
    expect(text).toContain('排期漂移 B')
    expect(text).toContain('草稿遗留 C')
  })

  it('never re-sends a source within the cooldown (不轰炸)', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ cooldownSeconds: 3600 }), now: T0 })

    const provider = new MockEmailProvider()
    const first = await runEmailReminders(db, { provider, now: T0 })
    expect(first.outcome).toBe('ran')
    expect(provider.sent).toHaveLength(1)

    // Immediate re-run at the same instant → cooldown suppresses.
    const second = await runEmailReminders(db, { provider, now: T0 + 60 })
    expect(second.outcome).toBe('ran')
    if (second.outcome === 'ran') {
      expect(second.summary.cooldownSkipped).toBe(1)
      expect(second.summary.sent).toBe(0)
    }
    expect(provider.totalCalls).toBe(1)

    // After the cooldown elapses the digest cadence may send again.
    const third = await runEmailReminders(db, { provider, now: T0 + 3600 + 1 })
    expect(third.outcome).toBe('ran')
    if (third.outcome === 'ran') {
      expect(third.summary.sent).toBe(1)
    }
    expect(provider.sent).toHaveLength(2)

    const deliveries = await listEmailDeliveries(db)
    expect(deliveries.find((d) => d.source_id === SOURCE.sourceId)?.sent_count).toBe(2)
  })

  it('one delivery row per source (additive dedup facts)', async () => {
    const db = createDatabase()
    for (const sourceId of ['x', 'y']) {
      await recordNotification(db, {
        notificationId: `n-dup-${sourceId}`,
        sourceType: 'schedule',
        sourceId,
        title: '重复来源',
        now: T0 - 7200,
      })
    }
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ cooldownSeconds: 0 }), now: T0 })

    const provider = new MockEmailProvider()
    await runEmailReminders(db, { provider, now: T0 })
    const deliveries = await listEmailDeliveries(db)
    expect(deliveries).toHaveLength(2)
    for (const d of deliveries) {
      expect(d.sent_count).toBe(1)
      expect(d.last_status).toBe('sent')
      expect(d.last_sent_at).toBe(T0)
    }
  })
})

describe('failure retry idempotency (外发失败不丢事实)', () => {
  it('rejection records a failed delivery fact, the notification stays open, retry succeeds', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ cooldownSeconds: 0 }), now: T0 })

    const provider = new MockEmailProvider([{ accepted: false, errorMessage: 'SMTP 550 relay denied' }])
    const first = await runEmailReminders(db, { provider, now: T0 })
    expect(first.outcome).toBe('ran')
    if (first.outcome === 'ran') {
      expect(first.summary.failed).toBe(1)
      expect(first.summary.sent).toBe(0)
    }

    // Fact retained: notification still open + unacknowledged; delivery failed.
    const notif = (await query<{ status: string; acknowledged: number }>(
      `SELECT status, acknowledged FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(notif.status).toBe('open')
    expect(notif.acknowledged).toBe(0)
    const failedDeliveries = await listEmailDeliveries(db)
    expect(failedDeliveries).toHaveLength(1)
    expect(failedDeliveries[0]?.last_status).toBe('failed')
    expect(failedDeliveries[0]?.last_error).toContain('550')
    expect(failedDeliveries[0]?.sent_count).toBe(0)

    // Retry is idempotent: the next run re-attempts and records one acceptance.
    const second = await runEmailReminders(db, { provider, now: T0 + 3600 })
    expect(second.outcome).toBe('ran')
    if (second.outcome === 'ran') {
      expect(second.summary.sent).toBe(1)
      expect(second.summary.failed).toBe(0)
    }
    const retriedDeliveries = await listEmailDeliveries(db)
    expect(retriedDeliveries[0]?.last_status).toBe('sent')
    expect(retriedDeliveries[0]?.sent_count).toBe(1)
    expect(retriedDeliveries[0]?.last_sent_at).toBe(T0 + 3600)
    // One accepted email recorded.
    expect(provider.sent).toHaveLength(1)
    expect(provider.totalCalls).toBe(2)
  })

  it('a throwing provider records failure and a later run retries', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ cooldownSeconds: 0 }), now: T0 })

    const provider = new MockEmailProvider([new Error('network timeout')])
    const first = await runEmailReminders(db, { provider, now: T0 })
    expect(first.outcome).toBe('ran')
    if (first.outcome === 'ran') expect(first.summary.failed).toBe(1)

    const deliveries = await listEmailDeliveries(db)
    expect(deliveries[0]?.last_status).toBe('failed')
    expect(deliveries[0]?.last_error).toContain('network timeout')

    const second = await runEmailReminders(db, { provider, now: T0 + 3600 })
    expect(second.outcome).toBe('ran')
    if (second.outcome === 'ran') expect(second.summary.sent).toBe(1)
    expect((await listEmailDeliveries(db))[0]?.last_status).toBe('sent')
  })
})

describe('acknowledged (已知晓 只停外部提醒)', () => {
  it('an acknowledged notification is never emailed but the fact stays open', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    const ack = await acknowledgeNotification(db, { ...SOURCE, now: T0 - 3600 })
    expect(ack.outcome).toBe('acknowledged')
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy(), now: T0 })

    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('ran')
    if (run.outcome === 'ran') {
      expect(run.summary.acknowledgedSkipped).toBe(1)
      expect(run.summary.sent).toBe(0)
    }
    expect(provider.totalCalls).toBe(0)
    const row = (await query<{ status: string; acknowledged: number }>(
      `SELECT status, acknowledged FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.status).toBe('open')
    expect(row.acknowledged).toBe(1)
  })
})

describe('unconfigured / disabled (未配置明确仅站内, 可关闭)', () => {
  it('never configured → unconfigured, in-site only, provider never called', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('unconfigured')
    expect(provider.totalCalls).toBe(0)
  })

  it('configured without recipients → unconfigured, in-site only', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ recipients: [] }), now: T0 })
    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('unconfigured')
    expect(provider.totalCalls).toBe(0)
  })

  it('no provider adapter bound → unconfigured, in-site only', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy(), now: T0 })
    const run = await runEmailReminders(db, { provider: null, now: T0 })
    expect(run.outcome).toBe('unconfigured')
  })

  it('disabled executor → disabled, notifications retained, never sends', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: false, policy: defaultPolicy(), now: T0 })
    const provider = new MockEmailProvider()
    const run = await runEmailReminders(db, { provider, now: T0 })
    expect(run.outcome).toBe('disabled')
    expect(provider.totalCalls).toBe(0)
    const row = (await query<{ status: string }>(
      `SELECT status FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.status).toBe('open')
  })

  it('config round-trips through D1 (policy survives a re-read)', async () => {
    const db = createDatabase()
    await setEmailRemindersConfig(db, {
      enabled: true,
      policy: defaultPolicy({ quietHours: { startMinute: 1330, endMinute: 1340 }, cooldownSeconds: 7200 }),
      now: T0,
    })
    const read = await getEmailRemindersConfig(db)
    expect(read).not.toBeNull()
    expect(read?.enabled).toBe(true)
    expect(read?.policy.recipients).toEqual(['author@example.test'])
    expect(read?.policy.quietHours).toEqual({ startMinute: 1330, endMinute: 1340 })
    expect(read?.policy.cooldownSeconds).toBe(7200)
  })
})

describe('race (竞态 — 并发只发一次)', () => {
  it('concurrent runs converge on a single claimed send per source', async () => {
    const db = createDatabase()
    await recordEligible(T0 - 7200)
    await setEmailRemindersConfig(db, { enabled: true, policy: defaultPolicy({ cooldownSeconds: 0 }), now: T0 })

    const provider = new MockEmailProvider([{ accepted: true }, { accepted: true }])
    const results = await Promise.all([
      runEmailReminders(db, { provider, now: T0 + 1 }),
      runEmailReminders(db, { provider, now: T0 + 2 }),
    ])
    const ran = results.filter((r) => r.outcome === 'ran')
    expect(ran.length).toBe(2)
    const ranSent = ran.reduce((sum, r) => (r.outcome === 'ran' ? sum + r.summary.sent : sum), 0)
    const ranFailed = ran.reduce((sum, r) => (r.outcome === 'ran' ? sum + r.summary.failed : sum), 0)
    // Exactly one claim won.
    expect(ranSent + ranFailed).toBe(1)
    expect(provider.totalCalls).toBe(1)

    const deliveries = await listEmailDeliveries(db)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.sent_count).toBe(1)
  })
})