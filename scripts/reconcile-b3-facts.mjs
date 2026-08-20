#!/usr/bin/env node
/**
 * B3-G — batch-3 acceptance fixture (issue #39).
 *
 * Read-only reconciliation of the eight batch-3 fact surfaces over ONE
 * immutable candidate (zero production writes). The fixture is meant to run
 * locally / in CI against a D1 state that was migrated, backfilled and driven
 * through the batch-3 command kernels from the same checked-out commit.
 *
 * Reconciled surfaces (strictly mapped to their owning tables):
 *
 *   1. 版本 (version)     — article_versions: per-article contiguous 1..N
 *       version facts; every version referenced by a formal publication,
 *       intent, event, outbox, revision, restore point or promotion must
 *       exist as a real version fact.
 *   2. 修订 (revision)    — publish_revisions ↔ publish_promotions: every
 *       promotion binds exactly one promoted revision; the promoted revision
 *       facts (base version, content hash) match the promotion event.
 *   3. 恢复点 (recovery)  — publish_restore_points ↔ publish_promotions: one
 *       deterministic pre-promotion restore point per promotion (rollback
 *       material), tamper-evident content hash (recomputed through the real
 *       snapshot kernel); publish_restore_ops reference existing points.
 *   4. 意图 (intent)      — publish_prepares ↔ publish_intents ↔
 *       publish_events: one committed prepare per intent, one intent per
 *       event, deterministic event_id derivation, matching version/slug.
 *   5. 事件 (events)      — publish_events / publish_promotions /
 *       article_lifecycles: every immutable event is tamper-evident
 *       (evidence_sha256 == sha256(payload)); lifecycle rows carry the
 *       declared direction; the latest lifecycle row agrees with the formal
 *       publication lifecycle.
 *   6. Outbox             — publish_outbox ↔ publish_events: one outbox row
 *       per event (deterministic outbox_id), matching article/version, and
 *       delivered semantics (delivered ⇔ delivered_at IS NOT NULL).
 *   7. 地址 (address)     — article_slug_addresses ↔ formal_publications: at
 *       most one `current` row per article matching the formal slug; a
 *       `historical` slug must have been live (present in an event or
 *       promotion of the same article); `candidate` rows never shadow the
 *       current address. A first-published article with NO address rows and
 *       NO promotion is tolerated (B3-04 backfill pending); a promoted
 *       article MUST have its current address registered.
 *   8. 投影 (projection)  — posts (legacy projection) follows the formal
 *       fact: status, slug, published_at and the content snapshot hash of the
 *       FORMAL version (drafts must project their latest version instead).
 *
 * Optionally binds the candidate: when `--candidate <sha>` is given the
 * migration ledger's last applied candidate identity must equal it — the same
 * immutable candidate that produced the D1 state.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-b3-facts.mjs --local \
 *     [--candidate <git-rev>] [--persist-to <dir>] [--database <name>] \
 *     [--config <path>] [--report <path>]
 *
 * Read-only: only SELECT statements are issued through `wrangler d1
 * execute`; any difference exits 1 and prints a per-item report.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const firstPublishUrl = pathToFileURL(join(repoRoot, 'lib', 'first-publish', 'kernel.ts')).href
const revisionUrl = pathToFileURL(join(repoRoot, 'lib', 'publish-revision', 'kernel.ts')).href
const lifecycleUrl = pathToFileURL(join(repoRoot, 'lib', 'article-lifecycle', 'kernel.ts')).href

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b39')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-b3')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-b3-facts-report.md')

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-b3-facts.mjs --local|--remote ' +
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
/* single read-only wrangler pass (16 SELECT groups, one spawn)        */
/* ------------------------------------------------------------------ */

