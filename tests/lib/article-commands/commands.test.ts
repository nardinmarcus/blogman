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

async function postRow(postRef: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT slug, title, content, html, description, category, tags, status, password,
            is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at,
            content_envelope, content_snapshot_sha256, source_sync_sha256
     FROM posts WHERE id = ${postRef}`,
  )
  return rows[0] ?? null
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
    const before = (await query<{ n: number }>('SELECT COUNT(*) AS n FROM posts')).at(-1)?.n as number
    const result = await create(db, {
      creationId,
      snapshot: snapshot({ title: '  ', content: '' }),
    })
    expect(result).toEqual({ outcome: 'skipped', reason: 'blank-session' })
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toEqual([])
    expect(
      await query(`SELECT id FROM article_versions WHERE operation_id = 'create:${creationId}'`),
    ).toEqual([])
    expect((await query<{ n: number }>('SELECT COUNT(*) AS n FROM posts')).at(-1)?.n).toBe(before)
  })

  it('creates the article identity + version 1 + posts compat projection atomically', async () => {
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

    // posts compat projection matches the version facts.
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
    // Pre-seed a post with that slug (outside the command layer).
    await query(
      `INSERT INTO posts (slug, title, content, html) VALUES ('${takenSlug}', '先占', '先占正文', '<p>先占正文</p>')`,
    )
    const creationId = fresh('slugconf')
    const db = createDatabase()
    const result = await create(db, { creationId, snapshot: snapshot({ slug: takenSlug }) })
    expect(result).toEqual({ outcome: 'slug-conflict', slug: takenSlug })
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toEqual([])
    expect(
      await query(`SELECT id FROM article_versions WHERE operation_id = 'create:${creationId}'`),
    ).toEqual([])
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE slug = '${takenSlug}'`)).at(-1)?.n).toBe(1)
  })

  it('rolls back the whole create batch when the slug UNIQUE fires mid-batch (transaction interruption)', async () => {
    const takenSlug = fresh('interrupt')
    await query(
      `INSERT INTO posts (slug, title, content, html) VALUES ('${takenSlug}', '先占', '先占正文', '<p>先占正文</p>')`,
    )
    const creationId = fresh('interrupt-mk')
    // The slug pre-read is stale (returns "free"); the batch then hits the real
    // UNIQUE(slug) and must roll back everything.
    const db = createDatabase({
      stale: [{ sqlIncludes: 'FROM posts WHERE slug =', rows: [] }],
    })
    const result = await create(db, { creationId, snapshot: snapshot({ slug: takenSlug }) })
    expect(result).toEqual({ outcome: 'slug-conflict', slug: takenSlug })

    // Zero partial writes: no article, no version, no second posts row.
    expect(await query(`SELECT id FROM articles WHERE draft_ref = '${creationId}'`)).toEqual([])
    expect(
      await query(`SELECT id FROM article_versions WHERE operation_id = 'create:${creationId}'`),
    ).toEqual([])
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE slug = '${takenSlug}'`)).at(-1)?.n).toBe(1)
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
      snapshot: snapshot({ title: '第二版', slug: (await query<Record<string, unknown>>(`SELECT slug FROM posts WHERE id = ${postRef}`))[0].slug as string }),
    })
    expect(v2.outcome).toBe('applied')
    if (v2.outcome !== 'applied') return
    expect(v2.version).toBe(2)
    expect(v2.postRef).toBe(postRef)

    const v3 = await save(db, {
      articleId,
      expectedVersion: 2,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '第三版', slug: (await query<Record<string, unknown>>(`SELECT slug FROM posts WHERE id = ${postRef}`))[0].slug as string }),
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
    await query(
      `INSERT INTO posts (slug, title, content, html) VALUES ('${takenSlug}', '占位', '占位正文', '<p>占位正文</p>')`,
    )
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

describe('lib/article-commands — #234-02 versioned article-level commands', { timeout: 600_000 }, () => {
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

  /** Latest snapshot's fields — the canonical state every public read resolves. */
  async function latestFields(articleId: number): Promise<Record<string, unknown> & { fields: Record<string, unknown> }> {
    const rows = await articleVersions(articleId)
    return JSON.parse(rows[0].snapshot_json as string)
  }

  it('setPinned appends an immutable version snapshot and advances the body version', async () => {
    const { articleId } = await createdArticle('置顶文章')
    const db = createDatabase()

    const result = await setPinned(db, { articleId, expectedVersion: 1, operationId: fresh('op'), is_pinned: 1 })
    expect(result).toMatchObject({ outcome: 'applied', postRef: (await findPostRef(articleId)), version: 2, existing: false })

    // The new snapshot carries the pinned state for the canonical public read.
    expect((await latestFields(articleId)).fields.is_pinned).toBe(1)
    expect((await articleVersions(articleId)).map((r) => r.version)).toEqual([2, 1])

    // Repeating the SAME operation id replays the original fact without writing.
    const replayOp = fresh('op')
    const first = await setHidden(db, { articleId, expectedVersion: 2, operationId: replayOp, is_hidden: 1 })
    expect(first).toMatchObject({ outcome: 'applied', version: 3 })
    const repeated = await setHidden(db, { articleId, expectedVersion: 3, operationId: replayOp, is_hidden: 1 })
    expect(repeated).toMatchObject({ outcome: 'replayed', existing: true, version: 3 })
    expect((await articleVersions(articleId)).map((r) => r.version)).toEqual([3, 2, 1])

    // A DIFFERENT operation whose target value is already live replays without writing.
    const noop = await setPinned(db, { articleId, expectedVersion: 3, operationId: fresh('op'), is_pinned: 1 })
    expect(noop).toMatchObject({ outcome: 'replayed', existing: true, version: 3 })
    expect(await articleVersions(articleId)).toHaveLength(3)
  })

  it('setPassword appends a snapshot; empty password == null (no-password state)', async () => {
    const { articleId } = await createdArticle('密码')
    const db = createDatabase()
    const result = await setPassword(db, { articleId, expectedVersion: 1, operationId: fresh('op'), password: 'secret' })
    expect(result).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await latestFields(articleId)).fields.password).toBe('secret')

    const cleared = await setPassword(db, { articleId, expectedVersion: 2, operationId: fresh('op'), password: '' })
    expect(cleared).toMatchObject({ outcome: 'applied', version: 3 })
    expect((await latestFields(articleId)).fields.password).toBeNull()
  })

  it('softDelete keeps the first deletion timestamp; restore returns to draft; both append snapshots', async () => {
    const { articleId } = await createdArticle('软删除')
    const db = createDatabase()

    const first = await softDelete(db, { articleId, expectedVersion: 1, operationId: 'del-op' })
    expect(first).toMatchObject({ outcome: 'applied', version: 2 })
    const stamp = (await latestFields(articleId)).fields.deleted_at
    expect(stamp).not.toBeNull()

    // Repeating the same operation id is a replay; the FIRST timestamp is preserved.
    const repeated = await softDelete(db, { articleId, expectedVersion: 2, operationId: 'del-op' })
    expect(repeated).toMatchObject({ outcome: 'replayed', existing: true })
    expect((await latestFields(articleId)).fields.deleted_at).toBe(stamp)
    expect(await articleVersions(articleId)).toHaveLength(2)

    const restored = await restore(db, { articleId, expectedVersion: 2, operationId: 're-op' })
    expect(restored).toMatchObject({ outcome: 'applied', version: 3 })
    const fields = (await latestFields(articleId)).fields
    expect(fields.status).toBe('draft')
    expect(fields.deleted_at).toBeNull()
  })

  it('setCategory appends a snapshot and moves categories.post_count deltas in the same transaction', async () => {
    const { articleId, categoriesCount } = await createdArticle('分类')
    const db = createDatabase()
    await query("INSERT OR IGNORE INTO categories (name, slug, post_count) VALUES ('随笔', 'essay', 0)")
    const before = await categoriesCount()

    const result = await setCategory(db, { articleId, expectedVersion: 1, operationId: fresh('op'), category: '随笔' })
    expect(result).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await latestFields(articleId)).fields.category).toBe('随笔')

    const after = await categoriesCount()
    expect((after['AI工具'] ?? 0) - (before['AI工具'] ?? 0)).toBe(-1)
    expect((after['随笔'] ?? 0) - (before['随笔'] ?? 0)).toBe(1)

    // Moving back to NULL decrements only the source category.
    const back = await setCategory(db, { articleId, expectedVersion: 2, operationId: fresh('op'), category: null })
    expect(back).toMatchObject({ outcome: 'applied', version: 3 })
    const finalCounts = await categoriesCount()
    expect((finalCounts['随笔'] ?? 0) - after['随笔']).toBe(-1)
  })

  it('rejects a stale expected version as a conflict with zero writes (旧请求拒绝)', async () => {
    const { articleId } = await createdArticle('旧请求')
    const db = createDatabase()
    await save(db, { articleId, expectedVersion: 1, operationId: fresh('op'), snapshot: snapshot({ title: '第二版' }) })

    const stale = await setHidden(db, { articleId, expectedVersion: 1, operationId: fresh('op'), is_hidden: 1 })
    expect(stale.outcome).toBe('conflict')
    if (stale.outcome !== 'conflict') return
    expect(stale.serverVersion).toBe(2)

    // Nothing changed: still exactly two versions, hidden still 0.
    expect(await articleVersions(articleId)).toHaveLength(2)
    expect((await latestFields(articleId)).fields.is_hidden).toBe(0)
  })

  it('batch classification returns per-article applied/conflict, never blocking each other or silently overwriting', async () => {
    const good = await createdArticle('批量好')
    const conflicting = await createdArticle('批量冲突')
    const db = createDatabase()

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
    expect(result.items[0].outcome).toBe('applied')
    expect(result.items[1].outcome).toBe('conflict')
    if (result.items[1].outcome === 'conflict') expect(result.items[1].serverVersion).toBe(2)
    expect(result.items[2].outcome).toBe('not-found')

    // The good article moved; the conflicting article was NOT silently overwritten.
    expect((await latestFields(good.articleId)).fields.category).toBe('随笔')
    expect((await latestFields(conflicting.articleId)).fields.category).toBe('AI工具')
  })

  it('an article-level action advances the version so a long-open editor save conflicts (编辑端冲突属预期)', async () => {
    const { articleId } = await createdArticle('修订')
    const db = createDatabase()

    const pin = await setPinned(db, { articleId, expectedVersion: 1, operationId: fresh('op'), is_pinned: 1 })
    expect(pin).toMatchObject({ outcome: 'applied', version: 2 })

    // The editor's pending save anchored on v1 now conflicts — refresh + replay.
    const staleSave = await save(db, {
      articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '第三版' }),
    })
    expect(staleSave.outcome).toBe('conflict')

    const v3 = await save(db, {
      articleId,
      expectedVersion: 2,
      operationId: fresh('op'),
      snapshot: snapshot({ title: '第三版' }),
    })
    expect(v3).toMatchObject({ outcome: 'applied', version: 3 })
    expect((await articleVersions(articleId)).map((r) => r.version)).toEqual([3, 2, 1])
    expect((await latestFields(articleId)).fields.title).toBe('第三版')
  })

  async function findPostRef(articleId: number): Promise<number> {
    const rows = await query<{ post_ref: number }>(`SELECT post_ref FROM articles WHERE id = ${articleId}`)
    return rows[0]!.post_ref
  }
})
