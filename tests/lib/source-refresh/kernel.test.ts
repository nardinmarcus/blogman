/**
 * B7-02 — 比较后显式刷新来源网页 kernel tests (issue #58).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns; single bootstrap → well under 60s). Proves the ticket's acceptance +
 * brief test surfaces:
 *
 *   - 差异展示 + 确认后更新: propose freezes the 标题/正文/媒体 diff WITHOUT a
 *     write; confirm (after explicit author confirmation) updates the article
 *     through the versioned kernel — a DRAFT writes a NEW version,
 *   - 正式文章只形成修订: confirm routes into the #34 unique active revision;
 *     the online version + projection stay untouched,
 *   - 版本变化要求重新比较: confirm refuses (stale) when the proposal's bound
 *     version no longer matches the article's current version OR the caller's
 *     expected version — the author must re-propose,
 *   - 媒体失败不得标完成: a media/provider failure in propose OR confirm writes
 *     no version and no refresh record,
 *   - 刷新记录幂等: re-proposing / re-confirming the same operation id replays
 *     the original facts with zero new rows,
 *   - 来源网页永不取得持续写作权威: the link stays `clip`, no `primary` link is
 *     created, and the B6 primary-source baseline is never advanced.
 *
 * Runs well under 60s (single Miniflare bootstrap for the whole file).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clipArticle } from '@/lib/clip'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import {
  MockMediaStore,
  MockSourceProvider,
  SOURCE_SYNC_DDL_STATEMENTS,
  type SourceContent,
} from '@/lib/source-sync'
import { SOURCE_REFRESH_DDL_STATEMENTS, proposeRefresh, confirmRefresh } from '@/lib/source-refresh'
import {
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'
import {
  bootstrapRevisionState,
  createFormalArticle,
} from '@/tests/lib/publish-revision/helpers'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b702-refresh-'))
  cleanup.push(state)
  // Full stack (ledger + identity + first-publish + revision + slug-address)
  // plus B6-01 source-identity, B6-02 source-sync (media reuse) and B7-02
  // source-refresh surfaces, so both draft and formal scenarios share one schema.
  await bootstrapRevisionState(state)
  await query('DROP TRIGGER IF EXISTS posts_ai')
  await query('DROP TRIGGER IF EXISTS posts_au')
  await query('DROP TRIGGER IF EXISTS posts_ad')
  await query('DROP TABLE IF EXISTS posts_fts')
  for (const stmt of SOURCE_IDENTITY_DDL_STATEMENTS) await query(stmt)
  for (const stmt of SOURCE_SYNC_DDL_STATEMENTS) await query(stmt)
  for (const stmt of SOURCE_REFRESH_DDL_STATEMENTS) await query(stmt)
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

function providerFor(content: SourceContent): MockSourceProvider {
  const provider = new MockSourceProvider(content)
  for (const m of content.media) {
    provider.setMediaBytes(m.ref, Buffer.from(`bytes-${m.ref}`, 'utf8'))
  }
  return provider
}

async function versionCount(articleId: number): Promise<number> {
  return (
    (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions WHERE article_id = ${articleId}`))[0]?.n ?? 0
  )
}

async function refreshRecordCount(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_refresh_records WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

async function proposalCount(articleId: number): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM source_refresh_proposals WHERE article_id = ${articleId}`))[0]?.n ?? 0
}

async function syncBaselineCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM source_sync_baselines'))[0]?.n ?? 0
}

async function linkRoles(articleId: number): Promise<string[]> {
  const rows = await query<{ role: string }>(
    `SELECT role FROM article_source_links WHERE article_id = ${articleId} AND status != 'cancelled'`,
  )
  return rows.map((r) => r.role)
}

/** Clipped article whose source then changes → the canonical propose/confirm path. */
async function createClippedDraft(url: string): Promise<{ articleId: number; postRef: number }> {
  const created = await clipArticle(createDatabase(), {
    url,
    title: '旧标题',
    content: '# 旧正文\n\n旧内容。',
  })
  expect(created.outcome).toBe('created')
  if (created.outcome !== 'created') throw new Error('clip create failed')
  return { articleId: created.articleId, postRef: created.postRef }
}


