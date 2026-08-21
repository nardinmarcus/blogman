/**
 * B4-01 — scheduled-publish kernel test suite (issue #40).
 *
 * One shared in-process Miniflare D1 (real bindings, zero CLI spawns), frozen
 * epoch-second clocks. Proves every acceptance surface of the batch:
 *
 *   - 只绑定已确认版本  a schedule binds an exact version + absolute time + IANA
 *             zone; replay / payload-mismatch / duplicate-version / already-
 *             published are never silently rebinding,
 *   - 漏 tick 可补偿     catch-up converges past-due schedules; an expired-lease
 *             claimed row is reclaimed and still produces ONE event,
 *   - 重复 tick 仅一个事件 overlapping scans converge on the D1 conditional
 *             claim + the confirm kernel's intent uniqueness — one event,
 *   - 版本漂移/已发布/文章缺失 → `stale` (never misfire; author re-confirms in #41),
 *   - 管理界面固定 Asia/Shanghai the default + stored IANA zone echo.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapScheduledState,
  createDatabase,
  createDraftArticle,
  createFormalArticle,
  freshSlug,
  query,
} from './helpers'
import { cancelSchedule, scanDueSchedules, schedulePublish } from '@/lib/scheduled-publish'
import { save } from '@/lib/article-commands'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
/** Frozen epoch-second clock for every deterministic scan. */
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b401-scheduled-publish-'))
  cleanup.push(state)
  await bootstrapScheduledState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

// Each test owns the schedule table — the shared D1 persists across tests, so a
// clean `publish_schedules` keeps every scan's candidate set deterministic.
beforeEach(async () => {
  await createDatabase().prepare('DELETE FROM publish_schedules').run()
})

function changedSnapshot(slug: string, title = '标题2', content = '# 正文2\n\n已更改的一版。'): ArticleCommandSnapshot {
  return {
    slug,
    title,
    content,
    html: `<p>${content}</p>`,
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

/** Advance an article to its next version through the write kernel. Returns the new version */
async function bumpVersion(articleId: number, slug: string): Promise<number> {
  const rows = await query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ${articleId}`,
  )
  const current = rows[0]?.version ?? 0
  const res = await save(createDatabase(), {
    articleId,
    expectedVersion: current,
    operationId: `sched-drift-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    snapshot: changedSnapshot(slug),
  })
  if (res.outcome !== 'applied') throw new Error(`bumpVersion failed: ${JSON.stringify(res)}`)
  return res.version
}