const READ_STATEMENTS = [
  'SELECT candidate_id FROM migration_ledger ORDER BY number DESC LIMIT 1',
  'SELECT id, post_ref FROM articles ORDER BY id',
  `SELECT id, slug, title, status, published_at, content_snapshot_sha256, deleted_at
     FROM posts ORDER BY id`,
  `SELECT article_id, version, operation_id, content_snapshot_sha256
     FROM article_versions ORDER BY article_id, version ASC`,
  `SELECT prepare_id, article_id, post_ref, prepared_version, prepared_slug,
          prepared_title, prepared_content_sha256, status
     FROM publish_prepares ORDER BY prepare_id ASC`,
  `SELECT intent_id, prepare_id, article_id, version, slug, lifecycle, status
     FROM publish_intents ORDER BY intent_id ASC`,
  `SELECT event_id, intent_id, article_id, version, slug, lifecycle,
          first_published_at, evidence_sha256, payload, created_at
     FROM publish_events ORDER BY event_id ASC`,
  `SELECT outbox_id, event_id, article_id, version, kind, status, attempts, delivered_at
     FROM publish_outbox ORDER BY outbox_id ASC`,
  `SELECT article_id, version, slug, lifecycle, first_published_at, published_at,
          public_url, event_id
     FROM formal_publications ORDER BY article_id ASC`,
  `SELECT event_id, article_id, version, slug, public_url, verified, verified_at
     FROM publish_receipts ORDER BY event_id ASC`,
  `SELECT revision_id, article_id, base_version, revision_number, status, content_sha256, slug
     FROM publish_revisions ORDER BY revision_id ASC`,
  `SELECT restore_point_id, article_id, formal_version, promoted_version,
          snapshot_json, content_sha256, reason
     FROM publish_restore_points ORDER BY restore_point_id ASC`,
  `SELECT promotion_id, article_id, revision_id, base_version, promoted_version,
          slug, public_url, content_sha256, evidence_sha256, payload
     FROM publish_promotions ORDER BY promotion_id ASC`,
  `SELECT restore_operation_id, article_id, source_restore_point_id, target,
          expected_version, status
     FROM publish_restore_ops ORDER BY restore_operation_id ASC`,
  `SELECT id, operation_id, article_id, post_ref, version, direction,
          lifecycle_before, lifecycle_after, source_version, public_url,
          evidence_sha256, payload
     FROM article_lifecycles ORDER BY id ASC`,
  `SELECT slug, article_id, kind FROM article_slug_addresses ORDER BY slug ASC`,
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
      `wrangler d1 execute failed (is every batch-3 table present? run the ` +
        `apply-*-ddl.mjs scripts first): ${detail.slice(0, 600)}`,
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
  const revision = (await import(revisionUrl)).default ?? (await import(revisionUrl))
  const lifecycle = (await import(lifecycleUrl)).default ?? (await import(lifecycleUrl))
  return {
    eventIdFor: firstPublish.eventIdFor,
    outboxIdFor: firstPublish.outboxIdFor,
    evidenceDigest: firstPublish.evidenceDigest,
    promotionIdFor: revision.promotionIdFor,
    restorePointIdFor: revision.restorePointIdFor,
    snapshotContentHash: revision.snapshotContentHash,
    lifecycleEvidenceDigest: lifecycle.evidenceDigest ?? firstPublish.evidenceDigest,
  }
}

/* ------------------------------------------------------------------ */
/* fact reconciliation                                                 */
/* ------------------------------------------------------------------ */

function buildIndexes(rows) {
  const articlesById = new Map(rows.articles.map((a) => [Number(a.id), a]))
  const postsById = new Map(rows.posts.map((p) => [Number(p.id), p]))
  const versionsByArticle = new Map()
  for (const v of rows.versions) {
    const aid = Number(v.article_id)
    if (!versionsByArticle.has(aid)) versionsByArticle.set(aid, [])
    versionsByArticle.get(aid).push(v)
  }
  for (const list of versionsByArticle.values()) list.sort((a, b) => Number(a.version) - Number(b.version))
  const versionByArticleAndNumber = new Map()
  for (const list of versionsByArticle.values()) {
    for (const v of list) versionByArticleAndNumber.set(`${v.article_id}:${v.version}`, v)
  }
  const mapBy = (rowsArr, key) => {
    const m = new Map()
    for (const r of rowsArr) m.set(String(r[key]), r)
    return m
  }
  return {
    articlesById,
    postsById,
    versionsByArticle,
    versionByArticleAndNumber,
    prepares: mapBy(rows.prepares, 'prepare_id'),
    intents: mapBy(rows.intents, 'intent_id'),
    events: mapBy(rows.events, 'event_id'),
    outboxes: mapBy(rows.outboxes, 'outbox_id'),
    receipts: mapBy(rows.receipts, 'event_id'),
    revisions: mapBy(rows.revisions, 'revision_id'),
    restorePoints: mapBy(rows.restorePoints, 'restore_point_id'),
    promotions: mapBy(rows.promotions, 'promotion_id'),
    lifecycles: rows.lifecycles,
    addresses: rows.addresses,
  }
}

