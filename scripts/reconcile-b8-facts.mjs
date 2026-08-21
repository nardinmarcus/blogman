#!/usr/bin/env node
/**
 * B8-G — batch-8 acceptance fixture (issue #65).
 *
 * Read-only reconciliation of the MOBILE task-matrix over SIX fact surfaces
 * from D1 — never from UI state (零生产; 全部从 D1 事实面读). The batch-8
 * mobile flows (bottom nav / deep-link restore, local draft restore, three-way
 * conflict choice, suggestion lifecycle, schedule commands, publish confirm +
 * receipt) are THIN adapters that reuse the shared command kernels; each
 * kernel writes its facts to a well-known D1 table. This fixture reads those
 * tables and checks the mobile matrix is internally consistent over ONE
 * immutable candidate. Only SELECT statements are issued through
 * `wrangler d1 execute`; any difference exits 1 and prints a per-item report.
 *
 * Reconciled surfaces (strictly mapped to their owning tables):
 *
 *   1. 导航/深链恢复 (nav/deep-link restore) — `activity_notifications`: every
 *       notification the today workbench deep-links from resolves to a real
 *       fact (schedule / event / article); no duplicate (source_type,
 *       source_id); status/ack shapes are valid.
 *   2. 本机稿恢复 (local draft restore) — `articles` + `posts` +
 *       `article_versions`: every article's version chain is contiguous 1..N,
 *       each version carries a content_snapshot_sha256 (a restored draft
 *       ALWAYS equals a stored, server-confirmed version — no fabricated
 *       draft), and the posts.current content hash agrees with the LATEST
 *       version (server-confirmed save).
 *   3. 三向冲突选择 (three-way conflict choice) — `source_conflict_resolutions`:
 *       an explicit side choice (source / blogman) bound to the baseline +
 *       anchored source fingerprint + anchored Blogman version; applied ⇒
 *       applied_at set; pre-resolution snapshot present; refs resolve.
 *   4. 建议生命周期 (suggestion lifecycle) — `publish_preparations` +
 *       `publish_suggestions`: suggestions version-bound to their preparation,
 *       the AI basis_sha256 equals the exact bound-version content hash, and
 *       the pending → applied/ignored/revoked/stale lifecycle is internally
 *       consistent (decided_at ⇔ decided; applied ⇒ applied_operation_id).
 *   5. 排期命令 (schedule commands) — `publish_schedules` +
 *       `schedule_control_ops`: the status machine stays valid and the latest
 *       control command agrees with the current status (pause ⇒ paused,
 *       cancel ⇒ cancelled, publish_now ⇒ fired).
 *   6. 发布确认与回据 (publish confirm + receipt) — `formal_publications` +
 *       `publish_events` + `publish_outbox` + `publish_receipts`: every formal
 *       publication is backed by exactly one event (evidence hash re-derived),
 *       exactly one durable outbox row, and exactly one independent receipt
 *       bound to the same article/version/public_url (博客/排期/渠道 回据).
 *
 * Optionally binds the immutable candidate: when `--candidate <sha>` is given
 * the migration ledger's last applied candidate identity must equal it.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-b8-facts.mjs --local \
 *     [--candidate <git-rev>] [--persist-to <dir>] [--database <name>] \
 *     [--config <path>] [--report <path>]
 *
 * Read-only: only SELECT statements are issued through `wrangler d1 execute`;
 * any difference exits 1 and prints a per-item report.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const firstPublishUrl = pathToFileURL(join(repoRoot, 'lib', 'first-publish', 'kernel.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b8g')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-b8')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-b8-facts-report.md')

const SHA64 = /^[0-9a-f]{64}$/

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-b8-facts.mjs --local|--remote ' +
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
/* single read-only wrangler pass (one spawn)                          */
/* ------------------------------------------------------------------ */

