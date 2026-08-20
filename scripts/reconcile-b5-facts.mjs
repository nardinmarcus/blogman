#!/usr/bin/env node
/**
 * B5-G — batch-5 acceptance fixture (issue #49).
 *
 * Read-only reconciliation of the WeChat draft-chain fact surfaces over ONE
 * immutable candidate (zero production writes, 不真调微信 API). The fixture is
 * meant to run locally / in CI against a D1 state that was migrated, backfilled
 * and driven through the batch-5 command kernels (deriveWechatDraft / settings
 * save / runWechatDraftExecutor / reconcileWechatDraft / replaceWechatDraft)
 * from the same checked-out commit. Only SELECT statements are issued through
 * `wrangler d1 execute`; any difference exits 1 and prints a per-item report.
 *
 * Reconciled surfaces (strictly mapped to the B5-01/B5-02/B5-03 fact tables):
 *
 *   1. 派生（版本绑定）  — `wechat_draft_tasks` + `wechat_draft_replacements`:
 *       the deterministic task_id (`wechat-draft:<article>:v<version>:<account>`)
 *       / replacement_key (`wechat-replacement:<priorKey>`), the article is a
 *       REAL formally published article, the bound version is a FROZEN version
 *       the article reached (≤ formal version and present in article_versions),
 *       content_sha256 matches the frozen version's snapshot hash, and
 *       projection_sha256 is the tamper-evident digest recomputed through the
 *       real projection kernel. task.post_ref matches the article's post_ref.
 *   2. 失败/重试/结果未知状态机  — the lifecycle columns shared by tasks and
 *       replacements plus the IMMUTABLE `wechat_draft_attempts` rows:
 *       classification ⇔ status / needs_author / next_attempt_at agreement
 *       ('ok' ⇒ submitted/superseded + media kept, 'retryable' ⇒ failed +
 *       backoff window, needs-author/unknown ⇒ failed author todo, never
 *       auto-retried), a submitted row never claims publication, and every
 *       attempt is one immutable bounded (-≤500) fact whose deterministic
 *       submission-attempt keys are contiguous 1..N and agree with the row's
 *       attempt_count.
 *   3. 代次与替代草稿历史  — `wechat_draft_generations` ↔ tasks ↔ replacements:
 *       per (article, account) generations are contiguous 1..N, each ledger
 *       row resolves to ONE lifecycle row with lockstep status/version, the
 *       chain's replaces_task_id is the immediate predecessor (gen 1 has
 *       replaces_task_id NULL), exactly the highest generation is live while
 *       every older generation / media_id is preserved as superseded, and no
 *       delivery row is an orphan.
 *   4. 待微信确认状态  — a `submitted` lifecycle row (the live draft delivered
 *       to the WeChat DRAFT BOX) MUST carry its media_id and is reported 待微信
 *       确认 (never 已发布); automation stops at the draft. Plus the optional
 *       immutable candidate binding (`--candidate`).
 *
 * Optionally binds the candidate: when `--candidate <sha>` is given the
 * migration ledger's last applied candidate identity must equal it — the same
 * immutable candidate that produced the D1 state.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-b5-facts.mjs --local \
 *     [--candidate <git-rev>] [--persist-to <dir>] [--database <name>] \
 *     [--config <path>] [--report <path>]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kernelUrl = pathToFileURL(join(repoRoot, 'lib', 'wechat-draft', 'kernel.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b59')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-b5')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-b5-facts-report.md')

/** Bounds copied from the sanctioned kernel — error facts must stay bounded. */
const ERROR_LIMIT = 500

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-b5-facts.mjs --local|--remote ' +
      '[--candidate <sha>] [--persist-to <dir>] [--database <name>] [--config <path>] [--report <path>]',
  )
}

