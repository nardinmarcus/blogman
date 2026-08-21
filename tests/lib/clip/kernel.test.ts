/**
 * B7-01 — Chrome 剪藏 command kernel tests (issue #57).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns). Proves the ticket's acceptance surface:
 *
 *   - 首次剪藏建文章 + 来源关系: a clip creates a DRAFT article + a PENDING
 *     source link whose ROLE is `clip` — the page never becomes the 主要源稿,
 *   - 重复剪藏返回既有文章身份, 不重复建: the same page via tracking-noise /
 *     fragment converges on the existing article, zero new rows, body NOT
 *     backfilled (无正文回填),
 *   - 并发首次只建一篇: concurrent first clips of one URL → exactly one article,
 *   - 主要源稿与一个来源网页可共存: an article can hold a `primary` source link
 *     AND a `clip` link on different URLs (roles stay distinct),
 *   - invalid URL → invalid-source; blank clip → skipped.
 *
 * Runs well under 60s (single Miniflare bootstrap for the whole file).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import { clipArticle, clipCreationId } from '@/lib/clip'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b701-clip-'))
  cleanup.push(state)
  await bootstrapState(state)
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

async function articleCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM articles'))[0]?.n ?? 0
}

async function linkCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM article_source_links'))[0]?.n ?? 0
}

/** Latest frozen snapshot fields for an article (canonical, projection-free). */
async function postFields(postRef: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT v.snapshot_json FROM articles a
     JOIN article_versions v ON v.article_id = a.id
      AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
     WHERE a.post_ref = ${postRef} LIMIT 1`,
  )
  const raw = rows[0]
  if (!raw) return null
  const record = JSON.parse(raw.snapshot_json as string) as { fields: Record<string, unknown>; original_content: string | null }
  return { ...record.fields, content: record.original_content ?? '' }
}

async function postsBody(postRef: number): Promise<string> {
  return ((await postFields(postRef))?.content as string) ?? ''
}

describe('首次剪藏建文章 + 来源关系 (role=clip, pending)', { timeout: 120_000 }, () => {
  it('creates one draft article + one pending clip link; the page is NOT the primary source', async () => {
    const db = createDatabase()
    const url = `https://example.com/first/${fresh('clip')}`
    const beforeArticles = await articleCount()
    const beforeLinks = await linkCount()

    const result = await clipArticle(db, { url, title: '剪藏标题', content: '# 正文\n\n内容。' })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.existing).toBe(false)
    expect(result.creationId).toBe(clipCreationId(url))
    expect(result.version).toBe(1)

    // source facts: identity + a pending CLIP-role link.
    expect(result.source.link?.status).toBe('pending')
    expect(result.source.link?.role).toBe('clip')
    expect(result.source.sourceIdentity.canonicalUrl).toBe(url)

    // exactly one article + one link were added.
    expect(await articleCount()).toBe(beforeArticles + 1)
    expect(await linkCount()).toBe(beforeLinks + 1)

    // the article was created as a draft.
    const fields = await postFields(result.postRef)
    expect(fields?.status).toBe('draft')
    expect(fields?.title).toBe('剪藏标题')
  })

  it('refuses an invalid (non-http) source URL with invalid-source', async () => {
    const db = createDatabase()
    const result = await clipArticle(db, { url: 'not a url', title: 'x', content: 'y' })
    expect(result.outcome).toBe('invalid-source')
  })

  it('skips a blank clip (no title AND no content)', async () => {
    const db = createDatabase()
    const result = await clipArticle(db, {
      url: `https://example.com/blank/${fresh('b')}`,
      title: '',
      content: '',
    })
    expect(result.outcome).toBe('skipped')
  })
})

