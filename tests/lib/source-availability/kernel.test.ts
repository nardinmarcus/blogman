/**
 * B6-05 — 保留关系地报告主要源稿不可用 kernel tests (issue #54).
 *
 * Real in-process D1 through one shared Miniflare instance (zero wrangler CLI
 * spawns), a controllable provider-mock probe, and the B6-01 source-identity
 * fact surface for durable identity + pending/confirmed links. Proves the
 * ticket's acceptance surface and the issue's verification scenarios:
 *
 *   - 不可用不推进版本或基线: a timeout / permission / confirmed-missing /
 *     unknown read permanently leaves the durable baseline (and no version
 *     pointer) untouched — the advance is refused with zero movement,
 *   - 确认缺失不删除关系媒体: explicitly confirmed missing preserves the article
 *     link and returns the relationship's media refs unchanged — nothing
 *     unlinked, nothing deleted,
 *   - 恢复后依据事实重新推导: after recovery the read-only report re-derives
 *     from the durable baseline facts (runtime cache is never authoritative),
 *   - 可用性观察与同步事实分离: the four sync conclusions are exposed ONLY on a
 *     reliable readable read; on timeout / permission / confirmed missing /
 *     unprobed / stale the operator sees 未知/不可确认 and never a fake synced,
 *   - 不阻止发布: while the source is unavailable, Blogman edit/publish still
 *     proceeds (availability never gates blogman content versioning),
 *   - controllable adapters: timeout, permission, confirmed missing, recovery
 *     read and during-period edits are each covered by the mock probe.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, save } from '@/lib/article-commands'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
} from '@/tests/lib/article-commands/helpers'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import { SOURCE_AVAILABILITY_DDL_STATEMENTS } from '@/lib/source-availability'
import {
  confirmSourceMissing,
  gateSyncConclusion,
  guardedAdvanceBaseline,
  observeSourceAvailability,
  reportSourceAvailability,
  reportableFromProbe,
} from '@/lib/source-availability'
import type { ProbeReadOutcome, SourceProbe } from '@/lib/source-availability'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b605-avail-'))
  cleanup.push(state)
  await bootstrapState(state)
  for (const stmt of [...SOURCE_IDENTITY_DDL_STATEMENTS, ...SOURCE_AVAILABILITY_DDL_STATEMENTS]) {
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

/** The feature tables are shared across tests — reset rows between tests. */
beforeEach(async () => {
  for (const t of [
    'source_availability_observations',
    'source_baseline_facts',
    'article_source_links',
    'source_url_variants',
    'source_identities',
    'article_versions',
    'articles',
  ]) {
    await query(`DELETE FROM ${t}`)
  }
})

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

/** Controllable provider-mock probe — tests feed canned read outcomes. */
class MockProbe implements SourceProbe {
  queue: ProbeReadOutcome[] = []
  calls = 0
  async readSource(): Promise<ProbeReadOutcome> {
    this.calls += 1
    const next = this.queue.shift()
    if (next) return next
    return { outcome: 'readable' } // default when empty
  }
  push(...o: ProbeReadOutcome[]): void {
    this.queue.push(...o)
  }
}

async function observationCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM source_availability_observations'))[0]?.n ?? 0
}

async function baselineCount(): Promise<number> {
  return (await query<{ n: number }>('SELECT COUNT(*) AS n FROM source_baseline_facts'))[0]?.n ?? 0
}

/* ------------------------------------------------------------------ */
/* Pure gating — 可用性观察与同步事实分离                                */
/* ------------------------------------------------------------------ */