function parseArgs(argv) {
  const args = {
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    persistTo: DEFAULT_PERSIST,
    report: DEFAULT_REPORT,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--local') args.local = true
    else if (flag === '--remote') args.remote = true
    else if (flag === '--candidate') args.candidate = argv[++i]
    else if (flag === '--persist-to') args.persistTo = resolve(argv[++i])
    else if (flag === '--database') args.database = argv[++i]
    else if (flag === '--config') args.config = resolve(argv[++i])
    else if (flag === '--report') args.report = resolve(argv[++i])
    else {
      usage()
      process.exit(2)
    }
  }
  if (!args.local && !args.remote) {
    usage()
    process.exit(2)
  }
  return args
}

/* ------------------------------------------------------------------ */
/* single read-only wrangler pass (9 SELECT groups, one spawn)         */
/* ------------------------------------------------------------------ */

const TASK_COLUMNS = `id, task_id, article_id, post_ref, version, account_id, status,
  title, html_projection, plaintext_projection, cover_image_url, digest,
  content_sha256, projection_sha256, source_url, remote_draft_id, provider_error,
  created_at, updated_at, revision, attempt_count, classification, needs_author,
  next_attempt_at, last_error, claimed_at, lease_token, lease_expires_at,
  generation, settings_revision`

const REPLACEMENT_COLUMNS = `id, replacement_key, article_id, version, account_id,
  replaces_task_id, status, title, html_projection, plaintext_projection,
  cover_image_url, digest, content_sha256, projection_sha256, source_url,
  remote_draft_id, provider_error, settings_revision, created_at, updated_at,
  revision, attempt_count, classification, needs_author, next_attempt_at,
  last_error, claimed_at, lease_token, lease_expires_at, generation`

const READ_STATEMENTS = [
  'SELECT candidate_id FROM migration_ledger ORDER BY number DESC LIMIT 1',
  'SELECT id, post_ref FROM articles ORDER BY id',
  `SELECT article_id, version, slug, lifecycle, public_url
     FROM formal_publications ORDER BY article_id`,
  `SELECT article_id, version, content_snapshot_sha256
     FROM article_versions ORDER BY article_id, version`,
  `SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks ORDER BY id ASC`,
  `SELECT id, attempt_key, task_id, attempt_no, classification, outcome,
          started_at, finished_at, remote_draft_id, error, created_at, updated_at
     FROM wechat_draft_attempts ORDER BY id ASC`,
  `SELECT id, article_id, account_id, settings_revision, title_override,
          digest_override, cover_image_override, created_at, updated_at
     FROM wechat_draft_settings ORDER BY id ASC`,
  `SELECT id, article_id, account_id, generation, version, task_id,
          replaces_task_id, status, settings_revision, created_at, updated_at
     FROM wechat_draft_generations ORDER BY article_id, account_id, generation`,
  `SELECT ${REPLACEMENT_COLUMNS} FROM wechat_draft_replacements ORDER BY id ASC`,
]