/** Latest frozen snapshot fields for an article (canonical, projection-free). */
async function canonFields(postRef: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT v.snapshot_json FROM articles a
     JOIN article_versions v ON v.article_id = a.id
      AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
     WHERE a.post_ref = ${postRef} LIMIT 1`,
  )
  const raw = rows[0]
  if (!raw) return null
  const record = JSON.parse(raw.snapshot_json as string) as {
    fields: Record<string, unknown>
    original_content: string | null
    original_html: string | null
  }
  return { ...record.fields, content: record.original_content ?? '', html: record.original_html ?? '' }
}

describe('差异展示 + 确认后更新 (draft → 新版本)', { timeout: 120_000 }, () => {
  it('propose freezes the 标题/正文/媒体 diff WITHOUT writing; confirm applies as a new version', async () => {
    const url = `https://example.com/refresh/${fresh('r')}`
    const { articleId, postRef } = await createClippedDraft(url)

    const content: SourceContent = {
      title: '  新标题(规范化)  ',
      markdown: '![主图](assets/hero.png)\n\n新正文',
      media: [{ ref: 'assets/hero.png', contentType: 'image/png', filename: 'hero.png' }],
    }
    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url,
      articleId,
      operationId: fresh('propose'),
      provider: providerFor(content),
      mediaStore: new MockMediaStore(),
    })

    // 差异展示 — nothing written yet.
    expect(proposed.outcome).toBe('proposed')
    if (proposed.outcome !== 'proposed') return
    expect(proposed.proposedVersion).toBe(1)
    expect(proposed.diff.titleChanged).toBe(true)
    expect(proposed.diff.bodyChanged).toBe(true)
    expect(proposed.diff.mediaChanged).toBe(true)
    expect(proposed.diff.media[0].status).toBe('added')
    expect(proposed.diff.changed).toBe(true)
    // no article write on propose.
    expect(await versionCount(articleId)).toBe(1)
    expect((await canonFields(postRef))?.title).toBe('旧标题')

    // 明确确认后才更新.
    const confirmed = await confirmRefresh(createDatabase(), {
      sourceUrl: url,
      articleId,
      proposalOperationId: proposed.proposalOperationId,
      expectedVersion: proposed.proposedVersion,
      operationId: fresh('confirm'),
      provider: providerFor(content),
      mediaStore: new MockMediaStore(),
    })

    expect(confirmed.outcome).toBe('refreshed')
    if (confirmed.outcome !== 'refreshed') return
    expect(confirmed.version).toBe(2)
    expect(confirmed.revisionId).toBeNull()
    expect(confirmed.projection.title).toBe('新标题(规范化)')
    expect(await versionCount(articleId)).toBe(2)

    const post = await canonFields(postRef)
    expect(post.title).toBe('新标题(规范化)')
    expect(post.content).toContain('/api/images/source-media/')
    expect(post.content).not.toContain('assets/hero.png')
    expect(await refreshRecordCount(articleId)).toBe(1)

    // proposal marked confirmed.
    const status = (await query<{ status: string }>(
      `SELECT status FROM source_refresh_proposals WHERE operation_id = '${confirmed.proposalOperationId}'`,
    ))[0].status
    expect(status).toBe('confirmed')
  })

  it('propose returns no-diff when the source matches the current article; confirm is a no-op', async () => {
    const url = `https://example.com/refresh/${fresh('same')}`
    const { articleId, postRef } = await createClippedDraft(url)
    const content: SourceContent = { title: '旧标题', markdown: '# 旧正文\n\n旧内容。', media: [] }

    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: fresh('propose'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(proposed.outcome).toBe('no-diff')

    const confirmed = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId,
      proposalOperationId: proposed.outcome === 'no-diff' ? proposed.proposalOperationId : 'x',
      expectedVersion: 1, operationId: fresh('confirm'),
      provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(confirmed.outcome).toBe('no-diff')
    // nothing written.
    expect(await versionCount(articleId)).toBe(1)
    expect((await canonFields(postRef))?.title).toBe('旧标题')
  })
})

