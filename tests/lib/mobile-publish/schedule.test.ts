/**
 * #262 — scheduling a first publish from the publish confirmation page.
 *
 * `scheduleMobilePublish` binds the EXACT confirmed version through the #40
 * kernel; the per-minute Cron wakes `scanDueSchedules`, which publishes it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapRevisionState,
  createDatabase,
  createFormalArticle,
  freshOp,
  query,
} from '@/tests/lib/publish-revision/helpers'
import { createDraftArticle } from '@/tests/lib/first-publish/helpers'
import { save } from '@/lib/article-commands'
import { mobileScheduleId, scheduleMobilePublish } from '@/lib/mobile-publish'
import { scanDueSchedules } from '@/lib/scheduled-publish'

const T0 = 1_700_000_000
const SITE = 'https://blog.example.test'
let state: string

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-262-schedule-'))
  await bootstrapRevisionState(state)
}, 300_000)

afterAll(() => {
  rmSync(state, { recursive: true, force: true })
})

beforeEach(async () => {
  await createDatabase().prepare('DELETE FROM publish_schedules').run()
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function schedule(articleId: number, expectedVersion: number, scheduledAt = T0 + 600) {
  return scheduleMobilePublish(createDatabase(), { articleId, expectedVersion, scheduledAt, actor: 'author', now: T0 })
}

async function scheduleRows(articleId: number) {
  return query<{ schedule_id: string; version: number; status: string; timezone: string }>(
    `SELECT schedule_id, version, status, timezone FROM publish_schedules WHERE article_id = ${articleId}`,
  )
}

describe('scheduleMobilePublish', { timeout: 600_000 }, () => {
  it('binds the confirmed version, replays on repeat, and the scan publishes it when due', async () => {
    const { articleId, slug } = await createDraftArticle(fresh('sched-ok'))

    const first = await schedule(articleId, 1)
    expect(first).toMatchObject({
      outcome: 'scheduled',
      scheduleId: mobileScheduleId(articleId, 1, T0 + 600),
      version: 1,
      scheduledAt: T0 + 600,
      timezone: 'Asia/Shanghai',
    })
    expect((await schedule(articleId, 1)).outcome).toBe('replayed')
    expect(await scheduleRows(articleId)).toEqual([
      { schedule_id: mobileScheduleId(articleId, 1, T0 + 600), version: 1, status: 'pending', timezone: 'Asia/Shanghai' },
    ])

    await scanDueSchedules(createDatabase(), { now: T0 + 599, siteUrl: SITE })
    expect(await query(`SELECT version FROM formal_publications WHERE article_id = ${articleId}`)).toEqual([])

    await scanDueSchedules(createDatabase(), { now: T0 + 601, siteUrl: SITE })
    expect(await query(`SELECT version, slug FROM formal_publications WHERE article_id = ${articleId}`)).toEqual([
      { version: 1, slug },
    ])
    expect((await scheduleRows(articleId))[0]?.status).toBe('fired')
  })

  it('refuses a version the page no longer shows', async () => {
    const { articleId, slug } = await createDraftArticle(fresh('sched-drift'))
    const bumped = await save(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: freshOp('sched-drift'),
      snapshot: {
        slug,
        title: '改过的标题',
        content: '# 正文\n\n第二版。',
        html: '<p>第二版。</p>',
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
      },
    })
    expect(bumped.outcome).toBe('applied')

    expect(await schedule(articleId, 1)).toMatchObject({ outcome: 'conflict', serverVersion: 2 })
    expect(await scheduleRows(articleId)).toEqual([])
  })

  it('only schedules first publishes and future times', async () => {
    const formal = await createFormalArticle(fresh('sched-formal'))
    expect(await schedule(formal.articleId, 1)).toMatchObject({ outcome: 'blocked', failures: ['path'] })

    const { articleId } = await createDraftArticle(fresh('sched-past'))
    expect(await schedule(articleId, 1, T0 - 60)).toMatchObject({ outcome: 'invalid' })
    expect(await scheduleRows(articleId)).toEqual([])
  })

  it('ships a per-minute Cron trigger in the Wrangler template', () => {
    const config = readFileSync(join(process.cwd(), 'wrangler.toml'), 'utf8')
    expect(config).toMatch(/^\[triggers\]\ncrons = \["\* \* \* \* \*"\]$/m)
  })
})