const READ_STATEMENTS = [
  'SELECT candidate_id FROM migration_ledger ORDER BY number DESC LIMIT 1',
  'SELECT id, post_ref, slug, draft_ref FROM articles ORDER BY id',
  'SELECT id, content_snapshot_sha256, deleted_at FROM posts ORDER BY id',
  'SELECT article_id, version, snapshot_json, content_snapshot_sha256, published_at FROM article_versions ORDER BY article_id, version ASC',
  `SELECT preparation_id, article_id, post_ref, bound_version, source, status, created_at, applied_at
     FROM publish_preparations ORDER BY id ASC`,
  `SELECT suggestion_id, preparation_id, article_id, field, value, basis_sha256, bound_version,
          status, applied_operation_id, decided_at
     FROM publish_suggestions ORDER BY id ASC`,
  `SELECT schedule_id, article_id, version, scheduled_at, timezone, status,
          attempt_count, stale_reason, fired_event_id
     FROM publish_schedules ORDER BY id ASC`,
  `SELECT id, operation_id, schedule_id, action, result, created_at
     FROM schedule_control_ops ORDER BY id ASC`,
  `SELECT event_id, intent_id, article_id, version, slug, lifecycle, evidence_sha256, payload
     FROM publish_events ORDER BY id ASC`,
  `SELECT outbox_id, event_id, article_id, version, kind, status, delivered_at
     FROM publish_outbox ORDER BY id ASC`,
  `SELECT article_id, version, slug, lifecycle, public_url, event_id
     FROM formal_publications ORDER BY article_id ASC`,
  `SELECT event_id, article_id, version, public_url, verified, verified_at
     FROM publish_receipts ORDER BY id ASC`,
  `SELECT notification_id, source_type, source_id, status, acknowledged
     FROM activity_notifications ORDER BY id ASC`,
  `SELECT id, canonical_url, identity_sha256 FROM source_identities ORDER BY id ASC`,
  `SELECT id, operation_id, source_identity_id, article_id, chosen_side, baseline_version,
          baseline_sha256, anchored_source_sha256, anchored_article_version,
          source_projection_json, source_media_json, pre_resolution_snapshot_json,
          status, applied_at
     FROM source_conflict_resolutions ORDER BY id ASC`,
]

