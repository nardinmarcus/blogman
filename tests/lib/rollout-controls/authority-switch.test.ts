/**
 * B2-G — acceptance fixtures for the producer/authority switch (issue #32).
 *
 * Real version kernel + real rollout-control switch against one shared
 * in-process Miniflare D1 (zero wrangler CLI spawns). Covers the full
 * acceptance matrix of the authority cutover:
 *
 *   - 幂等建稿  idempotent draft creation (replay never duplicates),
 *   - 保存确认  save confirmation (monotonic version + projection follow),
 *   - 跨入口冲突 cross-entry conflict (two writers, one wins, zero partial writes),
 *   - 临时发布  temporary versioned publish + unpublish,
 *   - 公共读取兼容 public read compatibility (posts stays a readable projection),
 *   - 投影/哈希对账 projection/hash reconciliation (posts columns == version facts),
 *   - 切换后无版本写拒绝 + 回滚开关 (authority on / producer off; rollback keeps
 *     reads + preserves version facts).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'
import { create, publishTemp, save } from '@/lib/article-commands'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import {
  ensureRolloutTables,
  readRolloutState,
  switchAuthority,
  versionedWriteGuard,
  evidenceDigest,
} from '@/lib/rollout-controls'

let state: string
const cleanup: string[] = []

function snapshot(slug: string, title: string, content = '正文', status: 'draft' | 'published' = 'draft'): ArticleCommandSnapshot {
  return {
    slug,
    title,
    content,
    html: `<p>${content}</p>`,
    description: null,
    category: null,
    tags: null,
    status,
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: null,
    updated_at: null,
  }
}

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

/** Canonical switch evidence digest for a fixture run. */
function switchRequest(op: string, producer: boolean, authority: boolean) {
  return {
    producer,
    authority,
    candidateId: 'authority-switch-fixture',
    evidenceSha256: evidenceDigest(`fixture:${op}:${authority}:${producer}`),
    evidenceState: 'verified' as const,
    operationId: op,
    actor: 'b2g-worker-fixture',
    reason: 'issue-32 authority switch acceptance fixture',
  }
}

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b2g-switch-'))
  cleanup.push(state)
  await bootstrapState(state)
  // B2-01b DDL channel: idempotently host the rollout tables (never a ledger migration).
  await ensureRolloutTables(createDatabase())
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  // Reset to pre-switch defaults for a clean per-test baseline.
  await switchRequestReset()
})

/** Return controls to the pre-switch default (rows absent). */
async function switchRequestReset(): Promise<void> {
  await query(`DELETE FROM rollout_controls`)
  await query(`DELETE FROM rollout_control_events`)
}

