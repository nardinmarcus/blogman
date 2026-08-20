/**
 * B5-G — batch-5 acceptance fixture tests (issue #49).
 *
 * Two layers:
 *
 *   A) SQL-seeded acceptance fixtures (wrangler-persisted states, the same
 *      channel the reconciler reads): a complete settled batch-5 fact state
 *      over the four B5-G surfaces (派生/版本绑定, 失败重试结果未知状态机,
 *      代次与替代草稿历史, 待微信确认) is ALIGNED when bound to the same
 *      immutable candidate, DRIFT on a candidate mismatch, and DRIFT with
 *      itemized messages when each surface is corrupted.
 *
 *   B) Real-kernel scenario coverage (in-process Miniflare persisting into the
 *      wrangler-addressable `v3/d1` layout): drive the REAL batch-5 kernels
 *      (deriveWechatDraft / saveWechatDraftSettings / runWechatDraftExecutor /
 *      reconcileWechatDraft / replaceWechatDraft) through a mock provider and
 *      then reconcile the resulting fact state ALIGNED:
 *      1. 模版派生→交付→替代代次 全链 —
 *      2. 失败/重试/交付 (状态机) —
 *      3. 结果未知→查询对账 (绝无盲重试) —
 *      4. 幂等重放 (同一命令重复执行不产生重复事实) —
 *      5. 新正式版本派生新代次、旧代次与 media_id 保留 —
 *      6. 负向探针: 伪造待确认缺 media_id / 篡改投影 → DRIFT。
 *
 * Zero production: every D1 access is local / tmpdir, the provider is the
 * in-memory mock (不真调微信 API), and the reconciler only issues read-only
 * SELECT statements. No full vitest run — this file is targeted independently.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CANDIDATE,
  applyB5Schema,
  cleanupB5State,
  createFormalArticle,
  createKernelContext,
  createWranglerState,
  promoteToVersion2,
  runReconcileB5,
  runD1,
  sha256,
  TEST_SITE_URL,
} from '@/tests/scripts/reconcile-b5-helpers'
import { literal } from '@/tests/helpers/article-identity-state'
import { MockWechatDraftProvider } from '@/lib/wechat-draft/provider'
import {
  deriveWechatDraft,
  projectionDigest,
  replaceWechatDraft,
  reconcileWechatDraft,
  runWechatDraftExecutor,
  wechatDraftAttemptKey,
  wechatDraftReconcileKey,
  wechatDraftTaskIdFor,
} from '@/lib/wechat-draft'

const SITE = 'https://blog.example.test'
const T0 = 1_700_000_000

const reportDirs: string[] = []
const seedStates: string[] = []
let seedState: string | null = null

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b5-facts-report-'))
  reportDirs.push(dir)
  return dir + '/report.md'
}

function freshSeedState(): string {
  const state = createWranglerState()
  seedStates.push(state)
  return state
}

afterAll(async () => {
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const s of seedStates.splice(0)) rmSync(s, { recursive: true, force: true })
  await cleanupB5State()
})

/* ------------------------------------------------------------------ */
/* SQL-seeded complete fixture (four surfaces, settled)                */
/* ------------------------------------------------------------------ */

/** The tamper-evident projection body for a seeded task/replacement row. */
function proj(title: string, digestText: string): { title: string; html: string; plaintext: string; coverImageUrl: string; digest: string; sourceUrl: string } {
  return {
    title,
    html: `<section><p>${title}</p></section>`,
    plaintext: title,
    coverImageUrl: '',
    digest: digestText,
    sourceUrl: `${SITE}/${digestText}`,
  }
}