function d1ReadAll(args) {
  const result = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'wrangler'),
    [
      'd1', 'execute', args.database,
      ...(args.local ? ['--local'] : ['--remote']),
      ...(args.local ? ['--persist-to', args.persistTo] : []),
      '--config', args.config,
      '--command', READ_STATEMENTS.join(';\n'),
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(
      `wrangler d1 execute failed (is every batch-8 table present? run the ` +
        `apply-suggestions / apply-scheduled-publish / apply-first-publish / ` +
        `apply-b404 / apply-conflict DDL channels first): ${detail.slice(0, 600)}`,
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
  const firstPublish = (await import(firstPublishUrl)).default ?? (await import(firstPublishUrl))
  return {
    eventIdFor: firstPublish.eventIdFor,
    outboxIdFor: firstPublish.outboxIdFor,
    evidenceDigest: firstPublish.evidenceDigest,
  }
}

/* ------------------------------------------------------------------ */
/* fact reconciliation                                                 */
/* ------------------------------------------------------------------ */

const NOTIFICATION_SOURCES = new Map([
  ['schedule', 'publish_schedules'],
  ['event', 'publish_events'],
  ['article', 'articles'],
])

function validJson(str) {
  if (str == null) return false
  try {
    const parsed = JSON.parse(String(str))
    return parsed !== null && typeof parsed === 'object'
  } catch {
    return false
  }
}

function reconcile(args, kernels, rows, drift) {
  const articleIds = new Set(rows.articles.map((a) => Number(a.id)))
  const identityIds = new Set(rows.identities.map((i) => Number(i.id)))
  const schedulesById = new Map(rows.schedules.map((s) => [String(s.schedule_id), s]))
  const eventsById = new Map(rows.events.map((e) => [String(e.event_id), e]))
  const outboxesByEvent = new Map(rows.outboxes.map((o) => [String(o.event_id), o]))
  const receiptsByEvent = new Map(rows.receipts.map((r) => [String(r.event_id), r]))

  // versions per article, sorted and validated for contiguity.
  const versionsByArticle = new Map()
  for (const v of rows.versions) {
    const aid = Number(v.article_id)
    if (!versionsByArticle.has(aid)) versionsByArticle.set(aid, [])
    versionsByArticle.get(aid).push(v)
  }
  for (const list of versionsByArticle.values()) list.sort((a, b) => Number(a.version) - Number(b.version))

  const preparationsById = new Map(rows.preparations.map((p) => [String(p.preparation_id), p]))

  const opsBySchedule = new Map()
  for (const op of rows.controlOps) {
    if (!opsBySchedule.has(String(op.schedule_id))) opsBySchedule.set(String(op.schedule_id), [])
    opsBySchedule.get(String(op.schedule_id)).push(op)
  }
  for (const list of opsBySchedule.values()) list.sort((a, b) => Number(a.id) - Number(b.id))

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

  /* ---- 1. 导航/深链恢复 (activity_notifications deep-link targets)  */
  const seenSources = new Set()
  for (const n of rows.notifications) {
    const sourceType = String(n.source_type)
    const sourceId = String(n.source_id)
    const key = `${sourceType}:${sourceId}`
    if (seenSources.has(key)) {
      drift.push(`导航: 通知 ${n.notification_id} 与已有 (source_type, source_id) 重复 (去重违约)`)
    }
    seenSources.add(key)
    if (sourceType === 'schedule' && !schedulesById.has(sourceId)) {
      drift.push(`导航: 通知 ${n.notification_id} 深链指向不存在的排期 ${sourceId}`)
    } else if (sourceType === 'event' && !eventsById.has(sourceId)) {
      drift.push(`导航: 通知 ${n.notification_id} 深链指向不存在的发布事件 ${sourceId}`)
    } else if (sourceType === 'article' && !articleIds.has(Number(sourceId))) {
      drift.push(`导航: 通知 ${n.notification_id} 深链指向不存在的文章 #${sourceId}`)
    } else if (!NOTIFICATION_SOURCES.has(sourceType)) {
      drift.push(`导航: 通知 ${n.notification_id} 未知 source_type '${sourceType}'`)
    }
    if (n.status !== 'open' && n.status !== 'resolved') {
      drift.push(`导航: 通知 ${n.notification_id} 未知状态 '${n.status}'`)
    }
    if (String(n.acknowledged) !== '0' && String(n.acknowledged) !== '1') {
      drift.push(`导航: 通知 ${n.notification_id} acknowledged 非法`)
    }
  }

  /* ---- 2. 本机稿恢复 (article → contiguous version chain) ---------- */
  const postsById = new Map(rows.posts.map((p) => [Number(p.id), p]))
  for (const a of rows.articles) {
    const aid = Number(a.id)
    const list = versionsByArticle.get(aid) ?? []
    // Every article must present a server-confirmed version chain 1..N.
    if (list.length === 0) {
      drift.push(`本机稿: 文章 #${aid} 无任何已确认版本快照（移动稿无法恢复）`)
      continue
    }
    let expected = 1
    for (const v of list) {
      const ver = Number(v.version)
      if (ver !== expected) {
        drift.push(`本机稿: 文章 #${aid} 版本链在 ${ver} 处不连续（期望 ${expected}）`)
      }
      expected = ver + 1
      if (!SHA64.test(String(v.content_snapshot_sha256 || ''))) {
        drift.push(`本机稿: 文章 #${aid} 版本 ${ver} 缺少内容快照哈希（恢复稿无基准）`)
      }
      if (!validJson(v.snapshot_json)) {
        drift.push(`本机稿: 文章 #${aid} 版本 ${ver} 的 snapshot_json 非法`)
      }
    }
    // Server-confirmed save: the posts.current content hash agrees with the
    // LATEST version (the restored draft always equals the confirmed version).
    const post = a.post_ref != null ? postsById.get(Number(a.post_ref)) : undefined
    const latest = list[list.length - 1]
    if (post && post.deleted_at == null && post.content_snapshot_sha256 != null) {
      if (String(post.content_snapshot_sha256) !== String(latest.content_snapshot_sha256)) {
        drift.push(
          `本机稿: 文章 #${aid} 当前 posts 内容哈希 ${String(post.content_snapshot_sha256).slice(0, 12)}… ` +
            `!= 最新版本 ${Number(latest.version)} 内容哈希 ${String(latest.content_snapshot_sha256).slice(0, 12)}…`,
        )
      }
    }
  }

  /* ---- 3. 三向冲突选择 (source_conflict_resolutions) --------------- */
  for (const r of rows.conflicts) {
    const op = String(r.operation_id)
    if (r.chosen_side !== 'source' && r.chosen_side !== 'blogman') {
      drift.push(`冲突: 解决 ${op} 未知 chosen_side '${r.chosen_side}'`)
    }
    if (!['open', 'applied', 'expired'].includes(r.status)) {
      drift.push(`冲突: 解决 ${op} 未知状态 '${r.status}'`)
    }
    if (!articleIds.has(Number(r.article_id))) {
      drift.push(`冲突: 解决 ${op} 引用不存在的文章 #${r.article_id}`)
    }
    if (!identityIds.has(Number(r.source_identity_id))) {
      drift.push(`冲突: 解决 ${op} 引用不存在的源稿身份 #${r.source_identity_id}`)
    }
    if (!SHA64.test(String(r.baseline_sha256 || ''))) {
      drift.push(`冲突: 解决 ${op} baseline_sha256 非法`)
    }
    if (!SHA64.test(String(r.anchored_source_sha256 || ''))) {
      drift.push(`冲突: 解决 ${op} anchored_source_sha256 非法`)
    }
    if (!(Number(r.anchored_article_version) > 0)) {
      drift.push(`冲突: 解决 ${op} 缺少 anchored_article_version`)
    }
    if (!validJson(r.source_projection_json)) drift.push(`冲突: 解决 ${op} 的 source_projection_json 非法`)
    if (!validJson(r.source_media_json)) drift.push(`冲突: 解决 ${op} 的 source_media_json 非法`)
    if (!validJson(r.pre_resolution_snapshot_json)) {
      drift.push(`冲突: 解决 ${op} 缺少合法 pre_resolution 快照（选边前必须冻结基准）`)
    }
    if (r.status === 'applied' && r.applied_at == null) {
      drift.push(`冲突: 已应用解决 ${op} 却缺少 applied_at`)
    } else if (r.status !== 'applied' && r.applied_at != null) {
      drift.push(`冲突: 非 applied 解决 ${op} 却残留 applied_at`)
    }
  }

  /* ---- 4. 建议生命周期 (publish_preparations + publish_suggestions) */
  for (const p of rows.preparations) {
    const pid = String(p.preparation_id)
    if (!['recorded', 'applied', 'abandoned'].includes(p.status)) {
      drift.push(`建议: 准备 ${pid} 未知状态 '${p.status}'`)
    }
    if (!articleIds.has(Number(p.article_id))) {
      drift.push(`建议: 准备 ${pid} 引用不存在的文章 #${p.article_id}`)
    }
    if (!(Number(p.bound_version) > 0)) drift.push(`建议: 准备 ${pid} 缺少 bound_version`)
    if (!String(p.source || '').trim()) drift.push(`建议: 准备 ${pid} 缺少来源标记`)
    if (p.status === 'applied' && p.applied_at == null) {
      drift.push(`建议: 已应用准备 ${pid} 却缺少 applied_at`)
    } else if (p.status !== 'applied' && p.applied_at != null) {
      drift.push(`建议: 非 applied 准备 ${pid} 却残留 applied_at`)
    }
  }
  for (const s of rows.suggestions) {
    const sid = String(s.suggestion_id)
    const prep = preparationsById.get(String(s.preparation_id))
    if (!prep) {
      drift.push(`建议: 建议 ${sid} 引用不存在的准备 ${s.preparation_id}`)
      continue
    }
    if (!['category', 'tags', 'description', 'title', 'content'].includes(s.field)) {
      drift.push(`建议: 建议 ${sid} 未知字段 '${s.field}'`)
    }
    if (!['pending', 'applied', 'ignored', 'revoked', 'stale', 'abandoned'].includes(s.status)) {
      drift.push(`建议: 建议 ${sid} 未知状态 '${s.status}'`)
    }
    if (!articleIds.has(Number(s.article_id))) {
      drift.push(`建议: 建议 ${sid} 引用不存在的文章 #${s.article_id}`)
    }
    // Version-bound: the suggestion shares its preparation's bound version and
    // its basis_sha256 equals the exact bound-version content hash.
    if (Number(s.bound_version) !== Number(prep.bound_version)) {
      drift.push(`建议: 建议 ${sid} bound_version=${s.bound_version} != 准备 ${prep.preparation_id} bound_version=${prep.bound_version}`)
    }
    const versionRows = versionsByArticle.get(Number(s.article_id)) ?? []
    const bound = versionRows.find((v) => Number(v.version) === Number(s.bound_version))
    if (!bound) {
      drift.push(`建议: 建议 ${sid} 的 bound_version ${s.bound_version} 无对应文章版本快照`)
    } else if (SHA64.test(String(bound.content_snapshot_sha256)) && String(s.basis_sha256) !== String(bound.content_snapshot_sha256)) {
      drift.push(`建议: 建议 ${sid} basis_sha256 ${String(s.basis_sha256).slice(0, 12)}… 不绑定版本 ${s.bound_version} 内容哈希 ${String(bound.content_snapshot_sha256).slice(0, 12)}…`)
    }
    // Lifecycle: decided ⇔ non-pending; applied ⇒ applied_operation_id.
    const decided = s.decided_at != null
    if (s.status === 'pending' && decided) {
      drift.push(`建议: 待处理建议 ${sid} 却已产生 decided_at`)
    } else if (s.status !== 'pending' && !decided) {
      drift.push(`建议: ${s.status} 建议 ${sid} 缺少 decided_at`)
    }
    if (s.status === 'applied' && !String(s.applied_operation_id || '').trim()) {
      drift.push(`建议: 已应用建议 ${sid} 缺少 applied_operation_id`)
    } else if (s.status !== 'applied' && s.applied_operation_id != null) {
      drift.push(`建议: ${s.status} 建议 ${sid} 却残留 applied_operation_id`)
    }
  }
  /* ---- 5. 排期命令 (schedule status machine + control command) ----- */
  const SCHEDULE_STATUSES = new Set(['pending', 'paused', 'claimed', 'fired', 'stale', 'cancelled'])
  const CONTROL_ACTION_OUTCOME = {
    pause: 'paused',
    reconfirm: 'reconfirmed',
    reschedule: 'rescheduled',
    cancel: 'cancelled',
    publish_now: 'published',
  }
  for (const s of rows.schedules) {
    const sid = String(s.schedule_id)
    if (!SCHEDULE_STATUSES.has(s.status)) {
      drift.push(`排期: 排期 ${sid} 未知状态 '${s.status}'`)
    }
    if (!articleIds.has(Number(s.article_id))) {
      drift.push(`排期: 排期 ${sid} 引用的文章 #${s.article_id} 不存在`)
    }
    if (!(Number(s.version) > 0) || !(Number(s.scheduled_at) > 0)) {
      drift.push(`排期: 排期 ${sid} 绑定无效 version/scheduled_at`)
    }
    if (s.status === 'fired' && (s.fired_event_id == null || String(s.fired_event_id) === '')) {
      drift.push(`排期: 已触发排期 ${sid} 缺少 fired_event_id`)
    } else if (s.status !== 'fired' && s.fired_event_id != null) {
      drift.push(`排期: 未触发排期 ${sid} 却残留 fired_event_id`)
    }
    if (s.status === 'stale' && (s.stale_reason == null || String(s.stale_reason) === '')) {
      drift.push(`排期: 停滞排期 ${sid} 缺少 stale_reason`)
    }
  }
  for (const op of rows.controlOps) {
    const opId = String(op.operation_id)
    const sched = schedulesById.get(String(op.schedule_id))
    if (!sched) {
      drift.push(`排期: 控制命令 ${opId} 引用不存在的排期 ${op.schedule_id}`)
      continue
    }
    const expectedOutcome = CONTROL_ACTION_OUTCOME[op.action]
    if (!expectedOutcome) {
      drift.push(`排期: 控制命令 ${opId} 未知动作 '${op.action}'`)
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse(String(op.result))
    } catch {
      drift.push(`排期: 控制命令 ${opId} 的 result 不是有效 JSON`)
      continue
    }
    if (parsed == null || parsed.outcome !== expectedOutcome) {
      drift.push(`排期: 控制命令 ${opId} outcome='${parsed?.outcome}' 与 action='${op.action}' 不符（应为 ${expectedOutcome}）`)
    }
  }
  for (const s of rows.schedules) {
    const sid = String(s.schedule_id)
    const ops = opsBySchedule.get(sid) ?? []
    if (ops.length === 0) continue
    const latest = ops[ops.length - 1]
    if (latest.action === 'cancel' && s.status !== 'cancelled') {
      drift.push(`排期: 排期 ${sid} 最新命令是 cancel 但状态为 '${s.status}'（cancel 是终态）`)
    }
    if (latest.action === 'pause' && s.status !== 'paused') {
      drift.push(`排期: 排期 ${sid} 最新命令是 pause 但状态为 '${s.status}'`)
    }
    if (latest.action === 'publish_now' && s.status !== 'fired') {
      drift.push(`排期: 排期 ${sid} 最新命令是 publish_now 但状态为 '${s.status}'（成功发布必为 fired）`)
    }
    if (s.status === 'pending' && ['pause', 'cancel', 'publish_now'].includes(latest.action)) {
      drift.push(`排期: 排期 ${sid} 状态为 pending 但最新命令是 '${latest.action}'`)
    }
  }

  /* ---- 6. 发布确认与回据 (formal + event + outbox + receipt) ------- */
  for (const f of rows.formals) {
    const aid = Number(f.article_id)
    if (!articleIds.has(aid)) drift.push(`发布: 正式发布 #${aid} 引用不存在的文章`)
    if (!(Number(f.version) > 0)) drift.push(`发布: 正式发布 #${aid} 缺少版本`)
    if (f.lifecycle !== 'published' && f.lifecycle !== 'unpublished') {
      drift.push(`发布: 正式发布 #${aid} 未知 lifecycle '${f.lifecycle}'`)
    }
    const ev = eventsById.get(String(f.event_id))
    if (!ev) {
      drift.push(`发布: 正式发布 #${aid} 缺少其发布事件 ${f.event_id}（确认必须落地事件）`)
      continue
    }
    if (Number(ev.article_id) !== aid || Number(ev.version) !== Number(f.version)) {
      drift.push(`发布: 事件 ${ev.event_id} 的 article/version 与正式发布 #${aid} 不一致`)
    }
    if (String(ev.lifecycle) !== 'published') {
      drift.push(`发布: 事件 ${ev.event_id} lifecycle='${ev.lifecycle}' 非 published`)
    }
    const expected = kernels.evidenceDigest(String(ev.payload))
    if (String(ev.evidence_sha256) !== expected) {
      drift.push(`发布: 事件 ${ev.event_id} 证据哈希不匹配 stored=${String(ev.evidence_sha256).slice(0, 12)}… expected=${expected.slice(0, 12)}…`)
    }
    // Durable outbox row bound to the same article/version.
    const o = outboxesByEvent.get(String(f.event_id))
    if (!o) {
      drift.push(`发布: 事件 ${f.event_id} 缺少 outbox 行（确认与 outbox 必须同一事务写入）`)
    } else if (Number(o.article_id) !== aid || Number(o.version) !== Number(f.version)) {
      drift.push(`发布: outbox ${o.outbox_id} 的 article/version 与正式发布 #${aid} 不一致`)
    } else if (o.kind !== 'public-receipt') {
      drift.push(`发布: outbox ${o.outbox_id} kind='${o.kind}' 非 public-receipt`)
    }
    // Independent receipt bound to the same article/version/public_url.
    const r = receiptsByEvent.get(String(f.event_id))
    if (!r) {
      drift.push(`发布: 正式发布 #${aid} 缺少独立回据 ${f.event_id}（回据必须绑定同一事件）`)
    } else if (Number(r.article_id) !== aid || Number(r.version) !== Number(f.version)) {
      drift.push(`发布: 回据 ${r.event_id} 的 article/version 与正式发布 #${aid} 不一致`)
    } else if (String(r.public_url) !== String(f.public_url)) {
      drift.push(`发布: 回据 ${r.event_id} public_url '${r.public_url}' != 正式发布 '${f.public_url}'（博客回据绑定正式地址）`)
    } else if (String(r.verified) !== '1') {
      drift.push(`发布: 回据 ${r.event_id} 未验证 (verified=0)`)
    } else if (r.verified_at == null) {
      drift.push(`发布: 回据 ${r.event_id} 缺少 verified_at`)
    }
  }
  // Every published event the mobile matrix produced must land a formal.
  for (const ev of rows.events) {
    if (String(ev.lifecycle) !== 'published') continue
    const formal = rows.formals.find((f) => String(f.event_id) === String(ev.event_id))
    if (!formal) {
      drift.push(`发布: 事件 ${ev.event_id} lifecycle=published 却无正式发布回据`)
    }
  }
}

function renderReport({ args, drift, counts }) {
  const aligned = drift.length === 0
  const lines = []
  lines.push('# B8-G 批次 8 验收对账报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  if (args.candidate) lines.push(`- 候选绑定: \`${args.candidate}\``)
  lines.push(`- 事实表计数: 文章 ${counts.articles} · 版本 ${counts.versions} · 通知 ${counts.notifications} · ` +
    `冲突解决 ${counts.conflicts} · 建议准备 ${counts.preparations} · 建议 ${counts.suggestions} · ` +
    `排期 ${counts.schedules} · 控制命令 ${counts.controlOps} · 事件 ${counts.events} · ` +
    `Outbox ${counts.outboxes} · 正式发布 ${counts.formals} · 回据 ${counts.receipts}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（六面移动矩阵事实完整，同一候选一致）' : 'DRIFT（存在事实缺失或篡改，阻断验收）'}`)
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
  lines.push('> 注：任何 导航/深链恢复 / 本机稿恢复 / 冲突选边 / 建议生命周期 / 排期命令 / 发布回据 差异都会阻断批次 8 验收（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const kernels = await loadKernels()
  const [
    ledger, articles, posts, versions, preparations, suggestions,
    schedules, controlOps, events, outboxes, formals, receipts,
    notifications, identities, conflicts,
  ] = d1ReadAll(args)

  const rows = {
    ledger, articles, posts, versions, preparations, suggestions,
    schedules, controlOps, events, outboxes, formals, receipts,
    notifications, identities, conflicts,
  }
  const counts = {
    articles: articles.length,
    versions: versions.length,
    notifications: notifications.length,
    conflicts: conflicts.length,
    preparations: preparations.length,
    suggestions: suggestions.length,
    schedules: schedules.length,
    controlOps: controlOps.length,
    events: events.length,
    outboxes: outboxes.length,
    formals: formals.length,
    receipts: receipts.length,
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
    `reconcile-b8-facts: articles=${counts.articles} versions=${counts.versions} notifications=${counts.notifications} ` +
      `conflicts=${counts.conflicts} preparations=${counts.preparations} suggestions=${counts.suggestions} ` +
      `schedules=${counts.schedules} controlOps=${counts.controlOps} events=${counts.events} ` +
      `outboxes=${counts.outboxes} formals=${counts.formals} receipts=${counts.receipts} ` +
      `drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

main().catch((error) => {
  console.error('reconcile-b8-facts failed:', error)
  process.exit(2)
})
