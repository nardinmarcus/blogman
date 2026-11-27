/**
 * #257 — the mobile schedule read view must resolve article display facts
 * from canonical facts only: production dropped `posts` / `posts_fts` (#234).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapScheduledState, createDatabase, createDraftArticle, freshSlug, query } from '@/tests/lib/scheduled-publish/helpers'
import { schedulePublish } from '@/lib/scheduled-publish'
import { save } from '@/lib/article-commands'
import { getMobileScheduleView } from '@/lib/mobile-schedule'

const T0 = 1_700_000_000
let state: string

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-257-schedule-view-'))
  await bootstrapScheduledState(state, { postsless: true })
}, 120_000)

afterAll(() => {
  rmSync(state, { recursive: true, force: true })
})

describe('getMobileScheduleView without the posts projection', () => {
  it('reads title, slug and status from the latest version snapshot', async () => {
    const tables = await query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('posts', 'posts_fts')",
    )
    expect(tables).toEqual([])

    const slug = freshSlug('postsless-view')
    const { articleId } = await createDraftArticle(slug, '无投影标题')
    const scheduled = await schedulePublish(createDatabase(), {
      scheduleId: 's-postsless',
      articleId,
      version: 1,
      scheduledAt: T0 + 100,
      timezone: 'Asia/Shanghai',
      actor: 'author',
      now: T0,
    })
    expect(scheduled.outcome).toBe('scheduled')

    const saved = await save(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: `postsless-save-${slug}`,
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
    expect(saved.outcome).toBe('applied')

    const view = await getMobileScheduleView(createDatabase(), 's-postsless')
    expect(view).toMatchObject({
      articleId,
      version: 1,
      title: '改过的标题',
      slug,
      articleStatus: 'draft',
      latestVersion: 2,
      published: false,
    })
  })
})
