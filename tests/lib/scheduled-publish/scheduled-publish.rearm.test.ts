/**
 * B4-01/B4-03 — scheduled-publish reliable-retry test (issues #40 + #42).
 *
 * A transient / core failure (the confirm kernel returns `aborted`) must NOT
 * go stale — the schedule is re-armed to `pending` with an incremented
 * attempt_count + sanitized last_error, and each failed execution records an
 * immutable attempt row. B4-03 adds the retry policy: a re-armed schedule is
 * only due again after its `next_attempt_at` backoff window, and each retry
 * opens a NEW attempt row while older rows stay untouched. Uses a mocked
 * confirmPublish that always aborts, isolating exactly this branch; the shared
 * in-process D1 keeps every state transition real.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootstrapScheduledState, createDatabase, createDraftArticle, freshSlug, query } from './helpers'

// A core failure during confirm must be retried, not marked stale.
vi.mock('@/lib/first-publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/first-publish')>()
  return {
    ...actual,
    confirmPublish: async () =>
      ({ outcome: 'aborted', articleId: 1, reason: 'test-abort: transient core failure' }) as Awaited<
        ReturnType<typeof actual.confirmPublish>
      >,
  }
})

// The kernel resolves these AFTER the mock is installed.
import { scanDueSchedules, schedulePublish } from '@/lib/scheduled-publish'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b401-scheduled-rearm-'))
  cleanup.push(state)
  await bootstrapScheduledState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

interface AttemptRowLite {
  attempt_no: number
  outcome: string | null
  finished_at: number | null
}

describe('scanDueSchedules — reliable retry on core failure', () => {
  it('re-arms a core failure to pending instead of stale, waits out the backoff, and retries', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-rearm'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-rearm',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    // Tick 1 — confirm aborts → retried, re-armed to pending with a backoff window.
    const first = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    expect(first).toMatchObject({ scanned: 1, claimed: 1, fired: 0, stale: 0, retried: 1, failed: 0 })

    let row = (
      await query<{ status: string; attempt_count: number; last_error: string | null; next_attempt_at: number | null }>(
        `SELECT status, attempt_count, last_error, next_attempt_at FROM publish_schedules WHERE schedule_id = 's-rearm'`,
      )
    )[0]
    expect(row.status).toBe('pending') // NOT stale — the tick's failure is transient
    expect(row.attempt_count).toBe(1)
    expect(row.last_error).toContain('test-abort')
    expect(row.next_attempt_at).toBe(T0 + 10 + 60) // default base backoff (60s)

    // No event was written by a failed confirm, and one immutable attempt exists.
    const ev = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
    expect(ev[0].c).toBe(0)
    let attempts = await query<AttemptRowLite>(
      `SELECT attempt_no, outcome, finished_at FROM publish_attempts WHERE schedule_id = 's-rearm'`,
    )
    expect(attempts).toEqual([{ attempt_no: 1, outcome: 'retried', finished_at: T0 + 10 }])

    // A duplicate tick inside the backoff window must NOT retry yet.
    const early = await scanDueSchedules(createDatabase(), { now: T0 + 10 + 59, siteUrl: 'https://blog.example.test' })
    expect(early).toMatchObject({ scanned: 0, claimed: 0, fired: 0, stale: 0, retried: 0, failed: 0 })

    // Tick 2 — the backoff window has elapsed → the same minute's catch-up retries.
    const second = await scanDueSchedules(createDatabase(), { now: T0 + 10 + 60, siteUrl: 'https://blog.example.test' })
    expect(second).toMatchObject({ scanned: 1, claimed: 1, fired: 0, retried: 1 })

    row = (
      await query<{ status: string; attempt_count: number; last_error: string | null; next_attempt_at: number | null }>(
        `SELECT status, attempt_count, last_error, next_attempt_at FROM publish_schedules WHERE schedule_id = 's-rearm'`,
      )
    )[0]
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(2)

    // The retry APPENDED a new attempt row — the old row is untouched (immutable).
    attempts = await query<AttemptRowLite>(
      `SELECT attempt_no, outcome, finished_at FROM publish_attempts WHERE schedule_id = 's-rearm' ORDER BY attempt_no`,
    )
    expect(attempts).toEqual([
      { attempt_no: 1, outcome: 'retried', finished_at: T0 + 10 },
      { attempt_no: 2, outcome: 'retried', finished_at: T0 + 10 + 60 },
    ])
  })
})