function reconcile(args, kernels, rows, drift) {
  const idx = buildIndexes(rows)

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

  /* ---- 1. 版本 (version surface) ---------------------------------- */
  for (const [aid, list] of idx.versionsByArticle) {
    const nums = list.map((v) => Number(v.version))
    const max = Math.max(...nums)
    if (nums.length !== max) {
      drift.push(`版本: article #${aid} 版本不连续 (count=${nums.length} max=${max}, 应有 1..${nums.length})`)
    }
  }
  const needVersion = (aid, version, where) => {
    if (!idx.versionByArticleAndNumber.has(`${aid}:${version}`)) {
      drift.push(`版本: ${where} 引用版本 ${version} 但 article #${aid} 无该版本事实`)
    }
  }
  for (const f of rows.formals) {
    needVersion(Number(f.article_id), Number(f.version), `formal_publications(${f.slug})`)
  }
  for (const i of rows.intents) {
    needVersion(Number(i.article_id), Number(i.version), `publish_intents(${i.intent_id})`)
  }
  for (const e of rows.events) {
    needVersion(Number(e.article_id), Number(e.version), `publish_events(${e.event_id})`)
  }
  for (const o of rows.outboxes) {
    needVersion(Number(o.article_id), Number(o.version), `publish_outbox(${o.outbox_id})`)
  }
  for (const r of rows.revisions) {
    needVersion(Number(r.article_id), Number(r.base_version), `publish_revisions(${r.revision_id})`)
  }
  for (const rp of rows.restorePoints) {
    needVersion(Number(rp.article_id), Number(rp.formal_version), `publish_restore_points(${rp.restore_point_id}) formal_version`)
    needVersion(Number(rp.article_id), Number(rp.promoted_version), `publish_restore_points(${rp.restore_point_id}) promoted_version`)
  }
  for (const p of rows.promotions) {
    needVersion(Number(p.article_id), Number(p.base_version), `publish_promotions(${p.promotion_id}) base_version`)
    needVersion(Number(p.article_id), Number(p.promoted_version), `publish_promotions(${p.promotion_id}) promoted_version`)
  }

  /* ---- 2. 修订 (revision surface) --------------------------------- */
  const promotionCountPerRevision = new Map()
  for (const p of rows.promotions) {
    const r = idx.revisions.get(String(p.revision_id))
    if (!r) {
      drift.push(`修订: promotion ${p.promotion_id} 引用不存在的 revision ${p.revision_id}`)
      continue
    }
    if (Number(r.article_id) !== Number(p.article_id)) {
      drift.push(`修订: promotion ${p.promotion_id} 的 article_id 与 revision ${p.revision_id} 不一致`)
    }
    if (r.status !== 'promoted') {
      drift.push(`修订: revision ${p.revision_id} 已被 promotion ${p.promotion_id} 上线却仍为 status='${r.status}'`)
    }
    if (Number(r.base_version) !== Number(p.base_version)) {
      drift.push(`修订: promotion ${p.promotion_id} base_version=${p.base_version} != revision ${p.revision_id} base_version=${r.base_version}`)
    }
    if (String(r.content_sha256) !== String(p.content_sha256)) {
      drift.push(`修订: promotion ${p.promotion_id} 内容哈希 ${p.content_sha256.slice(0, 12)}… != revision ${p.revision_id} ${r.content_sha256.slice(0, 12)}…`)
    }
    if (String(p.public_url) !== '' && !String(p.public_url).endsWith(`/${p.slug}`)) {
      drift.push(`修订: promotion ${p.promotion_id} public_url 与 slug 不符 (${p.public_url})`)
    }
    promotionCountPerRevision.set(String(p.revision_id), (promotionCountPerRevision.get(String(p.revision_id)) ?? 0) + 1)
  }
  for (const r of rows.revisions) {
    if (r.status === 'promoted') {
      const n = promotionCountPerRevision.get(String(r.revision_id)) ?? 0
      if (n === 0) drift.push(`修订: revision ${r.revision_id} 标记为 promoted 但无 promotion 事件`)
      else if (n > 1) drift.push(`修订: revision ${r.revision_id} 有 ${n} 个 promotion 事件（应恰好一个）`)
    }
  }

  /* ---- 3. 恢复点 (recovery point surface) ------------------------- */
  for (const p of rows.promotions) {
    const expectedId = kernels.restorePointIdFor(String(p.promotion_id))
    const rp = idx.restorePoints.get(expectedId)
    if (!rp) {
      drift.push(`恢复点: promotion ${p.promotion_id} 缺少恢复点 ${expectedId}`)
      continue
    }
    if (Number(rp.article_id) !== Number(p.article_id)) {
      drift.push(`恢复点: restore_point ${rp.restore_point_id} 的 article 与 promotion ${p.promotion_id} 不一致`)
    }
    if (Number(rp.formal_version) !== Number(p.base_version)) {
      drift.push(`恢复点: ${rp.restore_point_id} formal_version=${rp.formal_version} != promotion base_version=${p.base_version}`)
    }
    if (Number(rp.promoted_version) !== Number(p.promoted_version)) {
      drift.push(`恢复点: ${rp.restore_point_id} promoted_version=${rp.promoted_version} != promotion promoted_version=${p.promoted_version}`)
    }
    try {
      const snapshot = JSON.parse(String(rp.snapshot_json))
      const content = snapshot.original_content ?? snapshot.fields?.content ?? ''
      const expectedHash = kernels.snapshotContentHash({ content })
      if (String(rp.content_sha256) !== expectedHash) {
        drift.push(`恢复点: ${rp.restore_point_id} 内容哈希篡改 stored=${String(rp.content_sha256).slice(0, 12)}… expected=${expectedHash.slice(0, 12)}…`)
      }
    } catch (error) {
      drift.push(`恢复点: ${rp.restore_point_id} snapshot_json 解析失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const op of rows.restoreOps) {
    const rp = idx.restorePoints.get(String(op.source_restore_point_id))
    if (!rp) {
      drift.push(`恢复点: restore_op ${op.restore_operation_id} 引用不存在的恢复点 ${op.source_restore_point_id}`)
    } else if (Number(rp.article_id) !== Number(op.article_id)) {
      drift.push(`恢复点: restore_op ${op.restore_operation_id} 的 article 与恢复点 ${rp.restore_point_id} 不一致`)
    } else if (Number(rp.promoted_version) !== Number(op.expected_version)) {
      drift.push(`恢复点: restore_op ${op.restore_operation_id} expected_version=${op.expected_version} != 恢复点 ${rp.restore_point_id} promoted_version=${rp.promoted_version}`)
    }
  }
  for (const rp of rows.restorePoints) {
    const reason = String(rp.reason)
    if (reason.startsWith('promote:')) {
      const promotionId = `promote:${reason.slice('promote:'.length)}`
      const p = idx.promotions.get(promotionId)
      if (!p) drift.push(`恢复点: ${rp.restore_point_id} 声明来自 promotion ${promotionId} 但该 promotion 不存在`)
    }
  }

  /* ---- 4. 意图 (intent surface) ----------------------------------- */
  const intentsByPrepare = new Map()
  for (const i of rows.intents) {
    const prep = idx.prepares.get(String(i.prepare_id))
    if (!prep) {
      drift.push(`意图: intent ${i.intent_id} 引用不存在的 prepare ${i.prepare_id}`)
    } else {
      if (Number(prep.article_id) !== Number(i.article_id)) {
        drift.push(`意图: intent ${i.intent_id} 的 article 与 prepare ${prep.prepare_id} 不一致`)
      }
      if (Number(prep.prepared_version) !== Number(i.version)) {
        drift.push(`意图: intent ${i.intent_id} version=${i.version} != prepare ${prep.prepare_id} prepared_version=${prep.prepared_version}`)
      }
      if (String(prep.prepared_slug) !== String(i.slug)) {
        drift.push(`意图: intent ${i.intent_id} slug=${i.slug} != prepare ${prep.prepare_id} prepared_slug=${prep.prepared_slug}`)
      }
      if (prep.status !== 'committed') {
        drift.push(`意图: prepare ${prep.prepare_id} 已被意图 ${i.intent_id} 确认却仍为 status='${prep.status}'`)
      }
    }
    intentsByPrepare.set(String(i.prepare_id), i)
  }
  for (const prep of rows.prepares) {
    if (prep.status === 'committed' && !intentsByPrepare.has(String(prep.prepare_id))) {
      drift.push(`意图: prepare ${prep.prepare_id} 已 committed 但无意图记录`)
    }
  }
  for (const e of rows.events) {
    const i = idx.intents.get(String(e.intent_id))
    if (!i) {
      drift.push(`意图: event ${e.event_id} 引用不存在的 intent ${e.intent_id}`)
      continue
    }
    if (Number(i.article_id) !== Number(e.article_id)) drift.push(`意图: event ${e.event_id} 的 article 与 intent ${i.intent_id} 不一致`)
    if (Number(i.version) !== Number(e.version)) drift.push(`意图: event ${e.event_id} version=${e.version} != intent ${i.intent_id} version=${i.version}`)
    if (String(i.slug) !== String(e.slug)) drift.push(`意图: event ${e.event_id} slug 与 intent ${i.intent_id} 不一致`)
    if (i.status !== 'delivered') drift.push(`意图: intent ${i.intent_id} 已产生事件却仍为 status='${i.status}'`)
    const expectedEventId = kernels.eventIdFor(String(e.intent_id))
    if (String(e.event_id) !== expectedEventId) {
      drift.push(`事件: event_id ${e.event_id} 不是 intent ${e.intent_id} 的规范派生值 ${expectedEventId}`)
    }
  }

  /* ---- 5. 事件 (event surface) ------------------------------------ */
  for (const e of rows.events) {
    const expected = kernels.evidenceDigest(String(e.payload))
    if (String(e.evidence_sha256) !== expected) {
      drift.push(`事件: publish_events(${e.event_id}) 证据哈希不匹配 stored=${String(e.evidence_sha256).slice(0, 12)}… expected=${expected.slice(0, 12)}…`)
    }
  }
  for (const p of rows.promotions) {
    const expected = kernels.evidenceDigest(String(p.payload))
    if (String(p.evidence_sha256) !== expected) {
      drift.push(`事件: publish_promotions(${p.promotion_id}) 证据哈希不匹配 stored=${String(p.evidence_sha256).slice(0, 12)}… expected=${expected.slice(0, 12)}…`)
    }
    const expectedId = kernels.promotionIdFor(String(p.revision_id))
    if (String(p.promotion_id) !== expectedId) {
      drift.push(`事件: promotion_id ${p.promotion_id} 不是 revision ${p.revision_id} 的规范派生值 ${expectedId}`)
    }
    if (Number(p.promoted_version) !== Number(p.base_version) + 1) {
      drift.push(`事件: promotion ${p.promotion_id} promoted_version=${p.promoted_version} != base_version+1 (${p.base_version})`)
    }
  }
  const latestLifecycleByArticle = new Map()
  /* ---- intent → event completeness -------------------------------- */
  const eventByIntent = new Map(rows.events.map((e) => [String(e.intent_id), e]))
  for (const i of rows.intents) {
    if (!eventByIntent.has(String(i.intent_id))) {
      drift.push(`意图: intent ${i.intent_id} 无事件记录`)
    }
  }
  for (const f of rows.formals) {
    const event = idx.events.get(String(f.event_id)) ?? idx.promotions.get(String(f.event_id))
    if (!event) {
      drift.push(`事件: formal_publications(${f.slug}) 的 event_id ${f.event_id} 无对应事件/上线记录`)
    } else if (Number(event.article_id) !== Number(f.article_id)) {
      drift.push(`事件: formal_publications(${f.slug}) 的 event_id ${f.event_id} 属于其他文章`)
    }
    if (idx.events.has(String(f.event_id))) {
      const fe = idx.events.get(String(f.event_id))
      if (Number(f.first_published_at) !== Number(fe.first_published_at)) {
        drift.push(`事件: formal_publications(${f.slug}) first_published_at != 首次发布事件 ${f.event_id}`)
      }
    }
  }

  /* ---- receipts bound to their producing event -------------------- */
  for (const r of rows.receipts) {
    const e = idx.events.get(String(r.event_id))
    if (!e) {
      drift.push(`事件: publish_receipts(${r.event_id}) 引用不存在的 event`)
    } else {
      if (Number(r.article_id) !== Number(e.article_id)) drift.push(`事件: receipt ${r.event_id} 的 article 与 event 不一致`)
      if (Number(r.version) !== Number(e.version)) drift.push(`事件: receipt ${r.event_id} version=${r.version} != event version=${e.version}`)
      if (String(r.slug) !== String(e.slug)) drift.push(`事件: receipt ${r.event_id} slug 与 event 不一致`)
      if (String(r.public_url) !== '' && !String(r.public_url).endsWith(`/${r.slug}`)) {
        drift.push(`事件: receipt ${r.event_id} public_url 与 slug 不符 (${r.public_url})`)
      }
    }
  }

  for (const l of rows.lifecycles) {
    const expected = kernels.lifecycleEvidenceDigest(String(l.payload))
    if (String(l.evidence_sha256) !== expected) {
      drift.push(`事件: article_lifecycles(${l.operation_id}) 证据哈希不匹配 stored=${String(l.evidence_sha256).slice(0, 12)}… expected=${expected.slice(0, 12)}…`)
    }
    const direction = String(l.direction)
    const before = String(l.lifecycle_before)
    const after = String(l.lifecycle_after)
    if (direction === 'unpublish') {
      if (before !== 'published' || after !== 'unpublished') {
        drift.push(`事件: article_lifecycles(${l.operation_id}) 方向 unpublish 须 published→unpublished，实际 ${before}→${after}`)
      }
    } else if (direction === 'relive-formal' || direction === 'relive-revision') {
      if (before !== 'unpublished' || after !== 'published') {
        drift.push(`事件: article_lifecycles(${l.operation_id}) 方向 ${direction} 须 unpublished→published，实际 ${before}→${after}`)
      }
    } else {
      drift.push(`事件: article_lifecycles(${l.operation_id}) 未知方向 ${direction}`)
    }
    const previous = latestLifecycleByArticle.get(Number(l.article_id))
    if (!previous || Number(previous.id) < Number(l.id)) {
      latestLifecycleByArticle.set(Number(l.article_id), { id: l.id, after, version: Number(l.version) })
    }
  }
  for (const f of rows.formals) {
    const latest = latestLifecycleByArticle.get(Number(f.article_id))
    if (latest && latest.after !== String(f.lifecycle)) {
      drift.push(`事件: article #${f.article_id} 最新 lifecycle 为 '${latest.after}' 但 formal_publications.lifecycle='${f.lifecycle}'`)
    }
  }

  /* ---- 6. Outbox surface ------------------------------------------ */
  const outboxByEvent = new Map(rows.outboxes.map((o) => [String(o.event_id), o]))
  for (const e of rows.events) {
    if (!outboxByEvent.has(String(e.event_id))) {
      drift.push(`Outbox: event ${e.event_id} 缺少 outbox 行（事件与 outbox 必须同一事务写入）`)
    }
  }
  for (const o of rows.outboxes) {
    const e = idx.events.get(String(o.event_id))
    if (!e) {
      drift.push(`Outbox: ${o.outbox_id} 引用不存在的 event ${o.event_id}`)
      continue
    }
    if (Number(o.article_id) !== Number(e.article_id)) drift.push(`Outbox: ${o.outbox_id} 的 article 与 event ${e.event_id} 不一致`)
    if (Number(o.version) !== Number(e.version)) drift.push(`Outbox: ${o.outbox_id} version=${o.version} != event ${e.event_id} version=${e.version}`)
    const expectedId = kernels.outboxIdFor(String(o.event_id))
    if (String(o.outbox_id) !== expectedId) {
      drift.push(`Outbox: outbox_id ${o.outbox_id} 不是 event ${e.event_id} 的规范派生值 ${expectedId}`)
    }
    const delivered = o.status === 'delivered'
    const hasMarker = o.delivered_at !== null && o.delivered_at !== undefined
    if (delivered !== hasMarker) {
      drift.push(`Outbox: ${o.outbox_id} status='${o.status}' 与 delivered_at 标记不一致 (delivered_at=${o.delivered_at})`)
    }
  }

  /* ---- 7. 地址 (address surface) ---------------------------------- */
  const addressesByArticle = new Map()
  const promotionsByArticle = new Map()
  for (const a of rows.addresses) {
    const aid = Number(a.article_id)
    if (!addressesByArticle.has(aid)) addressesByArticle.set(aid, [])
    addressesByArticle.get(aid).push(a)
  }
  for (const p of rows.promotions) {
    const aid = Number(p.article_id)
    if (!promotionsByArticle.has(aid)) promotionsByArticle.set(aid, [])
    promotionsByArticle.get(aid).push(p)
  }
  const formalByArticle = new Map(rows.formals.map((f) => [Number(f.article_id), f]))
  for (const a of rows.addresses) {
    const aid = Number(a.article_id)
    if (!idx.articlesById.has(aid)) {
      drift.push(`地址: slug ${a.slug} 指向不存在的 article #${aid}`)
      continue
    }
    const formal = formalByArticle.get(aid)
    if (a.kind === 'current') {
      if (!formal) {
        drift.push(`地址: article #${aid} 有 current 地址 ${a.slug} 但无正式发布`)
      } else if (String(a.slug) !== String(formal.slug)) {
        drift.push(`地址: article #${aid} current 地址 ${a.slug} != 正式地址 ${formal.slug}`)
      }
    } else if (a.kind === 'candidate') {
      if (formal && String(a.slug) === String(formal.slug)) {
        drift.push(`地址: article #${aid} candidate 地址 ${a.slug} 与正式当前地址冲突`)
      }
    } else if (a.kind === 'historical') {
      const liveSlugs = new Set()
      for (const ev of rows.events) if (Number(ev.article_id) === aid) liveSlugs.add(String(ev.slug))
      for (const p of rows.promotions) if (Number(p.article_id) === aid) liveSlugs.add(String(p.slug))
      if (!liveSlugs.has(String(a.slug))) {
        drift.push(`地址: article #${aid} historical 地址 ${a.slug} 从未在该文章的任何事件/上线中存活`)
      }
    }
  }
  for (const f of rows.formals) {
    const aid = Number(f.article_id)
    const list = addressesByArticle.get(aid) ?? []
    const currents = list.filter((a) => a.kind === 'current')
    const hasPromotions = (promotionsByArticle.get(aid) ?? []).length > 0
    if (list.length === 0 && !hasPromotions) continue // backfill pending (B3-04) — tolerated
    if (currents.length !== 1) {
      drift.push(`地址: article #${aid} 的 current 地址数量为 ${currents.length}（应恰好 1，正式地址 ${f.slug}）`)
    } else if (String(currents[0].slug) !== String(f.slug)) {
      drift.push(`地址: article #${aid} current 地址 ${currents[0].slug} != 正式地址 ${f.slug}`)
    }
  }

  /* ---- 8. 投影 (projection surface) ------------------------------- */
  for (const f of rows.formals) {
    const article = idx.articlesById.get(Number(f.article_id))
    if (!article) {
      drift.push(`投影: formal article #${f.article_id} 无 articles 身份`)
      continue
    }
    const post = idx.postsById.get(Number(article.post_ref))
    if (!post) {
      drift.push(`投影: article #${f.article_id} 无 posts 投影行`)
      continue
    }
    if (f.lifecycle === 'published' && post.status !== 'published') {
      drift.push(`投影: article #${f.article_id} 正式已发布但 posts.status='${post.status}'`)
    } else if (f.lifecycle === 'unpublished' && post.status === 'published') {
      drift.push(`投影: article #${f.article_id} 正式未发布但 posts.status 仍为 published`)
    }
    if (String(post.slug) !== String(f.slug)) {
      drift.push(`投影: article #${f.article_id} posts.slug=${post.slug} != 正式 slug=${f.slug}`)
    }
    if (post.published_at !== null && f.published_at !== null && Number(post.published_at) !== Number(f.published_at)) {
      drift.push(`投影: article #${f.article_id} posts.published_at=${post.published_at} != formal published_at=${f.published_at}`)
    }
    const formalVersion = idx.versionByArticleAndNumber.get(`${f.article_id}:${f.version}`)
    if (formalVersion) {
      const postHash = post.content_snapshot_sha256 == null ? null : String(post.content_snapshot_sha256)
      const versionHash = String(formalVersion.content_snapshot_sha256)
      if (postHash === null) {
        drift.push(`投影: article #${f.article_id} posts 缺少 content_snapshot_sha256（正式版本 v${f.version} 已存在）`)
      } else if (postHash !== versionHash) {
        drift.push(`投影: article #${f.article_id} posts 投影哈希 ${postHash.slice(0, 12)}… != 正式版本 v${f.version} 哈希 ${versionHash.slice(0, 12)}…`)
      }
    }
  }
  for (const [aid, list] of idx.versionsByArticle) {
    if (formalByArticle.has(aid)) continue
    const article = idx.articlesById.get(aid)
    const post = article ? idx.postsById.get(Number(article.post_ref)) : undefined
    if (!post) continue
    const last = list[list.length - 1]
    const postHash = post.content_snapshot_sha256 == null ? null : String(post.content_snapshot_sha256)
    if (postHash !== null && last && postHash !== String(last.content_snapshot_sha256)) {
      drift.push(`投影: 草稿 article #${aid} posts 投影哈希 != 最新版本 v${last.version} 哈希`)
    }
  }
}

function renderReport({ args, drift, counts }) {
  const aligned = drift.length === 0
  const lines = []
  lines.push('# B3-G 批次 3 验收对账报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  if (args.candidate) lines.push(`- 候选绑定: \`${args.candidate}\``)
  lines.push(`- 事实表计数: 文章身份 ${counts.articles} · 版本 ${counts.versions} · 正式发布 ${counts.formals} · ` +
    `意图 ${counts.intents} · 事件 ${counts.events} · Outbox ${counts.outboxes} · ` +
    `修订 ${counts.revisions} · 恢复点 ${counts.restorePoints} · 上线 ${counts.promotions} · ` +
    `生命周期 ${counts.lifecycles} · 地址 ${counts.addresses} · 回执 ${counts.receipts}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（八面事实完整，同一候选一致）' : 'DRIFT（存在事实缺失或篡改，阻断验收）'}`)
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
  lines.push('> 注：任何版本 / 修订 / 恢复点 / 意图 / 事件 / Outbox / 地址 / 投影差异都会阻断批次 3 验收（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const kernels = await loadKernels()
  const [ledger, articles, posts, versions, prepares, intents, events, outboxes,
    formals, receipts, revisions, restorePoints, promotions, restoreOps, lifecycles, addresses] =
    d1ReadAll(args)

  const rows = {
    ledger, articles, posts, versions, prepares, intents, events, outboxes,
    formals, receipts, revisions, restorePoints, promotions, restoreOps,
    lifecycles, addresses,
  }
  const counts = {
    articles: articles.length,
    versions: versions.length,
    formals: formals.length,
    intents: intents.length,
    events: events.length,
    outboxes: outboxes.length,
    revisions: revisions.length,
    restorePoints: restorePoints.length,
    promotions: promotions.length,
    lifecycles: lifecycles.length,
    addresses: addresses.length,
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
    `reconcile-b3-facts: candidates=${rows.ledger.length} articles=${counts.articles} versions=${counts.versions} ` +
      `formals=${counts.formals} events=${counts.events} promotions=${counts.promotions} ` +
      `lifecycles=${counts.lifecycles} addresses=${counts.addresses} ` +
      `drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

main().catch((error) => {
  console.error('reconcile-b3-facts failed:', error)
  process.exit(2)
})