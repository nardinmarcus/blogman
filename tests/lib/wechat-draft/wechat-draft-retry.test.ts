/**
 * B5-02 — WeChat provider failure / retry / result-unknown state machine
 * (issue #47), D1-backed.
 *
 * Proves the retry and reconcile contracts on top of the B5-01 derivation:
 *
 *   - 失败重试上限    transient failures re-arm with a deterministic operation
 *                    id + cap + exponential backoff; exhausting the cap stops
 *                    auto-retry and turns the task into an author todo,
 *   - 限流/暂时错误    rate-limit (45009) / temporary-unavailability errors are
 *                    classified 'retryable' and retried under backoff,
 *   - 配置错误        permanent / configuration errors are classified
 *                    'needs-author' immediately and NEVER auto-retried,
 *   - 丢响应/未知结果  a dropped response is classified 'unknown'; the task
 *                    FREEZES as an author todo and is NEVER blindly retried —
 *                    only a query/reconcile advances it (未知停止自动重试并成待办),
 *   - 查询后恢复      reconcile found → submitted + media_id saved; reconcile
 *                    not-found → provably never created → re-armed exactly once,
 *   - 重复命令幂等    duplicate executor runs / duplicate reconciles converge on
 *                    ONE submission, ONE attempt per key, ONE task row (D1
 *                    证明未知不建第二草稿),
 *   - 崩溃回收        lease-expired claims are reclaimed; orphaned attempts are
 *                    finalized 'abandoned' then execution continues,
 *   - 脱敏分类        immutable attempt rows carry SANITIZED errors (secrets
 *                    redacted) and the four-way classification,
 *   - media_id 不丢失 覆盖 remote_draft_id (WeChat media_id) is permanent: never
 *                    overwritten on reconciles, retries or supersedure,
 *   - 微信故障不改博客  the executor/reconcile write ONLY wechat tables — blog
 *                    facts (versions/posts/formal publications) never change.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  bootstrapWechatDraftState,
  createDatabase,
  createFormalArticle,
  promoteToVersion2,
  query,
  TEST_SITE_URL,
} from './helpers'
import { MockWechatDraftProvider } from '@/lib/wechat-draft/provider'
import {
  deriveWechatDraft,
  ensureWechatDraftTables,
  listWechatDraftAttempts,
  reconcileWechatDraft,
  runWechatDraftExecutor,
  WECHAT_DRAFT_EXECUTOR_DISABLED_ENV,
} from '@/lib/wechat-draft'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b502-wechat-retry-'))
  cleanup.push(state)
  await bootstrapWechatDraftState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

const ACCOUNT = 'official-retry-a'

const T0 = 1_700_000_000

/** Create a zero-production draft task (no provider at derivation). */
async function createDraftTask(): Promise<{ articleId: number; taskId: string }> {
  const article = await createFormalArticle()
  const derived = await deriveWechatDraft(createDatabase(), {
    articleId: article.articleId,
    version: 1,
    accountId: ACCOUNT,
    siteUrl: TEST_SITE_URL,
  })
  expect(derived.outcome).toBe('created')
  if (derived.outcome !== 'created') throw new Error('derive failed')
  return { articleId: article.articleId, taskId: derived.taskId }
}

function retryable(error: string): import('@/lib/wechat-draft').WechatDraftProviderResult {
  return { accepted: false, classification: 'retryable', error }
}

