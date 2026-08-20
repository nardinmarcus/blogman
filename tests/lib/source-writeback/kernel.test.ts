/**
 * B6-03 — 显式写回 Blogman 领先内容到主要源稿 kernel tests (issue #52).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns during execution) + a mocked primary-source provider. Proves the
 * ticket acceptance surface:
 *
 *   - 确认前不推进基线: the baseline moves ONLY in confirmWriteBack (a done
 *     execute leaves it untouched),
 *   - 响应丢失可 query 同一操作: re-executing / re-confirming the same operation
 *     id returns the original outcome without re-pushing,
 *   - 失败保持 Blogman 领先: a provider/device failure never advances the
 *     baseline and never blocks publish (但不可称已同步),
 *   - 版本变化保持 Blogman 领先: a newer edit after the push makes confirm
 *     reject as `stale` with no baseline advance,
 *   - 拒绝 stale baseline/冲突，不自动覆盖: a source that diverged from the
 *     baseline refuses the write-back (no blind overwrite),
 *   - 源稿仍等于基线且 Blogman 领先时才可发起 (not-leading / no-baseline /
 *     link-not-confirmed refusals).
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, publishTemp, save } from '@/lib/article-commands'
import { confirmSourceLink, resolveSourceUrl } from '@/lib/source-identity'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import { SOURCE_WRITE_BACK_DDL_STATEMENTS } from '@/lib/source-writeback'
import { MockSourceWriteProvider } from '@/lib/source-writeback/provider'
import {
  baselineFor,
  confirmWriteBack,
  executeWriteBack,
  initiateWriteBack,
  writeBackByOperation,
} from '@/lib/source-writeback'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b603-writeback-'))
  cleanup.push(state)
  await bootstrapState(state)
  for (const stmt of SOURCE_IDENTITY_DDL_STATEMENTS) {
    await query(stmt)
  }
  for (const stmt of SOURCE_WRITE_BACK_DDL_STATEMENTS) {
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

function srcHash(content: { title: string; body: string }): string {
  return createHash('sha256').update(`${content.title}\n${content.body}`).digest('hex')
}

/** A fixed 64-hex "baseline source hash" (represents the source at last sync). */
const H0 = 'a'.repeat(64)

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: fresh('slug'),
    title: '标题',
    content: '# 标题\n\n正文。',
    html: '<h1>标题</h1><p>正文。</p>',
    description: '描述',
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

interface Seeded {
  db: ReturnType<typeof createDatabase>
  articleId: number
  sourceIdentityId: number
  operationId: string
  url: string
  provider: MockSourceWriteProvider
}

