/**
 * B5-03 — 交付前设置调整、替代草稿与历史 (issue #48), D1-backed.
 *
 * Proves the delivery-settings / generation / replacement contracts on top of
 * the B5-01 derivation + B5-02 retry state machine:
 *
 *   - 交付前设置调整与代次分离   saving deliverable settings bumps the
 *                    settings revision only — the article body version and the
 *                    delivery generation never move; re-deriving applies them
 *                    to the SAME task id / generation (沿用代次),
 *   - 设置修订不改变正文版本     settings writes never touch article_versions /
 *                    formal_publications,
 *   - 交付后不自动改稿     a delivered (submitted) row is never re-projected by
 *                    derive; only an EXPLICIT replacement creates a new draft,
 *   - 替代草稿新代次且旧身份保留   the replacement is the next monotonic
 *                    generation, references the prior generation, and the old
 *                    row (with its media_id) is preserved as superseded,
 *   - 替代草稿必须已交付     replacing a not-yet-delivered row is rejected,
 *   - 待微信确认     a delivered view reports 待微信确认 and NEVER 已发布;
 *                    the provider is only ever asked to create a draft-box
 *                    draft or query it (无群发路径, 自动化止于草稿),
 *   - 初始配置映射不猜历史     the first settings save maps to revision 1,
 *   - 旧 media_id/代次不可删除或覆盖   supersede/replace never deletes or
 *                    overwrites a stored remote_draft_id,
 *   - 可关闭管理写动作     WECHAT_DRAFT_ADMIN_WRITES_DISABLED closes the
 *                    settings/replace WRITE commands; reads keep working,
 *   - 新正式版本     a promoted version derives a new generation; prior
 *                    generations stay readable in the history ledger.
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
  listWechatDeliveries,
  listWechatDraftTasks,
  readWechatDeliveryView,
  readWechatDraftSettings,
  reconcileWechatDraft,
  replaceWechatDraft,
  runWechatDraftExecutor,
  saveWechatDraftSettings,
  WECHAT_DRAFT_ADMIN_WRITES_DISABLED_ENV,
} from '@/lib/wechat-draft'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b503-wechat-settings-'))
  cleanup.push(state)
  await bootstrapWechatDraftState(state)
}, 120_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

const ACCOUNT = 'official-settings-a'
const T0 = 1_700_000_000

/** Deliver a draft for a fresh formal article (mock accepted). */
async function deliverDraft(mediaId = 'media_v1'): Promise<{ articleId: number; taskId: string }> {
  const article = await createFormalArticle()
  const db = createDatabase()
  const provider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: mediaId }])
  const derived = await deriveWechatDraft(db, {
    articleId: article.articleId,
    version: 1,
    accountId: ACCOUNT,
    provider,
    siteUrl: TEST_SITE_URL,
  })
  expect(derived.outcome).toBe('submitted')
  if (derived.outcome !== 'submitted') throw new Error('deliverDraft failed')
  return { articleId: article.articleId, taskId: derived.taskId }
}