describe('lib/wechat-draft — 失败/重试/结果未知状态机 (B5-02)', { timeout: 600_000 }, () => {
  it('限流/暂时错误: 带操作 id 的确定性重试 + 指数退避，最终提交并保存 media_id', async () => {
    const { taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([
      retryable('errcode 45009: 接口调用超过限制'),
      retryable('temporarily unavailable'),
      { accepted: true, remoteDraftId: 'media_AB12' },
    ])

    const first = await runWechatDraftExecutor(db, {
      provider,
      now: T0,
      retryBackoffSeconds: 60,
      retryBackoffFactor: 2,
      retryBackoffMaxSeconds: 3600,
    })
    expect(first).toMatchObject({ disabled: false, scanned: 1, claimed: 1, retried: 1 })
    let task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('failed')
    expect(task!.classification).toBe('retryable')
    expect(task!.needs_author).toBe(0)
    expect(task!.attempt_count).toBe(1)
    expect(task!.next_attempt_at).toBe(T0 + 60)
    expect(task!.last_error).toContain('45009')

    // Not due yet — the same tick before backoff elapses must NOT retry.
    const early = await runWechatDraftExecutor(db, {
      provider,
      now: T0 + 30,
      retryBackoffSeconds: 60,
      retryBackoffFactor: 2,
    })
    expect(early.scanned).toBe(0)

    // Due at T0+60; second failure re-arms with backoff(2) = 60*2 = 120.
    const second = await runWechatDraftExecutor(db, {
      provider,
      now: T0 + 60,
      retryBackoffSeconds: 60,
      retryBackoffFactor: 2,
    })
    expect(second.retried).toBe(1)
    task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.attempt_count).toBe(2)
    expect(task!.next_attempt_at).toBe(T0 + 60 + 120)

    // Due at T0+180 → accepted; media_id permanently saved.
    const third = await runWechatDraftExecutor(db, {
      provider,
      now: T0 + 180,
      retryBackoffSeconds: 60,
      retryBackoffFactor: 2,
    })
    expect(third.submitted).toBe(1)
    task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('submitted')
    expect(task!.remote_draft_id).toBe('media_AB12')
    expect(task!.classification).toBe('ok')
    expect(task!.needs_author).toBe(0)
    expect(task!.next_attempt_at).toBeNull()

    expect(provider.totalCalls).toBe(3)
    expect(provider.submitted).toHaveLength(1)
    expect(provider.submitted[0]!.taskId).toBe(taskId)

    // Immutable attempt evidence: deterministic keys, one row per execution.
    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts).toHaveLength(3)
    expect(attempts.map((a) => a.attempt_no)).toEqual([3, 2, 1]) // newest first
    expect(attempts.map((a) => a.outcome).sort()).toEqual(['retried', 'retried', 'submitted'])
    expect(attempts.map((a) => a.classification).sort()).toEqual(['ok', 'retryable', 'retryable'])
    expect(attempts[0]!.remote_draft_id).toBe('media_AB12')
    for (const a of attempts) {
      expect(a.finished_at).not.toBeNull() // immutable: every attempt is finalized exactly once
      expect(a.attempt_key).toMatch(/^wechat-attempt:.+:submit:\d+$/)
    }
  })

  it('失败重试上限: 达到上限后停止自动重试并成为作者待办（下次执行零扫描）', async () => {
    const { taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([
      retryable('errcode 50001: 服务暂时不可用'),
      retryable('network reset'),
      retryable('errcode 45009: 拥挤'),
    ])

    const r1 = await runWechatDraftExecutor(db, { provider, now: T0, maxAttempts: 3, retryBackoffSeconds: 10, retryBackoffFactor: 2 })
    expect(r1.retried).toBe(1)
    const r2 = await runWechatDraftExecutor(db, { provider, now: T0 + 10, maxAttempts: 3, retryBackoffSeconds: 10, retryBackoffFactor: 2 })
    expect(r2.retried).toBe(1)
    const r3 = await runWechatDraftExecutor(db, { provider, now: T0 + 30, maxAttempts: 3, retryBackoffSeconds: 10, retryBackoffFactor: 2 })
    expect(r3.failed).toBe(1)

    const task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('failed')
    expect(task!.classification).toBe('needs-author')
    expect(task!.needs_author).toBe(1) // 成待办
    expect(task!.next_attempt_at).toBeNull() // 停止自动重试
    expect(task!.last_error).toContain('retries-exhausted')

    // Even a far-future executor run never re-arms a capped task.
    const later = await runWechatDraftExecutor(db, {
      provider,
      now: T0 + 100_000,
      maxAttempts: 3,
    })
    expect(later.scanned).toBe(0)
    expect(provider.totalCalls).toBe(3)

    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts).toHaveLength(3)
    expect(attempts.map((a) => a.outcome).sort()).toEqual(['failed', 'retried', 'retried'])
    for (const a of attempts) expect(a.finished_at).not.toBeNull()
  })

  it('配置错误: 立即可识别为 needs-author，绝不自动重试', async () => {
    const { taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([
      { accepted: false, classification: 'needs-author', error: 'errcode 40013: invalid appid (config)' },
    ])

    const run = await runWechatDraftExecutor(db, { provider, now: T0 })
    expect(run.needsAuthor).toBe(1)

    const task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('failed')
    expect(task!.classification).toBe('needs-author')
    expect(task!.needs_author).toBe(1)
    expect(task!.next_attempt_at).toBeNull()

    const later = await runWechatDraftExecutor(db, { provider, now: T0 + 100_000 })
    expect(later.scanned).toBe(0)
    expect(provider.totalCalls).toBe(1)

    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts[0]!.outcome).toBe('failed')
    expect(attempts[0]!.classification).toBe('needs-author')
  })

  it('未知结果冻结: 不盲重试、成待办；查询后确认已创建 → 恢复为 submitted 且 media_id 保存', async () => {
    const { articleId, taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider(
      [{ accepted: false, classification: 'unknown', error: 'response lost: timeout after request sent' }],
      [{ found: true, remoteDraftId: 'media_7' }],
    )

    const run = await runWechatDraftExecutor(db, { provider, now: T0 })
    expect(run.unknown).toBe(1)

    let task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('failed')
    expect(task!.classification).toBe('unknown')
    expect(task!.needs_author).toBe(1) // 未知 → 作者待办
    expect(task!.next_attempt_at).toBeNull() // 停止自动重试

    // 绝无盲重试: even far-future runs never touch a frozen unknown task.
    const blind = await runWechatDraftExecutor(db, { provider, now: T0 + 1_000_000 })
    expect(blind.scanned).toBe(0)
    expect(provider.totalCalls).toBe(1) // only the original (non-retried) call

    // Reconcile by QUERYING the remote first — found ⇒ the submission DID land.
    const reconciled = await reconcileWechatDraft(db, { taskId, provider, now: T0 + 10 })
    expect(reconciled.outcome).toBe('reconciled')
    if (reconciled.outcome !== 'reconciled') return
    expect(reconciled.found).toBe(true)
    expect(reconciled.remoteDraftId).toBe('media_7')

    task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('submitted')
    expect(task!.classification).toBe('ok')
    expect(task!.needs_author).toBe(0)
    expect(task!.remote_draft_id).toBe('media_7') // media_id 保存
    expect(provider.totalQueryCalls).toBe(1)
    expect(provider.queried).toHaveLength(1)
    expect(provider.queried[0]!.taskId).toBe(taskId)
    expect(provider.queried[0]!.accountId).toBe(ACCOUNT)

    // D1 证明未知不建第二草稿: exactly ONE task row for the (article, version, account).
    const rows = await query<{ id: number; task_id: string }>(
      `SELECT id, task_id FROM wechat_draft_tasks
       WHERE article_id = ${articleId} AND account_id = '${ACCOUNT}'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.task_id).toBe(taskId)

    // 迟到/重复结果: a late executor run and a duplicate reconcile are no-ops.
    const late = await runWechatDraftExecutor(db, { provider, now: T0 + 50 })
    expect(late.scanned).toBe(0)
    const replay = await reconcileWechatDraft(db, { taskId, provider, now: T0 + 60 })
    expect(replay.outcome).toBe('replayed')
    expect(replay.outcome === 'replayed' && replay.task?.remote_draft_id).toBe('media_7')

    // media_id 不丢失覆盖 after replays and late runs.
    const finalTask = await readWechatDraftTaskTask(db, taskId)
    expect(finalTask!.remote_draft_id).toBe('media_7')

    // The reconcile is its own immutable attempt row (outcome reconciled, ok).
    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts).toHaveLength(2)
    expect(attempts.map((a) => a.outcome).sort()).toEqual(['reconciled', 'unknown'])
    const reconciledAttempt = attempts.find((a) => a.outcome === 'reconciled')!
    expect(reconciledAttempt.classification).toBe('ok')
    expect(reconciledAttempt.remote_draft_id).toBe('media_7')
    expect(reconciledAttempt.attempt_no).toBe(2)
  })

  it('未知后查询确认未创建: 只安全重提一次，绝不重复草稿', async () => {
    const { articleId, taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider(
      [{ accepted: false, classification: 'unknown', error: 'dropped response' }],
      [{ found: false }],
    )

    await runWechatDraftExecutor(db, { provider, now: T0 })
    const reconciled = await reconcileWechatDraft(db, { taskId, provider, now: T0 + 5 })
    expect(reconciled.outcome).toBe('reconciled')
    if (reconciled.outcome !== 'reconciled') return
    expect(reconciled.found).toBe(false)

    // Provably never created ⇒ re-armed as a fresh draft for ONE safe resubmit.
    let task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('draft')
    expect(task!.classification).toBeNull()
    expect(task!.needs_author).toBe(0)

    const submitter = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_42' }])
    const resubmit = await runWechatDraftExecutor(db, { provider: submitter, now: T0 + 10 })
    expect(resubmit.submitted).toBe(1)

    task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('submitted')
    expect(task!.remote_draft_id).toBe('media_42')

    // Still exactly ONE task row — the re-submission reused the same task id.
    const rows = await query<{ id: number; task_id: string }>(
      `SELECT id, task_id FROM wechat_draft_tasks
       WHERE article_id = ${articleId} AND account_id = '${ACCOUNT}'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.task_id).toBe(taskId)

    // Duplicate reconcile after recovery is a no-op replay.
    const replay = await reconcileWechatDraft(db, { taskId, provider, now: T0 + 20 })
    expect(replay.outcome).toBe('replayed')

    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts).toHaveLength(3)
    const reconcileAttempt = attempts.find((a) => a.outcome === 'reconciled')!
    expect(reconcileAttempt.classification).toBe('retryable')
    expect(reconcileAttempt.error).toContain('confirmed-not-created')
  })

  it('重复命令幂等: 同一时刻多个执行器并发收敛为一次提交、一条尝试、一个任务', async () => {
    const { articleId, taskId } = await createDraftTask()
    const db = createDatabase()

    const providerA = new MockWechatDraftProvider()
    const providerB = new MockWechatDraftProvider()
    const [ra, rb] = await Promise.all([
      runWechatDraftExecutor(db, { provider: providerA, now: T0, leaseSeconds: 600 }),
      runWechatDraftExecutor(db, { provider: providerB, now: T0, leaseSeconds: 600 }),
    ])
    const totalSubmissions = (ra.submitted || 0) + (rb.submitted || 0)
    expect(totalSubmissions).toBe(1)
    expect(providerA.totalCalls + providerB.totalCalls).toBe(1)

    const task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('submitted')
    expect(task!.remote_draft_id).toBe('mock-draft-1')

    // Sequential duplicate command (same clock) is already a no-op: zero scan.
    const dup = await runWechatDraftExecutor(db, { provider: providerA, now: T0 })
    expect(dup.scanned).toBe(0)

    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.outcome).toBe('submitted')

    const rows = await query<{ id: number }>(
      `SELECT id FROM wechat_draft_tasks WHERE article_id = ${articleId} AND account_id = '${ACCOUNT}'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('崩溃回收: 租约过期后回收，孤儿尝试被标记 abandoned 后继续执行', async () => {
    const { taskId } = await createDraftTask()
    const db = createDatabase()

    // Simulate a crashed run: claimed with an expired lease + a running attempt.
    await query(
      `UPDATE wechat_draft_tasks
       SET claimed_at = 900, lease_expires_at = 900, lease_token = 'crashed-runner',
           attempt_count = 1, revision = 1
       WHERE task_id = '${taskId}'`,
    )
    await query(
      `INSERT INTO wechat_draft_attempts
         (attempt_key, task_id, attempt_no, classification, outcome,
          started_at, created_at, updated_at)
       VALUES ('wechat-attempt:${taskId}:submit:1', '${taskId}', 1, 'retryable', 'retried', 900, 900, 900)`,
    )

    const provider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_crash_ok' }])
    const run = await runWechatDraftExecutor(db, { provider, now: T0, leaseSeconds: 600 })
    expect(run.claimed).toBe(1)
    expect(run.submitted).toBe(1)

    const task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.status).toBe('submitted')
    expect(task!.remote_draft_id).toBe('media_crash_ok')
    expect(task!.lease_token).toBeNull()
    expect(task!.attempt_count).toBe(2)

    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts).toHaveLength(2)
    const orphaned = attempts.find((a) => a.attempt_no === 1)!
    const fresh = attempts.find((a) => a.attempt_no === 2)!
    expect(orphaned.outcome).toBe('abandoned')
    expect(orphaned.error).toContain('lease expired')
    expect(fresh.outcome).toBe('submitted')
    expect(fresh.remote_draft_id).toBe('media_crash_ok')
  })

  it('kill-switch: 关闭渠道执行器后任务/尝试/远端身份全部保留', async () => {
    const { taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider()

    process.env[WECHAT_DRAFT_EXECUTOR_DISABLED_ENV] = '1'
    try {
      const run = await runWechatDraftExecutor(db, { provider, now: T0 })
      expect(run.disabled).toBe(true)
      expect(run.scanned).toBe(0)
      expect(run.claimed).toBe(0)
      expect(provider.totalCalls).toBe(0)

      const task = await readWechatDraftTaskTask(db, taskId)
      expect(task!.status).toBe('draft')
      expect(task!.attempt_count).toBe(0)
      expect((await listWechatDraftAttempts(db, taskId)).length).toBe(0)
    } finally {
      delete process.env[WECHAT_DRAFT_EXECUTOR_DISABLED_ENV]
    }

    // Re-enabled run converges: the draft is submitted once.
    const run = await runWechatDraftExecutor(db, { provider, now: T0 })
    expect(run.submitted).toBe(1)
    expect(provider.totalCalls).toBe(1)
  })

  it('媒体/远端身份: 派生即成功提交的 media_id 在版本切换后由新旧任务永久保留', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([
      { accepted: true, remoteDraftId: 'media_v1' },
      { accepted: true, remoteDraftId: 'media_v2' },
    ])

    const v1 = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(v1.outcome).toBe('submitted')
    if (v1.outcome !== 'submitted') throw new Error('v1 should be submitted')
    expect(v1.task.remote_draft_id).toBe('media_v1')

    const promoted = await promoteToVersion2(article, 'B502 新版本', '# 升级\n\n第二版本正文。')
    const v2 = await deriveWechatDraft(db, {
      articleId: promoted.articleId,
      version: 2,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(v2.outcome).toBe('submitted')
    if (v2.outcome !== 'submitted') throw new Error('v2 should be submitted')
    expect(v2.task.remote_draft_id).toBe('media_v2')

    // media_id 不丢失覆盖: BOTH frozen rows keep their own permanent identity.
    const rows = await query<{ version: number; status: string; remote_draft_id: string | null }>(
      `SELECT version, status, remote_draft_id FROM wechat_draft_tasks
       WHERE article_id = ${article.articleId} AND account_id = '${ACCOUNT}' ORDER BY version`,
    )
    expect(rows.map((r) => r.version)).toEqual([1, 2])
    expect(rows[0]!.remote_draft_id).toBe('media_v1') // superseded row KEEPS its media_id
    expect(rows[0]!.status).toBe('superseded')
    expect(rows[1]!.remote_draft_id).toBe('media_v2')

    // A reconcile against the superseded (already-submitted) v1 is a no-op
    // that never touches the permanent media_id (superseded is not unknown).
    const replay = await reconcileWechatDraft(db, { taskId: v1.taskId, provider, now: T0 })
    expect(['replayed', 'not-unknown']).toContain(replay.outcome)
    expect(replay.outcome !== 'invalid' && replay.outcome !== 'not-found' && replay.task?.remote_draft_id).toBe('media_v1')
  })

  it('脱敏分类: 尝试与任务事实只存脱敏错误，绝不留存密钥', async () => {
    const { taskId } = await createDraftTask()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([
      { accepted: false, classification: 'retryable', error: 'auth failed appsecret=sec_12345 token Bearer abc123.zzz api_key=ak_999' },
    ])

    await runWechatDraftExecutor(db, { provider, now: T0 })
    const task = await readWechatDraftTaskTask(db, taskId)
    expect(task!.last_error).not.toContain('sec_12345')
    expect(task!.last_error).not.toContain('abc123')
    expect(task!.last_error).not.toContain('ak_999')
    expect(task!.last_error).toContain('REDACTED')

    const attempts = await listWechatDraftAttempts(db, taskId)
    expect(attempts[0]!.error).not.toContain('sec_12345')
    expect(attempts[0]!.error).toContain('REDACTED')
  })

  it('微信故障不改博客结果: 失败/未知/重试期间博客事实完全不变', async () => {
    const { articleId, taskId } = await createDraftTask()
    const db = createDatabase()

    const snapshot = async () => {
      const versions = await query<{ id: number; article_id: number; version: number }>(
        `SELECT id, article_id, version FROM article_versions WHERE article_id = ${articleId} ORDER BY id`,
      )
      const posts = await query<{ id: number; slug: string; title: string }>(
        `SELECT id, slug, title FROM posts WHERE id = (SELECT post_ref FROM articles WHERE id = ${articleId})`,
      )
      const formal = await query<{ article_id: number; version: number; lifecycle: string }>(
        `SELECT article_id, version, lifecycle FROM formal_publications WHERE article_id = ${articleId}`,
      )
      return { versions, posts, formal }
    }

    const before = await snapshot()
    const failing = new MockWechatDraftProvider([
      retryable('errcode 45009'),
      { accepted: false, classification: 'unknown', error: 'dropped' },
    ])
    await runWechatDraftExecutor(db, { provider: failing, now: T0, maxAttempts: 2 })
    await runWechatDraftExecutor(db, { provider: failing, now: T0 + 100, maxAttempts: 2 })
    await reconcileWechatDraft(db, { taskId, provider: failing, now: T0 + 200 })

    const after = await snapshot()
    expect(after).toEqual(before)
    // The blog article is still the SAME exact formal version — nothing rolled back.
    expect(after.formal[0]!.version).toBe(1)
  })

  it('DDL 幂等: B5-01 时代旧表经 PRAGMA 升级为 B5-02 形状，重复运行无副作用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blogman-b502-ddl-upgrade-'))
    cleanup.push(dir)
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'b502-ddl-upgrade' },
      persist: dir,
    })
    try {
      const db = (await mf.getD1Database('DB')) as D1Database
      // A B5-01-era wechat_draft_tasks — no B5-02 columns, no attempts table.
      await db.prepare(
        `CREATE TABLE wechat_draft_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT UNIQUE NOT NULL CHECK(length(task_id) > 0),
          article_id INTEGER NOT NULL CHECK(article_id > 0),
          post_ref INTEGER NOT NULL CHECK(post_ref > 0),
          version INTEGER NOT NULL CHECK(version > 0),
          account_id TEXT NOT NULL CHECK(length(account_id) > 0),
          status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'failed', 'superseded')),
          title TEXT NOT NULL,
          html_projection TEXT NOT NULL,
          plaintext_projection TEXT NOT NULL,
          cover_image_url TEXT,
          digest TEXT,
          content_sha256 TEXT NOT NULL,
          projection_sha256 TEXT NOT NULL,
          source_url TEXT NOT NULL,
          remote_draft_id TEXT,
          provider_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (article_id, version, account_id)
        ) STRICT`,
      ).run()

      await ensureWechatDraftTables(db)

      const { results: cols } = await db.prepare('PRAGMA table_info(wechat_draft_tasks)').all<{ name: string }>()
      const names = new Set(cols.map((c) => c.name))
      for (const col of ['revision', 'attempt_count', 'classification', 'needs_author', 'next_attempt_at', 'last_error', 'claimed_at', 'lease_token', 'lease_expires_at']) {
        expect(names.has(col)).toBe(true)
      }
      const attemptsTable = await db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wechat_draft_attempts'`,
      ).first<{ name: string }>()
      expect(attemptsTable?.name).toBe('wechat_draft_attempts')

      // Idempotent re-run adds nothing and never fails.
      await ensureWechatDraftTables(db)
      const { results: cols2 } = await db.prepare('PRAGMA table_info(wechat_draft_tasks)').all<{ name: string }>()
      expect(cols2.length).toBe(cols.length)
    } finally {
      await mf.dispose()
    }
  })
})

/** Read a task row by task_id (the shared read API is (article, version, account)). */
async function readWechatDraftTaskTask(db: ReturnType<typeof createDatabase>, taskId: string) {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM wechat_draft_tasks WHERE task_id = '${taskId}'`,
  )
  if (!rows[0]) return null
  return rows[0] as unknown as import('@/lib/wechat-draft').WechatDraftTaskRow
}