/**
 * B4-03 — scheduled-publish retry / lease / immutable-attempt suite (issue #42).
 *
 * Durable execution facts over the B4-01 scan kernel, all on the shared
 * in-process Miniflare D1 with frozen epoch-second clocks:
 *
 *   - 并发抢租约只赢一家  truly concurrent scans at the same instant converge on
 *            exactly ONE lease winner (per-claim `lease_token`) and one event,
 *   - 重试上限后停        transient failures retry under a cap + exponential
 *            backoff (`next_attempt_at`), then the schedule STOPS as an author
 *            todo (`retries-exhausted` stale) and never misfires,
 *   - attempt 不可变       old rows are never modified — retries only append; a
 *            crashed run is abandoned on lease reclaim; terminal rows survive
 *            idle scans byte-for-byte,
 *   - 错误脱敏            secrets never reach attempt/schedule error facts,
 *   - lease 领取/心跳/过期回收 heartbeat extends an owned lease; a reclaimed
 *            lease is lost for the old runner (token rotation).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapScheduledState,
  createDatabase,
  createDraftArticle,
  freshSlug,
  query,
} from './helpers'
import { ensureScheduledPublishTables } from '@/lib/scheduled-publish/ddl'
import {
  cancelSchedule,
  heartbeatScheduleLease,
  sanitizeError,
  scanDueSchedules,
  schedulePublish,
} from '@/lib/scheduled-publish'
import { confirmPublish } from '@/lib/first-publish'

// confirmPublish is wrapped so tests can inject abort / crash behaviors while
// the real kernel remains the default implementation. Between tests the mock
// is restored to the real kernel (concrete `mockImplementation` calls would
// otherwise leak across tests — vitest's `clearMocks` only clears calls).
const mocked = vi.hoisted(() => ({ realConfirm: undefined as unknown }))
vi.mock('@/lib/first-publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/first-publish')>()
  mocked.realConfirm = actual.confirmPublish
  return { ...actual, confirmPublish: vi.fn(actual.confirmPublish) }
})

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []
const siteUrl = 'https://blog.example.test'

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b403-publish-attempts-'))
  cleanup.push(state)
  await bootstrapScheduledState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.mocked(confirmPublish).mockImplementation(mocked.realConfirm as typeof confirmPublish)
  await createDatabase().prepare('DELETE FROM publish_attempts').run()
  await createDatabase().prepare('DELETE FROM publish_schedules').run()
})

function abortResult(articleId: number, reason: string) {
  return { outcome: 'aborted', articleId, reason } as const
}

async function countEvents(articleId: number): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
  return rows[0]?.c ?? 0
}

interface AttemptRowLite {
  attempt_no: number
  outcome: string | null
  error: string | null
  finished_at: number | null
}

function scheduleRow(scheduleId: string) {
  return query<{
    status: string
    attempt_count: number
    stale_reason: string | null
    next_attempt_at: number | null
    last_error: string | null
  }>(`SELECT status, attempt_count, stale_reason, next_attempt_at, last_error FROM publish_schedules WHERE schedule_id = '${scheduleId}'`)
}

function attemptsOf(scheduleId: string) {
  return query<AttemptRowLite>(
    `SELECT attempt_no, outcome, error, finished_at FROM publish_attempts WHERE schedule_id = '${scheduleId}' ORDER BY attempt_no`,
  )
}

/* ------------------------------------------------------------------ */
/* additive DDL migration                                              */
/* ------------------------------------------------------------------ */