/** A lifecycle row (task or replacement) with its deterministic keys ready. */
function seedRow({
  table,
  key,
  articleId,
  version,
  accountId,
  status,
  title,
  contentSha,
  remoteDraftId,
  classification,
  needsAuthor = 0,
  nextAttemptAt = null,
  attemptCount = 0,
  generation = 1,
  settingsRevision = 0,
  replacesTaskId = null,
  postRef = 1,
}: {
  table: 'task' | 'replacement'
  key: string
  articleId: number
  version: number
  accountId: string
  status: string
  title: string
  contentSha: string
  remoteDraftId: string | null
  classification: string | null
  needsAuthor?: number
  nextAttemptAt?: number | null
  attemptCount?: number
  generation?: number
  settingsRevision?: number
  replacesTaskId?: string | null
  postRef?: number
}): string {
  const p = proj(title, title)
  const projectionSha = projectionDigest(p, contentSha)
  const revision = attemptCount // keep it simple: revision mirrors executions
  if (table === 'task') {
    return `INSERT INTO wechat_draft_tasks
      (task_id, article_id, post_ref, version, account_id, status,
       title, html_projection, plaintext_projection, cover_image_url, digest,
       content_sha256, projection_sha256, source_url, remote_draft_id, provider_error,
       created_at, updated_at, revision, attempt_count, classification, needs_author,
       next_attempt_at, last_error, claimed_at, lease_token, lease_expires_at,
       generation, settings_revision)
     VALUES (${literal(key)}, ${articleId}, ${postRef}, ${version}, ${literal(accountId)}, ${literal(status)},
       ${literal(p.title)}, ${literal(p.html)}, ${literal(p.plaintext)}, NULL, ${literal(p.digest)},
       ${literal(contentSha)}, ${literal(projectionSha)}, ${literal(p.sourceUrl)}, ${literal(remoteDraftId)}, NULL,
       ${T0}, ${T0}, ${revision}, ${attemptCount}, ${literal(classification)}, ${needsAuthor},
       ${literal(nextAttemptAt)}, NULL, NULL, NULL, NULL,
       ${generation}, ${settingsRevision})`
  }
  return `INSERT INTO wechat_draft_replacements
      (replacement_key, article_id, version, account_id, replaces_task_id, generation,
       status, title, html_projection, plaintext_projection, cover_image_url, digest,
       content_sha256, projection_sha256, source_url, remote_draft_id, provider_error,
       settings_revision, created_at, updated_at, revision, attempt_count, classification,
       needs_author, next_attempt_at, last_error, claimed_at, lease_token, lease_expires_at)
     VALUES (${literal(key)}, ${articleId}, ${version}, ${literal(accountId)}, ${literal(replacesTaskId)}, ${generation},
       ${literal(status)}, ${literal(p.title)}, ${literal(p.html)}, ${literal(p.plaintext)}, NULL, ${literal(p.digest)},
       ${literal(contentSha)}, ${literal(projectionSha)}, ${literal(p.sourceUrl)}, ${literal(remoteDraftId)}, NULL,
       ${settingsRevision}, ${T0}, ${T0}, ${revision}, ${attemptCount}, ${literal(classification)},
       ${needsAuthor}, ${literal(nextAttemptAt)}, NULL, NULL, NULL, NULL)`
}

/**
 * The settled batch-5 fixture (one immutable candidate) covering all four
 * surfaces across five independent (article, account) delivery groups:
 *
 *   article 1 / acc-a — derived + delivered (submitted) → explicit replacement
 *                       (阿姨新代次) chains gen1 → gen2; gen1 superseded, gen2
 *                       live (待微信确认). 派生/版本绑定 + 代次历史 + 待确认.
 *   article 2 / acc-b — retryable transient failure (failed, re-armed with
 *                       backoff window). 失败/重试状态机.
 *   article 3 / acc-c — result-unknown (failed, needs_author=1, frozen as an
 *                       author todo). 结果未知状态机.
 *   article 4 / acc-d — fresh zero-production draft (no provider) never executed.
 *   article 5 / acc-e — was unknown → reconcile found:false re-armed as a
 *                       fresh draft (reconcile attempt present, submission
 *                       attempt preserved). reconcile namespace.
 */
