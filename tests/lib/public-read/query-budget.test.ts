/**
 * #244 P0 — detail resolution query budget.
 *
 * The article navigation waterfall is roundtrip-bound: resolvePublicArticle
 * used to execute six sequential SELECTs (schema probe, registry address,
 * formal row, formal version, post_ref, latest version). On a canonical DB
 * with a registered current address the whole resolution must collapse into
 * at most TWO roundtrips (schema probe + one joined fact read).
 *
 * The counter wraps the REAL Miniflare D1 binding — every SQL statement that
 * leaves the process is counted, so the budget is a true wire budget.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapSlugAddressState, createDatabase, query } from '@/tests/lib/slug-address/helpers'
import { backfillCurrentAddresses } from '@/lib/slug-address'
import { create } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import type { Database } from '@/lib/repositories/schema'
import { resolvePublicArticle } from '@/lib/public-read'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-244-query-budget-'))
  cleanup.push(state)
  await bootstrapSlugAddressState(state)
}, 300_000)

afterAll(async () => {
  await import('@/tests/lib/article-commands/helpers').then((m) => m.teardownState())
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function slug(): string {
  seq += 1
  return `budget-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}, s = slug()): ArticleCommandSnapshot {
  return {
    slug: s,
    title: '预算标题',
    content: '预算正文',
    html: '<p>预算正文</p>',
    description: '预算描述',
    category: '分类',
    tags: ['甲'],
    status: 'published',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: 1,
    updated_at: null,
    ...overrides,
  }
}

async function createFormal(s = slug()): Promise<string> {
  const snap = snapshot({}, s)
  const created = await create(createDatabase(), { creationId: `budget-${s}`, snapshot: snap })
  if (created.outcome !== 'created') throw new Error(`create failed: ${JSON.stringify(created)}`)
  const articleId = created.articleId
  const hashRow = (await query<{ content_snapshot_sha256: string | null }>(
    `SELECT content_snapshot_sha256 FROM article_versions
     WHERE article_id = ${articleId} AND version = 1 ORDER BY id DESC LIMIT 1`,
  ))[0]
  const prepared = await preparePublish(createDatabase(), {
    prepareId: `prep-${s}`,
    articleId,
    confirmedVersion: 1,
    slug: s,
    title: snap.title,
    contentSha256: hashRow?.content_snapshot_sha256 ?? '',
    actor: 'budget-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${s}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'budget-fixture',
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`)
  return s
}

/** Wrap the real D1 binding and count every executed SQL statement. */
interface Counted {
  db: Database
  selects: { sql: string }[]
}
function countSelects(db: Database): Counted {
  const selects: { sql: string }[] = []
  const counted: Database = {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) selects.push({ sql })
      return {
        bind: (...values: unknown[]) => statement.bind(...values),
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
      } as unknown as ReturnType<Database['prepare']>
    },
    batch: db.batch.bind(db),
  } as unknown as Database
  return { db: counted, selects }
}

describe('lib/public-read — #244 detail resolution query budget', { timeout: 600_000 }, () => {
  it('current slug 详情解析最多 2 次 SELECT（schema probe + 1 次合并事实读）', async () => {
    const s = await createFormal()
    await backfillCurrentAddresses(createDatabase())

    const { db, selects } = countSelects(createDatabase())
    const resolved = await resolvePublicArticle(db, s)

    expect(resolved.redirectSlug).toBeNull()
    expect(resolved.article).toBeTruthy()
    expect(resolved.article!.slug).toBe(s)
    expect(resolved.article!.content).toContain('预算正文')
    expect(resolved.article!.password).toBeNull()

    expect(
      selects.length,
      `expected <=2 SELECTs, saw ${selects.length}:\n${selects.map((q) => q.sql).join('\n')}`,
    ).toBeLessThanOrEqual(2)
  })

  it('unknown slug 仍然解析为空且预算受控', async () => {
    const { db, selects } = countSelects(createDatabase())
    const resolved = await resolvePublicArticle(db, 'definitely-not-a-budget-slug')
    expect(resolved.article).toBeNull()
    expect(resolved.redirectSlug).toBeNull()
    expect(selects.length).toBeLessThanOrEqual(3)
  })
})