/** Article at v1 + confirmed source link + a v1 baseline at source hash H0. */
async function seed(v1Title = '标题', v1Body = '# 标题\n\n正文。'): Promise<Seeded> {
  const db = createDatabase()
  const url = `https://example.com/articles/${fresh('u')}`
  const creationId = fresh('c')
  const created = await create(db, {
    creationId,
    snapshot: snapshot({ title: v1Title, content: v1Body, html: `<h1>${v1Title}</h1>` }),
    source: { url },
  })
  expect(created.outcome).toBe('created')
  if (created.outcome !== 'created') throw new Error('seed: create failed')
  const link = created.source?.link
  expect(link?.status).toBe('pending')
  const articleId = created.articleId
  const sourceIdentityId = link!.sourceIdentityId

  const confirmed = await confirmSourceLink(db, {
    sourceIdentityId,
    articleId,
    operationId: fresh('confirm'),
    expectedStatus: 'pending',
  })
  expect(confirmed.outcome).toBe('confirmed')

  await db
    .prepare(
      `INSERT INTO source_sync_baselines
         (source_identity_id, article_id, article_version, source_sync_sha256, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .bind(sourceIdentityId, articleId, H0, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
    .run()

  const provider = new MockSourceWriteProvider(H0, srcHash)
  return { db, articleId, sourceIdentityId, operationId: fresh('wb'), url, provider }
}

async function baselineRow(
  db: ReturnType<typeof createDatabase>,
  sourceIdentityId: number,
  articleId: number,
) {
  return db
    .prepare(
      `SELECT article_version, source_sync_sha256 FROM source_sync_baselines
       WHERE source_identity_id = ? AND article_id = ?`,
    )
    .bind(sourceIdentityId, articleId)
    .first<{ article_version: number; source_sync_sha256: string }>()
}

describe('B6-03 — 确认前不推进基线 · 完整流程', { timeout: 120_000 }, () => {
  it('only the external confirmation advances the baseline (execute alone does not)', async () => {
    const s = await seed()
    const db = s.db
    // Blogman 领先: save body to v2.
    const saved = await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: '改写标题', content: '# 改写标题\n\n领先正文。' }),
    })
    expect(saved.outcome).toBe('applied')
    if (saved.outcome !== 'applied') return

    const initiated = await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    expect(initiated.outcome).toBe('intent')
    if (initiated.outcome !== 'intent') return
    expect(initiated.intent.articleVersion).toBe(2)
    expect(initiated.intent.baselineVersion).toBe(1)

    // Baseline must NOT move on execute alone (确认前不推进基线).
    const executed = await executeWriteBack(db, s.provider, { operationId: s.operationId })
    expect(executed.outcome).toBe('written')
    let base = await baselineRow(db, s.sourceIdentityId, s.articleId)
    expect(base?.article_version).toBe(1)

    // External confirmation is the ONLY thing that advances it.
    const confirmed = await confirmWriteBack(db, { operationId: s.operationId })
    expect(confirmed.outcome).toBe('confirmed')
    base = await baselineRow(db, s.sourceIdentityId, s.articleId)
    expect(base?.article_version).toBe(2)
    expect(base?.source_sync_sha256).toBe(srcHash({ title: '改写标题', body: '# 改写标题\n\n领先正文。' }))
  }, 60_000)
})

describe('B6-03 — 响应丢失可 query 同一操作 (幂等)', { timeout: 120_000 }, () => {
  it('re-executing the same operation id returns written without re-pushing', async () => {
    const s = await seed()
    const db = s.db
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: '写回', content: '# 写回\n\nA。' }),
    })
    await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    const first = await executeWriteBack(db, s.provider, { operationId: s.operationId })
    expect(first.outcome).toBe('written')

    // Response lost → the client re-queries the same operation.
    const pushesBefore = s.provider.pushCount
    const again = await executeWriteBack(db, s.provider, { operationId: s.operationId })
    expect(again.outcome).toBe('written')
    if (again.outcome !== 'written') return
    expect(again.intent.status).toBe('written')
    expect(s.provider.pushCount).toBe(pushesBefore) // no second push
  }, 60_000)

  it('re-confirming is a no-op replay and a re-initiate returns the same intent', async () => {
    const s = await seed()
    const db = s.db
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: '写回2', content: '# 写回2\n\nB。' }),
    })
    await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    await executeWriteBack(db, s.provider, { operationId: s.operationId })

    const confirmed = await confirmWriteBack(db, { operationId: s.operationId })
    expect(confirmed.outcome).toBe('confirmed')
    const replay = await confirmWriteBack(db, { operationId: s.operationId })
    expect(replay.outcome).toBe('replayed')

    // A re-initiate with the same operation id returns the original intent.
    const reInit = await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    expect(reInit.outcome).toBe('replayed')
    expect(reInit.outcome === 'replayed' && reInit.intent.status).toBe('confirmed')
  }, 60_000)
})

describe('B6-03 — 失败/设备不可用保持 Blogman 领先', { timeout: 120_000 }, () => {
  it('a provider (device) failure never advances the baseline and publish still works', async () => {
    const s = await seed()
    const db = s.db
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: '设备不可用', content: '# 设备不可用\n\nC。' }),
    })
    await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })

    // Make the provider unavailable on the NEXT push (device offline).
    const failing = new MockSourceWriteProvider(H0, srcHash)
    failing.failNextPush()
    const executed = await executeWriteBack(db, failing, { operationId: s.operationId })
    expect(executed.outcome).toBe('provider-error')

    // Baseline untouched → Blogman stays leading (不可称已同步).
    const base = await baselineRow(db, s.sourceIdentityId, s.articleId)
    expect(base?.article_version).toBe(1)

    // publish is NOT blocked by the source outage.
    const published = await publishTemp(db, {
      articleId: s.articleId,
      expectedVersion: 2,
      currentStatus: 'draft',
      operationId: fresh('pub'),
      status: 'published',
    })
    expect(published.outcome).toBe('applied')
  }, 60_000)

  it('confirm before a successful push is refused (transition-refused)', async () => {
    const s = await seed()
    const db = s.db
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: '未推送', content: '# 未推送\n\nD。' }),
    })
    await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    const refused = await confirmWriteBack(db, { operationId: s.operationId })
    expect(refused.outcome).toBe('transition-refused')
  }, 60_000)
})

describe('B6-03 — 版本变化/冲突 拒绝且不自动覆盖', { timeout: 120_000 }, () => {
  it('a newer edit after the push makes confirm stale — baseline not advanced', async () => {
    const s = await seed()
    const db = s.db
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save1'),
      snapshot: snapshot({ title: '旧版', content: '# 旧版\n\nE。' }),
    })
    await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    expect((await executeWriteBack(db, s.provider, { operationId: s.operationId })).outcome).toBe('written')

    // Author edits again BEFORE the external confirmation arrives (v3).
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 2,
      operationId: fresh('save2'),
      snapshot: snapshot({ title: '新版', content: '# 新版\n\nF。' }),
    })

    const confirmed = await confirmWriteBack(db, { operationId: s.operationId })
    expect(confirmed.outcome).toBe('stale')
    const base = await baselineRow(db, s.sourceIdentityId, s.articleId)
    expect(base?.article_version).toBe(1) // NOT advanced → 保持 Blogman 领先
    expect((await writeBackByOperation(db, s.operationId))?.status).toBe('stale')
  }, 60_000)

  it('a source that diverged from the baseline refuses the write-back (no blind overwrite)', async () => {
    const s = await seed()
    const db = s.db
    await save(db, {
      articleId: s.articleId,
      expectedVersion: 1,
      operationId: fresh('save'),
      snapshot: snapshot({ title: '冲突', content: '# 冲突\n\nG。' }),
    })

    // The primary source no longer holds the baseline content (edit made abroad).
    s.provider.setSourceHash('c'.repeat(64))

    const initiated = await initiateWriteBack(db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    expect(initiated.outcome).toBe('source-diverged')
    expect(await writeBackByOperation(db, s.operationId)).toBeNull() // no intent, nothing overwritten
  }, 60_000)
})

describe('B6-03 — 发起前置条件', { timeout: 120_000 }, () => {
  it('not-leading when article version equals the baseline', async () => {
    const s = await seed()
    const res = await initiateWriteBack(s.db, s.provider, {
      articleId: s.articleId,
      sourceIdentityId: s.sourceIdentityId,
      operationId: s.operationId,
    })
    expect(res.outcome).toBe('not-leading')
  }, 60_000)

  it('no-baseline when no confirmed baseline exists', async () => {
    const db = createDatabase()
    const url = `https://example.com/articles/${fresh('nb')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '无基线' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    const link = created.source?.link ?? null
    if (!link) return
    const res = await initiateWriteBack(db, new MockSourceWriteProvider(H0, srcHash), {
      articleId: created.articleId,
      sourceIdentityId: link.sourceIdentityId,
      operationId: fresh('wb'),
    })
    expect(res.outcome).toBe('no-baseline')
  }, 60_000)

  it('link-not-confirmed when the source association is still pending', async () => {
    const db = createDatabase()
    const url = `https://example.com/articles/${fresh('pend')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '待确认' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    const link = created.source?.link ?? null
    if (!link) return
    const resolved = await resolveSourceUrl(db, url)
    const siId = resolved.outcome === 'resolved' ? resolved.identity.id : link.sourceIdentityId
    // Seed a baseline so leading could otherwise pass; the link guard is what rejects.
    await db
      .prepare(
        `INSERT INTO source_sync_baselines
           (source_identity_id, article_id, article_version, source_sync_sha256, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .bind(siId, created.articleId, H0, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
      .run()
    const res = await initiateWriteBack(db, new MockSourceWriteProvider(H0, srcHash), {
      articleId: created.articleId,
      sourceIdentityId: siId,
      operationId: fresh('wb'),
    })
    expect(res.outcome).toBe('link-not-confirmed')
  }, 60_000)
})

describe('B6-03 — 基线查询表面', { timeout: 120_000 }, () => {
  it('baselineFor reflects the confirmed baseline', async () => {
    const s = await seed()
    const base = await baselineFor(s.db, s.sourceIdentityId, s.articleId)
    expect(base?.articleVersion).toBe(1)
    expect(base?.sourceSyncSha256).toBe(H0)
  }, 60_000)
})