function seedB5Facts(state: string): void {
  const h1 = sha256('# 正式一\n\n内容一。')
  const h2 = sha256('# 正式二\n\n内容二。')
  const h3 = sha256('# 正式三\n\n内容三。')
  const h4 = sha256('# 正式四\n\n内容四。')
  const h5 = sha256('# 正式五\n\n内容五。')

  const t1 = wechatDraftTaskIdFor(1, 1, 'acc-a')          // wechat-draft:1:v1:acc-a
  const r1 = `wechat-replacement:${t1}`                    // replacement of t1
  const t2 = wechatDraftTaskIdFor(2, 1, 'acc-b')
  const t3 = wechatDraftTaskIdFor(3, 1, 'acc-c')
  const t4 = wechatDraftTaskIdFor(4, 1, 'acc-d')
  const t5 = wechatDraftTaskIdFor(5, 1, 'acc-e')

  const rows = [
    // ---- articles / frozen versions / formal publications (版本绑定) ----
    `INSERT INTO articles (id, post_ref, slug) VALUES
      (1, 1, 'b5-one'), (2, 2, 'b5-two'), (3, 3, 'b5-three'), (4, 4, 'b5-four'), (5, 5, 'b5-five')`,
    `INSERT INTO article_versions (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at) VALUES
      (1, 1, 'op:1:v1', ${literal('{}')}, ${literal(h1)}, NULL),
      (2, 1, 'op:2:v1', ${literal('{}')}, ${literal(h2)}, NULL),
      (3, 1, 'op:3:v1', ${literal('{}')}, ${literal(h3)}, NULL),
      (4, 1, 'op:4:v1', ${literal('{}')}, ${literal(h4)}, NULL),
      (5, 1, 'op:5:v1', ${literal('{}')}, ${literal(h5)}, NULL)`,
    `INSERT INTO formal_publications (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id) VALUES
      (1, 1, 'b5-one', 'published', ${T0}, ${T0}, '${SITE}/b5-one', 'ev:1'),
      (2, 1, 'b5-two', 'published', ${T0}, ${T0}, '${SITE}/b5-two', 'ev:2'),
      (3, 1, 'b5-three', 'published', ${T0}, ${T0}, '${SITE}/b5-three', 'ev:3'),
      (4, 1, 'b5-four', 'published', ${T0}, ${T0}, '${SITE}/b5-four', 'ev:4'),
      (5, 1, 'b5-five', 'published', ${T0}, ${T0}, '${SITE}/b5-five', 'ev:5')`,
    // ---- group A: derived+delivered task gen1 → replacement gen2 (待确认) ----
    seedRow({ table: 'task', key: t1, articleId: 1, version: 1, accountId: 'acc-a', status: 'superseded',
      title: '世代一标题', contentSha: h1, remoteDraftId: 'media_a1', classification: 'ok',
      attemptCount: 1, generation: 1, settingsRevision: 1 }),
    seedRow({ table: 'replacement', key: r1, articleId: 1, version: 1, accountId: 'acc-a',
      replacesTaskId: t1, status: 'submitted', title: '替代世代标题', contentSha: h1,
      remoteDraftId: 'media_a2', classification: 'ok', attemptCount: 1, generation: 2, settingsRevision: 2 }),
    // ---- group B: retryable failure (re-armed) ----
    seedRow({ table: 'task', key: t2, articleId: 2, version: 1, accountId: 'acc-b', status: 'failed',
      postRef: 2,
      title: '重试标题', contentSha: h2, remoteDraftId: null, classification: 'retryable',
      attemptCount: 1, generation: 1, nextAttemptAt: T0 + 60 }),
    // ---- group C: result-unknown → author todo ----
    seedRow({ table: 'task', key: t3, articleId: 3, version: 1, accountId: 'acc-c', status: 'failed',
      postRef: 3,
      title: '未知标题', contentSha: h3, remoteDraftId: null, classification: 'unknown',
      needsAuthor: 1, attemptCount: 1, generation: 1 }),
    // ---- group D: fresh zero-production draft (never executed) ----
    seedRow({ table: 'task', key: t4, articleId: 4, version: 1, accountId: 'acc-d', status: 'draft',
      postRef: 4,
      title: '零生产草案', contentSha: h4, remoteDraftId: null, classification: null, generation: 1 }),
    // ---- group E: unknown → reconciled (found:false) re-armed draft ----
    seedRow({ table: 'task', key: t5, articleId: 5, version: 1, accountId: 'acc-e', status: 'draft',
      postRef: 5,
      title: '对账重武草案', contentSha: h5, remoteDraftId: null, classification: null,
      attemptCount: 1, generation: 1 }),
    // ---- immutable attempt facts ----
    `INSERT INTO wechat_draft_attempts
       (attempt_key, task_id, attempt_no, classification, outcome, started_at, finished_at, remote_draft_id, error, created_at, updated_at) VALUES
      (${literal(wechatDraftAttemptKey(t1, 1))}, ${literal(t1)}, 1, 'ok', 'submitted', ${T0}, ${T0}, 'media_a1', NULL, ${T0}, ${T0}),
      (${literal(wechatDraftAttemptKey(r1, 1))}, ${literal(r1)}, 1, 'ok', 'submitted', ${T0}, ${T0}, 'media_a2', NULL, ${T0}, ${T0}),
      (${literal(wechatDraftAttemptKey(t2, 1))}, ${literal(t2)}, 1, 'retryable', 'retried', ${T0}, ${T0}, NULL, 'errcode 45009 限流', ${T0}, ${T0}),
      (${literal(wechatDraftAttemptKey(t3, 1))}, ${literal(t3)}, 1, 'unknown', 'unknown', ${T0}, ${T0}, NULL, 'response lost', ${T0}, ${T0}),
      (${literal(wechatDraftAttemptKey(t5, 1))}, ${literal(t5)}, 1, 'unknown', 'unknown', ${T0 - 5}, ${T0 - 5}, NULL, 'response lost', ${T0 - 5}, ${T0 - 5}),
      (${literal(wechatDraftReconcileKey(t5, 2))}, ${literal(t5)}, 2, 'retryable', 'reconciled', ${T0}, ${T0}, NULL, 'confirmed-not-created', ${T0}, ${T0})`,
    // ---- settings (设置修订) for group A ----
    `INSERT INTO wechat_draft_settings
       (article_id, account_id, settings_revision, title_override, digest_override, cover_image_override, created_at, updated_at)
     VALUES (1, 'acc-a', 2, '设定标题', NULL, NULL, ${T0}, ${T0})`,
    // ---- generation ledger (代次历史 + 链) ----
    `INSERT INTO wechat_draft_generations
       (article_id, account_id, generation, version, task_id, replaces_task_id, status, settings_revision, created_at, updated_at) VALUES
      (1, 'acc-a', 1, 1, ${literal(t1)}, NULL, 'superseded', 1, ${T0}, ${T0}),
      (1, 'acc-a', 2, 1, ${literal(r1)}, ${literal(t1)}, 'submitted', 2, ${T0}, ${T0}),
      (2, 'acc-b', 1, 1, ${literal(t2)}, NULL, 'failed', 0, ${T0}, ${T0}),
      (3, 'acc-c', 1, 1, ${literal(t3)}, NULL, 'failed', 0, ${T0}, ${T0}),
      (4, 'acc-d', 1, 1, ${literal(t4)}, NULL, 'draft', 0, ${T0}, ${T0}),
      (5, 'acc-e', 1, 1, ${literal(t5)}, NULL, 'draft', 0, ${T0}, ${T0})`,
  ]
  runD1(state, rows.join(';\n'))
}