describe('additive DDL migration (B4-03 over a B4-01 install)', () => {
  it('upgrades an existing publish_schedules with the new columns and never drops facts', async () => {
    // Rebuild the table in its exact B4-01 shape (no revision / next_attempt_at /
    // lease_token, no publish_attempts) and plant a terminal fired row.
    await createDatabase().prepare('DROP TABLE IF EXISTS publish_attempts').run()
    await createDatabase().prepare('DROP TABLE publish_schedules').run()
    await createDatabase()
      .prepare(
        `CREATE TABLE publish_schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
          article_id INTEGER NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
          timezone TEXT NOT NULL CHECK(length(timezone) > 0),
          status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'fired', 'stale', 'cancelled')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          claimed_at INTEGER,
          lease_expires_at INTEGER,
          stale_reason TEXT,
          fired_event_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT`,
      )
      .run()
    await createDatabase()
      .prepare(`CREATE INDEX idx_publish_schedules_due ON publish_schedules(status, scheduled_at)`)
      .run()
    await createDatabase()
      .prepare(
        `INSERT INTO publish_schedules
           (schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, fired_event_id, created_at, updated_at)
         VALUES ('s-old-install', 1, 1, ?, 'Asia/Shanghai', 'fired', 1, 'ev-old', ?, ?)`,
      )
      .bind(T0, T0, T0)
      .run()

    await ensureScheduledPublishTables(createDatabase())

    // The existing fired fact is retained untouched.
    const kept = (
      await query<{ status: string; fired_event_id: string | null }>(
        `SELECT status, fired_event_id FROM publish_schedules WHERE schedule_id = 's-old-install'`,
      )
    )[0]
    expect(kept).toEqual({ status: 'fired', fired_event_id: 'ev-old' })

    // The B4-03 shape is present: new columns + the attempt table + index.
    const columns = await query<{ name: string }>('PRAGMA table_info(publish_schedules)')
    const names = new Set(columns.map((row) => row.name))
    expect([...names]).toEqual(expect.arrayContaining(['revision', 'next_attempt_at', 'lease_token']))
    const attemptsExists = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'publish_attempts'`,
    )
    expect(attemptsExists[0].c).toBe(1)
    expect(await attemptsOf('s-old-install')).toEqual([])

    // Re-running the channel is a no-op (idempotent).
    await ensureScheduledPublishTables(createDatabase())
    const columnsAgain = await query<{ name: string }>('PRAGMA table_info(publish_schedules)')
    expect(new Set(columnsAgain.map((row) => row.name))).toEqual(names)
  })
})

/* ------------------------------------------------------------------ */
/* concurrent lease — one winner                                      */
/* ------------------------------------------------------------------ */

describe('lease contention (并发抢租约只赢一家)', () => {
  it('two concurrent scans at the same instant produce exactly one claim, one event and one attempt', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-contend'))
    const scheduleId = `s-contend-${slug}`
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    const [first, second] = await Promise.all([
      scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl }),
      scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl }),
    ])

    expect(first.claimed + second.claimed).toBe(1) // lease: only one winner
    expect(first.fired + second.fired).toBe(1)
    expect(first.failed + second.failed).toBe(0)
    expect(first.stale + second.stale).toBe(0)
    const attempts = await attemptsOf(scheduleId)
    expect(attempts.map((a) => a.outcome)).toEqual(['fired']) // one immutable attempt
    expect(await countEvents(articleId)).toBe(1) // duplicate wake, one result
  })
})

/* ------------------------------------------------------------------ */
/* retry policy — cap + backoff                                       */
/* ------------------------------------------------------------------ */

describe('retry cap + backoff (重试上限后停)', () => {
  it('retries with exponential backoff and stops once the cap is exhausted', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-cap'))
    const scheduleId = 's-cap'
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    vi.mocked(confirmPublish).mockImplementation(async () =>
      abortResult(articleId, 'crash: transient provider outage'),
    )

    const base = { siteUrl, maxAttempts: 3, retryBackoffSeconds: 10 }
    // Attempt 1 → re-armed, next retry at T0+10+10.
    const first = await scanDueSchedules(createDatabase(), { ...base, now: T0 + 10 })
    expect(first).toMatchObject({ scanned: 1, claimed: 1, fired: 0, stale: 0, retried: 1, failed: 0 })
    let row = (await scheduleRow(scheduleId))[0]
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(1)
    expect(row.next_attempt_at).toBe(T0 + 20)

    // Inside the backoff window nothing is due (duplicate ticks stay quiet).
    const within = await scanDueSchedules(createDatabase(), { ...base, now: T0 + 15 })
    expect(within).toMatchObject({ scanned: 0, claimed: 0, retried: 0 })

    // Attempt 2 at T0+20 → backoff doubles to 20s (next at T0+40).
    const second = await scanDueSchedules(createDatabase(), { ...base, now: T0 + 20 })
    expect(second).toMatchObject({ scanned: 1, claimed: 1, retried: 1 })
    row = (await scheduleRow(scheduleId))[0]
    expect(row.attempt_count).toBe(2)
    expect(row.next_attempt_at).toBe(T0 + 40)

    // Attempt 3 reaches the cap → the schedule STOPS retrying (author todo).
    const third = await scanDueSchedules(createDatabase(), { ...base, now: T0 + 40 })
    expect(third).toMatchObject({ scanned: 1, claimed: 1, fired: 0, stale: 0, retried: 0, failed: 1 })
    row = (await scheduleRow(scheduleId))[0]
    expect(row.status).toBe('stale')
    expect(row.stale_reason).toContain('retries-exhausted')
    expect(row.attempt_count).toBe(3)

    // Terminal: further scans never touch it again, and no event ever fired.
    const later = await scanDueSchedules(createDatabase(), { ...base, now: T0 + 1000 })
    expect(later).toMatchObject({ scanned: 0, claimed: 0, fired: 0, retried: 0, failed: 0 })
    expect(await countEvents(articleId)).toBe(0)

    // Classification per attempt: two retried + one failed, all with errors.
    const attempts = await attemptsOf(scheduleId)
    expect(attempts.map((a) => a.outcome)).toEqual(['retried', 'retried', 'failed'])
    expect(attempts.every((a) => a.error !== null)).toBe(true)
  })

  it('rearms only when the cap is not reached', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-cap-ok'))
    const scheduleId = 's-cap-ok'
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    vi.mocked(confirmPublish).mockImplementation(async () => abortResult(articleId, 'boom'))

    const first = await scanDueSchedules(createDatabase(), { now: T0 + 10 })
    expect(first.retried).toBe(1)
    const second = await scanDueSchedules(createDatabase(), { now: T0 + 70 }) // base backoff 60s
    expect(second.retried).toBe(1) // still under the default cap of 5
    expect((await scheduleRow(scheduleId))[0].attempt_count).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* immutable attempts + idempotent repeated scans                     */
/* ------------------------------------------------------------------ */

describe('attempt immutability (旧不改新追加) + repeated-scan idempotency', () => {
  it('old attempt rows are never modified — retries append, and idle scans change nothing', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-immutable'))
    const scheduleId = `s-immutable-${slug}`
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    vi.mocked(confirmPublish)
      .mockImplementationOnce(async () => abortResult(articleId, 'boom-one'))
      .mockImplementationOnce(async () => abortResult(articleId, 'boom-two'))

    const first = await scanDueSchedules(createDatabase(), { now: T0 + 10, retryBackoffSeconds: 10 })
    expect(first.retried).toBe(1)
    const row1 = await attemptsOf(scheduleId)

    // Retry 2 appends a new row; row 1 (old) is byte-for-byte untouched.
    const second = await scanDueSchedules(createDatabase(), { now: T0 + 20, retryBackoffSeconds: 10 })
    expect(second.retried).toBe(1)
    const afterSecond = await attemptsOf(scheduleId)
    expect(afterSecond.length).toBe(2)
    expect(afterSecond[0]).toEqual(row1[0])
    expect(afterSecond[1].outcome).toBe('retried')

    // Retry 3 succeeds for real → fired; the two old rows are still untouched.
    const third = await scanDueSchedules(createDatabase(), { now: T0 + 40, retryBackoffSeconds: 10 })
    expect(third.fired).toBe(1)
    const finalRows = await attemptsOf(scheduleId)
    expect(finalRows.map((a) => a.outcome)).toEqual(['retried', 'retried', 'fired'])
    expect(finalRows[0]).toEqual(row1[0])

    // Repeated scans of an already-terminal schedule: no new attempts, no new
    // events, and the recorded attempt facts never change (Cron 重复扫描幂等).
    const snapshot = JSON.stringify(await attemptsOf(scheduleId))
    for (let tick = 0; tick < 3; tick += 1) {
      const idle = await scanDueSchedules(createDatabase(), { now: T0 + 1000 + tick })
      expect(idle.scanned).toBe(0)
    }
    expect(JSON.stringify(await attemptsOf(scheduleId))).toBe(snapshot)
    expect(await countEvents(articleId)).toBe(1)
  })

  it('a crashed runner is abandoned on lease reclaim and the schedule converges to one event', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-crash'))
    const scheduleId = `s-crash-${slug}`
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    // The runner crashes mid-confirm: the scan throws, the attempt stays
    // `running`, the lease is held until it expires.
    vi.mocked(confirmPublish).mockImplementationOnce(async () => {
      throw new Error('worker died mid-confirm')
    })
    await expect(scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl })).rejects.toThrow('worker died')

    let attempts = await attemptsOf(scheduleId)
    expect(attempts.length).toBe(1)
    expect(attempts[0].finished_at).toBeNull() // still running — never finalized by the crash
    let row = (await scheduleRow(scheduleId))[0]
    expect(row.status).toBe('claimed')

    // After the (default 600s) lease lapses, the next tick reclaims: the crashed
    // attempt is finalized `abandoned` (immutable) and a NEW attempt delivers.
    const reclaim = await scanDueSchedules(createDatabase(), { now: T0 + 611, siteUrl })
    expect(reclaim).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })

    attempts = await attemptsOf(scheduleId)
    expect(attempts.map((a) => a.outcome)).toEqual(['abandoned', 'fired'])
    expect(attempts[0].finished_at).not.toBeNull()
    row = (await scheduleRow(scheduleId))[0]
    expect(row.status).toBe('fired')
    expect(await countEvents(articleId)).toBe(1) // crash + reclaim still yields exactly one event
  })
})

/* ------------------------------------------------------------------ */
/* error sanitization (日志脱敏)                                        */
/* ------------------------------------------------------------------ */

describe('error sanitization (错误脱敏)', () => {
  it('records only sanitized errors on attempts and the schedule — secrets never persist', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-sane'))
    const scheduleId = 's-sane'
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    vi.mocked(confirmPublish).mockImplementation(async () =>
      abortResult(
        articleId,
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig password=hunter2 api_key=sk-live-abc https://user:p%40ss@example.com/x',
      ),
    )

    // maxAttempts 1 → the sanitized reason lands in the terminal attempt + last_error.
    const scan = await scanDueSchedules(createDatabase(), { now: T0 + 10, maxAttempts: 1 })
    expect(scan.failed).toBe(1)

    const attempt = (await attemptsOf(scheduleId))[0]
    expect(attempt.error).toContain('[REDACTED]')
    expect(attempt.error).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(attempt.error).not.toContain('hunter2')
    expect(attempt.error).not.toContain('sk-live-abc')
    expect(attempt.error).not.toContain('p%40ss')

    const row = (await scheduleRow(scheduleId))[0]
    expect(row.last_error).toContain('[REDACTED]')
    expect(row.last_error).not.toContain('hunter2')
    expect(row.last_error).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('sanitizeError redacts bearer tokens, key=value secrets and URL credentials', () => {
    expect(sanitizeError('Bearer abc.def.ghi password=x')).toBe('Bearer [REDACTED] password=[REDACTED]')
    expect(sanitizeError('token=abc123 secret=xyz api_key=sk-live')).toContain('token=[REDACTED]')
    expect(sanitizeError('token=abc123 secret=xyz api_key=sk-live')).not.toContain('abc123')
    expect(sanitizeError('https://user:p%40ss@example.com/x')).toBe('https://[REDACTED]@example.com/x')
    expect(sanitizeError('x'.repeat(1000)).length).toBeLessThanOrEqual(500)
  })
})

/* ------------------------------------------------------------------ */
/* lease heartbeat + expiry reclaim                                   */
/* ------------------------------------------------------------------ */

describe('lease heartbeat (领取/心跳/过期回收)', () => {
  it('heartbeat extends an owned lease; a reclaimed lease is lost for the old runner', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-hb'))
    const scheduleId = 's-hb'
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    // Simulate THIS runner holding a claim (lease token + no expiry yet).
    await createDatabase()
      .prepare(
        `UPDATE publish_schedules SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, lease_token = ?, updated_at = ?
         WHERE schedule_id = ?`,
      )
      .bind(T0, T0 + 600, 'tok-runner-a', T0, scheduleId)
      .run()

    const extended = await heartbeatScheduleLease(createDatabase(), {
      scheduleId,
      leaseToken: 'tok-runner-a',
      now: T0 + 60,
    })
    expect(extended).toMatchObject({ outcome: 'extended', leaseExpiresAt: T0 + 660 })
    expect((await scheduleRow(scheduleId))[0].next_attempt_at).toBeNull() // untouched by heartbeat

    // The lease lapses; the next scan reclaims under a NEW token and fires.
    const reclaim = await scanDueSchedules(createDatabase(), { now: T0 + 700, siteUrl })
    expect(reclaim).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })

    // The old runner's heartbeat can no longer resurrect the reclaimed lease.
    const lost = await heartbeatScheduleLease(createDatabase(), {
      scheduleId,
      leaseToken: 'tok-runner-a',
      now: T0 + 700,
    })
    expect(lost).toMatchObject({ outcome: 'lost', reason: 'reclaimed' })
    const row = (await query<{ fired_event_id: string | null }>(
      `SELECT fired_event_id FROM publish_schedules WHERE schedule_id = '${scheduleId}'`,
    ))[0]
    expect(row.fired_event_id).toBeTruthy()
  })

  it('rejects heartbeat for an unknown / never-claimed schedule', async () => {
    const missing = await heartbeatScheduleLease(createDatabase(), {
      scheduleId: 's-no-such',
      leaseToken: 'tok-x',
      now: T0,
    })
    expect(missing).toMatchObject({ outcome: 'lost', reason: 'not-claimed' })
  })
})

/* ------------------------------------------------------------------ */
/* cancellation of a claimed execution                                 */
/* ------------------------------------------------------------------ */

describe('cancelSchedule over a claimed attempt', () => {
  it('cancelling a claimed row finalizes its running attempt as cancelled', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-cancel-run'))
    const scheduleId = 's-cancel-run'
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    // Runner holds the claim (attempt_count already bumped at claim time) and
    // its attempt row is mid-flight.
    await createDatabase()
      .prepare(
        `UPDATE publish_schedules SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, lease_token = ?, attempt_count = 1, updated_at = ?
         WHERE schedule_id = ?`,
      )
      .bind(T0, T0 + 600, 'tok-cancel', T0, scheduleId)
      .run()
    await createDatabase()
      .prepare(
        `INSERT INTO publish_attempts (attempt_key, schedule_id, attempt_no, started_at, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .bind('sched-attempt:s-cancel-run:1', scheduleId, T0, T0, T0)
      .run()

    const res = await cancelSchedule(createDatabase(), { scheduleId, actor: 'author', now: T0 + 1 })
    expect(res).toMatchObject({ outcome: 'cancelled', scheduleId })

    const row = (await scheduleRow(scheduleId))[0]
    expect(row.status).toBe('cancelled')
    const attempt = (await attemptsOf(scheduleId))[0]
    expect(attempt.outcome).toBe('cancelled')
    expect(attempt.finished_at).toBe(T0 + 1)
    expect(await countEvents(articleId)).toBe(0) // no misfire on mute
  })
})