describe('lib/wechat-draft — 交付前设置、替代草稿与历史 (B5-03)', { timeout: 600_000 }, () => {
  it('初始配置映射不猜历史: 首次保存映射为修订 1，且设置修订绝不改变正文版本', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const saved = await saveWechatDraftSettings(db, {
      articleId: article.articleId,
      accountId: ACCOUNT,
      title: '定制标题',
      digest: '定制摘要',
      now: T0,
    })
    expect(saved.outcome).toBe('saved')
    if (saved.outcome !== 'saved') return
    expect(saved.created).toBe(true)
    expect(saved.settingsRevision).toBe(1) // 初始修订 = 1, 不猜历史
    expect(saved.settings.settings_revision).toBe(1)

    // 第二次保存 → 修订 2（它是一条新的设置修订，不是历史的猜测）。
    const again = await saveWechatDraftSettings(db, {
      articleId: article.articleId,
      accountId: ACCOUNT,
      title: '再改标题',
      now: T0 + 10,
    })
    expect(again.outcome).toBe('saved')
    if (again.outcome !== 'saved') return
    expect(again.created).toBe(false)
    expect(again.settingsRevision).toBe(2)

    const settings = await readWechatDraftSettings(db, article.articleId, ACCOUNT)
    expect(settings?.settings_revision).toBe(2)
    expect(settings?.title_override).toBe('再改标题')

    // 设置修订与正文版本分离：article_versions / formal_publications 完全不变。
    const versions = await query<{ id: number }>(
      `SELECT id FROM article_versions WHERE article_id = ${article.articleId}`,
    )
    const formal = await query<{ version: number }>(
      `SELECT version FROM formal_publications WHERE article_id = ${article.articleId}`,
    )
    expect(versions).toHaveLength(1) // 仍是 v1 一个快照
    expect(formal[0]?.version).toBe(1)
  })

  it('交付前设置调整沿用代次: 同任务 id/同代次原地更新投影，绝不新建代次', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()

    const first = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(first.outcome).toBe('created')
    if (first.outcome !== 'created') return
    expect(first.generation).toBe(1)
    expect(first.task.settings_revision).toBe(0)
    expect(first.task.title).toBe('正式文章标题')

    // 交付前保存设置（修订 1）并重新派生 → 同一任务 id, 同一代次, 投影更新。
    await saveWechatDraftSettings(db, {
      articleId: article.articleId,
      accountId: ACCOUNT,
      title: '交付前定制标题',
      digest: '交付前定制摘要',
      now: T0,
    })
    const updated = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(updated.outcome).toBe('updated')
    if (updated.outcome !== 'updated') return
    expect(updated.taskId).toBe(first.taskId) // 沿用代次：同一任务
    expect(updated.task.id).toBe(first.task.id)
    expect(updated.generation).toBe(1) // 代次不变
    expect(updated.settingsRevision).toBe(1) // 设置修订变
    expect(updated.task.title).toBe('交付前定制标题')
    expect(updated.task.digest).toBe('交付前定制摘要')
    expect(updated.task.html_projection).toContain('交付前定制标题')
    expect(updated.task.projection_sha256).not.toBe(first.task.projection_sha256)

    // 正文版本仍未变（设置修订不改变正文版本）。
    const formal = await query<{ version: number }>(
      `SELECT version FROM formal_publications WHERE article_id = ${article.articleId}`,
    )
    expect(formal[0]?.version).toBe(1)

    // 相同设置重复派生 → existing（无变化）。
    const replay = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    expect(replay.outcome).toBe('existing')

    // 仍然只有一个任务行、一个代次。
    const rows = await listWechatDraftTasks(db, article.articleId, ACCOUNT)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.settings_revision).toBe(1)
    const deliveries = await listWechatDeliveries(db, article.articleId, ACCOUNT)
    expect(deliveries.map((d) => d.delivery.generation)).toEqual([1])
  })

  it('已交付后的设置调整不碰已交付行: derive 返回 existing 且绝不覆盖原事实', async () => {
    const { articleId } = await deliverDraft('media_delivered')
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'should-not-call' }])

    await saveWechatDraftSettings(db, {
      articleId,
      accountId: ACCOUNT,
      title: '交付后想改标题',
      now: T0,
    })

    const existing = await deriveWechatDraft(db, {
      articleId,
      version: 1,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(existing.outcome).toBe('existing') // 已交付 → 绝不自动改稿 / 重提交
    expect(provider.totalCalls).toBe(0)
    expect(existing.outcome === 'existing' && existing.task.remote_draft_id).toBe('media_delivered')
    expect(existing.outcome === 'existing' && existing.task.title).toBe('正式文章标题')
  })

  it('交付前不可替代; 必须显式替代已交付代次 → 新代次引用前代、旧身份保留、待微信确认', async () => {
    // (a) 尚未交付(零生产 draft) → 拒绝替代, 零写入。
    const articleA = await createFormalArticle()
    const db = createDatabase()
    await deriveWechatDraft(db, {
      articleId: articleA.articleId,
      version: 1,
      accountId: ACCOUNT,
      siteUrl: TEST_SITE_URL,
    })
    const notDelivered = await replaceWechatDraft(db, {
      articleId: articleA.articleId,
      accountId: ACCOUNT,
      now: T0,
      siteUrl: TEST_SITE_URL,
    })
    expect(notDelivered.outcome).toBe('not-delivered')
    if (notDelivered.outcome === 'not-delivered') expect(notDelivered.current.status).toBe('draft')
    expect((await listWechatDraftTasks(db, articleA.articleId, ACCOUNT)).length).toBe(1)
    expect(await query<{ id: number }>(`SELECT id FROM wechat_draft_replacements WHERE article_id = ${articleA.articleId}`)).toHaveLength(0)

    // (b) 已交付(模拟 provider 接受) → submitted, media_id 保存。
    const { articleId, taskId } = await deliverDraft('media_A') // 以独立文章交付
    const dbB = createDatabase()

    // 待微信确认视图 — 永不声称已发布。
    const view = await readWechatDeliveryView(dbB, taskId)
    expect(view?.awaitingWechatConfirmation).toBe(true)
    expect(view?.humanLabel).toContain('待微信确认')
    expect(view?.humanLabel).not.toContain('已发布')
    expect(view?.remoteDraftId).toBe('media_A')
    expect(view?.generation).toBe(1)

    // 显式替代 → 新代次(2), 引用前代, 新 media_id。
    const replacementProvider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_B' }])
    const replaced = await replaceWechatDraft(dbB, {
      taskId,
      provider: replacementProvider,
      now: T0 + 10,
      siteUrl: TEST_SITE_URL,
    })
    expect(replaced.outcome).toBe('submitted')
    if (replaced.outcome !== 'submitted') return
    expect(replaced.generation).toBe(2)
    expect(replaced.replacesTaskId).toBe(taskId) // 替代代次引用前代
    expect(replaced.taskId).toBe(`wechat-replacement:${taskId}`)
    expect(replaced.replacement.remote_draft_id).toBe('media_B')
    expect(replaced.replacement.status).toBe('submitted')

    // 旧身份保留：旧任务行仍在，media_id 保留，状态 superseded。
    const oldRow = await query<{ status: string; remote_draft_id: string | null }>(
      `SELECT status, remote_draft_id FROM wechat_draft_tasks WHERE task_id = '${taskId}'`,
    )
    expect(oldRow[0]?.status).toBe('superseded')
    expect(oldRow[0]?.remote_draft_id).toBe('media_A') // 旧 media_id 不可删除/覆盖
    expect(replacementProvider.submitted).toHaveLength(1)
    expect(replacementProvider.submitted[0]!.title).toBe('正式文章标题')

    // 替代草稿视图：待微信确认 (绝不等于已发布)。
    const replView = await readWechatDeliveryView(dbB, replaced.taskId)
    expect(replView?.awaitingWechatConfirmation).toBe(true)
    expect(replView?.humanLabel).toBe('待微信确认')
    expect(replView?.remoteDraftId).toBe('media_B')

    // 历史：代次 1 → 2, 链可追踪。
    const history = await listWechatDeliveries(dbB, articleId, ACCOUNT)
    expect(history.map((d) => d.delivery.generation)).toEqual([1, 2])
    expect(history[0]!.delivery.key).toBe(taskId)
    expect(history[0]!.delivery.remoteDraftId).toBe('media_A')
    expect(history[0]!.delivery.status).toBe('superseded')
    expect(history[1]!.delivery.key).toBe(replaced.taskId)
    expect(history[1]!.replacesTaskId).toBe(taskId)
    expect(history[1]!.delivery.remoteDraftId).toBe('media_B')
  })

  it('替代草稿幂等: 同一前代绝不建第二个替代行；替代新当前代会继续下一代', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_1' }])
    const derived = await deriveWechatDraft(db, {
      articleId: article.articleId,
      version: 1,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(derived.outcome).toBe('submitted')
    if (derived.outcome !== 'submitted') return

    const first = await replaceWechatDraft(db, {
      taskId: derived.taskId,
      provider: new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_2' }]),
      now: T0,
      siteUrl: TEST_SITE_URL,
    })
    expect(first.outcome).toBe('submitted')
    if (first.outcome !== 'submitted') return
    expect(first.generation).toBe(2)

    // 再次用同一个前代键替代 → 前代已 superseded → 拒绝, 绝无重复替代行。
    const dup = await replaceWechatDraft(db, {
      taskId: derived.taskId,
      provider: new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'dup' }]),
      now: T0 + 1,
      siteUrl: TEST_SITE_URL,
    })
    expect(dup.outcome).toBe('not-delivered')
    const rows = await query<{ id: number }>(
      `SELECT id FROM wechat_draft_replacements WHERE article_id = ${article.articleId} AND account_id = '${ACCOUNT}'`,
    )
    expect(rows).toHaveLength(1) // 幂等：绝不重复建替代草稿

    // 替代新的当前代（gen2, 已交付）→ 下一代 gen3, 链: gen1 → gen2 → gen3。
    const next = await replaceWechatDraft(db, {
      taskId: first.taskId,
      provider: new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'media_3' }]),
      now: T0 + 20,
      siteUrl: TEST_SITE_URL,
    })
    expect(next.outcome).toBe('submitted')
    if (next.outcome !== 'submitted') return
    expect(next.generation).toBe(3)
    expect(next.replacesTaskId).toBe(first.taskId)

    const history = await listWechatDeliveries(db, article.articleId, ACCOUNT)
    expect(history.map((d) => d.delivery.generation)).toEqual([1, 2, 3])
    expect(history.map((d) => d.delivery.remoteDraftId)).toEqual(['media_1', 'media_2', 'media_3'])
    expect(history.map((d) => d.delivery.status)).toEqual(['superseded', 'superseded', 'submitted'])
  })

  it('替代草稿的重试走同一状态机: 暂时失败重试后交付，自动化止于草稿', async () => {
    const { taskId } = await deliverDraft('media_first')
    const db = createDatabase()

    // 替代时 provider 暂时失败 → 重试臂挂起, 失败尝试记录。
    const failing = new MockWechatDraftProvider([
      { accepted: false, classification: 'retryable', error: 'errcode 45009: 接口调用超过限制' },
    ])
    const replaced = await replaceWechatDraft(db, {
      taskId,
      provider: failing,
      now: T0,
      maxAttempts: 5,
      retryBackoffSeconds: 60,
      retryBackoffFactor: 2,
      siteUrl: TEST_SITE_URL,
    })
    expect(replaced.outcome).toBe('failed')
    if (replaced.outcome !== 'failed') return
    const replKey = replaced.taskId
    expect(replaced.replacement.status).toBe('failed')
    expect(replaced.replacement.classification).toBe('retryable')
    expect(replaced.replacement.next_attempt_at).toBe(T0 + 60)

    // 到期后执行器扫描扫到并交付该替代草稿（只到草稿箱）。断言按行, 不依赖全局计数：
    // 队列给足足够结果，替代草稿拿到自己的 media_id。
    const acceptor = new MockWechatDraftProvider([
      { accepted: true, remoteDraftId: 'media_leftover_1' },
      { accepted: true, remoteDraftId: 'media_leftover_2' },
      { accepted: true, remoteDraftId: 'media_leftover_3' },
      { accepted: true, remoteDraftId: 'media_retry_ok' },
    ])
    await runWechatDraftExecutor(db, {
      provider: acceptor,
      now: T0 + 60,
      leaseSeconds: 600,
      retryBackoffSeconds: 60,
      retryBackoffFactor: 2,
    })
    expect(acceptor.submitted.some((p) => p.taskId === replKey)).toBe(true)
    const after = await query<{ status: string; remote_draft_id: string | null; classification: string | null }>(
      `SELECT status, remote_draft_id, classification FROM wechat_draft_replacements WHERE replacement_key = '${replKey}'`,
    )
    expect(after[0]?.status).toBe('submitted')
    expect(after[0]?.remote_draft_id).not.toBeNull() // 拿到自己的 media_id
    expect(after[0]?.classification).toBe('ok')

    // 尝试事实: 替代草稿有自己的不可变尝试（首次失败 + 重试提交）。
    const attempts = await query<{ task_id: string; outcome: string }>(
      `SELECT task_id, outcome FROM wechat_draft_attempts WHERE task_id = '${replKey}' ORDER BY id`,
    )
    expect(attempts.map((a) => a.outcome)).toEqual(['retried', 'submitted'])
  })

  it('零生产替代草稿: 无 provider 时只建草稿, 不发生任何外部调用', async () => {    const { taskId } = await deliverDraft('media_z')
    const db = createDatabase()

    const replaced = await replaceWechatDraft(db, {
      taskId,
      now: T0,
      siteUrl: TEST_SITE_URL,
    })
    expect(replaced.outcome).toBe('created')
    if (replaced.outcome !== 'created') return
    expect(replaced.handout).toBe(false)
    expect(replaced.replacement.status).toBe('draft')
    expect(replaced.replacement.remote_draft_id).toBeNull()
    expect(replaced.replacement.attempt_count).toBe(0)
    const attempts = await query<{ id: number }>(
      `SELECT id FROM wechat_draft_attempts WHERE task_id = '${replaced.taskId}'`,
    )
    expect(attempts).toHaveLength(0)
  })

  it('替代草稿的结果未知: 冻结为作者待办，查询对账后恢复并保存新 media_id', async () => {
    const { taskId } = await deliverDraft('media_orig')
    const db = createDatabase()

    // 替代交付时响应丢失 → 结果未知：冻结为待办, 绝无盲重试。
    const unknownProvider = new MockWechatDraftProvider([
      { accepted: false, classification: 'unknown', error: 'response lost' },
    ])
    const replaced = await replaceWechatDraft(db, {
      taskId,
      provider: unknownProvider,
      now: T0,
      siteUrl: TEST_SITE_URL,
    })
    expect(replaced.outcome).toBe('unknown')
    if (replaced.outcome !== 'unknown') return
    const replKey = replaced.taskId
    const frozen = await query<{ status: string; classification: string | null; needs_author: number; next_attempt_at: number | null }>(
      `SELECT status, classification, needs_author, next_attempt_at FROM wechat_draft_replacements WHERE replacement_key = '${replKey}'`,
    )
    expect(frozen[0]?.status).toBe('failed')
    expect(frozen[0]?.classification).toBe('unknown')
    expect(frozen[0]?.needs_author).toBe(1) // 未知 → 作者待办 / 停止自动重试
    expect(frozen[0]?.next_attempt_at).toBeNull()

    // 查询对账发现远端确实创建了草稿 → 恢复 submitted 并保存新 media_id。
    const reconciler = new MockWechatDraftProvider([], [{ found: true, remoteDraftId: 'media_reconciled' }])
    const reconciled = await reconcileWechatDraft(db, { taskId: replKey, provider: reconciler, now: T0 + 5 })
    expect(reconciled.outcome).toBe('reconciled')
    if (reconciled.outcome !== 'reconciled') return
    expect(reconciled.found).toBe(true)
    expect(reconciled.remoteDraftId).toBe('media_reconciled')
    const after = await query<{ status: string; remote_draft_id: string | null }>(
      `SELECT status, remote_draft_id FROM wechat_draft_replacements WHERE replacement_key = '${replKey}'`,
    )
    expect(after[0]?.status).toBe('submitted')
    expect(after[0]?.remote_draft_id).toBe('media_reconciled')

    // 旧代次身份依旧保留（未被删除/覆盖）。
    const old = await query<{ status: string; remote_draft_id: string | null }>(
      `SELECT status, remote_draft_id FROM wechat_draft_tasks WHERE task_id = '${taskId}'`,
    )
    expect(old[0]?.remote_draft_id).toBe('media_orig')
  })

  it('新正式版本: 派生新代次并保留旧代次与 media_id；旧替代草稿随版本前进被 superseded', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()
    const provider = new MockWechatDraftProvider([
      { accepted: true, remoteDraftId: 'media_v1' },
      { accepted: true, remoteDraftId: 'media_r1' },
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
    if (v1.outcome !== 'submitted') return

    // 显式替代 gen1 → gen2 (v1 的替代草稿)。
    const r1 = await replaceWechatDraft(db, {
      taskId: v1.taskId,
      provider,
      now: T0,
      siteUrl: TEST_SITE_URL,
    })
    expect(r1.outcome).toBe('submitted')
    if (r1.outcome !== 'submitted') return

    // 新正式版本 → gen3 基础任务；gen1/gen2 全部 superseded, 身份保留。
    const promoted = await promoteToVersion2(article, '升级后标题', '# 升级正文\n\nv2 正文')
    const v2 = await deriveWechatDraft(db, {
      articleId: promoted.articleId,
      version: 2,
      accountId: ACCOUNT,
      provider,
      siteUrl: TEST_SITE_URL,
    })
    expect(v2.outcome).toBe('submitted')
    if (v2.outcome !== 'submitted') return
    expect(v2.generation).toBe(3)
    expect(v2.task.remote_draft_id).toBe('media_v2')

    const history = await listWechatDeliveries(db, article.articleId, ACCOUNT)
    expect(history.map((d) => d.delivery.generation)).toEqual([1, 2, 3])
    expect(history.map((d) => d.delivery.version)).toEqual([1, 1, 2])
    expect(history.map((d) => d.delivery.remoteDraftId)).toEqual(['media_v1', 'media_r1', 'media_v2'])
    expect(history.map((d) => d.delivery.status)).toEqual(['superseded', 'superseded', 'submitted'])

    // 旧任务行 / 替代行都仍存在（不可删除）。
    expect(await query<{ id: number }>(`SELECT id FROM wechat_draft_tasks WHERE task_id = '${v1.taskId}'`)).toHaveLength(1)
    expect(await query<{ id: number }>(`SELECT id FROM wechat_draft_replacements WHERE replacement_key = '${r1.taskId}'`)).toHaveLength(1)
  })

  it('可关闭管理写动作: 设置保存与替代草稿被禁用, 读取全部可用', async () => {
    const article = await createFormalArticle()
    const db = createDatabase()
    await saveWechatDraftSettings(db, {
      articleId: article.articleId,
      accountId: ACCOUNT,
      title: '开关前的设置',
      now: T0,
    })
    const { taskId } = await deliverDraftFor(db, article.articleId, 'media_switch')

    process.env[WECHAT_DRAFT_ADMIN_WRITES_DISABLED_ENV] = '1'
    try {
      const saved = await saveWechatDraftSettings(db, {
        articleId: article.articleId,
        accountId: ACCOUNT,
        title: '被禁时应拒绝',
        now: T0,
      })
      expect(saved.outcome).toBe('disabled')

      const replaced = await replaceWechatDraft(db, {
        taskId,
        provider: new MockWechatDraftProvider([{ accepted: true, remoteDraftId: 'no' }]),
        now: T0,
        siteUrl: TEST_SITE_URL,
      })
      expect(replaced.outcome).toBe('disabled')

      // 读取不受影响: 设置 / 任务 / 代次 / 身份全部可读。
      expect(await readWechatDraftSettings(db, article.articleId, ACCOUNT)).not.toBeNull()
      expect((await listWechatDraftTasks(db, article.articleId, ACCOUNT)).length).toBe(1)
      expect((await listWechatDeliveries(db, article.articleId, ACCOUNT)).length).toBe(1)
      const view = await readWechatDeliveryView(db, taskId)
      expect(view?.remoteDraftId).toBe('media_switch')
      expect(view?.awaitingWechatConfirmation).toBe(true)
    } finally {
      delete process.env[WECHAT_DRAFT_ADMIN_WRITES_DISABLED_ENV]
    }
  })

  it('无群发路径: provider 只接受 createDraft/queryDraft 草稿箱调用，载荷无群发字段', async () => {
    const { taskId, articleId } = await deliverDraft('media_q')
    const db = createDatabase()
    const provider = new MockWechatDraftProvider()

    // 替代草稿交付只走 createDraft, payload 是草稿箱字段(无 publish_now/mass_send)。
    const repl = await replaceWechatDraft(db, {
      taskId,
      provider,
      now: T0 + 1,
      siteUrl: TEST_SITE_URL,
    })
    expect(repl.outcome).toBe('submitted')
    if (repl.outcome !== 'submitted') return
    expect(provider.totalQueryCalls).toBe(0) // 没有自动查询/群发
    const payload = provider.submitted.find((p) => p.taskId === repl.taskId)
    expect(payload).toBeTruthy()
    const allowed = [
      'taskId', 'articleId', 'version', 'accountId', 'contentSha256',
      'title', 'html', 'plaintext', 'coverImageUrl', 'digest', 'sourceUrl',
    ]
    for (const key of allowed) expect(payload).toHaveProperty(key)
    for (const forbidden of ['publish_now', 'mass_send', 'send', 'draft_id', 'media_id']) {
      expect(Object.keys(payload!).includes(forbidden)).toBe(false)
    }

    // 全链路没有任何“已发布”声明: 所有已交付视图都是待微信确认。
    const views = (await listWechatDeliveries(db, articleId, ACCOUNT)).map((d) => d.delivery)
    expect(views.every((v) => !String(v.status).includes('publish'))).toBe(true)
    for (const v of views) {
      const view = wechatViewOf(v)
      expect(view.humanLabel.includes('已发布')).toBe(false)
      if (v.status === 'submitted') expect(view.awaitingWechatConfirmation).toBe(true)
    }
  })

  it('DDL 幂等: B5-01 时代旧表经 PRAGMA 升级为 B5-03 形状，新表重复创建无副作用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blogman-b503-ddl-upgrade-'))
    cleanup.push(dir)
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'b503-ddl-upgrade' },
      persist: dir,
    })
    try {
      const db = (await mf.getD1Database('DB')) as D1Database
      // A B5-01-era wechat_draft_tasks — no B5-02/B5-03 columns, no extra tables.
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
      for (const col of ['revision', 'attempt_count', 'classification', 'needs_author', 'next_attempt_at', 'last_error', 'claimed_at', 'lease_token', 'lease_expires_at', 'generation', 'settings_revision']) {
        expect(names.has(col)).toBe(true)
      }
      for (const table of ['wechat_draft_attempts', 'wechat_draft_settings', 'wechat_draft_generations', 'wechat_draft_replacements']) {
        const row = await db.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
        ).first<{ name: string }>()
        expect(row?.name).toBe(table)
      }

      // Idempotent re-run adds nothing and never fails.
      await ensureWechatDraftTables(db)
      const { results: cols2 } = await db.prepare('PRAGMA table_info(wechat_draft_tasks)').all<{ name: string }>()
      expect(cols2.length).toBe(cols.length)
    } finally {
      await mf.dispose()
    }
  })
})

/** Mock-accept a fresh task for a given article id (delivered, media saved). */
async function deliverDraftFor(db: ReturnType<typeof createDatabase>, articleId: number, mediaId: string): Promise<{ taskId: string }> {
  const provider = new MockWechatDraftProvider([{ accepted: true, remoteDraftId: mediaId }])
  const derived = await deriveWechatDraft(db, {
    articleId,
    version: 1,
    accountId: ACCOUNT,
    provider,
    siteUrl: TEST_SITE_URL,
  })
  expect(derived.outcome).toBe('submitted')
  if (derived.outcome !== 'submitted') throw new Error('deliverDraftFor failed')
  return { taskId: derived.taskId }
}

/** Rebuild a human view from a lifecycle view (tests assert the label contract). */
function wechatViewOf(v: { status: string; remoteDraftId: string | null; generation: number; key: string }) {
  const awaiting = v.status === 'submitted'
  return {
    awaitingWechatConfirmation: awaiting,
    humanLabel: awaiting ? '待微信确认' : v.status === 'superseded' ? '历史代次（已交付）' : '未交付',
    remoteDraftId: v.remoteDraftId,
    generation: v.generation,
    key: v.key,
  }
}