function buildSeedState(): string {
  if (seedState) return seedState
  const state = freshSeedState()
  applyB5Schema(state)
  seedB5Facts(state)
  seedState = state
  return state
}

/* ------------------------------------------------------------------ */
/* Layer A — SQL-seeded acceptance fixtures                            */
/* ------------------------------------------------------------------ */

describe('reconcile-b5-facts (SQL-seeded acceptance fixture)', { timeout: 600_000 }, () => {
  it('reports ALIGNED on a complete batch-5 fact state bound to the same candidate', () => {
    const state = buildSeedState()
    const report = freshReport()
    const aligned = runReconcileB5(state, report, ['--candidate', CANDIDATE])
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('drift=0')
    expect(aligned.stdout).toContain('tasks=5')
    expect(aligned.stdout).toContain('attempts=6')
    expect(aligned.stdout).toContain('settings=1')
    expect(aligned.stdout).toContain('generations=6')
    expect(aligned.stdout).toContain('replacements=1')
    expect(aligned.stdout).toContain('awaiting=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('ALIGNED')
    expect(text).toContain('四维微信草稿事实完整')
  })

  it('reports DRIFT with a single candidate item when the ledger candidate mismatches', () => {
    const state = buildSeedState()
    const report = freshReport()
    const drifted = runReconcileB5(state, report, ['--candidate', 'd'.repeat(40)])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    expect(drifted.stdout).toContain('drift=1')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('候选漂移')
  })

  it('reports DRIFT with itemized items when each B5-G surface is corrupted', () => {
    const state = buildSeedState()
    const t1 = wechatDraftTaskIdFor(1, 1, 'acc-a')
    const t3 = wechatDraftTaskIdFor(3, 1, 'acc-c')

    // 1. 派生/版本绑定 — tamper the projection body (stored title changed
    //    without recomputing the digest) → projection hash breaks.
    runD1(state, `UPDATE wechat_draft_tasks SET title = '篡改后的标题' WHERE task_id = '${t1}'`)
    // 2. 状态机 — an ok/retryable mis-flag: force a retryable row to be an
    //    author todo (needs_author=1) with no backoff window.
    runD1(state, `UPDATE wechat_draft_tasks SET needs_author = 0, next_attempt_at = NULL
                   WHERE task_id = '${wechatDraftTaskIdFor(2, 1, 'acc-b')}'`)
    // 3. 待微信确认 — the LIVE submitted replacement loses its media_id → a
    //    delivered draft must always carry its media (分类 ok 也必须保存 media).
    runD1(state, `UPDATE wechat_draft_replacements SET remote_draft_id = NULL
                   WHERE replacement_key = 'wechat-replacement:${t1}'`)
    // 4. 代次历史 — break the replacement chain: gen2 no longer references gen1.
    runD1(state, `UPDATE wechat_draft_generations SET replaces_task_id = NULL
                   WHERE task_id = 'wechat-replacement:${t1}'`)
    // 5. 待确认: a fresh draft must not carry a remote id.
    runD1(state, `UPDATE wechat_draft_tasks SET remote_draft_id = 'stray-media'
                   WHERE task_id = '${wechatDraftTaskIdFor(4, 1, 'acc-d')}'`)
    // 6. 状态机: result-unknown row must freeze as author todo.
    runD1(state, `UPDATE wechat_draft_tasks SET needs_author = 0 WHERE task_id = '${t3}'`)

    const report = freshReport()
    const drifted = runReconcileB5(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    // 1. derivation / tamper-evidence
    expect(text).toContain('投影哈希被篡改')
    // 2. retryable state machine
    expect(text).toContain('分类 retryable 缺少 next_attempt_at 退避窗口')
    // 3. awaiting-confirmation media
    expect(text).toContain('submitted（待微信确认）必须携带远端 media_id')
    // 4. generation chain
    expect(text).toContain('replaces_task_id 与台账不一致')
    // 5. draft must not carry a remote id
    expect(text).toContain('draft 行未经执行不应有远端身份 media_id')
    // 6. unknown author todo
    expect(text).toContain('needs_author=0 与分类')
  })
})

/* ------------------------------------------------------------------ */
/* Layer B — real-kernel scenario coverage                             */
/* ------------------------------------------------------------------ */

describe('reconcile-b5-facts (real-kernel scenarios)', { timeout: 600_000 }, () => {
  it('全链: 派生→交付→替代代次 通过真实内核驱动并对账 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const provider = new MockWechatDraftProvider([
        { accepted: true, remoteDraftId: 'media_gen1' },
        { accepted: true, remoteDraftId: 'media_gen2' },
      ])
      const derived = await deriveWechatDraft(db, {
        articleId: article.articleId, version: 1, accountId: 'acc-x', provider, siteUrl: TEST_SITE_URL, now: T0,
      })
      expect(derived.outcome).toBe('submitted')

      const replaced = await replaceWechatDraft(db, {
        taskId: derived.taskId, provider, now: T0 + 10, siteUrl: TEST_SITE_URL,
      })
      expect(replaced.outcome).toBe('submitted')
      if (replaced.outcome !== 'submitted') throw new Error('replace failed')

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB5(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('tasks=1')
      expect(aligned.stdout).toContain('replacements=1')
      expect(aligned.stdout).toContain('generations=2')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('失败→重试→交付: 暂时失败重新武装，执行器按退避重投并交付，幂等重放不重复', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const provider = new MockWechatDraftProvider([
        { accepted: false, classification: 'retryable', error: 'errcode 45009 限流' },
        { accepted: true, remoteDraftId: 'media_retried' },
      ])
      const derived = await deriveWechatDraft(db, {
        articleId: article.articleId, version: 1, accountId: 'acc-y', provider, siteUrl: TEST_SITE_URL, now: T0,
      })
      expect(derived.outcome).toBe('failed')
      if (derived.outcome !== 'failed') throw new Error('derive fail expected')
      expect(derived.task.classification).toBe('retryable')

      // Idempotent replay of the derivation must NOT re-submit or duplicate.
      const replay = await deriveWechatDraft(db, {
        articleId: article.articleId, version: 1, accountId: 'acc-y', provider, siteUrl: TEST_SITE_URL, now: T0 + 1,
      })
      expect(replay.outcome).toBe('existing')

      await runWechatDraftExecutor(db, { provider, now: T0 + 60, leaseSeconds: 600 })

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB5(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('attempts=2') // retried + submitted
      // Only one delivery row, generation 1, awaiting confirmation.
      const rows = (await runD1(dir, 'SELECT status FROM wechat_draft_tasks'))[0].results
      expect(rows).toHaveLength(1)
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('结果未知→查询对账: 绝无盲重试，查询后恢复并保存新 media_id，对账 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const provider = new MockWechatDraftProvider([
        { accepted: false, classification: 'unknown', error: 'response lost' },
      ])
      const derived = await deriveWechatDraft(db, {
        articleId: article.articleId, version: 1, accountId: 'acc-z', provider, siteUrl: TEST_SITE_URL, now: T0,
      })
      expect(derived.outcome).toBe('unknown')
      if (derived.outcome !== 'unknown') throw new Error('unknown expected')

      // Executor must NOT touch a frozen unknown task (绝无盲重试).
      await runWechatDraftExecutor(db, { provider, now: T0 + 60, leaseSeconds: 600 })
      const stillFrozen = (await db.prepare(
        `SELECT classification FROM wechat_draft_tasks WHERE task_id = ?`,
      ).bind(derived.taskId).first<{ classification: string }>())
      expect(stillFrozen?.classification).toBe('unknown')

      const reconciler = new MockWechatDraftProvider([], [{ found: true, remoteDraftId: 'media_after_query' }])
      const reconciled = await reconcileWechatDraft(db, { taskId: derived.taskId, provider: reconciler, now: T0 + 5 })
      expect(reconciled.outcome).toBe('reconciled')
      if (reconciled.outcome !== 'reconciled') throw new Error('reconcile failed')

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB5(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('attempts=2') // unknown + reconcile
      expect(aligned.stdout).toContain('awaiting=1')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('新正式版本: 派生新代次并保留旧代次与 media_id；幂等重放不重复；对账 ALIGNED', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const provider = new MockWechatDraftProvider([
        { accepted: true, remoteDraftId: 'media_v1' },
      ])
      const v1 = await deriveWechatDraft(db, {
        articleId: article.articleId, version: 1, accountId: 'acc-w', provider, siteUrl: TEST_SITE_URL, now: T0,
      })
      expect(v1.outcome).toBe('submitted')

      // promote to v2, derive a new generation; old gen1 keeps its media_id.
      const promoted = await promoteToVersion2(db, article, '升级标题', '# 升级正文\n\nv2')
      const v2 = await deriveWechatDraft(db, {
        articleId: promoted.articleId, version: 2, accountId: 'acc-w', provider, siteUrl: TEST_SITE_URL, now: T0 + 20,
      })
      expect(v2.outcome).toBe('submitted')

      // Idempotent replay of v2 derivation → no new fact.
      const replay = await deriveWechatDraft(db, {
        articleId: promoted.articleId, version: 2, accountId: 'acc-w', provider, siteUrl: TEST_SITE_URL, now: T0 + 21,
      })
      expect(replay.outcome).toBe('existing')

      await ctx.dispose()
      const report = freshReport()
      const aligned = runReconcileB5(dir, report, ['--candidate', CANDIDATE])
      expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
      expect(aligned.stdout).toContain('verdict=ALIGNED')
      expect(aligned.stdout).toContain('tasks=2') // v1 (superseded) + v2 (live)
      expect(aligned.stdout).toContain('generations=2')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })

  it('负向探针: 真实内核状态被伪造后必须 DRIFT', async () => {
    const ctx = await createKernelContext()
    const { db, dir } = ctx
    try {
      const article = await createFormalArticle(db)
      const provider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_ok' }])
      const derived = await deriveWechatDraft(db, {
        articleId: article.articleId, version: 1, accountId: 'acc-v', provider, siteUrl: TEST_SITE_URL, now: T0,
      })
      expect(derived.outcome).toBe('submitted')

      // Fabricate drift: a delivered (待微信确认) row loses its media_id.
      await db.prepare('UPDATE wechat_draft_tasks SET remote_draft_id = NULL WHERE task_id = ?')
        .bind(derived.taskId).run()

      await ctx.dispose()
      const report = freshReport()
      const drifted = runReconcileB5(dir, report, ['--candidate', CANDIDATE])
      expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
      expect(drifted.stdout).toContain('verdict=DRIFT')
      const text = readFileSync(report, 'utf8')
      expect(text).toContain('submitted（待微信确认）必须携带远端 media_id')
    } finally {
      await ctx.dispose().catch(() => undefined)
    }
  })
})