async function countEvents(articleId: number): Promise<number> {
  const rows = await query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM publish_events WHERE article_id = ${articleId}`,
  )
  return rows[0]?.c ?? 0
}

/* ------------------------------------------------------------------ */
/* schedulePublish — version-bound intent                              */
/* ------------------------------------------------------------------ */

describe('schedulePublish (version-bound intent)', () => {
  it('rejects invalid inputs with a typed invalid reason', async () => {
    const invalid = await schedulePublish(createDatabase(), {
      scheduleId: '  ',
      articleId: 0,
      version: 0,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    expect(invalid.outcome).toBe('invalid')

    // scheduledAt must be strictly in the future relative to `now`.
    const past = await schedulePublish(createDatabase(), {
      scheduleId: 's-past',
      articleId: 1,
      version: 1,
      scheduledAt: T0,
      actor: 'author',
      now: T0,
    })
    expect(past.outcome).toBe('invalid')

    // A non-IANA timezone is rejected (management UI is fixed to Asia/Shanghai).
    const badTz = await schedulePublish(createDatabase(), {
      scheduleId: 's-bad-tz',
      articleId: 1,
      version: 1,
      scheduledAt: T0 + 5,
      timezone: 'Not/AZone',
      actor: 'author',
      now: T0,
    })
    expect(badTz.outcome).toBe('invalid')
  })

  it('returns not-found for an unknown article', async () => {
    const res = await schedulePublish(createDatabase(), {
      scheduleId: 's-missing',
      articleId: 999_999,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    expect(res.outcome).toBe('not-found')
  })

  it('refuses to schedule an already formally published article (never a second first-publish)', async () => {
    const { articleId } = await createFormalArticle(freshSlug('sched-conflict-formal'))
    const res = await schedulePublish(createDatabase(), {
      scheduleId: 's-formal-conflict',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    expect(res).toMatchObject({ outcome: 'conflict', reason: 'already-published', articleId })
  })

  it('records a pending schedule bound to the exact version, absolute time and IANA zone', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-ok'))
    const res = await schedulePublish(createDatabase(), {
      scheduleId: 's-ok',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    expect(res).toEqual({
      outcome: 'scheduled',
      scheduleId: 's-ok',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      timezone: 'Asia/Shanghai', // default — management UI is fixed to Asia/Shanghai
    })

    const row = (
      await query<{ status: string; timezone: string; version: number; scheduled_at: number }>(
        `SELECT status, timezone, version, scheduled_at FROM publish_schedules WHERE schedule_id = 's-ok'`,
      )
    )[0]
    expect(row).toEqual({ status: 'pending', timezone: 'Asia/Shanghai', version: 1, scheduled_at: T0 + 5 })
  })

  it('stores a custom IANA timezone verbatim for the author echo', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-tz'))
    const res = await schedulePublish(createDatabase(), {
      scheduleId: 's-tz',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      timezone: 'America/New_York',
      actor: 'author',
      now: T0,
    })
    expect(res.outcome).toBe('scheduled')
    if (res.outcome !== 'scheduled') return
    expect(res.timezone).toBe('America/New_York')
  })

  it('replays an identical intent idempotently', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-replay'))
    const payload = {
      scheduleId: 's-replay',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      timezone: 'Asia/Shanghai',
      actor: 'author',
      now: T0,
    }
    await schedulePublish(createDatabase(), payload)
    const again = await schedulePublish(createDatabase(), payload)
    expect(again).toMatchObject({ outcome: 'replayed', scheduleId: 's-replay' })
  })

  it('flags a payload change under the same id as a conflict (never silently rebinds)', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-payload'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-payload',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    const changed = await schedulePublish(createDatabase(), {
      scheduleId: 's-payload',
      articleId,
      version: 1,
      scheduledAt: T0 + 99, // different absolute time → different payload
      actor: 'author',
      now: T0,
    })
    expect(changed).toMatchObject({ outcome: 'conflict', reason: 'payload-mismatch', articleId })
  })

  it('rejects a second pending schedule for the same version (author must cancel first)', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-dup'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-dup-a',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    const dup = await schedulePublish(createDatabase(), {
      scheduleId: 's-dup-b', // different id, same article + version
      articleId,
      version: 1,
      scheduledAt: T0 + 6,
      actor: 'author',
      now: T0,
    })
    expect(dup).toMatchObject({ outcome: 'conflict', reason: 'duplicate-version', articleId })
  })
})

/* ------------------------------------------------------------------ */
/* cancelSchedule — interface seam (issue #41 command surface)         */
/* ------------------------------------------------------------------ */

describe('cancelSchedule (issue #41 seam)', () => {
  it('cancels a pending schedule and replays on an already-cancelled id', async () => {
    const { articleId } = await createDraftArticle(freshSlug('sched-cancel'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-cancel',
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    const cancelled = await cancelSchedule(createDatabase(), { scheduleId: 's-cancel', actor: 'author', now: T0 })
    expect(cancelled).toMatchObject({ outcome: 'cancelled', scheduleId: 's-cancel' })

    const row = (
      await query<{ status: string }>(`SELECT status FROM publish_schedules WHERE schedule_id = 's-cancel'`)
    )[0]
    expect(row.status).toBe('cancelled')

    const replay = await cancelSchedule(createDatabase(), { scheduleId: 's-cancel', actor: 'author', now: T0 })
    expect(replay.outcome).toBe('replayed')
  })

  it('returns not-found for an unknown id', async () => {
    const res = await cancelSchedule(createDatabase(), { scheduleId: 's-does-not-exist', actor: 'author', now: T0 })
    expect(res.outcome).toBe('not-found')
  })
})

/* ------------------------------------------------------------------ */
/* scanDueSchedules — the per-minute compensation contract             */
/* ------------------------------------------------------------------ */

describe('scanDueSchedules (per-minute compensation)', () => {
  it('returns all zeros when nothing is due', async () => {
    const res = await scanDueSchedules(createDatabase(), { now: T0 })
    expect(res).toEqual({ scanned: 0, claimed: 0, fired: 0, stale: 0, retried: 0, failed: 0 })
  })

  it('fires a due schedule through the real publish kernel exactly once', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-fire'))
    await schedulePublish(createDatabase(), {
      scheduleId: `s-fire-${slug}`,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    const res = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 1, claimed: 1, fired: 1, stale: 0, retried: 0 })

    const row = (
      await query<{ status: string; fired_event_id: string | null }>(
        `SELECT status, fired_event_id FROM publish_schedules WHERE schedule_id = 's-fire-${slug}'`,
      )
    )[0]
    expect(row.status).toBe('fired')
    expect(row.fired_event_id).toBeTruthy()

    // One formal publication + one publish event — the schedule is terminal.
    const formal = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM formal_publications WHERE article_id = ${articleId}`,
    )
    expect(formal[0].c).toBe(1)
    expect(await countEvents(articleId)).toBe(1)

    // The article is actually live now (canonical: formal facts).
    const post = await query<{ status: string; published_at: number | null }>(
      `SELECT f.lifecycle AS status, f.published_at AS published_at
       FROM formal_publications f WHERE f.article_id = ${articleId}`,
    )
    expect(post[0].status).toBe('published')
    expect(post[0].published_at).not.toBeNull()
  })

  it('records version drift as stale and never misfires (author re-confirms in #41)', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-drift'))
    await schedulePublish(createDatabase(), {
      scheduleId: `s-drift-${slug}`,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })
    // Author saves a newer version before fire time → bound v1 is no longer current.
    await bumpVersion(articleId, slug)

    const res = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 1, claimed: 1, fired: 0, stale: 1, retried: 0 })

    const row = (
      await query<{ status: string; stale_reason: string | null }>(
        `SELECT status, stale_reason FROM publish_schedules WHERE schedule_id = 's-drift-${slug}'`,
      )
    )[0]
    expect(row.status).toBe('stale')
    expect(row.stale_reason).toContain('version-drift')

    // Zero events — a drift must NEVER publish the wrong version.
    expect(await countEvents(articleId)).toBe(0)
  })

  it('records already-published as stale at fire time (no second first-publish)', async () => {
    const { articleId } = await createFormalArticle(freshSlug('sched-alr'))
    // Force a pending schedule directly (schedulePublish rejects formal articles, so
    // we simulate the race where formal publication lands between scheduling and fire).
    await createDatabase()
      .prepare(
        `INSERT INTO publish_schedules
           (schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'Asia/Shanghai', 'pending', 0, ?, ?)`,
      )
      .bind(`s-alr-${articleId}`, articleId, T0 + 5, T0, T0)
      .run()

    const res = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 1, claimed: 1, fired: 0, stale: 1, retried: 0 })

    const row = (
      await query<{ status: string; stale_reason: string | null }>(
        `SELECT status, stale_reason FROM publish_schedules WHERE schedule_id = 's-alr-${articleId}'`,
      )
    )[0]
    expect(row.status).toBe('stale')
    expect(row.stale_reason).toContain('already-published')
    expect(await countEvents(articleId)).toBe(1) // unchanged — only the real first-publish event
  })

  it('records a missing article as stale', async () => {
    await createDatabase()
      .prepare(
        `INSERT INTO publish_schedules
           (schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, created_at, updated_at)
         VALUES ('s-noarticle', 888_888, 1, ?, 'Asia/Shanghai', 'pending', 0, ?, ?)`,
      )
      .bind(T0 + 5, T0, T0)
      .run()

    const res = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 1, claimed: 1, fired: 0, stale: 1, retried: 0 })

    const row = (
      await query<{ status: string; stale_reason: string | null }>(
        `SELECT status, stale_reason FROM publish_schedules WHERE schedule_id = 's-noarticle'`,
      )
    )[0]
    expect(row.status).toBe('stale')
    expect(row.stale_reason).toBe('article-missing')
  })

  it('an overlapping duplicate tick converges to exactly one event', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-dtick'))
    await schedulePublish(createDatabase(), {
      scheduleId: `s-dtick-${slug}`,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    // Two ticks land at the SAME instant — both scan, but only one event results.
    const first = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    const second = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })

    expect(first).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })
    expect(second).toMatchObject({ scanned: 0, claimed: 0, fired: 0 }) // already fire-terminal
    expect(await countEvents(articleId)).toBe(1) // single event across overlapping ticks
  })

  it('reclaims an expired-lease claimed row (crashed runner) and produces exactly one event', async () => {
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-lease'))
    const scheduleId = `s-lease-${slug}`
    await schedulePublish(createDatabase(), {
      scheduleId,
      articleId,
      version: 1,
      scheduledAt: T0 + 5,
      actor: 'author',
      now: T0,
    })

    // Simulate a runner that CLAIMED then crashed BEFORE confirming: the row is
    // left `claimed` with an already-expired lease and no event written.
    await createDatabase()
      .prepare(
        `UPDATE publish_schedules SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE schedule_id = ?`,
      )
      .bind(T0, T0, T0, scheduleId)
      .run()

    // A later tick reclaims the expired lease; the article is not yet published,
    // so the schedule delivers exactly one event (never two).
    const res = await scanDueSchedules(createDatabase(), { now: T0 + 60, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 1, claimed: 1, fired: 1, stale: 0 })

    const row = (
      await query<{ status: string; fired_event_id: string | null }>(
        `SELECT status, fired_event_id FROM publish_schedules WHERE schedule_id = '${scheduleId}'`,
      )
    )[0]
    expect(row.status).toBe('fired')
    expect(await countEvents(articleId)).toBe(1) // exact one event across the crash + reclaim
  })

  it('catches up multiple past-due schedules in one scan', async () => {
    const a = await createDraftArticle(freshSlug('sched-catch-a'))
    const b = await createDraftArticle(freshSlug('sched-catch-b'))
    for (const [article, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      // Schedules may only be created in the future; a later tick catches them up.
      await schedulePublish(createDatabase(), {
        scheduleId: `s-catch-${tag}`,
        articleId: article.articleId,
        version: 1,
        scheduledAt: T0 + 100, // becomes overdue before the scan
        actor: 'author',
        now: T0,
      })
    }

    const res = await scanDueSchedules(createDatabase(), { now: T0 + 200, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 2, claimed: 2, fired: 2, stale: 0 })
    expect(await countEvents(a.articleId)).toBe(1)
    expect(await countEvents(b.articleId)).toBe(1)
  })

  it('honours the bounded scan limit batch', async () => {
    const a = await createDraftArticle(freshSlug('sched-limit-a'))
    const b = await createDraftArticle(freshSlug('sched-limit-b'))
    await schedulePublish(createDatabase(), {
      scheduleId: 's-limit-a',
      articleId: a.articleId,
      version: 1,
      scheduledAt: T0 + 100,
      actor: 'author',
      now: T0,
    })
    await schedulePublish(createDatabase(), {
      scheduleId: 's-limit-b',
      articleId: b.articleId,
      version: 1,
      scheduledAt: T0 + 110,
      actor: 'author',
      now: T0,
    })

    const one = await scanDueSchedules(createDatabase(), { now: T0 + 200, limit: 1, siteUrl: 'https://blog.example.test' })
    expect(one).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })

    // The unprocessed row is still pending (next minute catches it up).
    const pending = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM publish_schedules WHERE status = 'pending'`,
    )
    expect(pending[0].c).toBe(1)

    const rest = await scanDueSchedules(createDatabase(), { now: T0 + 200, siteUrl: 'https://blog.example.test' })
    expect(rest).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })
  })

  it('always resolves the scan against the current fire-time version (not the scheduleAt time)', async () => {
    // A schedule bound to v1 fires, then a subsequent schedule to the same article
    // cannot be scheduled (already-published) — covered above. Here we confirm a
    // version-bumped article with a LATER schedule for v2 still fires v2 exactly.
    const { articleId, slug } = await createDraftArticle(freshSlug('sched-v2'))
    await bumpVersion(articleId, slug) // now latest = 2
    await createDatabase()
      .prepare(
        `INSERT INTO publish_schedules
           (schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, created_at, updated_at)
         VALUES ('s-v2', ?, 2, ?, 'Asia/Shanghai', 'pending', 0, ?, ?)`,
      )
      .bind(articleId, T0 + 5, T0, T0)
      .run()

    const res = await scanDueSchedules(createDatabase(), { now: T0 + 10, siteUrl: 'https://blog.example.test' })
    expect(res).toMatchObject({ scanned: 1, claimed: 1, fired: 1 })
    const formal = await query<{ version: number }>(
      `SELECT version FROM formal_publications WHERE article_id = ${articleId}`,
    )
    expect(formal[0].version).toBe(2)
  })
})
