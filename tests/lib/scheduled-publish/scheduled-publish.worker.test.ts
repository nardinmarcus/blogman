/**
 * B4-01 — scheduled-publish Cron-wake contract (issue #40).
 *
 * `runScheduledPublishScan` is the exact command the worker's `scheduled`
 * handler (and therefore the later batch's Cron `[triggers]` entry) invokes
 * every minute. This suite proves the wake contract end-to-end against a real
 * D1 binding — proving "scheduled 契约调用同一命令":
 *
 *   - a missing DB binding disables the scan without throwing (`skipped`),
 *   - a present DB binding wakes the SAME `scanDueSchedules` command the
 *     kernel suite exercises, and a due schedule publishes exactly once.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapScheduledState, createDatabase, createDraftArticle, freshSlug, query } from './helpers'
import { runScheduledPublishScan } from '@/lib/scheduled-publish/scheduled'
import { schedulePublish } from '@/lib/scheduled-publish'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b401-scheduled-wake-'))
  cleanup.push(state)
  await bootstrapScheduledState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('runScheduledPublishScan (the Cron wake contract)', () => {
  it('skips cleanly when the DB binding is absent (zero production, never throws)', async () => {
    const run = await runScheduledPublishScan({})
    expect(run.skipped).toBe(true)
    expect(run.reason).toContain('DB unavailable')
    expect(run.result).toBeUndefined()
  })

  it('wakes the same D1 scan command and fires a due schedule exactly once', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-wake'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-wake',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    const run = await runScheduledPublishScan(
      { DB: createDatabase(), NEXT_PUBLIC_SITE_URL: 'https://blog.example.test' },
      { now: T0 + 10 },
    )
    expect(run.skipped).toBe(false)
    expect(run.result).toMatchObject({ scanned: 1, claimed: 1, fired: 1, stale: 0 })

    const row = (
      await query<{ status: string; fired_event_id: string | null }>(
        `SELECT status, fired_event_id FROM publish_schedules WHERE schedule_id = 's-wake'`,
      )
    )[0]
    expect(row.status).toBe('fired')
    expect(row.fired_event_id).toBeTruthy()

    const ev = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
    expect(ev[0].c).toBe(1)
  })

  it('a disabled executor skips without touching tasks or attempts, and converges after re-enable', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-disabled'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-disabled',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    const wait = { now: T0 + 10 }
    const disabled = await runScheduledPublishScan(
      { DB: createDatabase(), SCHEDULED_PUBLISH_DISABLED: '1', NEXT_PUBLIC_SITE_URL: 'https://blog.example.test' },
      wait,
    )
    expect(disabled.skipped).toBe(true)
    expect(disabled.reason).toContain('disabled')

    // Task fact retained untouched — no attempt was ever opened.
    const row = (
      await query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM publish_schedules WHERE schedule_id = 's-disabled'`,
      )
    )[0]
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(0)
    const attemptCount = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM publish_attempts WHERE schedule_id = 's-disabled'`,
    )
    expect(attemptCount[0].c).toBe(0)
    const events = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
    expect(events[0].c).toBe(0)

    // Re-enabled: the same wake converges to exactly one event.
    const enabled = await runScheduledPublishScan(
      { DB: createDatabase(), NEXT_PUBLIC_SITE_URL: 'https://blog.example.test' },
      wait,
    )
    expect(enabled.skipped).toBe(false)
    expect(enabled.result).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })
    const after = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
    expect(after[0].c).toBe(1)
  })
})
