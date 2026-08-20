/**
 * B6-01 — 幂等建立主要源稿身份与待确认关联 kernel tests (issue #50).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns during execution). Proves the ticket's acceptance surface:
 *
 *   - 规范化 URL 幂等识别: repeated recording → same identity, zero new rows,
 *   - 重复录入零新增: a duplicate source URL converges on the owning article,
 *   - 待确认关联状态机: pending → confirmed / pending → cancelled, replayed
 *     transitions are no-ops, off-terminal transitions are refused,
 *   - 复制身份碰撞 → author chooses ownership (never guessed),
 *   - URL 变体需显式合并 (mergeSourceVariant),
 *   - 写回失败无隐藏孤儿 (replay converges the pending link),
 *   - 改名移动不改变关系, 一次性 API 不建关系.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, save } from '@/lib/article-commands'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import {
  cancelSourceLink,
  confirmSourceLink,
  linkSourceToArticle,
  mergeSourceVariant,
  resolveSourceUrl,
} from '@/lib/source-identity'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b601-source-'))
  cleanup.push(state)
  await bootstrapState(state)
  // B6-01 source-identity fact surface.
  for (const stmt of SOURCE_IDENTITY_DDL_STATEMENTS) {
    await query(stmt)
  }
}, 300_000)

afterAll(async () => {
  await teardownState()
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
    content: '# 标题\n\n正文。',
    html: '<h1>标题</h1><p>正文。</p>',
    description: '描述',
    category: '未分类',
    tags: null,
    status: 'draft',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: null,
    updated_at: null,
    ...overrides,
  }
}

async function sourceIdentityCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM source_identities'))[0]?.n ?? 0
}

async function linkCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM article_source_links'))[0]?.n ?? 0
}

describe('lib/source-identity — identity idempotency', { timeout: 120_000 }, () => {
  it('same normalized URL resolves to the same identity with zero new rows', async () => {
    const db = createDatabase()
    const before = await sourceIdentityCount()
    const a = await resolveSourceUrl(db, 'https://Example.com/page?utm_source=x')
    const b = await resolveSourceUrl(db, 'https://example.com/page')
    expect(a.outcome).toBe('resolved')
    expect(b.outcome).toBe('resolved')
    if (a.outcome !== 'resolved' || b.outcome !== 'resolved') return
    expect(a.identity.id).toBe(b.identity.id)
    expect(a.identity.existing).toBe(false)
    expect(b.identity.existing).toBe(true) // already recorded → idempotent
    // Repeated recording must not inflate the identity table.
    expect(await sourceIdentityCount()).toBe(before + 1)
  })
})

describe('create + source — 重复录入零新增', { timeout: 120_000 }, () => {
  it('duplicate submission returns the same article + version + source, zero new rows', async () => {
    const db = createDatabase()
    const url = `https://example.com/articles/${fresh('u')}`
    const snap = snapshot({ title: '源稿建稿', status: 'draft' })
    const creationId = fresh('c')

    const first = await create(db, { creationId, snapshot: snap, source: { url } })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return
    expect(first.source?.link?.status).toBe('pending')
    expect(first.source?.sourceIdentity.canonicalUrl).toBe(url)

    const identitiesBefore = await sourceIdentityCount()
    const linksBefore = await linkCount()

    // Response-lost retry: the same creation id returns the same article + version.
    const retry = await create(db, { creationId, snapshot: snap, source: { url } })
    expect(retry.outcome).toBe('existing')
    if (retry.outcome !== 'existing') return
    expect(retry.articleId).toBe(first.articleId)
    expect(retry.postRef).toBe(first.postRef)
    expect(retry.version).toBe(first.version)
    expect(retry.source?.link?.status).toBe('pending')
    expect(retry.source?.link?.operationId).toBe(`source:${creationId}`)

    expect(await sourceIdentityCount()).toBe(identitiesBefore)
    expect(await linkCount()).toBe(linksBefore)
  })

  it('a duplicate SOURCE URL (different creation id) converges on the owning article', async () => {
    const db = createDatabase()
    const url = `https://example.com/clip/${fresh('url')}`
    const first = await create(db, {
      creationId: fresh('x1'),
      snapshot: snapshot({ title: '首剪' }),
      source: { url },
    })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return

    const articlesBefore = (
      await query<{ n: number }>('SELECT COUNT(*) AS n FROM articles')
    )[0]?.n as number
    const linksBefore = await linkCount()

    // A second clip of the same page must NOT create a second article.
    const again = await create(db, {
      creationId: fresh('x2'),
      snapshot: snapshot({ title: '重剪' }),
      source: { url },
    })
    expect(again.outcome).toBe('source-linked')
    if (again.outcome !== 'source-linked') return
    expect(again.articleId).toBe(first.articleId)
    expect(again.postRef).toBe(first.postRef)
    expect(again.source?.link?.status).toBe('pending')

    // zero new articles and zero new links
    const articlesAfter = (
      await query<{ n: number }>('SELECT COUNT(*) AS n FROM articles')
    )[0]?.n as number
    expect(articlesAfter).toBe(articlesBefore)
    expect(await linkCount()).toBe(linksBefore)
  }, 60_000)
})

describe('pending-link 状态机', { timeout: 120_000 }, () => {
  it('pending → confirmed, then replay is a no-op', async () => {
    const db = createDatabase()
    const url = `https://example.com/confirm/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('cc'),
      snapshot: snapshot({ title: '待确认' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created' || !created.source?.link) return
    const { sourceIdentityId, articleId } = created.source.link

    const confirmed = await confirmSourceLink(db, {
      sourceIdentityId,
      articleId,
      expectedStatus: 'pending',
      operationId: fresh('op-confirm'),
    })
    expect(confirmed.outcome).toBe('confirmed')
    if (confirmed.outcome !== 'confirmed') return
    expect(confirmed.link.status).toBe('confirmed')

    // A repeated confirm (any operation id) is a no-op — outcome already reached.
    const again = await confirmSourceLink(db, {
      sourceIdentityId,
      articleId,
      expectedStatus: 'pending',
      operationId: fresh('op-confirm-2'),
    })
    expect(again.outcome).toBe('replayed')
    const pairCount =
      (await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM article_source_links
         WHERE source_identity_id = ${sourceIdentityId} AND article_id = ${articleId}`,
      ))[0]?.n ?? 0
    expect(pairCount).toBe(1) // replay added no new link for this pair
  })

  it('pending → cancelled; off-terminal transitions are refused', async () => {
    const db = createDatabase()
    const url = `https://example.com/cancel/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('can'),
      snapshot: snapshot({ title: '取消' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created' || !created.source?.link) return
    const { sourceIdentityId, articleId } = created.source.link

    const cancelled = await cancelSourceLink(db, {
      sourceIdentityId,
      articleId,
      expectedStatus: 'pending',
      operationId: fresh('op-cancel'),
    })
    expect(cancelled.outcome).toBe('cancelled')
    if (cancelled.outcome !== 'cancelled') return
    expect(cancelled.link.status).toBe('cancelled')

    // Confirming a CANCELLED (terminal) link is refused.
    const confirmLater = await confirmSourceLink(db, {
      sourceIdentityId,
      articleId,
      expectedStatus: 'pending',
      operationId: fresh('op-confirm-after'),
    })
    expect(confirmLater.outcome).toBe('not-found') // no live (non-cancelled) link
  })

  it('写回失败无隐藏孤儿 — a missing link is converged on replay and stays confirmable/cancellable', async () => {
    const db = createDatabase()
    const url = `https://example.com/orphan/${fresh('u')}`
    const creationId = fresh('orphan')
    const snap = snapshot({ title: '孤儿收敛' })

    const created = await create(db, { creationId, snapshot: snap, source: { url } })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created' || !created.source?.link) return

    // Simulate a failed write-back: article committed, link missing.
    await query(`DELETE FROM article_source_links WHERE operation_id = 'source:${creationId}'`)

    // Replay the same creation → the pending link is re-converged (no hidden orphan).
    const retry = await create(db, { creationId, snapshot: snap, source: { url } })
    expect(retry.outcome).toBe('existing')
    if (retry.outcome !== 'existing' || !retry.source?.link) return
    expect(retry.source.link.status).toBe('pending')

    // ...and it can be confirmed or cancelled.
    const confirmed = await confirmSourceLink(db, {
      sourceIdentityId: retry.source.link.sourceIdentityId,
      articleId: retry.source.link.articleId,
      expectedStatus: 'pending',
      operationId: fresh('op-recover'),
    })
    expect(confirmed.outcome).toBe('confirmed')
  })
})

describe('复制身份碰撞 → 作者选归属', { timeout: 120_000 }, () => {
  it('a URL already live-linked to another article is refused, never guessed', async () => {
    const db = createDatabase()
    const url = `https://example.com/owned/${fresh('u')}`
    const first = await create(db, {
      creationId: fresh('own1'),
      snapshot: snapshot({ title: '归属A' }),
      source: { url },
    })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created' || !first.source?.link) return

    // A second article B explicitly attaches the same URL → collision.
    const b = await create(db, {
      creationId: fresh('own2'),
      snapshot: snapshot({ title: '归属B' }),
    })
    expect(b.outcome).toBe('created')
    if (b.outcome !== 'created') return

    const attach = await linkSourceToArticle(db, {
      operationId: fresh('op-attach'),
      url,
      articleId: b.articleId,
    })
    expect(attach.outcome).toBe('collision')
    if (attach.outcome !== 'collision') return
    expect(attach.sourceIdentity.canonicalUrl).toBe(url)
    expect(attach.existingLink.articleId).toBe(first.articleId)

    // Author chooses: cancel the original ownership, then re-attach to B.
    const cancelled = await cancelSourceLink(db, {
      sourceIdentityId: attach.existingLink.sourceIdentityId,
      articleId: attach.existingLink.articleId,
      expectedStatus: 'pending',
      operationId: fresh('op-cancel-own'),
    })
    expect(cancelled.outcome).toBe('cancelled')

    const reattach = await linkSourceToArticle(db, {
      operationId: fresh('op-reattach'),
      url,
      articleId: b.articleId,
    })
    expect(reattach.outcome).toBe('applied')
    if (reattach.outcome !== 'applied') return
    expect(reattach.link.articleId).toBe(b.articleId)
    expect(reattach.link.status).toBe('pending')
  })
})

describe('mergeSourceVariant — URL 变体需显式合并', { timeout: 120_000 }, () => {
  it('only an explicit merge maps a semantic variant to the target identity', async () => {
    const db = createDatabase()
    const https = 'https://example.com/variant/path'
    const http = 'http://example.com/variant/path'

    // Different scheme = different identity, NOT auto-merged (不猜身份).
    const a = await resolveSourceUrl(db, https)
    const b = await resolveSourceUrl(db, http)
    expect(a.outcome).toBe('resolved')
    expect(b.outcome).toBe('resolved')
    if (a.outcome !== 'resolved' || b.outcome !== 'resolved') return
    expect(a.identity.id).not.toBe(b.identity.id)

    // Explicit merge: http variant now resolves to the https identity.
    const merged = await mergeSourceVariant(db, {
      operationId: fresh('op-merge'),
      variantUrl: http,
      targetIdentityId: a.identity.id,
    })
    expect(merged.outcome).toBe('merged')

    const again = await resolveSourceUrl(db, http)
    expect(again.outcome).toBe('resolved')
    if (again.outcome !== 'resolved') return
    expect(again.identity.id).toBe(a.identity.id) // variant now owned by target

    // Re-merge same operation → replay, no new row.
    const remerge = await mergeSourceVariant(db, {
      operationId: fresh('op-merge2'),
      variantUrl: http,
      targetIdentityId: a.identity.id,
    })
    expect(remerge.outcome).toBe('replayed')
  })
})

describe('rename/move 不改关系 · 一次性 API 不建关系', { timeout: 120_000 }, () => {
  it('saving a new slug does not change the source link row (rename/move safe)', async () => {
    const db = createDatabase()
    const url = `https://example.com/rename/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('rn'),
      snapshot: snapshot({ title: '改名', slug: fresh('old-slug') }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created' || !created.source?.link) return
    const { articleId, sourceIdentityId } = created.source.link
    const version = created.version

    const linksBefore = (
      await query<Record<string, unknown>>(
        `SELECT source_identity_id, article_id, status FROM article_source_links WHERE operation_id = 'source:${created.operationId.replace('create:', '')}'`,
      )
    )[0]

    const saved = await save(db, {
      articleId,
      expectedVersion: version,
      operationId: fresh('op-rename'),
      snapshot: snapshot({ title: '改名后', slug: fresh('new-slug') }),
    })
    expect(saved.outcome).toBe('applied')

    const linksAfter = (
      await query<Record<string, unknown>>(
        `SELECT source_identity_id, article_id, status FROM article_source_links WHERE source_identity_id = ${sourceIdentityId} AND article_id = ${articleId}`,
      )
    )[0]
    expect(linksAfter).toEqual(linksBefore) // relationship unchanged by slug change
  })

  it('one-shot create WITHOUT a source URL builds NO relationship', async () => {
    const db = createDatabase()
    const identitiesBefore = await sourceIdentityCount()
    const linksBefore = await linkCount()

    const noun = await create(db, {
      creationId: fresh('oneshot'),
      snapshot: snapshot({ title: '一次性' }),
    })
    expect(noun.outcome).toBe('created')
    if (noun.outcome !== 'created') return

    expect(await sourceIdentityCount()).toBe(identitiesBefore)
    expect(await linkCount()).toBe(linksBefore)
  })

  it('an invalid source URL is refused without creating anything', async () => {
    const db = createDatabase()
    const identitiesBefore = await sourceIdentityCount()
    const result = await create(db, {
      creationId: fresh('bad'),
      snapshot: snapshot({ title: '坏URL' }),
      source: { url: 'not a url' },
    })
    expect(result.outcome).toBe('invalid-source')
    expect(await sourceIdentityCount()).toBe(identitiesBefore)
  })
})