function d1ReadAll(args) {
  const result = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    [
      'd1', 'execute', args.database,
      ...(args.local ? ['--local'] : ['--remote']),
      '--persist-to', args.persistTo,
      '--config', args.config,
      '--command', READ_STATEMENTS.join(';\n'),
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(
      `wrangler d1 execute failed (is every batch-5 table present? run the ` +
        `apply-wechat-draft-ddl.mjs first): ${detail.slice(0, 600)}`,
    )
  }
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected wrangler output: ${String(result.stdout).slice(0, 200)}`)
  }
  return parsed.map((entry) => entry.results ?? [])
}

/* ------------------------------------------------------------------ */
/* canonical kernels (same implementations the command layer uses)     */
/* ------------------------------------------------------------------ */

async function loadKernels() {
  const kernel = (await import(kernelUrl)).default ?? (await import(kernelUrl))
  return {
    taskIdFor: kernel.wechatDraftTaskIdFor,
    attemptKey: kernel.wechatDraftAttemptKey,
    reconcileKey: kernel.wechatDraftReconcileKey,
    projectionDigest: kernel.projectionDigest,
    projectionFromRow: kernel.projectionFromRow,
  }
}

/* ------------------------------------------------------------------ */
/* fact reconciliation                                                 */
/* ------------------------------------------------------------------ */

const TASK_STATUSES = new Set(['draft', 'submitted', 'failed', 'superseded'])
const CLASSIFICATIONS = new Set(['ok', 'retryable', 'needs-author', 'unknown'])
const ATTEMPT_OUTCOMES = new Set(['submitted', 'retried', 'failed', 'unknown', 'reconciled', 'abandoned', 'cancelled'])
const ATTEMPT_CLASSIFICATIONS = new Set(['ok', 'retryable', 'needs-author', 'unknown'])

function hasRemote(row) {
  return row.remoteDraftId != null && String(row.remoteDraftId).trim().length > 0
}

function reconcile(args, kernels, rows, drift) {
  /* ---- candidate binding ------------------------------------------ */
  if (args.candidate) {
    const ledger = rows.ledger[0]
    if (!ledger) {
      drift.push('候选绑定: migration_ledger 为空，无法绑定不可变候选')
    } else if (String(ledger.candidate_id) !== args.candidate) {
      drift.push(
        `候选漂移: ledger candidate_id=${String(ledger.candidate_id).slice(0, 12)}… ` +
          `!= 提供 --candidate=${args.candidate.slice(0, 12)}…`,
      )
    }
  }

  const articlesById = new Map(rows.articles.map((a) => [Number(a.id), a]))
  const formalByArticle = new Map(rows.formals.map((f) => [Number(f.article_id), f]))
  const versionShas = new Map(rows.versions.map((v) => [`${v.article_id}:${v.version}`, String(v.content_snapshot_sha256)]))
  const settingsByKey = new Map(rows.settings.map((s) => [`${s.article_id}:${s.account_id}`, s]))

  /* ---- 1. 派生（版本绑定） ---------------------------------------- */
  for (const t of rows.tasks) {
    const key = String(t.task_id)
    const aid = Number(t.article_id)
    const version = Number(t.version)
    const account = String(t.account_id)
    const expectedId = kernels.taskIdFor(aid, version, account)
    if (key !== expectedId) {
      drift.push(`派生: 任务 ${key} 不是 (article ${aid}, v${version}, ${account}) 的规范派生键 ${expectedId}`)
    }

    const article = articlesById.get(aid)
    if (!article) {
      drift.push(`派生: 任务 ${key} 引用的文章 #${aid} 不存在`)
    } else if (Number(article.post_ref) !== Number(t.post_ref)) {
      drift.push(`派生: 任务 ${key} post_ref=${t.post_ref} != 文章 #${aid} 的 post_ref=${article.post_ref}`)
    }

    const formal = formalByArticle.get(aid)
    if (!formal || String(formal.lifecycle) !== 'published') {
      drift.push(`派生: 任务 ${key} 依赖的正式发布事实缺失或未发布 (lifecycle='${formal?.lifecycle ?? 'NONE'}')`)
    } else if (version > Number(formal.version)) {
      drift.push(`派生: 任务 ${key} 绑定的版本 v${version} 超过正式发表版本 v${formal.version}（绝不绑定未来版本）`)
    }

    const versionSha = versionShas.get(`${aid}:${version}`)
    if (versionSha === undefined) {
      drift.push(`派生: 任务 ${key} 绑定的版本 v${version} 在 article_versions 无冻结快照事实`)
    } else if (t.content_sha256 !== versionSha) {
      drift.push(`派生: 任务 ${key} content_sha256=${String(t.content_sha256).slice(0, 12)}… != 冻结版本 v${version} 哈希 ${versionSha.slice(0, 12)}…`)
    }

    // Tamper-evident projection body identity through the real kernel.
    const digest = kernels.projectionDigest(kernels.projectionFromRow(t), String(t.content_sha256))
    if (String(t.projection_sha256) !== digest) {
      drift.push(`派生: 任务 ${key} 投影哈希被篡改 stored=${String(t.projection_sha256).slice(0, 12)}… expected=${digest.slice(0, 12)}…`)
    }

    if (!String(t.source_url || '').trim()) drift.push(`派生: 任务 ${key} 缺少 source_url`)
    if (!(Number(t.generation) > 0)) drift.push(`派生: 任务 ${key} 缺少有效代次 generation=${t.generation}`)
  }

  // Replacements bind a frozen version too (shared projection kernel), and
  // their key is deterministic from the replaced prior generation.
  for (const r of rows.replacements) {
    const key = String(r.replacement_key)
    const aid = Number(r.article_id)
    const version = Number(r.version)
    const formal = formalByArticle.get(aid)
    if (!formal || String(formal.lifecycle) !== 'published') {
      drift.push(`派生: 替代草稿 ${key} 依赖的正式发布事实缺失或未发布`)
    } else if (version > Number(formal.version)) {
      drift.push(`派生: 替代草稿 ${key} 绑定的版本 v${version} 超过正式发表版本 v${formal.version}`)
    }
    if (versionShas.get(`${aid}:${version}`) === undefined) {
      drift.push(`派生: 替代草稿 ${key} 绑定的版本 v${version} 无冻结快照事实`)
    }
    const projection = {
      title: r.title,
      html: r.html_projection,
      plaintext: r.plaintext_projection,
      coverImageUrl: r.cover_image_url ?? '',
      digest: r.digest ?? '',
      sourceUrl: r.source_url,
    }
    const digest = kernels.projectionDigest(projection, String(r.content_sha256))
    if (String(r.projection_sha256) !== digest) {
      drift.push(`派生: 替代草稿 ${key} 投影哈希被篡改 stored=${String(r.projection_sha256).slice(0, 12)}… expected=${digest.slice(0, 12)}…`)
    }
    const expectedKey = `wechat-replacement:${r.replaces_task_id}`
    if (key !== expectedKey) {
      drift.push(`派生: 替代草稿 ${key} 不是前代 ${r.replaces_task_id} 的规范派生键 ${expectedKey}`)
    }
  }

  /* ---- 2. 失败/重试/结果未知状态机 (lifecycle rows) ---------------- */
  const lifecycleByKey = new Map()
  for (const t of rows.tasks) {
    const view = {
      kind: 'task',
      key: String(t.task_id),
      articleId: Number(t.article_id),
      version: Number(t.version),
      accountId: String(t.account_id),
      generation: Number(t.generation),
      status: String(t.status),
      classification: t.classification == null ? null : String(t.classification),
      needsAuthor: Number(t.needs_author),
      nextAttemptAt: t.next_attempt_at,
      remoteDraftId: t.remote_draft_id,
      attemptCount: Number(t.attempt_count),
      replacesTaskId: null,
      settingsRevision: Number(t.settings_revision),
      error: t.last_error,
      raw: t,
    }
    lifecycleByKey.set(view.key, view)
  }
  for (const r of rows.replacements) {
    const view = {
      kind: 'replacement',
      key: String(r.replacement_key),
      articleId: Number(r.article_id),
      version: Number(r.version),
      accountId: String(r.account_id),
      generation: Number(r.generation),
      status: String(r.status),
      classification: r.classification == null ? null : String(r.classification),
      needsAuthor: Number(r.needs_author),
      nextAttemptAt: r.next_attempt_at,
      remoteDraftId: r.remote_draft_id,
      attemptCount: Number(r.attempt_count),
      replacesTaskId: r.replaces_task_id == null ? null : String(r.replaces_task_id),
      settingsRevision: Number(r.settings_revision),
      error: r.last_error,
      raw: r,
    }
    lifecycleByKey.set(view.key, view)
  }

  for (const row of lifecycleByKey.values()) {
    const label = `${row.kind === 'task' ? '任务' : '替代草稿'} ${row.key}`
    if (!TASK_STATUSES.has(row.status)) {
      drift.push(`状态机: ${label} 未知状态 '${row.status}'`)
    }
    if (row.classification != null && !CLASSIFICATIONS.has(row.classification)) {
      drift.push(`状态机: ${label} 未知分类 '${row.classification}'`)
    }
    const needsAuthor = row.needsAuthor === 1
    const expectNeedsAuthor = row.classification === 'needs-author' || row.classification === 'unknown'
    if (needsAuthor !== expectNeedsAuthor) {
      drift.push(`状态机: ${label} needs_author=${row.needsAuthor} 与分类 '${row.classification ?? 'NULL'}' 不符（needs-author/unknown 才应标记作者待办）`)
    }

    switch (row.classification) {
      case 'ok':
        if (row.status !== 'submitted' && row.status !== 'superseded') {
          drift.push(`状态机: ${label} 分类 ok 但状态为 '${row.status}'（应 submitted 或 superseded 历史）`)
        }
        if (!hasRemote(row)) drift.push(`状态机: ${label} 分类 ok 却无远端身份 media_id（media 必须永久保存）`)
        if (row.nextAttemptAt != null) drift.push(`状态机: ${label} 分类 ok 却残留 next_attempt_at`)
        break
      case 'retryable':
        if (row.status !== 'failed') drift.push(`状态机: ${label} 分类 retryable 但状态为 '${row.status}'（应 failed 等待重试）`)
        if (needsAuthor) drift.push(`状态机: ${label} 分类 retryable 不应标记作者待办`)
        if (row.nextAttemptAt == null) drift.push(`状态机: ${label} 分类 retryable 缺少 next_attempt_at 退避窗口`)
        break
      case 'needs-author':
      case 'unknown':
        if (row.status !== 'failed') drift.push(`状态机: ${label} 分类 ${row.classification} 但状态为 '${row.status}'（应冻结为 failed）`)
        if (row.nextAttemptAt != null) drift.push(`状态机: ${label} 分类 ${row.classification} 不应携带 next_attempt_at（绝无自动重试）`)
        break
      case null:
        if (row.status === 'draft') {
          if (needsAuthor) drift.push(`状态机: ${label} draft 行不应标记作者待办`)
          if (row.nextAttemptAt != null) drift.push(`状态机: ${label} draft 行不应携带 next_attempt_at`)
          if (hasRemote(row)) drift.push(`状态机: ${label} draft 行未经执行不应有远端身份 media_id`)
        }
        break
      default:
        break
    }

    if (row.status === 'submitted') {
      if (row.classification !== 'ok') drift.push(`状态机: ${label} submitted 但分类为 '${row.classification ?? 'NULL'}'（应 ok）`)
      if (needsAuthor) drift.push(`状态机: ${label} submitted 不应标记作者待办`)
      if (row.nextAttemptAt != null) drift.push(`状态机: ${label} submitted 不应携带 next_attempt_at`)
      if (!hasRemote(row)) drift.push(`状态机: ${label} submitted（待微信确认）必须携带远端 media_id`)
    }
    if (row.status === 'draft' && row.classification != null) {
      drift.push(`状态机: ${label} draft 行不应带分类（未执行或对账 found:false 重新武装后为 NULL）`)
    }
    if (row.status === 'failed' && row.classification == null) {
      drift.push(`状态机: ${label} failed 行缺少分类（失败必定有可分类的原因）`)
    }
    if (String(row.status).toLowerCase().includes('publish')) {
      drift.push(`状态机: ${label} 状态 '${row.status}' 含 publish 字样——微信草稿链绝不声称已发布`)
    }
    if (row.error != null && String(row.error).length > ERROR_LIMIT) {
      drift.push(`状态机: ${label} 的错误事实超出长度上限 ${ERROR_LIMIT}`)
    }
  }

  /* ---- attempts: ONE immutable bounded fact per execution ---------- */
  const attemptsByTask = new Map()
  for (const a of rows.attempts) {
    const key = String(a.task_id)
    if (!attemptsByTask.has(key)) attemptsByTask.set(key, [])
    attemptsByTask.get(key).push(a)
  }
  for (const list of attemptsByTask.values()) list.sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no))
  for (const [taskId, list] of attemptsByTask) {
    const row = lifecycleByKey.get(taskId)
    if (!row) {
      drift.push(`尝试: 尝试事实引用不存在的生命周期行 ${taskId}`)
      continue
    }
    const submission = list.filter((a) => String(a.attempt_key).includes(':submit:'))
    if (submission.length !== row.attemptCount) {
      drift.push(`尝试: ${taskId} attempt_count=${row.attemptCount} 但存在 ${submission.length} 条提交通用尝试事实`)
    }
    let prevNo = 0
    for (const a of submission) {
      const no = Number(a.attempt_no)
      if (no !== prevNo + 1) {
        drift.push(`尝试: ${taskId} 提交尝试序号不连续（期望 ${prevNo + 1}，实际 ${no}）`)
      }
      prevNo = no
      const expectedKey = kernels.attemptKey(taskId, no)
      if (String(a.attempt_key) !== expectedKey) {
        drift.push(`尝试: 尝试 ${a.attempt_key} 不是 ${taskId} 第 ${no} 次的规范键 ${expectedKey}`)
      }
      if (!ATTEMPT_OUTCOMES.has(String(a.outcome))) drift.push(`尝试: 尝试 ${a.attempt_key} 未知 outcome '${a.outcome}'`)
      if (!ATTEMPT_CLASSIFICATIONS.has(String(a.classification))) {
        drift.push(`尝试: 尝试 ${a.attempt_key} 未知分类 '${a.classification}'`)
      }
      if (a.error != null && String(a.error).length > ERROR_LIMIT) {
        drift.push(`尝试: 尝试 ${a.attempt_key} 的 error 超出长度上限 ${ERROR_LIMIT}`)
      }
    }
    for (const a of list) {
      if (String(a.attempt_key).includes(':reconcile:')) {
        const m = /:reconcile:(\d+)$/.exec(String(a.attempt_key))
        const keySegment = String(a.attempt_key).replace(/:reconcile:\d+$/, '')
        if (!m) {
          drift.push(`尝试: 对账尝试 ${a.attempt_key} 键格式非法`)
          continue
        }
        if (keySegment !== `wechat-attempt:${taskId}`) {
          drift.push(`尝试: 对账尝试 ${a.attempt_key} 引用非本行任务 ${taskId}`)
        }
        if (!ATTEMPT_OUTCOMES.has(String(a.outcome))) drift.push(`尝试: 对账尝试 ${a.attempt_key} 未知 outcome '${a.outcome}'`)
      }
    }
  }

  /* ---- 3. 代次与替代草稿历史 (generations ledger chain) ----------- */
  const gensByGroup = new Map()
  for (const g of rows.generations) {
    const groupKey = `${g.article_id}:${g.account_id}`
    if (!gensByGroup.has(groupKey)) gensByGroup.set(groupKey, [])
    gensByGroup.get(groupKey).push(g)
  }
  for (const list of gensByGroup.values()) list.sort((a, b) => Number(a.generation) - Number(b.generation))

  const deliveryKeySet = new Set(lifecycleByKey.keys())
  const replacementKeySet = new Set(rows.replacements.map((r) => String(r.replacement_key)))
  for (const g of rows.generations) {
    const taskId = String(g.task_id)
    if (!deliveryKeySet.has(taskId)) {
      drift.push(`代次: 台账 ${g.id} 引用的生命周期行 ${taskId} 不存在`)
    }
    if (g.replaces_task_id != null && !deliveryKeySet.has(String(g.replaces_task_id))) {
      drift.push(`代次: 台账 ${g.id} 引用的前代 ${g.replaces_task_id} 不存在`)
    }
  }

  for (const [groupKey, list] of gensByGroup) {
    const nums = list.map((g) => Number(g.generation))
    let prev = 0
    let live = 0
    for (let i = 0; i < list.length; i += 1) {
      const g = list[i]
      const no = nums[i]
      if (no !== prev + 1) {
        drift.push(`代次: 组 ${groupKey} 代次不连续（期望 ${prev + 1}，实际 ${no}）`)
      }
      prev = no
      const delivery = lifecycleByKey.get(String(g.task_id))
      const isLive = String(g.status) !== 'superseded'
      if (isLive) live += 1

      if (delivery) {
        if (String(g.status) !== String(delivery.status)) {
          drift.push(`代次: ${groupKey} 代次 ${no} 台账状态 '${g.status}' 与生命周期行 '${delivery.status}' 不同步`)
        }
        if (Number(g.version) !== delivery.version) {
          drift.push(`代次: ${groupKey} 代次 ${no} 台账版本 v${g.version} 与生命周期行 v${delivery.version} 不一致`)
        }
        if (delivery.generation !== no) {
          drift.push(`代次: ${groupKey} 代次 ${no} 台账任务 ${g.task_id} 自带代次 ${delivery.generation} 不一致`)
        }
      }

      // Chain: generation 1 is a base derivation with no predecessor; a
      // generation that IS an explicit replacement (its task is a
      // replacement_key) must reference the IMMEDIATELY previous generation;
      // a base-task generation from a new-version derivation replaces nothing.
      const isReplacement = replacementKeySet.has(String(g.task_id))
      if (no === 1) {
        if (isReplacement) {
          drift.push(`代次: ${groupKey} 代次 1 不可是替代草稿（替代必须引用前代）`)
        } else if (g.replaces_task_id != null) {
          drift.push(`代次: ${groupKey} 代次 1 不应引用前代 (replaces_task_id=${g.replaces_task_id})`)
        }
      } else if (isReplacement) {
        const prevGen = list[i - 1]
        if (String(g.replaces_task_id) !== String(prevGen.task_id)) {
          drift.push(`代次: ${groupKey} 替代代次 ${no} 的 replaces_task_id=${g.replaces_task_id} != 前代代次 ${no - 1} 的任务 ${prevGen.task_id}`)
        }
      } else if (g.replaces_task_id != null) {
        drift.push(`代次: ${groupKey} 基础代次 ${no} 不应引用前代（新版本派生非显式替代）`)
      }
    }
    // Exactly one live (non-superseded) generation per group — the newest.
    const maxGen = list[list.length - 1]
    const maxLive = String(maxGen.status) !== 'superseded'
    if (live !== 1) {
      drift.push(`代次: 组 ${groupKey} 的存活代次数为 ${live}（应恰好 1）`)
    }
    for (const g of list) {
      if (String(g.id) !== String(maxGen.id) && String(g.status) !== 'superseded') {
        drift.push(`代次: ${groupKey} 非最新代次 ${g.generation} 仍未 superseded（旧代次不得继续存活）`)
      }
    }
    if (!maxLive) {
      drift.push(`代次: ${groupKey} 最新代次 ${maxGen.generation} 也已 superseded（最新代次必须是存活交付）`)
    }
  }

  // Every delivery row must be referenced by exactly one generation ledger row.
  const ledByTask = new Map()
  for (const g of rows.generations) {
    const taskId = String(g.task_id)
    if (!ledByTask.has(taskId)) ledByTask.set(taskId, 0)
    ledByTask.set(taskId, ledByTask.get(taskId) + 1)
  }
  for (const key of deliveryKeySet) {
    const n = ledByTask.get(key) ?? 0
    if (n !== 1) drift.push(`代次: 生命周期行 ${key} 在台账中被引用 ${n} 次（应恰好一次，不得孤儿）`)
  }

  // Replacement cross-check: the replacement's replaces_task_id must be the
  // immediate predecessor generation of the SAME group (the ledger chain
  // already enforces this via generation ledger rows — assert the row agrees).
  for (const r of rows.replacements) {
    const gen = rows.generations.find((g) => String(g.task_id) === String(r.replacement_key))
    if (!gen) {
      drift.push(`替代: 替代草稿 ${r.replacement_key} 无对应台账代次`)
      continue
    }
    if (Number(gen.generation) !== Number(r.generation)) {
      drift.push(`替代: 替代草稿 ${r.replacement_key} 行代次 ${r.generation} != 台账代次 ${gen.generation}`)
    }
    if (String(gen.replaces_task_id) !== String(r.replaces_task_id)) {
      drift.push(`替代: 替代草稿 ${r.replacement_key} replaces_task_id 与台账不一致`)
    }
  }

  /* ---- 4. 待微信确认状态 ------------------------------------------ */
  for (const row of lifecycleByKey.values()) {
    if (row.status === 'submitted') {
      if (row.kind === 'task') {
        const formal = formalByArticle.get(row.articleId)
        if (!formal) drift.push(`待确认: 提交行 ${row.key} 的正式发布缺失`)
      }
      // delivered drafts are the live generation — the 待微信确认 surface.
    }
  }
  for (const t of rows.tasks) {
    const settings = settingsByKey.get(`${t.article_id}:${t.account_id}`)
    if (settings && Number(t.settings_revision) > Number(settings.settings_revision)) {
      drift.push(`派生: 任务 ${t.task_id} settings_revision=${t.settings_revision} 超过设置行版本 ${settings.settings_revision}`)
    }
    if (Number(t.settings_revision) < 0) drift.push(`派生: 任务 ${t.task_id} settings_revision 非法`)
  }
}