describe('reportableFromProbe + gateSyncConclusion (pure gating)', { timeout: 60_000 }, () => {
  it('maps each provider outcome to a reportable availability without fabricating a status', () => {
    expect(reportableFromProbe({ outcome: 'readable' })).toEqual({ availability: 'readable' })
    expect(reportableFromProbe({ outcome: 'temporarily-unavailable', reason: 'timeout' })).toEqual({
      availability: 'temporarily-unavailable',
      reason: 'timeout',
    })
    expect(reportableFromProbe({ outcome: 'temporarily-unavailable', reason: 'permission', status: 403 })).toEqual({
      availability: 'temporarily-unavailable',
      reason: 'permission',
      status: 403,
    })
    expect(reportableFromProbe({ outcome: 'confirmed-missing', status: 404 })).toEqual({
      availability: 'confirmed-missing',
      status: 404,
    })
  })

  it('exposes the four sync conclusions ONLY on a reliable readable read', () => {
    const readable = { availability: 'readable' as const }
    // readable + comparison → the four-state conclusion is reportable
    expect(gateSyncConclusion(readable, { sync: 'source-ahead' })).toBe('source-ahead')
    expect(gateSyncConclusion(readable, { sync: 'synced' })).toBe('synced')
    expect(gateSyncConclusion(readable, { sync: 'conflict' })).toBe('conflict')
    expect(gateSyncConclusion(readable, { sync: 'blogman-ahead' })).toBe('blogman-ahead')
    // readable + no comparison → no sync conclusion is asserted
    expect(gateSyncConclusion(readable, null)).toBeNull()

    // not reliably readable → the four conclusions are hidden, even with facts
    const unavailable = { availability: 'temporarily-unavailable' as const, reason: 'timeout' as const }
    const missing = { availability: 'confirmed-missing' as const, status: 404 }
    const unknown = { availability: 'unknown' as const, reason: 'unprobed' as const }
    expect(gateSyncConclusion(unavailable, { sync: 'synced' })).toBeNull()
    expect(gateSyncConclusion(missing, { sync: 'synced' })).toBeNull()
    expect(gateSyncConclusion(unknown, { sync: 'synced' })).toBeNull() // 不伪装已同步
  })
})

/* ------------------------------------------------------------------ */
/* observeSourceAvailability — durable observation, zero side effects  */
/* ------------------------------------------------------------------ */

