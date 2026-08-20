/**
 * B8-04 — mobile schedule D1 integration tests (issue #63).
 *
 * Proves the mobile path over the SHARED #41 schedule-control kernel through
 * `dispatchMobileScheduleAction` (the same dispatcher the API route calls):
 *
 *   - reschedule: re-arm to a new time, then a repeat replay (idempotent),
 *   - cancel:     terminal and fact-preserving (repeats replay),
 *   - publish-now: fires the exact bound version through the shared kernel
 *                  exactly once; a repeat never double-publishes,
 *   - paused reconfirm: content change pauses (retains time+version), then the
 *                  author re-confirms the new version to re-arm; a repeat on
 *                  the SAME version replays, a NEW version is a fresh op,
 *   - the read view rebuilds authoritative D1 facts (never client-optimistic).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapScheduledState, createDatabase, createDraftArticle, freshSlug, query } from '@/tests/lib/scheduled-publish/helpers'
import { ensureScheduleControlTables } from '@/lib/schedule-control'
import { ensureNotificationTables } from '@/lib/notifications'
import { schedulePublish } from '@/lib/scheduled-publish'
import { save } from '@/lib/article-commands'
import { dispatchMobileScheduleAction, getMobileScheduleView } from '@/lib/mobile-schedule'
import { scheduleBlocker } from '@/lib/mobile-schedule'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b804-mobile-schedule-'))
  cleanup.push(state)
  await bootstrapScheduledState(state)
  await ensureScheduleControlTables(createDatabase())
  await ensureNotificationTables(createDatabase())
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await createDatabase().prepare('DELETE FROM publish_schedules').run()
  await createDatabase().prepare('DELETE FROM schedule_control_ops').run()
  await createDatabase().prepare('DELETE FROM activity_notifications').run()
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

async function schedule(articleId: number, scheduleId: string, scheduledAt = T0 + 100): Promise<void> {
  const res = await schedulePublish(createDatabase(), {
    scheduleId,
    articleId,
    version: 1,
    scheduledAt,
    timezone: 'Asia/Shanghai',
    actor: 'author',
    now: T0,
  })
  if (res.outcome !== 'scheduled') throw new Error(`schedule failed: ${JSON.stringify(res)}`)
}

async function bumpVersion(articleId: number, slug: string): Promise<number> {
  const rows = await query<{ version: number }>(
    `SELECT COALESCE(MAX(version),0) AS version FROM article_versions WHERE article_id = ${articleId}`,
  )
  const current = rows[0]?.version ?? 0
  const res = await save(createDatabase(), {
    articleId,
    expectedVersion: current,
    operationId: `mobile-drift-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    snapshot: changedSnapshot(slug),
  })
  if (res.outcome !== 'applied') throw new Error(`bump failed: ${JSON.stringify(res)}`)
  return res.version
}

async function row(scheduleId: string) {
  const rows = await query<{ status: string; version: number; scheduled_at: number; timezone: string; stale_reason: string | null }>(
    `SELECT status, version, scheduled_at, timezone, stale_reason FROM publish_schedules WHERE schedule_id = '${scheduleId}'`,
  )
  return rows[0]
}

async function countOps(operationId: string): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM schedule_control_ops WHERE operation_id = '${operationId}'`)
  return rows[0]?.c ?? 0
}

async function countEvents(articleId: number): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`)
  return rows[0]?.c ?? 0
}

describe('mobile-schedule — reschedule path', () => {
  it('moves a pending intent to a new Asia/Shanghai time and is idempotent on repeat', async () => {
    const { articleId } = await createDraftArticle(freshSlug('mobile-re'))
    await schedule(articleId, 's-re')

    const first = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-re',
      action: 'reschedule',
      newScheduledAt: T0 + 5000,
      timezone: 'Asia/Shanghai',
      actor: 'mobile',
      now: T0,
    })
    if (first.outcome !== 'ok') throw new Error('expected ok')
    expect((first.result as { outcome: string }).outcome).toBe('rescheduled')
    expect((await row('s-re')).scheduled_at).toBe(T0 + 5000)
    expect((await row('s-re')).status).toBe('pending')

    // The read view re-reads D1 (authoritative) — never a client guess.
    const view = await getMobileScheduleView(createDatabase(), 's-re')
    expect(view?.scheduledAt).toBe(T0 + 5000)

    // Idempotent: same reschedule target replays, recorded exactly once.
    const replay = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-re',
      action: 'reschedule',
      newScheduledAt: T0 + 5000,
      timezone: 'Asia/Shanghai',
      actor: 'mobile',
      now: T0,
    })
    if (replay.outcome !== 'ok') throw new Error('expected ok')
    expect((replay.result as { outcome: string }).outcome).toBe('replayed')
    expect(await countOps(`b8-04:reschedule:s-re:${T0 + 5000}`)).toBe(1)
    expect((await row('s-re')).scheduled_at).toBe(T0 + 5000)
  })

  it('a different reschedule target is a fresh auditable operation', async () => {
    const { articleId } = await createDraftArticle(freshSlug('mobile-re2'))
    await schedule(articleId, 's-re2')
    await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-re2', action: 'reschedule', newScheduledAt: T0 + 5000, timezone: 'Asia/Shanghai', actor: 'mobile', now: T0,
    })
    await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-re2', action: 'reschedule', newScheduledAt: T0 + 9000, timezone: 'Asia/Shanghai', actor: 'mobile', now: T0,
    })
    expect((await row('s-re2')).scheduled_at).toBe(T0 + 9000)
  })
})

describe('mobile-schedule — cancel path', () => {
  it('cancels a pending intent, preserves facts, and replays on repeat', async () => {
    const { articleId } = await createDraftArticle(freshSlug('mobile-cancel'))
    await schedule(articleId, 's-cancel')

    const res = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-cancel', action: 'cancel', actor: 'mobile', now: T0,
    })
    if (res.outcome !== 'ok') throw new Error('expected ok')
    expect((res.result as { outcome: string }).outcome).toBe('cancelled')
    expect((await row('s-cancel')).status).toBe('cancelled')

    const replay = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-cancel', action: 'cancel', actor: 'mobile', now: T0,
    })
    if (replay.outcome !== 'ok') throw new Error('expected ok')
    expect((replay.result as { outcome: string }).outcome).toBe('replayed')
    expect(await countOps('b8-04:cancel:s-cancel')).toBe(1)
  })
})

describe('mobile-schedule — publish-now path', () => {
  it('fires the exact bound version through the shared kernel exactly once', async () => {
    const { articleId } = await createDraftArticle(freshSlug('mobile-pub'))
    await schedule(articleId, 's-pub')

    const res = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-pub', action: 'publish_now', actor: 'mobile', now: T0,
    })
    if (res.outcome !== 'ok') throw new Error('expected ok')
    expect((res.result as { outcome: string }).outcome).toBe('published')
    expect(await countEvents(articleId)).toBe(1)
    expect((await row('s-pub')).status).toBe('fired')

    // A repeat never fires a second publish event.
    await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-pub', action: 'publish_now', actor: 'mobile', now: T0,
    })
    expect(await countEvents(articleId)).toBe(1)
  })
})

describe('mobile-schedule — paused re-confirm path', () => {
  it('content change pauses (retains time+version), then re-confirms the new version to re-arm', async () => {
    const { articleId } = await createDraftArticle(freshSlug('mobile-paused'))
    await schedule(articleId, 's-paused')

    // Author edits the article → new saved version. Schedule stays on v1.
    const newVersion = await bumpVersion(articleId, 'mobile-paused')
    expect(newVersion).toBeGreaterThan(1)

    // Pause the schedule (retains original time + version). 
    const paused = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-paused', action: 'pause', actor: 'mobile', now: T0,
    })
    if (paused.outcome !== 'ok') throw new Error('expected ok')
    expect((paused.result as { outcome: string }).outcome).toBe('paused')

    // The view surfaces authoritative version drift → publish-now gated.
    const view = await getMobileScheduleView(createDatabase(), 's-paused')
    expect(view?.version).toBe(1)
    expect(view?.latestVersion).toBe(newVersion)
    expect(scheduleBlocker({
      scheduleStatus: view!.status,
      hasUnsavedLocalDraft: false,
      latestVersion: view!.latestVersion,
      scheduleVersion: view!.version,
    }, 'publish_now')).toBe('version-drift')
    expect(scheduleBlocker({
      scheduleStatus: view!.status,
      hasUnsavedLocalDraft: false,
      latestVersion: view!.latestVersion,
      scheduleVersion: view!.version,
    }, 'cancel')).toBeNull()

    // Re-confirm binds the NEW saved version and re-arms to pending.
    const re = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-paused', action: 'reconfirm', newVersion, actor: 'mobile', now: T0,
    })
    if (re.outcome !== 'ok') throw new Error('expected ok')
    expect((re.result as { outcome: string }).outcome).toBe('reconfirmed')
    expect(await row('s-paused')).toMatchObject({ status: 'pending', version: newVersion })

    // Same-version repeat replays (idempotent) — recorded exactly once.
    const repeat = await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-paused', action: 'reconfirm', newVersion, actor: 'mobile', now: T0,
    })
    if (repeat.outcome !== 'ok') throw new Error('expected ok')
    expect((repeat.result as { outcome: string }).outcome).toBe('replayed')
    expect(await countOps(`b8-04:reconfirm:s-paused:${newVersion}`)).toBe(1)

    // A LATER drift to an even newer version is a fresh (auditable) operation.
    const newVersion3 = await bumpVersion(articleId, 'mobile-paused')
    await dispatchMobileScheduleAction(createDatabase(), {
      scheduleId: 's-paused', action: 'reconfirm', newVersion: newVersion3, actor: 'mobile', now: T0,
    })
    expect(await row('s-paused')).toMatchObject({ status: 'pending', version: newVersion3 })
    expect(await countOps(`b8-04:reconfirm:s-paused:${newVersion3}`)).toBe(1)
  })
})