function renderReport({ args, drift, counts }) {
  const aligned = drift.length === 0
  const lines = []
  lines.push('# B5-G 批次 5 验收对账报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  if (args.candidate) lines.push(`- 候选绑定: \`${args.candidate}\``)
  lines.push(`- 事实表计数: 正式发布 ${counts.formals} · 冻结版本 ${counts.versions} · 任务 ${counts.tasks} · ` +
    `尝试 ${counts.attempts} · 设置 ${counts.settings} · 代次 ${counts.generations} · ` +
    `替代草稿 ${counts.replacements} · 待微信确认 ${counts.awaiting}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（四维微信草稿事实完整，同一候选一致）' : 'DRIFT（存在事实缺失或篡改，阻断验收）'}`)
  lines.push('')
  if (drift.length === 0) {
    lines.push('## 差异清单')
    lines.push('')
    lines.push('（无）')
  } else {
    lines.push('## 差异清单')
    lines.push('')
    for (const item of drift) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('> 注：任何 派生 / 状态机 / 代次 / 替代历史 / 待微信确认 差异都会阻断批次 5 验收（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const kernels = await loadKernels()
  const [ledger, articles, formals, versions, tasks, attempts, settings, generations, replacements] =
    d1ReadAll(args)

  const rows = { ledger, articles, formals, versions, tasks, attempts, settings, generations, replacements }
  const awaiting = tasks.filter((t) => String(t.status) === 'submitted').length +
    replacements.filter((r) => String(r.status) === 'submitted').length
  const counts = {
    formals: formals.length,
    versions: versions.length,
    tasks: tasks.length,
    attempts: attempts.length,
    settings: settings.length,
    generations: generations.length,
    replacements: replacements.length,
    awaiting,
  }

  const drift = []
  reconcile(args, kernels, rows, drift)
  const uniqueDrift = [...new Set(drift)]
  drift.length = 0
  drift.push(...uniqueDrift)

  const aligned = drift.length === 0
  const report = renderReport({ args, drift, counts })
  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, report, 'utf8')

  console.log(
    `reconcile-b5-facts: formals=${counts.formals} versions=${counts.versions} tasks=${counts.tasks} ` +
      `attempts=${counts.attempts} settings=${counts.settings} generations=${counts.generations} ` +
      `replacements=${counts.replacements} awaiting=${counts.awaiting} ` +
      `drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

main().catch((error) => {
  console.error('reconcile-b5-facts failed:', error)
  process.exit(2)
})