describe('observeSourceAvailability — provider mock + D1 facts', { timeout: 120_000 }, () => {
  it('timeout becomes temporarily-unavailable and records a durable observation', async () => {
    const db = createDatabase()
    const url = `https://example.com/obs/${fresh('u')}`
    const probe = new MockProbe()
    probe.push({ outcome: 'temporarily-unavailable', reason: 'timeout' })

    const res = await observeSourceAvailability(db, { operationId: fresh('o1'), url, probe })
    expect(res.outcome).toBe('observed')
    if (res.outcome !== 'observed') return
    expect(res.reported).toEqual({ availability: 'temporarily-unavailable', reason: 'timeout' })
    expect(await observationCount()).toBe(1)
  })

  it('permission is a distinct temporarily-unavailable reason (not confirmed missing)', async () => {
    const db = createDatabase()
    const url = `https://example.com/perm/${fresh('u')}`
    const probe = new MockProbe()
    probe.push({ outcome: 'temporarily-unavailable', reason: 'permission', status: 403 })

    const res = await observeSourceAvailability(db, { operationId: fresh('o2'), url, probe })
    expect(res.outcome).toBe('observed')
    if (res.outcome !== 'observed') return
    expect(res.reported.availability).toBe('temporarily-unavailable')
    if (res.reported.availability === 'temporarily-unavailable') {
      expect(res.reported.reason).toBe('permission')
    }
    // an ambiguous 403 is never treated as confirmed missing
    expect(res.reported.availability).not.toBe('confirmed-missing')
  })

  it('an observation never mutates the link or baseline (可用性观察≠同步事实)', async () => {
    const db = createDatabase()
    const url = `https://example.com/nop/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '观察不改' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    const linkBefore = created.source?.link

    const probe = new MockProbe()
    probe.push({ outcome: 'temporarily-unavailable', reason: 'network' })
    const res = await observeSourceAvailability(db, { operationId: fresh('o3'), url, probe })
    expect(res.outcome).toBe('observed')

    // link untouched, baseline untouched (no facts advanced)
    const linkNow = (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_source_links`))[0]?.n ?? 0
    expect(linkNow).toBe(1)
    expect(linkBefore?.status).toBe('pending')
    expect(await baselineCount()).toBe(0)
  })

  it('replay by operation id returns the original observation, zero new rows', async () => {
    const db = createDatabase()
    const url = `https://example.com/replay/${fresh('u')}`
    const op = fresh('o')
    const probe = new MockProbe()
    probe.push({ outcome: 'confirmed-missing', status: 410 })

    const first = await observeSourceAvailability(db, { operationId: op, url, probe })
    expect(first.outcome).toBe('observed')
    const probe2 = new MockProbe()
    probe2.push({ outcome: 'readable' }) // a replay must NOT re-read
    const again = await observeSourceAvailability(db, { operationId: op, url, probe: probe2 })
    expect(again.outcome).toBe('replayed')
    expect(probe2.calls).toBe(0) // no provider read on replay
    expect(await observationCount()).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* guardedAdvanceBaseline — 不可用不推进版本或基线                       */
/* ------------------------------------------------------------------ */

describe('guardedAdvanceBaseline — unavailable never advances version/baseline', { timeout: 120_000 }, () => {
  it('timeout refuses the advance; the baseline stays untouched', async () => {
    const db = createDatabase()
    const url = `https://example.com/adv/${fresh('u')}`
    const probe = new MockProbe()
    probe.push({ outcome: 'temporarily-unavailable', reason: 'timeout' })

    const res = await guardedAdvanceBaseline(db, {
      operationId: fresh('a'),
      url,
      contentSha256: 'a'.repeat(64),
      probe,
    })
    expect(res.outcome).toBe('refused-unavailable')
    if (res.outcome !== 'refused-unavailable') return
    expect(res.reported.availability).toBe('temporarily-unavailable')
    expect(await baselineCount()).toBe(0) // 不可用不推进基线
  })

  it('confirmed missing refuses advance and preserves the link+baseline', async () => {
    const db = createDatabase()
    const url = `https://example.com/advmiss/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '缺稿' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    const probe = new MockProbe()
    probe.push({ outcome: 'confirmed-missing', status: 404 })

    const res = await guardedAdvanceBaseline(db, {
      operationId: fresh('a'),
      url,
      contentSha256: 'b'.repeat(64),
      probe,
    })
    expect(res.outcome).toBe('refused-unavailable')
    // relationship preserved — still one live link, nothing unlinked
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_source_links`))[0]?.n).toBe(1)
    expect(await baselineCount()).toBe(0)
  })

  it('a reliable readable read + explicit advance moves the baseline; replay is idempotent', async () => {
    const db = createDatabase()
    const url = `https://example.com/advok/${fresh('u')}`
    const op = fresh('a')
    const probe = new MockProbe()
    probe.push({ outcome: 'readable' })

    const res = await guardedAdvanceBaseline(db, {
      operationId: op,
      url,
      contentSha256: 'c'.repeat(64),
      probe,
    })
    expect(res.outcome).toBe('advanced')
    if (res.outcome !== 'advanced') return
    expect(res.baseline.contentSha256).toBe('c'.repeat(64))
    expect(await baselineCount()).toBe(1)

    // replay — cached by the baseline operation id, no re-read, no new row
    const probe2 = new MockProbe()
    probe2.push({ outcome: 'readable' })
    const again = await guardedAdvanceBaseline(db, { operationId: op, url, contentSha256: 'd'.repeat(64), probe: probe2 })
    expect(again.outcome).toBe('replayed')
    if (again.outcome !== 'replayed') return
    expect(again.baseline.contentSha256).toBe('c'.repeat(64)) // original baseline preserved
    expect(probe2.calls).toBe(0)
    expect(await baselineCount()).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* confirmSourceMissing — 确认缺失不删除关系媒体                          */
/* ------------------------------------------------------------------ */

describe('confirmSourceMissing — confirmed missing preserves relationship media', { timeout: 120_000 }, () => {
  it('returns the preserved link and media refs unchanged; nothing deleted, nothing unlinked', async () => {
    const db = createDatabase()
    const url = `https://example.com/miss/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '确认缺失' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return

    const media = [`https://media.example.com/${fresh('m1')}`, `https://media.example.com/${fresh('m2')}`]
    const res = await confirmSourceMissing(db, { operationId: fresh('ms'), url, mediaRefs: media, status: 404 })
    expect(res.outcome).toBe('confirmed-missing')
    if (res.outcome !== 'confirmed-missing') return

    // relationship media preserved identically — nothing deleted
    expect(res.preservedMedia.refs).toEqual(media)
    // link preserved — still live, not unlinked
    expect(res.link?.status).toBe('pending')
    expect((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM article_source_links`))[0]?.n).toBe(1)
    // no baseline movement
    expect(await baselineCount()).toBe(0)
  })

  it('replay by operation id is a no-op and preserves media again', async () => {
    const db = createDatabase()
    const url = `https://example.com/missreplay/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '缺稿重放' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    const op = fresh('ms')
    const media = [`https://media.example.com/${fresh('m')}`]
    const first = await confirmSourceMissing(db, { operationId: op, url, mediaRefs: media })
    expect(first.outcome).toBe('confirmed-missing')
    const again = await confirmSourceMissing(db, { operationId: op, url, mediaRefs: ['should-not-replace'] })
    expect(again.outcome).toBe('replayed')
    expect(await observationCount()).toBe(1) // replay adds no new observation
  })
})

/* ------------------------------------------------------------------ */
/* reportSourceAvailability — gate + preserve + recovery               */
/* ------------------------------------------------------------------ */

describe('reportSourceAvailability — gate, preserve, recovery', { timeout: 120_000 }, () => {
  it('probing disabled → unknown/unprobed, never masquerades as synced', async () => {
    const db = createDatabase()
    const url = `https://example.com/unprobed/${fresh('u')}`
    // no probe passed → probing disabled
    const report = await reportSourceAvailability(db, { url, comparison: { sync: 'synced' } })
    if ('outcome' in report) throw new Error('unexpected invalid-source')
    expect(report.reported).toEqual({ availability: 'unknown', reason: 'unprobed' })
    expect(report.syncConclusion).toBeNull() // 关闭探测时显示未知/不可确认，不伪装已同步
  })

  it('recent timeout hides the four conclusions even when comparison claims synced', async () => {
    const db = createDatabase()
    const url = `https://example.com/tout/${fresh('u')}`
    const probe = new MockProbe()
    probe.push({ outcome: 'temporarily-unavailable', reason: 'timeout' })
    await observeSourceAvailability(db, { operationId: fresh('o'), url, probe })

    const report = await reportSourceAvailability(db, {
      url,
      probe: new MockProbe(),
      comparison: { sync: 'synced' },
    })
    if ('outcome' in report) throw new Error('unexpected invalid-source')
    expect(report.reported.availability).toBe('temporarily-unavailable')
    expect(report.syncConclusion).toBeNull() // 无法可靠读取时不显示四种同步结论
  })

  it('recent confirmed missing reports missing with preserved link+baseline', async () => {
    const db = createDatabase()
    const url = `https://example.com/rptmiss/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '报告缺失' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    const probe = new MockProbe()
    probe.push({ outcome: 'confirmed-missing', status: 404 })
    await observeSourceAvailability(db, { operationId: fresh('o'), url, probe })

    const report = await reportSourceAvailability(db, { url, probe: new MockProbe() })
    if ('outcome' in report) throw new Error('unexpected invalid-source')
    expect(report.reported.availability).toBe('confirmed-missing')
    expect(report.syncConclusion).toBeNull()
    expect(report.link?.status).toBe('pending') // relationship preserved
  })

  it('readable recent read gates the four sync conclusions from sync facts', async () => {
    const db = createDatabase()
    const url = `https://example.com/gate/${fresh('u')}`
    const probe = new MockProbe()
    probe.push({ outcome: 'readable' })
    await observeSourceAvailability(db, { operationId: fresh('o'), url, probe })

    const report = await reportSourceAvailability(db, {
      url,
      probe: new MockProbe(),
      comparison: { sync: 'blogman-ahead' },
    })
    if ('outcome' in report) throw new Error('unexpected invalid-source')
    expect(report.reported.availability).toBe('readable')
    expect(report.syncConclusion).toBe('blogman-ahead')

    // without comparison facts, no sync conclusion is asserted
    const bare = await reportSourceAvailability(db, { url, probe: new MockProbe() })
    if ('outcome' in bare) throw new Error('unexpected invalid-source')
    expect(bare.syncConclusion).toBeNull()
  })

  it('recovers after missing: a fresh readable re-read re-derives from the durable baseline', async () => {
    const db = createDatabase()
    const url = `https://example.com/recover/${fresh('u')}`
    const baseOp = fresh('a')
    // first a good read + explicit advance sets the durable baseline
    const writer = new MockProbe()
    writer.push({ outcome: 'readable' })
    const adv = await guardedAdvanceBaseline(db, {
      operationId: baseOp,
      url,
      contentSha256: 'e'.repeat(64),
      probe: writer,
    })
    expect(adv.outcome).toBe('advanced')

    // then the source goes missing
    const missing = new MockProbe()
    missing.push({ outcome: 'confirmed-missing', status: 404 })
    await observeSourceAvailability(db, { operationId: fresh('o'), url, probe: missing })
    const whileDown = await reportSourceAvailability(db, {
      url,
      probe: new MockProbe(),
      comparison: { sync: 'source-ahead' },
      now: Date.now(),
    })
    if ('outcome' in whileDown) throw new Error('unexpected invalid-source')
    expect(whileDown.reported.availability).toBe('confirmed-missing')
    expect(whileDown.syncConclusion).toBeNull()
    // durable baseline preserved — re-derivable after recovery
    expect(whileDown.baseline?.contentSha256).toBe('e'.repeat(64))

    // recovery: the provider reads fine again → a fresh readable observation flips
    // the report back to readable and re-derives from the durable original baseline
    const recoveredProbe = new MockProbe()
    recoveredProbe.push({ outcome: 'readable' })
    const recob = await observeSourceAvailability(db, { operationId: fresh('rec'), url, probe: recoveredProbe })
    expect(recob.outcome).toBe('observed')
    const recovered = await reportSourceAvailability(db, {
      url,
      probe: new MockProbe(),
      comparison: { sync: 'synced' },
      now: Date.now(),
    })
    if ('outcome' in recovered) throw new Error('unexpected invalid-source')
    expect(recovered.reported.availability).toBe('readable')
    expect(recovered.syncConclusion).toBe('synced')
    expect(recovered.baseline?.contentSha256).toBe('e'.repeat(64)) // 恢复后依据事实重新推导
  })

  it('a readable observation older than the window is stale → unknown (runtime cache is not authoritative)', async () => {
    const db = createDatabase()
    const url = `https://example.com/stale/${fresh('u')}`
    const now = Date.now()
    // record a readable observation "now"
    const probe = new MockProbe()
    probe.push({ outcome: 'readable' })
    await observeSourceAvailability(db, { operationId: fresh('o'), url, probe, now: Math.floor(now / 1000) })

    // later, probing is disabled: even though a readable observation exists, it is
    // older than the freshness window → unknown, never masquerade as synced
    const later = now + 20 * 60 * 1000
    const report = await reportSourceAvailability(db, {
      url,
      probe: undefined,
      comparison: { sync: 'synced' },
      now: later,
      maxAgeMs: 5 * 60 * 1000,
    })
    if ('outcome' in report) throw new Error('unexpected invalid-source')
    expect(report.reported.availability).toBe('unknown')
    expect(report.syncConclusion).toBeNull()
    // durable baseline still present and read-only
    expect(report.baseline).toBeNull()
  })

  it('blogman edit still proceeds during unavailability (不阻止发布)', async () => {
    const db = createDatabase()
    const url = `https://example.com/edit/${fresh('u')}`
    const created = await create(db, {
      creationId: fresh('c'),
      snapshot: snapshot({ title: '期间编辑' }),
      source: { url },
    })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    const articleId = created.articleId
    const version = created.version

    // source becomes temporarily unavailable
    const probe = new MockProbe()
    probe.push({ outcome: 'temporarily-unavailable', reason: 'timeout' })
    await observeSourceAvailability(db, { operationId: fresh('o'), url, probe })

    // Blogman content versioning proceeds — nothing is blocked
    const saved = await save(db, {
      articleId,
      expectedVersion: version,
      operationId: fresh('s'),
      snapshot: snapshot({ title: '期间编辑·新版本' }),
    })
    expect(saved.outcome).toBe('applied')
    if (saved.outcome !== 'applied') return
    expect(saved.version).toBeGreaterThan(version)

    // the report still honestly shows the source is not reliably readable
    const report = await reportSourceAvailability(db, { url, probe: new MockProbe() })
    if ('outcome' in report) throw new Error('unexpected invalid-source')
    expect(report.reported.availability).toBe('temporarily-unavailable')
    expect(report.syncConclusion).toBeNull()
    // and the unavailability did not itself advance the sync baseline
    expect(await baselineCount()).toBe(0)
  })
})
