/**
 * B3-04 — permanent slug address registry D1 fixture (issue #36).
 *
 * One shared in-process Miniflare instance (real D1 binding, zero wrangler CLI
 * spawns), reusing the first-publish + revision bootstrap. Covers the full
 * address lifecycle acceptance matrix:
 *
 *   - 候选保留且上线前不公开 a pending revision's slug is reserved (candidate)
 *     and is NOT publicly resolvable before go-live,
 *   - 上线切换并登记旧地址 promotion rotates the registry in the SAME batch:
 *     old live slug → historical, promoted slug → current,
 *   - 旧地址单跳 historical addresses resolve DIRECTLY to the current address
 *     (single hop), even after several renames — never a redirect chain,
 *   - 当前冲突 another article may not claim a current address,
 *   - 候选冲突 another article may not claim a pending candidate address,
 *   - 历史冲突 another article may not claim a permanently-occupied historical
 *     address, and an article may not revert to one of its own historical
 *     addresses,
 *   - 前端阻断冲突 blocked BEFORE the publish transaction (promote gate),
 *   - 回填只登记当前可观察 slug backfill registers only current observable
 *     slugs and never invents history.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapSlugAddressState, createDatabase, createFormalArticle, freshOp, query } from './helpers'
import { save } from '@/lib/article-commands'
import { promoteRevision } from '@/lib/publish-revision'
import { backfillCurrentAddresses, resolveArticleAddress } from '@/lib/slug-address'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import type { AddressRow } from '@/lib/slug-address/kernel'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b304-slug-address-'))
  cleanup.push(state)
  await bootstrapSlugAddressState(state)
}, 300_000)

afterAll(async () => {
  await import('@/tests/lib/article-commands/helpers').then((m) => m.teardownState())
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title: '标题',
    content: '正文内容',
    html: '<p>正文内容</p>',
    description: '描述',
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

async function addresses(slug: string): Promise<AddressRow[]> {
  return query<AddressRow>(`SELECT * FROM article_slug_addresses WHERE slug = '${slug}'`)
}

/** Save a body-editing revision carrying a (possibly new) candidate slug. */
async function saveRevisionWith(articleId: number, expectedVersion: number, slug: string, content = '修订正文') {
  return save(createDatabase(), {
    articleId,
    expectedVersion,
    operationId: freshOp('rev'),
    snapshot: snapshot({ slug, title: '修订标题', content, html: `<p>${content}</p>` }),
  })
}