describe('重复剪藏返回既有文章身份, 不重复建 / 无正文回填', { timeout: 120_000 }, () => {
  it('the same page via tracking-noise/fragment converges on the existing article, zero new rows, no body backfill', async () => {
    const db = createDatabase()
    const url = `https://example.com/repeat/${fresh('r')}`
    const first = await clipArticle(db, {
      url: `${url}?utm_source=tw#sec`,
      title: '首剪',
      content: '# 首剪正文',
    })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return
    const articleId = first.articleId
    const postRef = first.postRef

    const articlesBefore = await articleCount()
    const linksBefore = await linkCount()

    // repeated clip of the SAME physical page (different tracking param) —
    // must NOT create a second article or a second clip.
    const again = await clipArticle(db, {
      url: `${url}?utm_campaign=launch`,
      title: '重剪（不同标题，不得回填）',
      content: '# 重剪正文（不得覆盖）',
    })

    expect(again.outcome).toBe('existing')
    if (again.outcome !== 'existing') return
    expect(again.articleId).toBe(articleId)
    expect(again.postRef).toBe(postRef)
    expect(again.creationId).toBe(first.creationId)
    expect(again.source.link?.role).toBe('clip')

    // zero new articles and zero new links.
    expect(await articleCount()).toBe(articlesBefore)
    expect(await linkCount()).toBe(linksBefore)

    // 无正文回填 — the second clip's content/title never touched the post.
    expect(await postsBody(postRef)).toContain('首剪正文')
    expect(await postsBody(postRef)).not.toContain('重剪正文')
  })
})

describe('并发首次只建一篇', { timeout: 120_000 }, () => {
  it('concurrent first clips of one URL create exactly one article', async () => {
    const db = createDatabase()
    const url = `https://example.com/concurrent/${fresh('c')}`
    const beforeArticles = await articleCount()
    const beforeLinks = await linkCount()

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        clipArticle(db, { url, title: '并发首剪', content: '# 并发正文' }),
      ),
    )

    // every attempt landed on ONE article identity.
    const articleIds = new Set(
      attempts.map((a) => (a.outcome === 'created' || a.outcome === 'existing' ? a.articleId : -1)),
    )
    expect(articleIds.size).toBe(1)

    // exactly one article and one clip link were created.
    expect(await articleCount()).toBe(beforeArticles + 1)
    expect(await linkCount()).toBe(beforeLinks + 1)

    // every concurrent attempt converged (created or existing) — never a
    // duplicate, collision or failure.
    for (const a of attempts) {
      expect(['created', 'existing']).toContain(a.outcome)
    }
  })
})

describe('主要源稿与一个来源网页可共存', { timeout: 120_000 }, () => {
  it('one article holds a PRIMARY writable-source link AND a clip link on different URLs (roles distinct)', async () => {
    const db = createDatabase()
    const primaryUrl = `https://primary.example.com/${fresh('p')}`
    const clipUrl = `https://clip.example.com/article/${fresh('k')}`

    // Establish the primary writable source on an article via the B6 chain.
    const { create } = await import('@/lib/article-commands')
    const { linkSourceToArticle } = await import('@/lib/source-identity')
    const created = await create(db, {
      creationId: fresh('primary-create'),
      snapshot: {
        slug: `primary-${fresh('s')}`, title: '主要源稿', content: '# 正文',
        html: '<h1>正文</h1>', description: null, category: '未分类', tags: null,
        status: 'draft', password: null, is_pinned: 0, is_hidden: 0,
        cover_image: null, deleted_at: null, published_at: null, updated_at: null,
      },
      source: { url: primaryUrl, role: 'primary' },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created' || !created.source?.link) return
    const articleId = created.articleId

    // Attach a clip (reference) link to the SAME article on a DIFFERENT URL.
    const attached = await linkSourceToArticle(db, {
      operationId: `clip:${fresh('op')}`,
      url: clipUrl,
      articleId,
      role: 'clip',
    })
    expect(attached.outcome).toBe('applied')
    if (attached.outcome !== 'applied') return
    expect(attached.link.role).toBe('clip')

    // Both live links coexist on ONE article, on DIFFERENT identities/roles.
    const links = await query<{ source_identity_id: number; status: string; role: string }>(
      `SELECT source_identity_id, status, role FROM article_source_links WHERE article_id = ${articleId} ORDER BY id`,
    )
    expect(links.length).toBe(2)
    expect(links.find((l) => l.role === 'primary')?.status).toBe('pending')
    expect(links.find((l) => l.role === 'clip')?.status).toBe('pending')
    expect(links[0].source_identity_id).not.toBe(links[1].source_identity_id)
  })
})