describe('版本变化要求重新比较 (stale)', { timeout: 120_000 }, () => {
  it('refuses to confirm when the article advanced past the proposal bound version', async () => {
    const url = `https://example.com/refresh/${fresh('stale')}`
    const { articleId } = await createClippedDraft(url)
    const content: SourceContent = { title: '新标题', markdown: '# 新正文', media: [] }

    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: fresh('propose'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(proposed.outcome).toBe('proposed')
    if (proposed.outcome !== 'proposed') return
    const propOp = proposed.proposalOperationId

    // Author edits the article in between → version advances to 2.
    const { save } = await import('@/lib/article-commands')
    const saved = await save(createDatabase(), {
      articleId,
      expectedVersion: 1,
      operationId: fresh('author-edit'),
      snapshot: {
        slug: (await query<{ slug: string }>(`SELECT slug FROM articles WHERE id = ${articleId}`))[0].slug,
        title: '作者手改', content: '# 作者手改', html: '<h1>作者手改</h1>',
        description: null, category: null, tags: null, status: 'draft', password: null,
        is_pinned: 0, is_hidden: 0, cover_image: null, deleted_at: null, published_at: null, updated_at: null,
      },
    })
    expect(saved.outcome).toBe('applied')
    expect(await versionCount(articleId)).toBe(2)

    // Confirm with the proposal's bound version (1) but current is 2 → stale.
    const confirmed = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId, proposalOperationId: propOp, expectedVersion: 1,
      operationId: fresh('confirm'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(confirmed.outcome).toBe('stale')
    if (confirmed.outcome === 'stale') {
      expect(confirmed.proposedVersion).toBe(1)
      expect(confirmed.currentVersion).toBe(2)
    }
    // no new refresh record.
    expect(await refreshRecordCount(articleId)).toBe(0)
  })

  it('refuses to confirm when the caller passes a different expected version', async () => {
    const url = `https://example.com/refresh/${fresh('stale2')}`
    const { articleId } = await createClippedDraft(url)
    const content: SourceContent = { title: '新标题', markdown: '# 新正文', media: [] }

    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: fresh('propose'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(proposed.outcome).toBe('proposed')
    if (proposed.outcome !== 'proposed') return

    const confirmed = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId, proposalOperationId: proposed.proposalOperationId, expectedVersion: 99,
      operationId: fresh('confirm'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(confirmed.outcome).toBe('stale')
    expect(await refreshRecordCount(articleId)).toBe(0)
  })
})

describe('媒体失败不得标完成', { timeout: 120_000 }, () => {
  it('a media failure during propose returns media-failed with no write', async () => {
    const url = `https://example.com/refresh/${fresh('mf')}`
    const { articleId } = await createClippedDraft(url)
    const provider = providerFor({
      title: '新标题',
      markdown: '![主图](assets/hero.png)\n\n新正文',
      media: [{ ref: 'assets/hero.png', contentType: 'image/png', filename: 'hero.png' }],
    })
    provider.failMedia('assets/hero.png')

    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: fresh('propose'), provider, mediaStore: new MockMediaStore(),
    })
    expect(proposed.outcome).toBe('media-failed')
    expect(await versionCount(articleId)).toBe(1)
    expect(await refreshRecordCount(articleId)).toBe(0)
  })

  it('a media failure during confirm writes no version and no refresh record', async () => {
    const url = `https://example.com/refresh/${fresh('mf2')}`
    const { articleId } = await createClippedDraft(url)
    const content: SourceContent = {
      title: '新标题',
      markdown: '![主图](assets/hero.png)\n\n新正文',
      media: [{ ref: 'assets/hero.png', contentType: 'image/png', filename: 'hero.png' }],
    }
    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: fresh('propose'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(proposed.outcome).toBe('proposed')
    if (proposed.outcome !== 'proposed') return

    // Media disappears between propose and confirm → media-failed, not complete.
    const failing = providerFor(content)
    failing.failMedia('assets/hero.png')
    const confirmed = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId, proposalOperationId: proposed.proposalOperationId, expectedVersion: 1,
      operationId: fresh('confirm'), provider: failing, mediaStore: new MockMediaStore(),
    })
    expect(confirmed.outcome).toBe('media-failed')
    expect(await versionCount(articleId)).toBe(1)
    expect(await refreshRecordCount(articleId)).toBe(0)
  })
})

describe('刷新记录幂等', { timeout: 120_000 }, () => {
  it('re-proposing and re-confirming the same operation id replays with zero new rows', async () => {
    const url = `https://example.com/refresh/${fresh('idem')}`
    const { articleId, postRef } = await createClippedDraft(url)
    const content: SourceContent = { title: '新标题', markdown: '# 新正文', media: [] }
    const proposeOp = fresh('propose')
    const provider = providerFor(content)
    const mediaStore = new MockMediaStore()

    const first = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: proposeOp, provider, mediaStore,
    })
    const second = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: proposeOp, provider, mediaStore,
    })
    expect(first.outcome).toBe('proposed')
    expect(second.outcome).toBe('replayed')
    expect(await proposalCount(articleId)).toBe(1)

    const confirmOp = fresh('confirm')
    const c1 = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId, proposalOperationId: proposeOp, expectedVersion: 1,
      operationId: confirmOp, provider, mediaStore,
    })
    expect(c1.outcome).toBe('refreshed')
    const c2 = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId, proposalOperationId: proposeOp, expectedVersion: 1,
      operationId: confirmOp, provider, mediaStore,
    })
    expect(c2.outcome).toBe('replayed')
    expect(await refreshRecordCount(articleId)).toBe(1)
    // replay never writes a second version.
    expect(await versionCount(articleId)).toBe(2)
    expect((await canonFields(postRef))?.title).toBe('新标题')
  })
})

