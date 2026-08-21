/**
 * B2-03 — versioned article write command kernel tests.
 *
 * Isolated D1 through one shared in-process Miniflare instance (real workerd
 * engine, real D1 binding — zero wrangler CLI spawns during execution),
 * bootstrapped once per suite. Exercises the full command surface of
 * lib/article-commands: response-lost replay, duplicate commands, concurrent
 * saves, stale expected versions, slug conflicts, transaction interruption,
 * and projection failure.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, publishTemp, save, setPinned, setHidden, setPassword, setCategory, softDelete, restore, batchSetCategory } from '@/lib/article-commands'
import { bootstrapState, createDatabase, query, teardownState } from './helpers'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b203-commands-'))
  cleanup.push(state)
  await bootstrapState(state)
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
    title: '你好世界',
    content: '# 标题\n\n正文段落。',
    html: '<h1>标题</h1><p>正文段落。</p>',
    description: '描述',
    category: 'AI工具',
    tags: ['甲', '乙'],
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

/**
 * Materialize the legacy-compatible article state from CANONICAL facts
 * (latest immutable version snapshot) — the projection is retired (ADR 0008).
 */
async function postRow(postRef: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT v.snapshot_json FROM articles a
     JOIN article_versions v ON v.article_id = a.id
     WHERE a.post_ref = ${postRef} ORDER BY v.version DESC LIMIT 1`,
  )
  const raw = rows[0]
  if (!raw) return null
  const record = JSON.parse(raw.snapshot_json as string) as {
    fields: Record<string, unknown>
    original_content: string | null
    original_html: string | null
    envelope: unknown
    content_snapshot_sha256: string | null
  }
  return {
    slug: record.fields.slug,
    title: record.fields.title,
    content: record.original_content,
    html: record.original_html,
    description: record.fields.description,
    category: record.fields.category,
    tags: record.fields.tags,
    status: record.fields.status,
    password: record.fields.password,
    is_pinned: record.fields.is_pinned,
    is_hidden: record.fields.is_hidden,
    cover_image: record.fields.cover_image,
    deleted_at: record.fields.deleted_at,
    published_at: record.fields.published_at,
    updated_at: record.fields.updated_at,
    content_envelope: record.envelope ? JSON.stringify(record.envelope) : null,
    content_snapshot_sha256: record.content_snapshot_sha256,
  }
}

/** Current observable slug of an article — from its latest frozen snapshot. */
async function currentSlug(postRef: number): Promise<string> {
  const rows = await query<Record<string, unknown>>(
    `SELECT v.snapshot_json FROM articles a
     JOIN article_versions v ON v.article_id = a.id
     WHERE a.post_ref = ${postRef} ORDER BY v.version DESC LIMIT 1`,
  )
  const record = JSON.parse(rows[0].snapshot_json as string) as { fields: { slug: string } }
  return record.fields.slug
}

/** Seed a slug owned by a foreign article id in the address registry. */
const FOREIGN_ARTICLE_ID = 987654
async function seedTakenSlug(slug: string): Promise<void> {
  await query(
    `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
     VALUES ('${slug}', ${FOREIGN_ARTICLE_ID}, 'candidate', strftime('%s','now'), strftime('%s','now'))`,
  )
}

async function articleVersions(articleId: number): Promise<Array<Record<string, unknown>>> {
  return query<Record<string, unknown>>(
    `SELECT id, article_id, version, operation_id, snapshot_json,
            content_snapshot_sha256, published_at
     FROM article_versions WHERE article_id = ${articleId} ORDER BY version DESC`,
  )
}

describe('lib/article-commands — create', { timeout: 600_000 }, () => {
  it('skips a blank session (no title and no body) with zero writes', async () => {
    const creationId = fresh('blank')
    const db = createDatabase()
    const before = (await query<{ n: number }>('SELECT COUNT(*) AS n FROM article_slug_addresses')).at(-1)?.n as number
    const result = await create(db, {
      creationId,
      snapshot: snapshot({ title: '  ', content: '' }),
    })
    expect(result).toEqual({ outcome: 'skipped', reason: 'blank-session' })
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toEqual([])
    expect(
      await query(`SELECT id FROM article_versions WHERE operation_id = 'create:${creationId}'`),
    ).toEqual([])
    expect((await query<{ n: number }>('SELECT COUNT(*) AS n FROM article_slug_addresses')).at(-1)?.n).toBe(before)
  })

  it('creates the article identity + version 1 atomically (no projection)', async () => {
    const creationId = fresh('mk')
    const snap = snapshot({ title: '建稿标题', status: 'published' })
    const db = createDatabase()
    const result = await create(db, { creationId, snapshot: snap })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.existing).toBe(false)
    expect(result.version).toBe(1)
    expect(result.operationId).toBe(`create:${creationId}`)

    // articles identity row, draft_ref = creationId, slug + post_ref filled.
    const articles = await query<Record<string, unknown>>(
      `SELECT id, post_ref, slug, draft_ref FROM articles WHERE draft_ref = '${creationId}'`,
    )
    expect(articles).toHaveLength(1)
    expect(articles[0].slug).toBe(snap.slug)
    expect(result.postRef).toBe(articles[0].post_ref)

    // version-1 fact.
    const versions = await articleVersions(result.articleId)
    expect(versions).toHaveLength(1)
    expect(versions[0].version).toBe(1)
    expect(versions[0].operation_id).toBe(`create:${creationId}`)

    // snapshot record: stamped post_ref + version, envelope + hashes present.
    const record = JSON.parse(versions[0].snapshot_json as string) as Record<string, unknown>
    expect(record.format).toBe('blogman-article-identity/v1')
    expect(record.post_ref).toBe(articles[0].post_ref)
    expect(record.version).toBe(1)
    expect(record.title ?? (record.fields as Record<string, unknown>).title).toBe('建稿标题')
    expect((record.fields as Record<string, unknown>).status).toBe('published')
    expect(record.envelope).not.toBeNull()
    expect(record.content_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.source_sync_sha256).toMatch(/^[0-9a-f]{64}$/)

    // Canonical state matches the version facts.
    const post = await postRow(result.postRef)
    expect(post).not.toBeNull()
    expect(post!.slug).toBe(snap.slug)
    expect(post!.status).toBe('published')
    expect(post!.content_envelope).not.toBeNull()
    expect(post!.content_snapshot_sha256).toBe(record.content_snapshot_sha256)
    expect(post!.published_at).not.toBeNull() // first publish -> now
  })

  it('replays a lost-response creation as the same article (at most one per creation id)', async () => {
    const creationId = fresh('replay')
    const db = createDatabase()
    const first = await create(db, { creationId, snapshot: snapshot({ title: '原稿' }) })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return

    const second = await create(db, {
      creationId,
      snapshot: snapshot({ title: '换了个内容' }), // different payload, same key
    })
    expect(second).toMatchObject({
      outcome: 'existing',
      articleId: first.articleId,
      postRef: first.postRef,
      version: 1,
      operationId: `create:${creationId}`,
      existing: true,
    })

    // Still exactly one article + one version; original facts untouched.
    expect(
      await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`),
    ).toHaveLength(1)
    expect(await articleVersions(first.articleId)).toHaveLength(1)
    expect((await postRow(first.postRef))!.title).toBe('原稿')
  })

  it('returns slug-conflict with zero writes when the slug is already taken', async () => {
    const takenSlug = fresh('taken')
    // Pre-seed the address registry with a foreign owner (outside the command layer).
    await seedTakenSlug(takenSlug)
    const creationId = fresh('slugconf')
    const db = createDatabase()
    const result = await create(db, { creationId, snapshot: snapshot({ slug: takenSlug }) })
    expect(result).toEqual({ outcome: 'slug-conflict', slug: takenSlug })
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toEqual([])
    expect(
      await query(`SELECT id FROM article_versions WHERE operation_id = 'create:${creationId}'`),
    ).toEqual([])
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_slug_addresses WHERE slug = '${takenSlug}'`)).at(-1)?.n).toBe(1)
  })

  it('rolls back the whole create batch when the registry UNIQUE fires mid-batch (transaction interruption)', async () => {
    const takenSlug = fresh('interrupt')
    await seedTakenSlug(takenSlug)
    const creationId = fresh('interrupt-mk')
    // The registry pre-read is stale (returns "free"); the batch then hits the
    // real registry UNIQUE(slug) and must roll back everything.
    const db = createDatabase({
      stale: [{ sqlIncludes: 'FROM article_slug_addresses WHERE slug =', rows: [] }],
    })
    const result = await create(db, { creationId, snapshot: snapshot({ slug: takenSlug }) })
    expect(result).toEqual({ outcome: 'slug-conflict', slug: takenSlug })

    // Zero partial writes: no article, no version, no second registry row.
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toEqual([])
    expect(
      await query(`SELECT id FROM article_versions WHERE operation_id = 'create:${creationId}'`),
    ).toEqual([])
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_slug_addresses WHERE slug = '${takenSlug}'`)).at(-1)?.n).toBe(1)
  })
})

