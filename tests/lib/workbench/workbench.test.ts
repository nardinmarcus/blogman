/**
 * B4-04 — workbench read-model test suite (issue #43).
 *
 * One shared in-process Miniflare D1. Proves the read-model contract:
 *
 *   - 分组正确  drafts / schedules / system-in-progress / author-todos are
 *             grouped by responsible party and each entry traces to an
 *             authoritative source (article id / schedule id),
 *   - 可追溯    every entry re-reads current facts, never stale params,
 *   - 可重建    rebuilding re-queries authoritative facts (idempotent, read-only),
 *   - 可关闭    投影 toggle never touches a source task / schedule fact,
 *   - 无副作用  building the projection writes nothing to source tables.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapB404State,
  createDatabase,
  createDraftArticle,
  createFormalArticle,
  query,
} from './helpers'
import { buildTodayWorkbench, setWorkbenchEnabled } from '@/lib/workbench'
import { schedulePublish } from '@/lib/scheduled-publish'

let state: string
const T0 = 1_700_000_000
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b404-workbench-'))
  cleanup.push(state)
  await bootstrapB404State(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  // Shared in-process D1 persists across tests — reset the surfaces this suite
  // creates so each draft/schedule assertion is deterministic.
  await createDatabase().prepare('DELETE FROM publish_schedules').run()
  await createDatabase().prepare('DELETE FROM workbench_controls').run()
  await createDatabase().prepare('DELETE FROM publish_prepares').run()
  await createDatabase().prepare('DELETE FROM publish_intents').run()
  await createDatabase().prepare('DELETE FROM publish_events').run()
  await createDatabase().prepare('DELETE FROM formal_publications').run()
  await createDatabase().prepare('DELETE FROM publish_receipts').run()
  await createDatabase().prepare('DELETE FROM article_versions').run()
  await createDatabase().prepare('DELETE FROM articles').run()
  await createDatabase().prepare('DELETE FROM posts').run()
})

describe('workbench grouping (责任方)', () => {
  it('reads canonical article facts, not the legacy posts projection (reader source assertion)', async () => {
    // B2-07/B3 — the workbench draft reader must source from canonical
    // articles + article_versions, never from the legacy `posts` compat rows.
    // A draft is created through the versioned write kernel (identity + version)
    // and then its legacy posts projection row is erased: the workbench must
    // still list it from the canonical layer.
    const draft = await createDraftArticle('wb-src-1', '来源断言草稿')
    await createDatabase()
      .prepare('DELETE FROM posts WHERE id = ?')
      .bind(draft.postRef)
      .run()

    const wb = await buildTodayWorkbench(createDatabase(), { now: T0 })
    const drafts = wb.groups.find((g) => g.group === 'drafts')
    expect(drafts).toBeDefined()
    expect(drafts!.items.map((i) => i.title)).toContain('来源断言草稿')
    expect(drafts!.items[0].sourceType).toBe('article')
    expect(drafts!.items[0].sourceId).toBe(String(draft.articleId))
  })

  it('groups drafts, schedules, system in-progress and author todos by responsible party', async () => {
    const draft = await createDraftArticle('wb-draft-1', '草稿A')
    await createFormalArticle('wb-formal-1', '正式B')
    await schedulePublish(createDatabase(), {
      scheduleId: 'wb-sched-1',
      articleId: draft.articleId,
      version: 1,
      scheduledAt: T0 + 3600,
      actor: 'author',
      now: T0,
    })

    const wb = await buildTodayWorkbench(createDatabase(), { now: T0 })
    expect(wb.projectionEnabled).toBe(true)

    const byGroup = Object.fromEntries(wb.groups.map((g) => [g.group, g]))
    expect(byGroup['drafts'].responsible).toBe('author')
    expect(byGroup['drafts'].items).toHaveLength(1)
    expect(byGroup['drafts'].items[0].sourceType).toBe('article')
    // formal article is NOT a draft — it should not appear in drafts
    const draftTitles = byGroup['drafts'].items.map((i) => i.title)
    expect(draftTitles).toContain('草稿A')
    expect(draftTitles).not.toContain('正式B')

    expect(byGroup['schedules'].responsible).toBe('author')
    expect(byGroup['schedules'].items).toHaveLength(1)
    expect(byGroup['schedules'].items[0].sourceType).toBe('schedule')
    expect(byGroup['schedules'].items[0].sourceId).toBe('wb-sched-1')

    expect(byGroup['system-in-progress'].responsible).toBe('system')
    expect(byGroup['author-todos'].responsible).toBe('author')
  })

  it('places claimed schedules under system in-progress', async () => {
    const draft = await createDraftArticle('wb-sys-1', '系统处理文章')
    await schedulePublish(createDatabase(), {
      scheduleId: 'wb-sys-sched',
      articleId: draft.articleId,
      version: 1,
      scheduledAt: T0 + 100,
      actor: 'author',
      now: T0,
    })
    await createDatabase()
      .prepare(`UPDATE publish_schedules SET status = 'claimed' WHERE schedule_id = 'wb-sys-sched'`)
      .run()

    const wb = await buildTodayWorkbench(createDatabase(), { now: T0 })
    const inProgress = wb.groups.find((g) => g.group === 'system-in-progress')
    expect(inProgress?.items).toHaveLength(1)
    expect(inProgress?.items[0].sourceId).toBe('wb-sys-sched')
    expect(inProgress?.responsible).toBe('system')
  })

  it('places stale schedules under author todos with the stale reason', async () => {
    const draft = await createDraftArticle('wb-todo-1', '作者待办文章')
    await schedulePublish(createDatabase(), {
      scheduleId: 'wb-todo-sched',
      articleId: draft.articleId,
      version: 1,
      scheduledAt: T0 + 100,
      actor: 'author',
      now: T0,
    })
    await createDatabase()
      .prepare(`UPDATE publish_schedules SET status = 'stale', stale_reason = 'version-drift' WHERE schedule_id = 'wb-todo-sched'`)
      .run()

    const wb = await buildTodayWorkbench(createDatabase(), { now: T0 })
    const todos = wb.groups.find((g) => g.group === 'author-todos')
    expect(todos?.items).toHaveLength(1)
    expect(todos?.items[0].meta).toMatchObject({ status: 'stale', staleReason: 'version-drift' })
    expect(todos?.responsible).toBe('author')
  })
})

describe('workbench rebuild + projection toggle (可重建/可关闭)', () => {
  it('rebuild re-queries authoritative facts — a new draft appears on the next build', async () => {
    const draft = await createDraftArticle('wb-rb-1', '重建前')
    const wb1 = await buildTodayWorkbench(createDatabase(), { now: T0 })
    expect(wb1.groups.find((g) => g.group === 'drafts')?.items).toHaveLength(1)

    await createDraftArticle('wb-rb-2', '重建后')
    const wb2 = await buildTodayWorkbench(createDatabase(), { now: T0 })
    const drafts2 = wb2.groups.find((g) => g.group === 'drafts')?.items ?? []
    expect(drafts2).toHaveLength(2)
    expect(drafts2.map((i) => i.title)).toContain('重建后')
    expect(draft.articleId).toBeGreaterThan(0)
  })

  it('disabling the projection does not touch source drafts or schedules', async () => {
    const draft = await createDraftArticle('wb-off-1', '关闭投影文章')
    await schedulePublish(createDatabase(), {
      scheduleId: 'wb-off-sched',
      articleId: draft.articleId,
      version: 1,
      scheduledAt: T0 + 3600,
      actor: 'author',
      now: T0,
    })

    const res = await setWorkbenchEnabled(createDatabase(), false, T0)
    expect(res.outcome).toBe('disabled')

    // Projection disabled → no groups, but source facts intact.
    const wb = await buildTodayWorkbench(createDatabase(), { now: T0 })
    expect(wb.projectionEnabled).toBe(false)
    expect(wb.groups).toHaveLength(0)

    // Source drafts live in canonical facts (latest snapshot status = draft).
    const draftCount = (await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM articles a
       JOIN article_versions v ON v.article_id = a.id
        AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
       WHERE json_extract(v.snapshot_json, '$.fields.status') = 'draft'
         AND NOT EXISTS (SELECT 1 FROM formal_publications f WHERE f.article_id = a.id AND f.lifecycle = 'published')`,
    ))[0]?.c ?? 0
    const schedCount = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_schedules`))[0]?.c ?? 0
    expect(draftCount).toBe(1)
    expect(schedCount).toBe(1)

    // Re-enable → projection returns.
    await setWorkbenchEnabled(createDatabase(), true, T0)
    const wbOn = await buildTodayWorkbench(createDatabase(), { now: T0 })
    expect(wbOn.projectionEnabled).toBe(true)
    expect(wbOn.groups.find((g) => g.group === 'drafts')?.items).toHaveLength(1)
  })

  it('building the projection writes nothing to source tables (no side effects)', async () => {
    await createDraftArticle('wb-side-1', '无副作用文章')
    const beforeFormal = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM formal_publications`))[0]?.c ?? 0
    const beforeEvents = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events`))[0]?.c ?? 0

    await buildTodayWorkbench(createDatabase(), { now: T0 })

    const afterFormal = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM formal_publications`))[0]?.c ?? 0
    const afterEvents = (await query<{ c: number }>(`SELECT COUNT(*) AS c FROM publish_events`))[0]?.c ?? 0
    expect(afterFormal).toBe(beforeFormal)
    expect(afterEvents).toBe(beforeEvents)
  })
})
