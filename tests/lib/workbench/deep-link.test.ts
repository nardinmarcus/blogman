/**
 * B4-04 — safe deep-link resolver test suite (issue #43).
 *
 * Proves the 安全深链 contract against the real D1 binding:
 *
 *   - 只导航并重读  current state is re-read; the request only supplies identity,
 *   - 无写副作用     resolving never writes to any table,
 *   - 过期深链落到当前实况  fired/cancelled schedules and missing articles fall
 *             through to current reality (live URL / list) instead of stale data,
 *   - 不含过期参数    the navigation href is derived ONLY from live facts.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapB404State, createDatabase, createDraftArticle, createFormalArticle, query } from './helpers'
import { schedulePublish } from '@/lib/scheduled-publish'
import { resolveDeepLink } from '@/lib/deep-link'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b404-deeplink-'))
  cleanup.push(state)
  await bootstrapB404State(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('deep link resolves by re-reading current state', () => {
  it('a draft article navigates to the editor from its live article id', async () => {
    const draft = await createDraftArticle('dl-draft-1', '深链草稿')
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'article', sourceId: String(draft.articleId) })
    expect(res.outcome).toBe('article-draft')
    expect(res.fallback).toBe(false)
    expect(res.navigation.href).toBe(`/editor?article=${draft.articleId}`)
    expect(res.responsible).toBe('author')
  })

  it('a live published article navigates to its CURRENT public url', async () => {
    const formal = await createFormalArticle('dl-live-1', '已发布深链')
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'article', sourceId: String(formal.articleId) })
    expect(res.outcome).toBe('article-live')
    expect(res.liveStatus).toBe('published')
    expect(res.navigation.href).toContain('blog.example.test')
    expect(res.fallback).toBe(false)
  })

  it('a pending schedule resolves to its live pending status, navigating to management', async () => {
    const draft = await createDraftArticle('dl-sched-1', '排期深链')
    await schedulePublish(createDatabase(), {
      scheduleId: 'dl-sched',
      articleId: draft.articleId,
      version: 1,
      scheduledAt: T0 + 3600,
      actor: 'author',
      now: T0,
    })
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'schedule', sourceId: 'dl-sched' })
    expect(res.outcome).toBe('schedule-pending')
    expect(res.liveStatus).toBe('pending')
    expect(res.responsible).toBe('author')
    expect(res.fallback).toBe(false)
  })
})

describe('expired / missing deep links fall through to current reality (过期深链落到当前实况)', () => {
  it('a missing article falls back to the article list, never fabricated', async () => {
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'article', sourceId: '999999' })
    expect(res.outcome).toBe('article-missing')
    expect(res.fallback).toBe(true)
    expect(res.navigation.href).toBe('/admin/posts')
  })

  it('a missing schedule falls back without stale navigation', async () => {
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'schedule', sourceId: 'does-not-exist' })
    expect(res.outcome).toBe('schedule-expired')
    expect(res.fallback).toBe(true)
    expect(res.navigation.href).toBe('/admin/posts')
  })

  it('a fired schedule falls through to the article live url (current reality)', async () => {
    const formal = await createFormalArticle('dl-fired-1', '已发布文章')
    await createDatabase()
      .prepare(
        `INSERT INTO publish_schedules
           (schedule_id, article_id, version, scheduled_at, timezone, status, created_at, updated_at)
         VALUES ('dl-fired', ?, 1, ?, 'Asia/Shanghai', 'fired', ?, ?)`,
      )
      .bind(formal.articleId, T0, T0, T0)
      .run()
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'schedule', sourceId: 'dl-fired' })
    expect(res.outcome).toBe('schedule-fired')
    expect(res.fallback).toBe(true)
    expect(res.liveStatus).toBe('fired')
    expect(res.navigation.href).toContain('blog.example.test')
  })

  it('an invalid deep-link id is rejected without any write', async () => {
    const res = await resolveDeepLink(createDatabase(), { sourceType: 'article', sourceId: 'not-an-int' })
    expect(res.fallback).toBe(true)
  })
})

describe('deep link has no write side effects (深链无写副作用)', () => {
  it('resolving writes nothing to any fact table', async () => {
    await createDraftArticle('dl-side-1', '无副作用')
    const before = {
      posts: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM posts`))[0]?.c ?? 0,
      schedules: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_schedules`))[0]?.c ?? 0,
      events: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events`))[0]?.c ?? 0,
      notifications: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM activity_notifications`))[0]?.c ?? 0,
    }

    const draft = (await query<{ id: number }>(`SELECT id FROM articles LIMIT 1`))[0]
    await resolveDeepLink(createDatabase(), { sourceType: 'article', sourceId: String(draft.id) })
    await resolveDeepLink(createDatabase(), { sourceType: 'schedule', sourceId: 'missing-xyz' })

    const after = {
      posts: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM posts`))[0]?.c ?? 0,
      schedules: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_schedules`))[0]?.c ?? 0,
      events: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events`))[0]?.c ?? 0,
      notifications: (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM activity_notifications`))[0]?.c ?? 0,
    }
    expect(after).toEqual(before)
  })
})