describe('lib/article-commands — save', { timeout: 600_000 }, () => {
  async function createdArticle(title: string): Promise<{ articleId: number; postRef: number; slug: string }> {
    const creationId = fresh('save-base')
    const snap = snapshot({ title, slug: fresh('save-slug') })
    const result = await create(createDatabase(), { creationId, snapshot: snap })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('create failed')
    return { articleId: result.articleId, postRef: result.postRef, slug: snap.slug }
  }

  it('writes the next monotonic version only when the expected version matches', async () => {
    const { articleId, postRef } = await createdArticle('单调版本')
    const db = createDatabase()

    const v2 = await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '第二版', slug: await currentSlug(postRef) }),
    })
    expect(v2.outcome).toBe('applied')
    if (v2.outcome !== 'applied') return
    expect(v2.version).toBe(2)
    expect(v2.postRef).toBe(postRef)

    const v3 = await save(db, {
      articleId,
      expectedVersion: 2,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '第三版', slug: await currentSlug(postRef) }),
    })
    expect(v3.outcome).toBe('applied')
    if (v3.outcome !== 'applied') return
    expect(v3.version).toBe(3)

    const versions = (await articleVersions(articleId)).map((row) => row.version)
    expect(versions).toEqual([3, 2, 1])

    // posts compat projection follows the latest version.
    const post = await postRow(postRef)
    expect(post!.title).toBe('第三版')
    expect(post!.content_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('replays the original result for the same operation id (response-lost save)', async () => {
    const { articleId, postRef } = await createdArticle('重放保存')
    const db = createDatabase()
    const opId = fresh('replay-op')
    const payload = snapshot({ title: '重放内容' })

    const first = await save(db, { articleId, expectedVersion: 1, operationId: opId, snapshot: payload })
    expect(first.outcome).toBe('applied')
    if (first.outcome !== 'applied') return
    expect(first.version).toBe(2)

    const again = await save(db, { articleId, expectedVersion: 2, operationId: opId, snapshot: payload })
    expect(again).toMatchObject({
      outcome: 'replayed',
      articleId,
      postRef,
      version: 2,
      operationId: opId,
      existing: true,
    })

    // No new version, posts untouched by the replay.
    expect(await articleVersions(articleId)).toHaveLength(2)
    expect((await postRow(postRef))!.title).toBe('重放内容')
  })

  it('rejects a stale expected version with the server version + comparison facts and zero writes', async () => {
    const { articleId, postRef } = await createdArticle('旧版本冲突')
    const db = createDatabase()
    await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '服务端第二版' }),
    })

    const conflict = await save(db, {
      articleId,
      expectedVersion: 1, // stale — server is already at 2
      operationId: fresh('op'),
      snapshot: snapshot({ title: '客户端旧版想覆盖' }),
    })
    expect(conflict.outcome).toBe('conflict')
    if (conflict.outcome !== 'conflict') return
    expect(conflict.serverVersion).toBe(2)
    expect(conflict.expectedVersion).toBe(1)
    expect(conflict.postRef).toBe(postRef)
    expect(conflict.facts.version).toBe(2)
    expect(conflict.facts.title).toBe('服务端第二版')
    expect(conflict.facts.content_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)

    // Zero partial writes.
    expect(await articleVersions(articleId)).toHaveLength(2)
    expect((await postRow(postRef))!.title).toBe('服务端第二版')
  })

  it('detects a concurrent save that lost the race between pre-read and batch (zero partial writes)', async () => {
    const { articleId, postRef } = await createdArticle('并发保存')
    const dbReal = createDatabase()
    // Server commits v2 via a first writer.
    const winner = await save(dbReal, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '先到者第二版' }),
    })
    expect(winner.outcome).toBe('applied')
    if (winner.outcome !== 'applied') return

    // Second writer read the latest version BEFORE the first writer committed
    // (stale pre-read simulates the race window); server state is already v2.
    const staleV1 = (
      await query<Record<string, unknown>>(
        `SELECT id, article_id, version, operation_id, snapshot_json,
                content_snapshot_sha256, published_at
         FROM article_versions WHERE article_id = ${articleId} AND version = 1`,
      )
    )[0]
    const dbStale = createDatabase({
      stale: [{ sqlIncludes: 'ORDER BY version DESC LIMIT 1', rows: [staleV1] }],
    })

    const loser = await save(dbStale, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '后到者试图覆盖' }),
    })
    expect(loser.outcome).toBe('conflict')
    if (loser.outcome !== 'conflict') return
    expect(loser.serverVersion).toBe(2)

    // The guarded batch wrote nothing: versions still [2,1], posts still the winner's.
    expect((await articleVersions(articleId)).map((row) => row.version)).toEqual([2, 1])
    expect((await postRow(postRef))!.title).toBe('先到者第二版')
    expect((await postRow(postRef))!.content_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns slug-conflict with zero writes when renaming to a taken slug', async () => {
    const { articleId, postRef } = await createdArticle('改slug冲突')
    const takenSlug = fresh('taken-save')
    await seedTakenSlug(takenSlug)
    const db = createDatabase()
    const result = await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ slug: takenSlug, title: '想改名' }),
    })
    expect(result).toEqual({ outcome: 'slug-conflict', slug: takenSlug })
    expect(await articleVersions(articleId)).toHaveLength(1)
    expect((await postRow(postRef))!.slug).not.toBe(takenSlug)
  })
})

