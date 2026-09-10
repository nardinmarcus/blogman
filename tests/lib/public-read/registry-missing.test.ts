/**
 * #244 regression — slug-address registry table missing.
 *
 * When canonical formal/identity facts exist but individual fact tables are
 * absent (pre-DDL DB), the detail resolver must DEGRADE exactly like the
 * base implementation did (per-read silent catches):
 *
 *   - `article_slug_addresses` missing → formal-slug fallback, article live;
 *   - `articles` missing             → post_ref degrades to 0, article live;
 *   - `article_versions` missing     → article NOT observable (null, no body);
 *   - `formal_publications` missing  → unresolvable (null).
 *
 * Any OTHER DB failure must propagate — never swallowed to fake a pass.
 * Normal-path budget is unaffected (≤2 SELECTs, query-budget.test.ts).
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
import { resolvePublicArticle } from '@/lib/public-read'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-244-registry-missing-'))
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
  return `noref-${Date.now()}-${seq}`
}

async function createFormal(s = slug()): Promise<string> {
  const snap: ArticleCommandSnapshot = {
    slug: s,
    title: '无表标题',
    content: '无表正文',
    html: '<p>无表正文</p>',
    description: null,
    category: null,
    tags: null,
    status: 'published',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: 1,
    updated_at: null,
  }
  const created = await create(createDatabase(), { creationId: `noref-${s}`, snapshot: snap })
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
    actor: 'noref-fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
  const confirmed = await confirmPublish(createDatabase(), {
    intentId: `intent-${s}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'noref-fixture',
    siteUrl: 'https://blog.example.test',
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`)
  return s
}

describe('lib/public-read — #244 missing-fact-table degradation', { timeout: 600_000 }, () => {
  // ALL fixtures are created while every fact table is still present; the
  // tables are then dropped one by one across the sequential cases below.
  let s1 = ''
  let s2 = ''
  let s3 = ''

  it('fixture: three formal articles + address backfill', async () => {
    s1 = await createFormal()
    s2 = await createFormal()
    s3 = await createFormal()
    await backfillCurrentAddresses(createDatabase())
    expect(
      (await resolvePublicArticle(createDatabase(), s1)).article?.live,
    ).toBe(true)
  })

  it('registry 表缺失 → formal-slug fallback 仍返回 live 文章', async () => {
    await query('DROP TABLE article_slug_addresses')
    const resolved = await resolvePublicArticle(createDatabase(), s1)
    expect(resolved.redirectSlug).toBeNull()
    expect(resolved.article).toBeTruthy()
    expect(resolved.article!.live).toBe(true)
    expect(resolved.article!.slug).toBe(s1)
    expect(resolved.article!.title).toBe('无表标题')
    expect(resolved.article!.content).toContain('无表正文')
  })

  it('缺 articles 表 → post_ref 降为 0，文章仍 live（base 语义）', async () => {
    await query('DROP TABLE articles')
    const resolved = await resolvePublicArticle(createDatabase(), s3)
    expect(resolved.redirectSlug).toBeNull()
    expect(resolved.article).toBeTruthy()
    expect(resolved.article!.live).toBe(true)
    expect(resolved.article!.slug).toBe(s3)
    expect(resolved.article!.id).toBe(0)
  })

  it('缺 article_versions 表 → article 不可观察（base 语义 null，无正文）', async () => {
    await query('DROP TABLE article_versions')
    const resolved = await resolvePublicArticle(createDatabase(), s2)
    expect(resolved.article).toBeNull()
    expect(resolved.redirectSlug).toBeNull()
  })

  it('缺 formal_publications 表 → 完全不可解析', async () => {
    await query('DROP TABLE formal_publications')
    const resolved = await resolvePublicArticle(createDatabase(), 'whatever')
    expect(resolved.article).toBeNull()
    expect(resolved.redirectSlug).toBeNull()
  })
})