describe('rollout-controls — authority switch acceptance', { timeout: 600_000 }, () => {
  it('默认未切换时 producer 开放、authority 关闭（预切换兼容行为）', async () => {
    const db = createDatabase()
    const state0 = await readRolloutState(db, {})
    expect(state0.producer).toBe(true)
    expect(state0.authority).toBe(false)
    const guard = await versionedWriteGuard(db, { requireProducer: true, env: {} })
    expect(guard.refused).toBe(false)
  })

  it('幂等建稿：同 creationId 重试不重复建文章；posts 以草稿投影', async () => {
    const db = createDatabase()
    const slug = fresh('idem')
    const creationId = fresh('idem-c')

    const first = await create(db, { creationId, snapshot: snapshot(slug, '幂等草稿', '首稿') })
    expect(first.outcome).toBe('created')
    expect((first as { version: number }).version).toBe(1)

    // Retry with a different payload but the same creationId → existing, no duplicate.
    const retry = await create(db, { creationId, snapshot: snapshot(slug, '不同重试', '别的内容') })
    expect(retry.outcome).toBe('existing')
    expect((retry as { articleId: number }).articleId).toBe((first as { articleId: number }).articleId)

    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM articles WHERE draft_ref = '${creationId}'`)
    expect(rows.at(-1)?.n).toBe(1)
    const versions = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_versions`)
    // Only the single article's v1 (no duplicate versions).
    const createdVersions = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM article_versions av JOIN articles a ON a.id = av.article_id WHERE a.draft_ref = '${creationId}'`,
    )
    expect(createdVersions.at(-1)?.n).toBe(1)
    expect(rows.at(-1)?.n).toBe(1)
    void versions

    // posts projection is a readable draft (kernel create keeps the draft status).
    const post = (await query<{ status: string; title: string }>(`SELECT status, title FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.status).toBe('draft')
    expect(post.title).toBe('幂等草稿')
  })

  it('保存确认：version 单调递增，replay 不膨胀版本，投影跟随最新版本', async () => {
    const db = createDatabase()
    const slug = fresh('save')
    const created = await create(db, { creationId: fresh('save-c'), snapshot: snapshot(slug, '基底') })
    const articleId = (created as { articleId: number }).articleId

    const saved = await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-save-1', snapshot: snapshot(slug, '第二版', '二稿'),
    })
    expect(saved.outcome).toBe('applied')
    expect((saved as { version: number }).version).toBe(2)

    const replayed = await save(db, {
      articleId, expectedVersion: 2, operationId: 'op-save-1', snapshot: snapshot(slug, '第二版', '二稿'),
    })
    expect(replayed.outcome).toBe('replayed')
    expect((replayed as { version: number }).version).toBe(2)

    const vs = await query<{ version: number }>(`SELECT version FROM article_versions WHERE article_id = ${articleId} ORDER BY version`)
    expect(vs.map((r) => r.version)).toEqual([1, 2])

    const post = (await query<{ title: string; content: string }>(`SELECT title, content FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.title).toBe('第二版')
    expect(post.content).toBe('二稿')
  })

  it('跨入口冲突：两个 writer 同 expectedVersion，一个 applied、一个 conflict，零部分写入', async () => {
    const db = createDatabase()
    const slug = fresh('conflict')
    const created = await create(db, { creationId: fresh('conflict-c'), snapshot: snapshot(slug, '基底') })
    const articleId = (created as { articleId: number }).articleId

    const a = await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-conf-a', snapshot: snapshot(slug, 'A 写入'),
    })
    const b = await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-conf-b', snapshot: snapshot(slug, 'B 写入'),
    })
    const aApplied = a.outcome === 'applied'
    const bApplied = b.outcome === 'applied'
    expect(aApplied !== bApplied).toBe(true)
    const loser = (aApplied ? b : a) as { outcome: string; serverVersion: number }
    expect(loser.outcome).toBe('conflict')
    expect(loser.serverVersion).toBe(2)

    const winner = (aApplied ? a : b) as { articleId: number; version: number }
    const vs = await query<{ version: number }>(`SELECT version FROM article_versions WHERE article_id = ${articleId} ORDER BY version`)
    expect(vs.map((r) => r.version)).toEqual([1, 2])
    const winnerTitle = (await query<{ title: string }>(`SELECT title FROM posts WHERE slug = '${slug}'`))[0].title
    expect(winnerTitle).toBe('A 写入')
    void winner
  })

  it('临时发布：publishTemp 发布 + 取消发布都产生版本事实且投影反映状态', async () => {
    const db = createDatabase()
    const slug = fresh('publish')
    const created = await create(db, { creationId: fresh('publish-c'), snapshot: snapshot(slug, '待发布') })
    const articleId = (created as { articleId: number }).articleId

    const pub = await publishTemp(db, {
      articleId, expectedVersion: 1, currentStatus: 'draft', operationId: 'op-pub-1', status: 'published',
    })
    expect(pub.outcome).toBe('applied')
    expect((pub as { version: number }).version).toBe(2)
    const post = (await query<{ status: string; published_at: string | null }>(`SELECT status, published_at FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.status).toBe('published')
    expect(post.published_at).not.toBeNull()

    const unpub = await publishTemp(db, {
      articleId, expectedVersion: 2, currentStatus: 'published', operationId: 'op-pub-2', status: 'draft',
    })
    expect(unpub.outcome).toBe('applied')
    const post2 = (await query<{ status: string }>(`SELECT status FROM posts WHERE slug = '${slug}'`))[0]
    expect(post2.status).toBe('draft')
  })

  it('公共读取兼容：posts 投影始终为可读的最新版本（公共读不依赖版本表）', async () => {
    const db = createDatabase()
    const slug = fresh('pubread')
    const created = await create(db, { creationId: fresh('pubread-c'), snapshot: snapshot(slug, '公开标题', '公开正文') })
    const articleId = (created as { articleId: number }).articleId
    await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-pubread-1', snapshot: snapshot(slug, '公开标题2', '公开正文2'),
    })

    // The public read surface only touches posts.
    const post = (await query<{ slug: string; title: string; content: string; content_envelope: string | null }>(
      `SELECT slug, title, content, content_envelope FROM posts WHERE slug = '${slug}'`,
    ))[0]
    expect(post.slug).toBe(slug)
    expect(post.title).toBe('公开标题2')
    expect(post.content).toBe('公开正文2')
    expect(post.content_envelope).not.toBeNull()
  })

  it('投影/哈希对账：posts 的 envelope/哈希/正文与最新版本事实一致', async () => {
    const db = createDatabase()
    const slug = fresh('recon')
    const created = await create(db, { creationId: fresh('recon-c'), snapshot: snapshot(slug, '对账', '对账正文') })
    const articleId = (created as { articleId: number }).articleId
    await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-recon-1', snapshot: snapshot(slug, '对账2', '对账正文2'),
    })

    const latest = (await query<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM article_versions WHERE article_id = ${articleId} ORDER BY version DESC LIMIT 1`,
    ))[0]
    const record = JSON.parse(latest.snapshot_json) as {
      fields: { slug: string; title: string; status: string }
      content_snapshot_sha256: string | null
      source_sync_sha256: string
      envelope: unknown
    }
    const post = (await query<{
      slug: string; title: string; content: string; status: string
      content_snapshot_sha256: string | null; source_sync_sha256: string | null; content_envelope: string | null
    }>(
      `SELECT slug, title, content, status, content_snapshot_sha256, source_sync_sha256, content_envelope FROM posts WHERE slug = '${slug}'`,
    ))[0]

    expect(post.slug).toBe(record.fields.slug)
    expect(post.title).toBe(record.fields.title)
    expect(post.status).toBe(record.fields.status)
    expect(post.content_snapshot_sha256).toBe(record.content_snapshot_sha256)
    expect(post.source_sync_sha256).toBe(record.source_sync_sha256)
    expect(post.content_envelope).toBe(JSON.stringify(record.envelope))
  })

  it('切换后 authority=on / producer=off：无版本写拒绝，版本化写仍工作', async () => {
    const db = createDatabase()
    await switchAuthority(db, switchRequest('op-switch-1', false, true))

    const state1 = await readRolloutState(db, {})
    expect(state1.producer).toBe(false)
    expect(state1.authority).toBe(true)

    // Versionless write refused.
    const guard = await versionedWriteGuard(db, { requireProducer: true, env: {} })
    expect(guard.refused).toBe(true)
    expect(guard.message).toContain('版本事实已切换为权威')

    // Idempotent switch: retry does not double-write.
    const replayed = await switchAuthority(db, switchRequest('op-switch-1', false, true))
    expect(replayed.outcome).toBe('replayed')

    // Versioned kernel writes still work after the switch.
    const slug = fresh('postswitch')
    const created = await create(db, { creationId: fresh('postswitch-c'), snapshot: snapshot(slug, '切换后新建') })
    expect(created.outcome).toBe('created')
    const articleId = (created as { articleId: number }).articleId
    const saved = await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-switch-save', snapshot: snapshot(slug, '切换后保存'),
    })
    expect(saved.outcome).toBe('applied')
  })

  it('回滚开关：关新写入口、继续兼容读、保留全部版本事实', async () => {
    const db = createDatabase()
    const slug = fresh('rollback')
    const created = await create(db, { creationId: fresh('rollback-c'), snapshot: snapshot(slug, '回滚文章') })
    const articleId = (created as { articleId: number }).articleId
    await save(db, {
      articleId, expectedVersion: 1, operationId: 'op-rb-save', snapshot: snapshot(slug, '回滚版本2'),
    })

    // Normal switch, then rollback to producer=off (close) + authority=off.
    await switchAuthority(db, switchRequest('op-rb-on', false, true))
    const rb = await switchAuthority(db, switchRequest('op-rb-off', false, false))
    expect(rb.outcome).toBe('switched')

    const state2 = await readRolloutState(db, {})
    expect(state2.producer).toBe(false)
    expect(state2.authority).toBe(false)

    // New-write entry closed: a versionless write is refused even with authority off.
    const guard = await versionedWriteGuard(db, { requireProducer: true, env: {} })
    expect(guard.refused).toBe(true)

    // Compatible reads continue (posts projection intact).
    const post = (await query<{ title: string }>(`SELECT title FROM posts WHERE slug = '${slug}'`))[0]
    expect(post.title).toBe('回滚版本2')

    // All version facts preserved.
    const vs = await query<{ version: number }>(`SELECT version FROM article_versions WHERE article_id = ${articleId} ORDER BY version`)
    expect(vs.map((r) => r.version)).toEqual([1, 2])

    // Immutable audit events retained for both flips.
    const events = await query<{ control_key: string; operation_id: string }>(
      `SELECT control_key, operation_id FROM rollout_control_events ORDER BY operation_id, control_key`,
    )
    const ops = [...new Set(events.map((e) => e.operation_id.split(':')[0]))]
    expect(ops).toContain('op-rb-on')
    expect(ops).toContain('op-rb-off')
  })

  it('紧急开关：BLOGMAN_DISABLE_AUTHORITY 可在未改持久行时暂停 authority', async () => {
    const db = createDatabase()
    await switchAuthority(db, switchRequest('op-emergency', false, true))
    // Emergency disable in a fresh object (normal env still has authority on).
    const paused = await readRolloutState(db, { BLOGMAN_DISABLE_AUTHORITY: 'true' })
    expect(paused.authority).toBe(false)
    const pausedGuard = await versionedWriteGuard(db, { requireProducer: true, env: { BLOGMAN_DISABLE_AUTHORITY: 'true' } })
    // producer off still refuses even with authority paused.
    expect(pausedGuard.refused).toBe(true)

    const resumed = await readRolloutState(db, {})
    expect(resumed.authority).toBe(true)
    expect(resumed.producer).toBe(false)
  })
})