describe('lib/article-commands — publishTemp', { timeout: 600_000 }, () => {
  async function publishedArticle(): Promise<{ articleId: number; postRef: number }> {
    const creationId = fresh('pub-base')
    const result = await create(createDatabase(), {
      creationId,
      snapshot: snapshot({ title: '临时发布基稿', status: 'published' }),
    })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('create failed')
    return { articleId: result.articleId, postRef: result.postRef }
  }

  it('transitions draft<->published with version + status preconditions; first published_at now', async () => {
    const { articleId } = await publishedArticle() // v1 = published
    const db = createDatabase()

    const toDraft = await publishTemp(db, {
      articleId,
      expectedVersion: 1,
      currentStatus: 'published',
      operationId: fresh('op'),
      status: 'draft',
    })
    expect(toDraft).toMatchObject({ outcome: 'applied', version: 2 })
    if (toDraft.outcome !== 'applied') return

    const toPublished = await publishTemp(db, {
      articleId,
      expectedVersion: 2,
      currentStatus: 'draft',
      operationId: fresh('op'),
      status: 'published',
    })
    expect(toPublished).toMatchObject({ outcome: 'applied', version: 3 })
    if (toPublished.outcome !== 'applied') return

    const post = await postRow(toPublished.postRef)
    expect(post!.status).toBe('published')
    expect(post!.published_at).not.toBeNull()

    // Version facts record both transitions with the observable published time.
    const versions = await articleVersions(articleId)
    expect(versions.map((row) => row.version)).toEqual([3, 2, 1])
    const vStatus3 = (JSON.parse(versions[0].snapshot_json as string) as { fields: { status: string } }).fields.status
    expect(vStatus3).toBe('published')
  })

  it('keeps the first published_at on unpublish and records the draft with no observable time (never fabricates)', async () => {
    const { articleId, postRef } = await publishedArticle()
    const db = createDatabase()
    const before = (await postRow(postRef))!.published_at as number

    const unpublish = await publishTemp(db, {
      articleId,
      expectedVersion: 1,
      currentStatus: 'published',
      operationId: fresh('op'),
      status: 'draft',
    })
    expect(unpublish.outcome).toBe('applied')
    if (unpublish.outcome !== 'applied') return

    // Legacy compat: posts keeps the first published time.
    expect((await postRow(postRef))!.status).toBe('draft')
    expect((await postRow(postRef))!.published_at).toBe(before)

    // Version fact: draft has NO observable published_at.
    const draftVersion = (await articleVersions(articleId))[0]
    expect(draftVersion.published_at).toBeNull()
    const record = JSON.parse(draftVersion.snapshot_json as string) as {
      fields: { status: string; published_at: number | null }
      published_at: number | null
    }
    expect(record.fields.status).toBe('draft')
    expect(record.published_at).toBeNull()
  })

  it('rejects a stale version preconditions as a conflict', async () => {
    const { articleId } = await publishedArticle()
    const db = createDatabase()
    const conflict = await publishTemp(db, {
      articleId,
      expectedVersion: 99, // stale
      currentStatus: 'published',
      operationId: fresh('op'),
      status: 'draft',
    })
    expect(conflict.outcome).toBe('conflict')
    if (conflict.outcome !== 'conflict') return
    expect(conflict.serverVersion).toBe(1)
    expect(await articleVersions(articleId)).toHaveLength(1)
  })

  it('rejects a status precondition mismatch as a status-conflict with zero writes', async () => {
    const { articleId, postRef } = await publishedArticle()
    const db = createDatabase()
    const conflict = await publishTemp(db, {
      articleId,
      expectedVersion: 1,
      currentStatus: 'draft', // wrong — it is published
      operationId: fresh('op'),
      status: 'draft', // no-op transition also refused
    })
    expect(conflict).toMatchObject({
      outcome: 'status-conflict',
      articleId,
      postRef,
      expectedVersion: 1,
      serverVersion: 1,
      currentStatus: 'published',
    })
    expect(await articleVersions(articleId)).toHaveLength(1)
    expect((await postRow(postRef))!.status).toBe('published')
  })

  it('replays the original result for the same operation id', async () => {
    const { articleId } = await publishedArticle()
    const db = createDatabase()
    const opId = fresh('op')
    const first = await publishTemp(db, {
      articleId,
      expectedVersion: 1,
      currentStatus: 'published',
      operationId: opId,
      status: 'draft',
    })
    expect(first.outcome).toBe('applied')
    if (first.outcome !== 'applied') return

    const again = await publishTemp(db, {
      articleId,
      expectedVersion: 2,
      currentStatus: 'draft',
      operationId: opId,
      status: 'draft',
    })
    expect(again).toMatchObject({ outcome: 'replayed', version: 2, operationId: opId, existing: true })
    expect(await articleVersions(articleId)).toHaveLength(2)
  })
})

