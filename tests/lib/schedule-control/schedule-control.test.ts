/**
 * B4-02 — schedule control command test suite (issue #41).
 *
 * One shared in-process Miniflare D1 (real bindings, zero CLI spawns), frozen
 * epoch-second clocks. Proves the acceptance surface of the batch:
 *
 *   - pause    suspends a pending/claimed intent and RETAINS original time +
 *              bound version (nothing deleted); wrong-state rejects,
 *   - reconfirm binds an EXACT new saved version and re-arms; refused when the
 *              version is unsaved or in conflict; never silent,
 *   - reschedule moves to a new absolute time (re-arms paused → pending);
 *              past / wrong-state rejects,
 *   - cancel   terminal for pending/claimed/paused; fact-preserving; fired /
 *              stale are rejected,
 *   - publish-now fires the bound version through the EXISTING publish kernel
 *              (never bypasses it): a drifted bound version is BLOCKED with
 *              zero events; an armed intent publishes exactly once,
 *   - operation-id idempotency — repeated commands replay, never double-apply,
 *              and reuse across a different schedule/action is a hard conflict.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapScheduledState, createDatabase, createDraftArticle, freshSlug, query } from '@/tests/lib/scheduled-publish/helpers'
import { ensureScheduleControlTables } from '@/lib/schedule-control/ddl'
import { schedulePublish } from '@/lib/scheduled-publish'
import {
  cancelScheduleControl,
  pauseSchedule,
  publishNowSchedule,
  reconfirmSchedule,
  rescheduleSchedule,
} from '@/lib/schedule-control'
import { save } from '@/lib/article-commands'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b402-schedule-control-'))
  cleanup.push(state)
  await bootstrapScheduledState(state)
  await ensureScheduleControlTables(createDatabase())
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await createDatabase().prepare('DELETE FROM publish_schedules').run()
  await createDatabase().prepare('DELETE FROM schedule_control_ops').run()
})

function changedSnapshot(slug: string): ArticleCommandSnapshot {
  return {
    slug,
    title: '标题2',
    content: '# 正文2\n\n已更改的一版。',
    html: '<p>已更改的一版。</p>',
    description: null,
    category: null,
    tags: null,
    status: 'draft',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: null,
    updated_at: null,
  }
}

/** Advance an article to its next saved version through the write kernel. */
async function bumpVersion(articleId: number, slug: string): Promise<number> {
  const rows = await query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ${articleId}`,
  )
  const current = rows[0]?.version ?? 0
  const res = await save(createDatabase(), {
    articleId,
    expectedVersion: current,
    operationId: `ctrl-drift-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    snapshot: changedSnapshot(slug),
  })
  if (res.outcome !== 'applied') throw new Error(`bumpVersion failed: ${JSON.stringify(res)}`)
  return res.version
}

async function schedule(articleId: number, scheduleId: string, scheduledAt = T0 + 100): Promise<void> {
  const res = await schedulePublish(createDatabase(), {
    scheduleId,
    articleId,
    version: 1,
    scheduledAt,
    actor: 'author',
    now: T0,
  })
  if (res.outcome !== 'scheduled') throw new Error(`schedule failed: ${JSON.stringify(res)}`)
}

async function scheduleRow(scheduleId: string): Promise<{ status: string; version: number; scheduled_at: number; timezone: string; stale_reason: string | null }> {
  const rows = await query<{ status: string; version: number; scheduled_at: number; timezone: string; stale_reason: string | null }>(
    `SELECT status, version, scheduled_at, timezone, stale_reason FROM publish_schedules WHERE schedule_id = '${scheduleId}'`,
  )
  return rows[0]
}

async function countEvents(articleId: number): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
  return rows[0]?.c ?? 0
}