describe('正式文章只形成修订 + 来源网页不取得持续写作权威', { timeout: 120_000 }, () => {
  it('refresh routes a formal article into its unique active revision; the clip never becomes primary', async () => {
    const url = `https://example.com/formal/${fresh('f')}`
    const { articleId, postRef } = await createFormalArticle(fresh('formal-slug'))
    const { linkSourceToArticle } = await import('@/lib/source-identity')
    const linked = await linkSourceToArticle(createDatabase(), {
      operationId: fresh('link'), url, articleId, role: 'clip',
    })
    expect(linked.outcome).toBe('applied')

    const content: SourceContent = {
      title: '修订标题',
      markdown: '![图](assets/a.png)\n\n修订正文',
      media: [{ ref: 'assets/a.png', contentType: 'image/png', filename: 'a.png' }],
    }
    const proposed = await proposeRefresh(createDatabase(), {
      sourceUrl: url, articleId, operationId: fresh('propose'), provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(proposed.outcome).toBe('proposed')
    if (proposed.outcome !== 'proposed') return

    const confirmed = await confirmRefresh(createDatabase(), {
      sourceUrl: url, articleId, proposalOperationId: proposed.proposalOperationId,
      expectedVersion: proposed.proposedVersion, operationId: fresh('confirm'),
      provider: providerFor(content), mediaStore: new MockMediaStore(),
    })
    expect(confirmed.outcome).toBe('refreshed')
    if (confirmed.outcome !== 'refreshed') return
    expect(confirmed.version).toBe(1)
    expect(confirmed.revisionId).toBeTruthy()

    // 正式文章不写新 article_versions(线上版本保持), 只建一条 active 修订.
    expect(await versionCount(articleId)).toBe(1)
    const active = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`))[0].n
    expect(active).toBe(1)
    const post = await canonFields(postRef)
    expect(post.title).toBe('正式文章标题')

    // 来源网页永不取得持续写作权威 — role stays clip, no primary link, baseline untouched.
    expect(await linkRoles(articleId)).toEqual(['clip'])
    expect(await syncBaselineCount()).toBe(0)
  })
})