describe('lib/article-commands — projections', { timeout: 600_000 }, () => {
  it('keeps core facts when an out-of-transaction projection fails (failure never rolls back)', async () => {
    const creationId = fresh('proj')
    const db = createDatabase()
    const result = await create(db, {
      creationId,
      snapshot: snapshot({ title: '投影失败稿' }),
      projections: {
        afterCommit: async () => {
          throw new Error('kv projection exploded')
        },
      },
    })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.projectionFailures).toEqual(['kv projection exploded'])

    // Core facts fully committed despite the projection failure.
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toHaveLength(1)
    expect(await articleVersions(result.articleId)).toHaveLength(1)
    expect((await postRow(result.postRef))!.title).toBe('投影失败稿')

    // A second command still works and reports its own projection failures.
    const second = await save(db, {
      articleId: result.articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '投影成功稿' }),
      projections: {
        afterCommit: async () => {
          throw new Error('vector projection exploded')
        },
      },
    })
    expect(second).toMatchObject({ outcome: 'applied', projectionFailures: ['vector projection exploded'] })
    expect(await articleVersions(result.articleId)).toHaveLength(2)
  })
})

describe('lib/article-commands — B2-06 article-level commands', { timeout: 600_000 }, () => {
  async function createdArticle(title: string): Promise<{ articleId: number; postRef: number; categoriesCount: () => Promise<Record<string, number>> }> {
    const creationId = fresh('b206-base')
    const snap = snapshot({ title, slug: fresh('b206-slug'), category: 'AI工具', status: 'published' })
    const result = await create(createDatabase(), { creationId, snapshot: snap })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('create failed')
    return {
      articleId: result.articleId,
      postRef: result.postRef,
      categoriesCount: async () => {
        const rows = await query<{ name: string; post_count: number }>('SELECT name, post_count FROM categories')
        return Object.fromEntries(rows.map((r) => [r.name, r.post_count]))
      },
    }
  }

  it('setPinned appends an immutable version carrying the patched state (ADR 0007)', async () => {
    const { articleId, postRef } = await createdArticle('置顶文章')
    const db = createDatabase()

    const result = await setPinned(db, { articleId, expectedVersion: 1, operationId: fresh('op'), is_pinned: 1 })
    expect(result).toMatchObject({ outcome: 'applied', postRef, version: 2, existing: false })

    // The new version carries the pin; the public canonical read sees it immediately.
    expect((await postRow(postRef))!.is_pinned).toBe(1)
    expect(await articleVersions(articleId)).toHaveLength(2)

    // Repeating the SAME operation id is a response-lost replay.
    const sameOp = await setPinned(db, { articleId, expectedVersion: 2, operationId: 'same-op' , is_pinned: 1 })
    expect(sameOp.outcome).toBe('replayed')

    // A no-op (already pinned) replays without writing a new version.
    const noop = await setPinned(db, { articleId, expectedVersion: 2, operationId: fresh('op'), is_pinned: 1 })
    expect(noop).toMatchObject({ outcome: 'replayed', version: 2, existing: true })
    expect(await articleVersions(articleId)).toHaveLength(2)
  })

  it('rejects a stale expected version as a conflict with zero writes (旧请求拒绝)', async () => {
    const { articleId, postRef } = await createdArticle('旧请求')
    const db = createDatabase()
    // A content revision moves the body to v2 first.
    await save(db, { articleId, expectedVersion: 1, operationId: fresh('op'), snapshot: snapshot({ title: '第二版' }) })

    const stale = await setHidden(db, { articleId, expectedVersion: 1, operationId: fresh('op'), is_hidden: 1 })
    expect(stale.outcome).toBe('conflict')
    if (stale.outcome !== 'conflict') return
    expect(stale.serverVersion).toBe(2)

    // Nothing changed: still exactly two versions, is_hidden still 0.
    expect(await articleVersions(articleId)).toHaveLength(2)
    expect((await postRow(postRef))!.is_hidden).toBe(0)
  })

  it('setPassword appends versions; empty == null', async () => {
    const { articleId, postRef } = await createdArticle('密码')
    const db = createDatabase()
    const result = await setPassword(db, { articleId, expectedVersion: 1, operationId: fresh('op'), password: 'secret' })
    expect(result).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await postRow(postRef))!.password).toBe('secret')
    expect(await articleVersions(articleId)).toHaveLength(2)

    const cleared = await setPassword(db, { articleId, expectedVersion: 2, operationId: fresh('op'), password: '' })
    expect(cleared).toMatchObject({ outcome: 'applied', version: 3 })
    expect((await postRow(postRef))!.password).toBeNull()
    expect(await articleVersions(articleId)).toHaveLength(3)
  })

  it('soft-delete keeps the first deletion timestamp; repeated lifecycle commands are idempotent and advance versions', async () => {
    const { articleId, postRef } = await createdArticle('软删除')
    const db = createDatabase()

    const first = await softDelete(db, { articleId, expectedVersion: 1, operationId: 'del-op' })
    expect(first).toMatchObject({ outcome: 'applied', version: 2 })
    const stamp = (await postRow(postRef))!.deleted_at
    expect(stamp).not.toBeNull()
    expect(await articleVersions(articleId)).toHaveLength(2)

    // Repeating the same operation id (response-lost / double-click) is a replay;
    // the FIRST deletion timestamp is preserved across it.
    const repeated = await softDelete(db, { articleId, expectedVersion: 2, operationId: 'del-op' })
    expect(repeated).toMatchObject({ outcome: 'replayed', version: 2, existing: true })
    expect((await postRow(postRef))!.deleted_at).toBe(stamp)
    expect(await articleVersions(articleId)).toHaveLength(2)

    // A second delete command with a fresh op id is a no-op replay (already deleted).
    const noop = await softDelete(db, { articleId, expectedVersion: 2, operationId: fresh('op') })
    expect(noop).toMatchObject({ outcome: 'replayed', version: 2 })
    expect(await articleVersions(articleId)).toHaveLength(2)

    // Restore returns to draft with a NULL deletion timestamp as version 3.
    const restored = await restore(db, { articleId, expectedVersion: 2, operationId: 're-op' })
    expect(restored).toMatchObject({ outcome: 'applied', version: 3 })
    const row = await postRow(postRef)
    expect(row!.status).toBe('draft')
    expect(row!.deleted_at).toBeNull()
    expect(await articleVersions(articleId)).toHaveLength(3)
  })

  it('setCategory keeps categories.post_count (deltas) and appends a version', async () => {
    const { articleId, postRef, categoriesCount } = await createdArticle('分类')
    const db = createDatabase()
    // Ensure the target category row exists so the count increment applies.
    await query("INSERT OR IGNORE INTO categories (name, slug, post_count) VALUES ('随笔', 'essay', 0)")
    const before = await categoriesCount()

    const result = await setCategory(db, { articleId, expectedVersion: 1, operationId: fresh('op'), category: '随笔' })
    expect(result).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await postRow(postRef))!.category).toBe('随笔')
    expect(await articleVersions(articleId)).toHaveLength(2)

    const after = await categoriesCount()
    // The article left 'AI工具' and entered '随笔'.
    expect((after['AI工具'] ?? 0) - (before['AI工具'] ?? 0)).toBe(-1)
    expect((after['随笔'] ?? 0) - (before['随笔'] ?? 0)).toBe(1)
  })

  it('batch classification returns per-article applied/conflict, never blocking each other or silently overwriting', async () => {
    const good = await createdArticle('批量好')
    const conflicting = await createdArticle('批量冲突')
    const db = createDatabase()

    // Conflict article: content saved elsewhere (v2), so expectedVersion 1 is stale.
    const saved = await save(db, {
      articleId: conflicting.articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '并发内容' }),
    })
    expect(saved.outcome).toBe('applied')

    const result = await batchSetCategory(db, {
      items: [
        { articleId: good.articleId, expectedVersion: 1, operationId: fresh('op'), category: '随笔' },
        { articleId: conflicting.articleId, expectedVersion: 1, operationId: fresh('op'), category: '随笔' },
        { articleId: 99999, expectedVersion: 1, operationId: fresh('op'), category: '随笔' },
      ],
    })

    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toMatchObject({ outcome: 'applied', version: 2 })
    expect(result.items[1].outcome).toBe('conflict')
    if (result.items[1].outcome === 'conflict') expect(result.items[1].serverVersion).toBe(2)
    expect(result.items[2].outcome).toBe('not-found')

    // The good article moved; the conflicting article was NOT silently overwritten.
    expect((await postRow(good.postRef))!.category).toBe('随笔')
    expect((await postRow(conflicting.postRef))!.category).toBe('AI工具')
  })

  it('an article-level action ADVANCES the version; the editor must re-anchor on the latest before saving (ADR 0007)', async () => {
    const { articleId, postRef } = await createdArticle('修订')
    const db = createDatabase()

    const v2 = await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '完整第二版', category: 'AI工具' }),
    })
    expect(v2.outcome).toBe('applied')
    if (v2.outcome !== 'applied') return
    expect(v2.version).toBe(2)

    // Pin at version 2 -> appends version 3.
    const pin = await setPinned(db, { articleId, expectedVersion: 2, operationId: fresh('op'), is_pinned: 1 })
    expect(pin).toMatchObject({ outcome: 'applied', version: 3 })

    // A save still anchored on v2 conflicts; re-anchored on v3 it lands.
    const stale = await save(db, {
      articleId,
      expectedVersion: 2,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '锚在旧版本' }),
    })
    expect(stale).toMatchObject({ outcome: 'conflict', serverVersion: 3 })

    const v4 = await save(db, {
      articleId,
      expectedVersion: 3,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '第三版' }),
    })
    expect(v4).toMatchObject({ outcome: 'applied', version: 4 })
    expect(await articleVersions(articleId)).toHaveLength(4)
    expect((await postRow(postRef))!.title).toBe('第三版')
  })
})