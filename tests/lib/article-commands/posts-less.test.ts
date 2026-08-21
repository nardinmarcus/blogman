/**
 * #234 Phase A T1 — posts-less tracer suite.
 *
 * Same in-process Miniflare seam as the B2-03 command kernel suite, but the
 * shared D1 is bootstrapped WITHOUT the legacy `posts` / `posts_fts` tables
 * (dropped after the ledger migration so any residual reference fails loudly).
 * Proves the article-commands write kernel works with canonical facts only:
 * create → save → publishTemp, plus slug exclusivity through the address
 * registry (ADR 0008 / 0009).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, publishTemp, save } from '@/lib/article-commands'
import { bootstrapState, createDatabase, query, teardownState } from './helpers'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b234-postsless-'))
  cleanup.push(state)
  await bootstrapState(state, { postsless: true })
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
    slug: 'posts-less-article',
    title: '无投影文章',
    content: '# 正文\n\n一段正文。',
    html: '<p>一段正文。</p>',
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
    ...overrides,
  }
}

describe('article-commands kernel on a posts-less database', () => {
  it('creates an article without the posts projection and synthesizes a unique post_ref', async () => {
    const db = createDatabase()
    const creationId = fresh('create')
    const result = await create(db, { creationId, snapshot: snapshot() })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.articleId).toBeGreaterThan(0)
    expect(result.postRef).toBeGreaterThan(0)

    const identity = await query<{ id: number; post_ref: number; draft_ref: string }>(
      `SELECT id, post_ref, draft_ref FROM articles WHERE id = ${result.articleId}`,
    )
    expect(identity).toHaveLength(1)
    expect(identity[0].draft_ref).toBe(creationId)
    expect(identity[0].post_ref).toBe(result.postRef)

    // The slug is reserved in the address registry for this article.
    const address = await query<{ article_id: number; kind: string }>(
      `SELECT article_id, kind FROM article_slug_addresses WHERE slug = 'posts-less-article'`,
    )
    expect(address).toHaveLength(1)
    expect(address[0].article_id).toBe(result.articleId)
    expect(address[0].kind).toBe('candidate')

    // Version 1 carries the full snapshot.
    const version = await query<{ version: number; snapshot_json: string }>(
      `SELECT version, snapshot_json FROM article_versions WHERE article_id = ${result.articleId}`,
    )
    expect(version).toHaveLength(1)
    expect(version[0].version).toBe(1)
    const parsed = JSON.parse(version[0].snapshot_json) as { fields: { slug: string; status: string } }
    expect(parsed.fields.slug).toBe('posts-less-article')
    expect(parsed.fields.status).toBe('draft')
  })

  it('rejects a second create whose slug is already reserved by another article', async () => {
    const db = createDatabase()
    const first = await create(db, { creationId: fresh('dup-a'), snapshot: snapshot({ slug: 'dup-slug' }) })
    expect(first.outcome).toBe('created')

    const second = await create(db, {
      creationId: fresh('dup-b'),
      snapshot: snapshot({ slug: 'dup-slug', title: '撞地址文章' }),
    })
    expect(second).toMatchObject({ outcome: 'slug-conflict', slug: 'dup-slug' })
  })

  it('saves a new version without the projection and detects slug conflicts through the registry', async () => {
    const db = createDatabase()
    const created = await create(db, { creationId: fresh('save'), snapshot: snapshot({ slug: 'save-base' }) })
    if (created.outcome !== 'created') throw new Error(`fixture create failed: ${JSON.stringify(created)}`)

    // Rival article owns the target slug.
    await create(db, { creationId: fresh('rival'), snapshot: snapshot({ slug: 'save-taken' }) })

    const conflict = await save(db, {
      articleId: created.articleId,
      expectedVersion: 1,
      operationId: fresh('save-op'),
      snapshot: snapshot({ slug: 'save-taken' }),
    })
    expect(conflict).toMatchObject({ outcome: 'slug-conflict', slug: 'save-taken' })

    const applied = await save(db, {
      articleId: created.articleId,
      expectedVersion: 1,
      operationId: fresh('save-op-2'),
      snapshot: snapshot({ slug: 'save-next', title: '第二版标题' }),
    })
    expect(applied).toMatchObject({ outcome: 'applied', version: 2 })

    // Replaying the same operation id returns the original result.
    const replayed = await save(db, {
      articleId: created.articleId,
      expectedVersion: 1,
      operationId: applied.outcome === 'applied' ? applied.operationId : 'x',
      snapshot: snapshot({ slug: 'save-next' }),
    })
    expect(replayed).toMatchObject({ outcome: 'replayed', existing: true, version: 2 })
  })

  it('publishes temporarily with the status precondition anchored on the latest version snapshot', async () => {
    const db = createDatabase()
    const created = await create(db, { creationId: fresh('ptemp'), snapshot: snapshot({ slug: 'ptemp-base' }) })
    if (created.outcome !== 'created') throw new Error(`fixture create failed: ${JSON.stringify(created)}`)

    const wrongStatus = await publishTemp(db, {
      articleId: created.articleId,
      expectedVersion: 1,
      currentStatus: 'published',
      operationId: fresh('ptemp-op-wrong'),
      status: 'published',
    })
    expect(wrongStatus).toMatchObject({ outcome: 'status-conflict', currentStatus: 'draft' })

    const applied = await publishTemp(db, {
      articleId: created.articleId,
      expectedVersion: 1,
      currentStatus: 'draft',
      operationId: fresh('ptemp-op'),
      status: 'published',
    })
    expect(applied).toMatchObject({ outcome: 'applied', version: 2 })

    const latest = await query<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM article_versions WHERE article_id = ${created.articleId} ORDER BY version DESC LIMIT 1`,
    )
    const parsed = JSON.parse(latest[0].snapshot_json) as { fields: { status: string; published_at: number | null } }
    expect(parsed.fields.status).toBe('published')
    expect(parsed.fields.published_at).not.toBeNull()
  })
})