describe('lib/slug-address — permanent address registry', { timeout: 600_000 }, () => {
  it('候选保留且上线前不公开：编辑产生候选地址，解析不返回', async () => {
    const article = await createFormalArticle(fresh('cand'))
    const candidateSlug = fresh('candidate')
    // Register the article's observable current address (as a backfill would).
    await backfillCurrentAddresses(createDatabase())

    const saved = await saveRevisionWith(article.articleId, 1, candidateSlug)
    expect(saved.outcome).toBe('applied')

    // The candidate address is registered + exclusively owned by this article.
    const [cand] = await addresses(candidateSlug)
    expect(cand).toBeTruthy()
    expect(cand.article_id).toBe(article.articleId)
    expect(cand.kind).toBe('candidate')

    // But it is NOT publicly resolvable before go-live.
    expect(await resolveArticleAddress(createDatabase(), candidateSlug)).toBeNull()
    // The article's live slug is still served directly.
    const live = await resolveArticleAddress(createDatabase(), article.slug)
    expect(live).toEqual({ articleId: article.articleId, currentSlug: article.slug, redirect: false })
  })

  it('上线事务切换并登记旧地址：旧 slug→历史，新 slug→当前，旧地址单跳', async () => {
    const article = await createFormalArticle(fresh('rot'))
    const newSlug = fresh('rot-new')
    const saved = await saveRevisionWith(article.articleId, 1, newSlug)
    expect(saved.outcome).toBe('applied')
    if (saved.outcome !== 'applied') return

    const promoted = await promoteRevision(createDatabase(), {
      articleId: article.articleId,
      actor: 'b304-fixture',
      siteUrl: 'https://blog.example.test',
    })
    expect(promoted.outcome).toBe('promoted')
    if (promoted.outcome !== 'promoted') return

    // Old slug → historical; new slug → current, both owned by the article.
    const oldRows = await addresses(article.slug)
    const newRows = await addresses(newSlug)
    expect(oldRows).toHaveLength(1)
    expect(oldRows[0]!.kind).toBe('historical')
    expect(newRows).toHaveLength(1)
    expect(newRows[0]!.kind).toBe('current')

    // Historical single-hop → current address.
    expect(await resolveArticleAddress(createDatabase(), article.slug)).toEqual({
      articleId: article.articleId,
      currentSlug: newSlug,
      redirect: true,
    })
    // Current address served directly.
    expect(await resolveArticleAddress(createDatabase(), newSlug)).toEqual({
      articleId: article.articleId,
      currentSlug: newSlug,
      redirect: false,
    })
  })

  it('多次改名：每次旧地址都永久单跳到最终当前地址，无重定向链', async () => {
    const article = await createFormalArticle(fresh('multi'))
    const s2 = fresh('m2')
    const s3 = fresh('m3')

    // First rename s1 → s2.
    await saveRevisionWith(article.articleId, 1, s2, '第一版修订')
    expect((await promoteRevision(createDatabase(), { articleId: article.articleId, actor: 'b304-fixture', siteUrl: 'https://b.test' })).outcome).toBe('promoted')

    // Second rename s2 → s3.
    await saveRevisionWith(article.articleId, 2, s3, '第二版修订')
    const promoted2 = await promoteRevision(createDatabase(), { articleId: article.articleId, actor: 'b304-fixture', siteUrl: 'https://b.test' })
    expect(promoted2.outcome).toBe('promoted')
    if (promoted2.outcome !== 'promoted') return

    // BOTH former slugs single-hop straight to s3 (never to the intermediate s2).
    expect(await resolveArticleAddress(createDatabase(), article.slug)).toEqual({
      articleId: article.articleId, currentSlug: s3, redirect: true,
    })
    expect(await resolveArticleAddress(createDatabase(), s2)).toEqual({
      articleId: article.articleId, currentSlug: s3, redirect: true,
    })
    expect(await resolveArticleAddress(createDatabase(), s3)).toEqual({
      articleId: article.articleId, currentSlug: s3, redirect: false,
    })
  })

  it('当前冲突：另一篇文章不能占用既有文章的当前地址', async () => {
    const a = await createFormalArticle(fresh('cur-conf-a'))
    await saveRevisionWith(a.articleId, 1, fresh('cur-bump'), 'A改名')
    expect((await promoteRevision(createDatabase(), { articleId: a.articleId, actor: 'b', siteUrl: 'https://b.test' })).outcome).toBe('promoted')

    // Article B cannot save a revision carrying A's current address.
    const b = await createFormalArticle(fresh('cur-conf-b'))
    const aCurrent = (await query<{ slug: string }>(
      `SELECT slug FROM article_slug_addresses WHERE article_id = ${a.articleId} AND kind = 'current'`,
    ))[0]
    const blocked = await saveRevisionWith(b.articleId, 1, aCurrent?.slug ?? 'x')
    expect(blocked.outcome).toBe('conflict')
    if (blocked.outcome === 'conflict') expect((blocked as { reason?: string }).reason).toBe('slug-conflict')
  })

  it('候选冲突：另一篇文章不能占用处于待发布状态的候选地址', async () => {
    const a = await createFormalArticle(fresh('cand-conf-a'))
    const pending = fresh('cand-pending')
    // A reserves the candidate (not yet promoted).
    expect((await saveRevisionWith(a.articleId, 1, pending, '待发布')).outcome).toBe('applied')

    // Article B tries to claim the same pending candidate address.
    const b = await createFormalArticle(fresh('cand-conf-b'))
    const blocked = await saveRevisionWith(b.articleId, 1, pending, 'B想占用')
    expect(blocked.outcome).toBe('conflict')
    if (blocked.outcome === 'conflict') expect((blocked as { reason?: string }).reason).toBe('slug-conflict')
  })

  it('历史冲突：另一篇文章不能占用已永久登记的历史地址', async () => {
    const a = await createFormalArticle(fresh('hist-conf-a'))
    const aOld = a.slug
    await saveRevisionWith(a.articleId, 1, fresh('hist-a-new'), 'A改名')
    expect((await promoteRevision(createDatabase(), { articleId: a.articleId, actor: 'b', siteUrl: 'https://b.test' })).outcome).toBe('promoted')
    // aOld is now permanently historical for A.

    const b = await createFormalArticle(fresh('hist-conf-b'))
    const blocked = await saveRevisionWith(b.articleId, 1, aOld, 'B想占用旧地址')
    expect(blocked.outcome).toBe('conflict')
    if (blocked.outcome === 'conflict') expect((blocked as { reason?: string }).reason).toBe('slug-conflict')
  })

  it('不能回退到自己的历史地址：revert 冲突', async () => {
    const article = await createFormalArticle(fresh('revert'))
    const original = article.slug
    await saveRevisionWith(article.articleId, 1, fresh('revert-new'), '改名')
    expect((await promoteRevision(createDatabase(), { articleId: article.articleId, actor: 'b', siteUrl: 'https://b.test' })).outcome).toBe('promoted')

    // Trying to revert to the article's own historical address is blocked.
    const reverted = await saveRevisionWith(article.articleId, 2, original, '想回退')
    expect(reverted.outcome).toBe('conflict')
    if (reverted.outcome === 'conflict') expect((reverted as { reason?: string }).reason).toBe('slug-conflict')
  })

  it('发布前阻断：promote 门在写入事务前检查注册表冲突', async () => {
    const a = await createFormalArticle(fresh('gate-a'))
    const taken = fresh('gate-taken')
    // A reserves `taken` as candidate, then the address is externally handed to
    // article B (simulating a concurrent claim that landed after the save) so
    // the PROMOTE gate — not the save — must abort the go-live.
    expect((await saveRevisionWith(a.articleId, 1, taken, 'A候选')).outcome).toBe('applied')
    const b = await createFormalArticle(fresh('gate-b'))
    const now = Math.floor(Date.now() / 1000)
    await query(
      `DELETE FROM article_slug_addresses WHERE slug = '${taken}'`,
    )
    // B owns the address (as candidate — any kind owned by another article
    // blocks the promote gate; simulating a concurrent claim after the save).
    await query(
      `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
       VALUES ('${taken}', ${b.articleId}, 'candidate', ${now}, ${now})`,
    )

    const promoted = await promoteRevision(createDatabase(), {
      articleId: a.articleId,
      actor: 'b304-fixture',
      siteUrl: 'https://blog.example.test',
    })
    expect(promoted.outcome).toBe('blocked')
    if (promoted.outcome !== 'blocked') return
    expect(promoted.failures).toContain('slug-conflict')
    // The go-live did NOT happen — formal version unchanged, old slug still live.
    const formal = (await query<{ version: number; slug: string }>(
      `SELECT version, slug FROM formal_publications WHERE article_id = ${a.articleId}`,
    ))[0]
    expect(formal?.version).toBe(1)
    expect(formal?.slug).toBe(a.slug)
  })

  it('回填只登记当前可观察 slug，不猜历史', async () => {
    const a = await createFormalArticle(fresh('backfill-a'))
    const b = await createFormalArticle(fresh('backfill-b'))

    const result = await backfillCurrentAddresses(createDatabase())
    // Both freshly-published articles get a current row for their observable slug.
    const aRow = (await query<{ kind: string }>(
      `SELECT kind FROM article_slug_addresses WHERE article_id = ${a.articleId} AND kind = 'current'`,
    ))[0]
    const bRow = (await query<{ kind: string }>(
      `SELECT kind FROM article_slug_addresses WHERE article_id = ${b.articleId} AND kind = 'current'`,
    ))[0]
    expect(aRow?.kind).toBe('current')
    expect(bRow?.kind).toBe('current')
    // A backfill invents no historical addresses for these articles.
    const historicalForA = (await query<{ id: number }>(
      `SELECT id FROM article_slug_addresses
       WHERE article_id IN (${a.articleId}, ${b.articleId}) AND kind = 'historical'`,
    )).length
    expect(historicalForA).toBe(0)
    expect(result.registered).toBeGreaterThanOrEqual(2)

    // Idempotent: a second run registers nothing new for these articles.
    await backfillCurrentAddresses(createDatabase())
    const aCount = (await query<{ id: number }>(
      `SELECT id FROM article_slug_addresses WHERE article_id = ${a.articleId} AND slug = '${a.slug}' AND kind = 'current'`,
    )).length
    expect(aCount).toBe(1)
  })
})
