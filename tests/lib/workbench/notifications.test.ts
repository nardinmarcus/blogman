/**
 * B4-04 — notification kernel test suite (issue #43), D1-backed.
 *
 * Proves the notification lifecycle against the real D1 binding:
 *
 *   - 去重    record of the same (source_type, source_id) replays, never duplicates,
 *   - 解决    resolve is explicit and separate from acknowledge,
 *   - 重建    rebuild reconciles the D1 set against current authoritative facts,
 *   - 已知晓  acknowledge only silences EXTERNAL reminders; status stays open
 *             (never fakes a resolution),
 *   - 竞态    concurrent record/resolve/acknowledge converge on the source
 *             UNIQUE index + guarded conditional updates (one winner).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapB404State, createDatabase, query } from './helpers'
import {
  acknowledgeNotification,
  listNotifications,
  rebuildNotifications,
  recordNotification,
  resolveNotification,
} from '@/lib/notifications'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

const SOURCE = { sourceType: 'schedule', sourceId: 'sched-1' }

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b404-notifications-'))
  cleanup.push(state)
  await bootstrapB404State(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await createDatabase().prepare('DELETE FROM activity_notifications').run()
})

describe('notification dedup (去重)', () => {
  it('recording the same source twice yields exactly one row', async () => {
    const first = await recordNotification(createDatabase(), {
      notificationId: 'n-1',
      ...SOURCE,
      title: '版本漂移',
      now: T0,
    })
    expect(first.outcome).toBe('recorded')

    const second = await recordNotification(createDatabase(), {
      notificationId: 'n-1',
      ...SOURCE,
      title: '版本漂移',
      now: T0,
    })
    expect(second.outcome).toBe('replayed')
    if (second.outcome === 'replayed') {
      expect(second.existing).toBe(true)
    }

    const count = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM activity_notifications`))[0]?.c ?? 0
    expect(count).toBe(1)
  })

  it('different sources are distinct rows', async () => {
    await recordNotification(createDatabase(), { notificationId: 'a', sourceType: 'schedule', sourceId: 's-1', title: 'A', now: T0 })
    await recordNotification(createDatabase(), { notificationId: 'b', sourceType: 'schedule', sourceId: 's-2', title: 'B', now: T0 })
    const all = await listNotifications(createDatabase())
    expect(all).toHaveLength(2)
  })
})

describe('acknowledge vs resolve (已知晓/解决)', () => {
  it('acknowledge silences reminders but leaves the fact open (never fakes resolution)', async () => {
    await recordNotification(createDatabase(), { notificationId: 'n-ack', ...SOURCE, title: '需要关注', now: T0 })
    const ack = await acknowledgeNotification(createDatabase(), { ...SOURCE, now: T0 + 5 })
    expect(ack.outcome).toBe('acknowledged')
    if (ack.outcome === 'acknowledged') {
      // Status remains open — acknowledge did NOT resolve.
      expect(ack.status).toBe('open')
    }

    const row = (await query<{ status: string; acknowledged: number }>(
      `SELECT status, acknowledged FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.acknowledged).toBe(1)
    expect(row.status).toBe('open')
  })

  it('resolve is explicit and separate from acknowledge', async () => {
    await recordNotification(createDatabase(), { notificationId: 'n-res', ...SOURCE, title: '待解决', now: T0 })
    const res = await resolveNotification(createDatabase(), { ...SOURCE, now: T0 + 5 })
    expect(res.outcome).toBe('resolved')

    const row = (await query<{ status: string; acknowledged: number }>(
      `SELECT status, acknowledged FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.status).toBe('resolved')
    expect(row.acknowledged).toBe(0)
  })

  it('resolving then acknowledging keeps the resolved status (ack does not reopen)', async () => {
    await recordNotification(createDatabase(), { notificationId: 'n-3', ...SOURCE, title: '已解决', now: T0 })
    await resolveNotification(createDatabase(), { ...SOURCE, now: T0 + 5 })
    const ack = await acknowledgeNotification(createDatabase(), { ...SOURCE, now: T0 + 10 })
    expect(ack.outcome).toBe('acknowledged')
    if (ack.outcome === 'acknowledged') {
      expect(ack.status).toBe('resolved')
    }
  })

  it('acknowledging an unrecorded source is not-found, not fabricated', async () => {
    const res = await acknowledgeNotification(createDatabase(), { sourceType: 'schedule', sourceId: 'nope', now: T0 })
    expect(res.outcome).toBe('not-found')
  })
})

describe('notification rebuild (重建)', () => {
  it('reconciles the D1 set against the wanted authoritative facts', async () => {
    // Seed a notification that will become unwanted.
    await recordNotification(createDatabase(), { notificationId: 'stale', sourceType: 'schedule', sourceId: 'gone', title: '旧', now: T0 })

    const rebuilt = await rebuildNotifications(createDatabase(), {
      wanted: [
        { sourceType: 'schedule', sourceId: 'live-1', title: '新排期' },
        { sourceType: 'schedule', sourceId: 'live-2', title: '新排期2' },
      ],
      now: T0 + 5,
    })
    expect(rebuilt.outcome).toBe('rebuilt')
    expect(rebuilt.recorded).toBe(2)
    // The old unwanted notification was resolved (not deleted).
    expect(rebuilt.resolved).toBe(1)

    const all = await listNotifications(createDatabase())
    expect(all).toHaveLength(3)
    expect(all.filter((n) => n.status === 'open')).toHaveLength(2)
    const gone = all.find((n) => n.source_id === 'gone')
    expect(gone?.status).toBe('resolved')
  })

  it('rebuild re-recording the same source does not duplicate it', async () => {
    await rebuildNotifications(createDatabase(), {
      wanted: [{ sourceType: 'schedule', sourceId: 'dup', title: 'X' }],
      now: T0,
    })
    const second = await rebuildNotifications(createDatabase(), {
      wanted: [{ sourceType: 'schedule', sourceId: 'dup', title: 'X' }],
      now: T0 + 5,
    })
    expect(second.recorded).toBe(0)
    const count = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM activity_notifications`))[0]?.c ?? 0
    expect(count).toBe(1)
  })
})

describe('notification race (竞态)', () => {
  it('concurrent resolve converges to a single resolved row', async () => {
    await recordNotification(createDatabase(), { notificationId: 'race', ...SOURCE, title: '竞态', now: T0 })
    const results = await Promise.all([
      resolveNotification(createDatabase(), { ...SOURCE, now: T0 + 1 }),
      resolveNotification(createDatabase(), { ...SOURCE, now: T0 + 2 }),
      resolveNotification(createDatabase(), { ...SOURCE, now: T0 + 3 }),
    ])
    const resolvedCount = results.filter((r) => r.outcome === 'resolved').length
    expect(resolvedCount).toBe(1)
    const row = (await query<{ status: string }>(
      `SELECT status FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.status).toBe('resolved')
  })

  it('concurrent record converges to a single row (source UNIQUE wins)', async () => {
    const results = await Promise.all([
      recordNotification(createDatabase(), { notificationId: 'r1', ...SOURCE, title: '并发1', now: T0 }),
      recordNotification(createDatabase(), { notificationId: 'r2', ...SOURCE, title: '并发2', now: T0 }),
      recordNotification(createDatabase(), { notificationId: 'r3', ...SOURCE, title: '并发3', now: T0 }),
    ])
    expect(results.filter((r) => r.outcome === 'recorded').length).toBe(1)
    expect(results.filter((r) => r.outcome === 'replayed').length).toBe(2)
    const count = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM activity_notifications`))[0]?.c ?? 0
    expect(count).toBe(1)
  })

  it('concurrent acknowledge converges (only one flips 0→1)', async () => {
    await recordNotification(createDatabase(), { notificationId: 'race-ack', ...SOURCE, title: '并发已知晓', now: T0 })
    const results = await Promise.all([
      acknowledgeNotification(createDatabase(), { ...SOURCE, now: T0 + 1 }),
      acknowledgeNotification(createDatabase(), { ...SOURCE, now: T0 + 2 }),
      acknowledgeNotification(createDatabase(), { ...SOURCE, now: T0 + 3 }),
    ])
    expect(results.filter((r) => r.outcome === 'acknowledged').length).toBe(1)
    const row = (await query<{ acknowledged: number }>(
      `SELECT acknowledged FROM activity_notifications WHERE source_type='schedule' AND source_id='sched-1'`,
    ))[0]
    expect(row.acknowledged).toBe(1)
  })
})