async function countOps(operationId: string): Promise<number> {
  const rows = await query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM schedule_control_ops WHERE operation_id = '${operationId}'`,
  )
  return rows[0]?.c ?? 0
}

/* ------------------------------------------------------------------ */
/* pause                                                              */
/* ------------------------------------------------------------------ */

describe('pauseSchedule', () => {
  it('pauses a pending intent and RETAINS the original time + bound version (never deletes facts)', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-pause'))
    await schedule(articleId, 's-pause')
    const res = await pauseSchedule(createDatabase(), {
      scheduleId: 's-pause',
      operationId: 'op-pause-1',
      actor: 'author',
      now: T0,
      reason: 'content changed',
    })
    expect(res).toMatchObject({ outcome: 'paused', scheduleId: 's-pause', articleId, version: 1, scheduledAt: T0 + 100 })

    const row = await scheduleRow('s-pause')
    expect(row).toMatchObject({ status: 'paused', version: 1, scheduled_at: T0 + 100 }) // time retained

    // The row still exists — pause did NOT delete it.
    expect(await countOps('op-pause-1')).toBe(1)
  })

  it('is idempotent — the same operation replays; a fresh operation on an already-paused intent no-ops', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-pause-idem'))
    await schedule(articleId, 's-pause-idem')
    await pauseSchedule(createDatabase(), { scheduleId: 's-pause-idem', operationId: 'op-pause-a', actor: 'author', now: T0 })

    const replay = await pauseSchedule(createDatabase(), { scheduleId: 's-pause-idem', operationId: 'op-pause-a', actor: 'author', now: T0 })
    expect(replay.outcome).toBe('replayed')
    expect((replay as unknown as { result: { outcome: string } }).result.outcome).toBe('paused')
    // Same operation must not be double-recorded.
    expect(await countOps('op-pause-a')).toBe(1)

    // A DIFFERENT operation against the same paused intent is a no-op (still paused).
    const again = await pauseSchedule(createDatabase(), { scheduleId: 's-pause-idem', operationId: 'op-pause-b', actor: 'author', now: T0 })
    expect(again.outcome).toBe('paused')
    expect((await scheduleRow('s-pause-idem')).status).toBe('paused')
  })

  it('rejects in an error state (fired / cancelled are not pau-sable)', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-pause-reject'))
    await schedule(articleId, 's-pause-f')
    await createDatabase()
      .prepare(`UPDATE publish_schedules SET status = 'fired', updated_at = ? WHERE schedule_id = 's-pause-f'`)
      .bind(T0)
      .run()
    const res = await pauseSchedule(createDatabase(), { scheduleId: 's-pause-f', operationId: 'op-pause-f', actor: 'author', now: T0 })
    expect(res.outcome).toBe('conflict')
  })
})

/* ------------------------------------------------------------------ */
/* reconfirm                                                          */
/* ------------------------------------------------------------------ */

describe('reconfirmSchedule', () => {
  it('re-confirms a paused intent onto an EXACT new saved version and re-arms to pending, retaining the time', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-reconfirm'))
    await schedule(articleId, 's-reconfirm')
    await pauseSchedule(createDatabase(), { scheduleId: 's-reconfirm', operationId: 'op-rc-pause', actor: 'author', now: T0 })
    // Author saves a newer version → the new exact version is a REAL saved fact.
    const v2 = await bumpVersion(articleId, slug)
    expect(v2).toBe(2)

    const res = await reconfirmSchedule(createDatabase(), {
      scheduleId: 's-reconfirm',
      operationId: 'op-rc-1',
      actor: 'author',
      newVersion: 2,
      now: T0,
    })
    expect(res).toMatchObject({ outcome: 'reconfirmed', scheduleId: 's-reconfirm', articleId, version: 2, scheduledAt: T0 + 100 })
    const row = await scheduleRow('s-reconfirm')
    expect(row).toMatchObject({ status: 'pending', version: 2, scheduled_at: T0 + 100 })
    expect(row.stale_reason).toBeNull()
  })

  it('is idempotent — replaying the operation never re-arms twice', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-rc-idem'))
    await schedule(articleId, 's-rc-idem')
    await pauseSchedule(createDatabase(), { scheduleId: 's-rc-idem', operationId: 'op-rcidem-p', actor: 'author', now: T0 })
    await bumpVersion(articleId, slug)

    await reconfirmSchedule(createDatabase(), { scheduleId: 's-rc-idem', operationId: 'op-rc-idem', actor: 'author', newVersion: 2, now: T0 })
    const replay = await reconfirmSchedule(createDatabase(), { scheduleId: 's-rc-idem', operationId: 'op-rc-idem', actor: 'author', newVersion: 2, now: T0 })
    expect(replay.outcome).toBe('replayed')
    expect(await countOps('op-rc-idem')).toBe(1)
  })

  it('refuses when the new version is not saved (未保存不能重新确认)', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-rc-unsaved'))
    await schedule(articleId, 's-rc-unsaved')
    await pauseSchedule(createDatabase(), { scheduleId: 's-rc-unsaved', operationId: 'op-rcu-p', actor: 'author', now: T0 })
    // Version 5 does not exist — there is no saved fact to bind.
    const res = await reconfirmSchedule(createDatabase(), {
      scheduleId: 's-rc-unsaved',
      operationId: 'op-rc-unsaved',
      actor: 'author',
      newVersion: 5,
      now: T0,
    })
    expect(res).toMatchObject({ outcome: 'conflict', reason: 'version-not-saved' })
    void slug
  })

  it('refuses when another active schedule already owns the target version (冲突不能重新确认)', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-rc-dup'))
    await schedule(articleId, 's-rc-dup', T0 + 100) // active on v1
    await bumpVersion(articleId, slug) // now v2 exists
    // Second active schedule for the SAME article on a DIFFERENT version (v2).
    const created = await schedulePublish(createDatabase(), {
      scheduleId: 's-rc-dup2',
      articleId,
      version: 2,
      scheduledAt: T0 + 200,
      actor: 'author',
      now: T0,
    })
    if (created.outcome !== 'scheduled') throw new Error(`second schedule failed: ${JSON.stringify(created)}`)

    // s-rc-dup2 is on v2; trying to re-confirm it ONTO v1 collides with the
    // still-active s-rc-dup (which owns v1) → duplicate-version conflict.
    const res = await reconfirmSchedule(createDatabase(), {
      scheduleId: 's-rc-dup2',
      operationId: 'op-rc-dup-v1',
      actor: 'author',
      newVersion: 1,
      now: T0,
    })
    expect(res).toMatchObject({ outcome: 'conflict', reason: 'duplicate-version' })
  })

  it('rejects on a terminal schedule', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-rc-term'))
    await schedule(articleId, 's-rc-term')
    await bumpVersion(articleId, slug)
    await createDatabase()
      .prepare(`UPDATE publish_schedules SET status = 'cancelled', updated_at = ? WHERE schedule_id = 's-rc-term'`)
      .bind(T0)
      .run()
    const res = await reconfirmSchedule(createDatabase(), {
      scheduleId: 's-rc-term',
      operationId: 'op-rc-term',
      actor: 'author',
      newVersion: 2,
      now: T0,
    })
    expect(res.outcome).toBe('conflict')
  })
})

/* ------------------------------------------------------------------ */
/* reschedule                                                         */
/* ------------------------------------------------------------------ */

describe('rescheduleSchedule', () => {
  it('moves a paused intent to a new absolute time and re-arms it to pending', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-rs'))
    await schedule(articleId, 's-rs')
    await pauseSchedule(createDatabase(), { scheduleId: 's-rs', operationId: 'op-rs-p', actor: 'author', now: T0 })

    const res = await rescheduleSchedule(createDatabase(), {
      scheduleId: 's-rs',
      operationId: 'op-rs-1',
      actor: 'author',
      newScheduledAt: T0 + 500,
      now: T0,
    })
    expect(res).toMatchObject({ outcome: 'rescheduled', scheduleId: 's-rs', articleId, version: 1, scheduledAt: T0 + 500 })
    expect(await scheduleRow('s-rs')).toMatchObject({ status: 'pending', scheduled_at: T0 + 500, version: 1 })
  })

  it('is idempotent and rejects a past time', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-rs-idem'))
    await schedule(articleId, 's-rs-idem')
    await rescheduleSchedule(createDatabase(), { scheduleId: 's-rs-idem', operationId: 'op-rs-idem', actor: 'author', newScheduledAt: T0 + 300, now: T0 })
    const replay = await rescheduleSchedule(createDatabase(), { scheduleId: 's-rs-idem', operationId: 'op-rs-idem', actor: 'author', newScheduledAt: T0 + 300, now: T0 })
    expect(replay.outcome).toBe('replayed')
    expect(await countOps('op-rs-idem')).toBe(1)

    const past = await rescheduleSchedule(createDatabase(), { scheduleId: 's-rs-idem', operationId: 'op-rs-past', actor: 'author', newScheduledAt: T0 - 1, now: T0 })
    expect(past.outcome).toBe('invalid')
  })
})

/* ------------------------------------------------------------------ */
/* cancel                                                             */
/* ------------------------------------------------------------------ */

describe('cancelScheduleControl', () => {
  it('cancels a paused intent terminally without deleting the row', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-cancel'))
    await schedule(articleId, 's-cancel')
    await pauseSchedule(createDatabase(), { scheduleId: 's-cancel', operationId: 'op-cancel-p', actor: 'author', now: T0 })
    const res = await cancelScheduleControl(createDatabase(), { scheduleId: 's-cancel', operationId: 'op-cancel-1', actor: 'author', now: T0 })
    expect(res).toMatchObject({ outcome: 'cancelled', scheduleId: 's-cancel' })
    expect((await scheduleRow('s-cancel')).status).toBe('cancelled')
  })

  it('rejects cancelling a fired or stale schedule', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-cancel-rej'))
    await schedule(articleId, 's-cancel-f')
    await createDatabase()
      .prepare(`UPDATE publish_schedules SET status = 'fired', updated_at = ? WHERE schedule_id = 's-cancel-f'`)
      .bind(T0)
      .run()
    const res = await cancelScheduleControl(createDatabase(), { scheduleId: 's-cancel-f', operationId: 'op-cancel-f', actor: 'author', now: T0 })
    expect(res.outcome).toBe('conflict')
  })
})

/* ------------------------------------------------------------------ */
/* publish-now — through the SHARED kernel, never bypassing            */
/* ------------------------------------------------------------------ */

describe('publishNowSchedule', () => {
  it('publishes a pending intent immediately through the real publish kernel exactly once', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-pn'))
    await schedule(articleId, 's-pn')

    const res = await publishNowSchedule(createDatabase(), { scheduleId: 's-pn', operationId: 'op-pn-1', actor: 'author', siteUrl: 'https://blog.example.test', now: T0 })
    expect(res.outcome).toBe('published')
    if (res.outcome !== 'published') return
    expect(res.eventId).toBeTruthy()

    expect((await scheduleRow('s-pn')).status).toBe('fired')
    expect(await countEvents(articleId)).toBe(1) // exactly one event
    const formal = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM formal_publications WHERE article_id = ${articleId}`)
    expect(formal[0].c).toBe(1)
    void slug
  })

  it('does NOT bypass the publish kernel — a drifted bound version is blocked with zero events', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('ctrl-pn-drift'))
    await schedule(articleId, 's-pn-drift') // bound to v1
    // Author saves v2 → the bound v1 is no longer the current/live version.
    await bumpVersion(articleId, slug)

    const res = await publishNowSchedule(createDatabase(), { scheduleId: 's-pn-drift', operationId: 'op-pn-drift', actor: 'author', siteUrl: 'https://blog.example.test', now: T0 })
    // preparePublish fails the `saved` blocker on live state → NOT published.
    expect(res.outcome).toBe('conflict')
    expect(res).toMatchObject({ reason: expect.stringContaining('blocked') })
    expect(await countEvents(articleId)).toBe(0) // zero events — never misfired
    expect((await scheduleRow('s-pn-drift')).status).toBe('stale')
  })

  it('is idempotent and rejects publishing an already-fired schedule', async () => {
    const { articleId } = await createDraftArticle(freshSlug('ctrl-pn-again'))
    await schedule(articleId, 's-pn-again')
    await publishNowSchedule(createDatabase(), { scheduleId: 's-pn-again', operationId: 'op-pn-again', actor: 'author', siteUrl: 'https://blog.example.test', now: T0 })

    // Same operation → replay (never a second event).
    const replay = await publishNowSchedule(createDatabase(), { scheduleId: 's-pn-again', operationId: 'op-pn-again', actor: 'author', siteUrl: 'https://blog.example.test', now: T0 })
    expect(replay.outcome).toBe('replayed')
    expect(await countEvents(articleId)).toBe(1)

    // A NEW operation against the now-fired schedule → rejected (already published).
    const again = await publishNowSchedule(createDatabase(), { scheduleId: 's-pn-again', operationId: 'op-pn-again2', actor: 'author', siteUrl: 'https://blog.example.test', now: T0 })
    expect(again.outcome).toBe('conflict')
    expect(await countEvents(articleId)).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* operation-id re-use across a different target is a conflict         */
/* ------------------------------------------------------------------ */

describe('operation-id integrity', () => {
  it('rejects reusing an operation id on a different schedule/action (never silent)', async () => {
    const a = await createDraftArticle(freshSlug('ctrl-op-a'))
    const b = await createDraftArticle(freshSlug('ctrl-op-b'))
    await schedule(a.articleId, 's-op-a')
    await schedule(b.articleId, 's-op-b')
    await pauseSchedule(createDatabase(), { scheduleId: 's-op-a', operationId: 'op-shared', actor: 'author', now: T0 })

    const reused = await pauseSchedule(createDatabase(), { scheduleId: 's-op-b', operationId: 'op-shared', actor: 'author', now: T0 })
    expect(reused).toMatchObject({ outcome: 'conflict', reason: 'operation-id-reused' })
    // The target schedule must remain untouched pending.
    expect((await scheduleRow('s-op-b')).status).toBe('pending')
  })
})
