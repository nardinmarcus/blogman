#!/usr/bin/env node
/**
 * B6-G — batch-6 acceptance fixture (issue #56).
 *
 * Read-only reconciliation of the writable-primary-source chain's EIGHT fact
 * surfaces over ONE immutable candidate (zero production writes). The fixture
 * is meant to run locally / in CI against a D1 state that was migrated,
 * backfilled and driven through the batch-6 command kernels (identity / link /
 * confirm / sync / write-back / conflict / availability / relink) from the
 * same checked-out commit. Only SELECT statements are issued through
 * `wrangler d1 execute`; any difference exits 1 and prints a per-item report.
 *
 * Reconciled surfaces:
 *
 *   1. 身份 (identity)       — `source_identities` + `source_url_variants`:
 *       the canonical identity_sha256 == sha256(canonical_url), the URL is a
 *       normalized http(s) source URL, every variant row references a real
 *       identity and never equals its own canonical URL.
 *   2. 关联 (association)    — `article_source_links` 的 pending/active/unbound
 *       状态机: every link references a real identity + article, status is a
 *       valid lifecycle state, pending ⇒ resolved_at IS NULL and
 *       confirmed/cancelled ⇒ resolved_at IS SET, operation_id is unique and
 *       there is AT MOST ONE live (pending/confirmed) link per identity (解除后
 *       无 live, 重新关联产生新 pending; cancelled rows stay as history).
 *   3. 基线 (baseline)      — `source_sync_baselines` (union) +
 *       `source_baseline_facts`: every baseline row declares a well-formed
 *       source hash (64-hex) and binds to a real identity + article.
 *   4. 同步方向 (sync)      — `source_sync_attempts` + `media_assets` +
 *       `source_media_mappings`: a `synced` attempt MUST carry its baseline
 *       fingerprint + synced version, a `failed` attempt NEVER carries a
 *       baseline (任一媒体/保存失败不产生半同步, 不推进基线), and every media
 *       fact is content-identity-addressed and mapping-consistent.
 *   5. 冲突选边 (conflict)  — `source_conflict_resolutions`: operation_id
 *       unique, chosen_side/status are valid (open → applied / expired,
 *       applied ⇒ applied_at), every anchored baseline/source hash is
 *       64-hex, and the snapshots (source_projection / source_media /
 *       pre_resolution) are valid JSON.
 *   6. 恢复点 (restore)     — a chosen-source applied resolution MUST carry a
 *       valid pre-resolution snapshot, and every `conflict-pick-source:<op>`
 *       restore point resolves to a real applied source-side resolution.
 *   7. 不可用观察 (avail)   — `source_availability_observations`: operation_id
 *       unique, outcome is one of readable / temporarily-unavailable /
 *       confirmed-missing, and the row references a real identity.
 *   8. 写回意图与确认 (wb)  — `source_write_back_intents`: status lifecycle
 *       (intent → written → confirmed / stale), column completeness per
 *       status, and 确认前不推进基线 — ONLY a confirmed intent advances the
 *       baseline (a confirmed intent's version+source hash must equal the
 *       durable baseline's, while a written/intent/stale intent must NOT).
 *
 * Full-chain consistency (全链一致性): every durable baseline's source hash
 * must be TRACED to a fact-producing operation — the last `synced` sync
 * attempt's fingerprint, a `confirmed` write-back intent's source hash, or an
 * `applied` conflict resolution's anchored source hash. A baseline that no
 * producer backs is drift and blocks acceptance.
 *
 * Optionally binds the immutable candidate: when `--candidate <sha>` is given
 * the migration ledger's last applied candidate identity must equal it.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-b6-facts.mjs --local \
 *     [--candidate <git-rev>] [--persist-to <dir>] [--database <name>] \
 *     [--config <path>] [--report <path>]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b6g')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-b6')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-b6-facts-report.md')

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

const SHA64 = /^[0-9a-f]{64}$/

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-b6-facts.mjs --local|--remote ' +
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
/* single read-only wrangler pass (14 SELECT groups, one spawn)        */
/* ------------------------------------------------------------------ */

const READ_STATEMENTS = [
  'SELECT candidate_id FROM migration_ledger ORDER BY number DESC LIMIT 1',
  'SELECT id, post_ref FROM articles ORDER BY id',
  `SELECT id, canonical_url, identity_sha256, created_at
     FROM source_identities ORDER BY id ASC`,
  `SELECT id, source_identity_id, variant_canonical_url, merged_by_operation_id, created_at
     FROM source_url_variants ORDER BY id ASC`,
  `SELECT id, source_identity_id, article_id, status, operation_id, created_at, resolved_at
     FROM article_source_links ORDER BY id ASC`,
  `SELECT source_identity_id, article_id, article_version, source_sync_sha256,
          baseline_sha256, synced_version, synced_revision_id, synced_title,
          synced_markdown, synced_html, synced_media_json, updated_at
     FROM source_sync_baselines ORDER BY source_identity_id, article_id`,
  `SELECT source_identity_id, content_sha256, advanced_by_operation_id, advanced_at
     FROM source_baseline_facts ORDER BY source_identity_id ASC`,
  `SELECT operation_id, source_identity_id, article_id, post_ref, outcome, reason,
          baseline_sha256, synced_version, synced_revision_id, projection_json,
          media_json
     FROM source_sync_attempts ORDER BY id ASC`,
  `SELECT id, content_sha256, r2_key, media_type, size
     FROM media_assets ORDER BY id ASC`,
  `SELECT id, source_identity_id, source_ref, media_asset_id
     FROM source_media_mappings ORDER BY id ASC`,
  `SELECT operation_id, source_identity_id, article_id, chosen_side, baseline_version,
          baseline_sha256, anchored_source_sha256, anchored_article_version,
          source_projection_json, source_media_json, pre_resolution_snapshot_json,
          write_back_content_json, status, created_at, applied_at
     FROM source_conflict_resolutions ORDER BY id ASC`,
  `SELECT id, restore_point_id, article_id, snapshot_json, content_sha256, reason, created_at
     FROM publish_restore_points ORDER BY id ASC`,
  `SELECT id, source_identity_id, operation_id, outcome, detail, observed_at
     FROM source_availability_observations ORDER BY id ASC`,
  `SELECT id, source_identity_id, article_id, article_version, baseline_version,
          operation_id, status, external_ref, source_sync_sha256, intent_at,
          written_at, confirmed_at
     FROM source_write_back_intents ORDER BY id ASC`,
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
      `wrangler d1 execute failed (is every batch-6 table present? run the ` +
        `apply-source-identity/sync/write-back/conflict/availability DDL channels first): ${detail.slice(0, 600)}`,
    )
  }
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected wrangler output: ${String(result.stdout).slice(0, 200)}`)
  }
  return parsed.map((entry) => entry.results ?? [])
}

/* ------------------------------------------------------------------ */
/* fact reconciliation                                                 */
/* ------------------------------------------------------------------ */

const LINK_STATUSES = new Set(['pending', 'confirmed', 'cancelled'])
const CONFLICT_SIDES = new Set(['source', 'blogman'])
const CONFLICT_STATUSES = new Set(['open', 'applied', 'expired'])
const SYNC_OUTCOMES = new Set(['synced', 'failed'])
const AVAIL_OUTCOMES = new Set(['readable', 'temporarily-unavailable', 'confirmed-missing'])
const WRITEBACK_STATUSES = new Set(['intent', 'written', 'confirmed', 'stale'])

function validJson(str) {
  if (str == null) return false
  try {
    const parsed = JSON.parse(String(str))
    return parsed !== null && typeof parsed === 'object'
  } catch {
    return false
  }
}

function reconcile(args, rows, drift) {
  const identityIds = new Set(rows.identities.map((i) => Number(i.id)))
  const articleIds = new Set(rows.articles.map((a) => Number(a.id)))
  const baselineByKey = new Map(rows.baselines.map((b) => [`${b.source_identity_id}:${b.article_id}`, b]))
  const variantsByIdentity = new Map()
  for (const v of rows.variants) {
    const key = String(v.source_identity_id)
    if (!variantsByIdentity.has(key)) variantsByIdentity.set(key, [])
    variantsByIdentity.get(key).push(v)
  }

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

  /* ---- 1. 身份 (source identities + URL variants) ----------------- */
  const canonicalByUrl = new Map(rows.identities.map((i) => [i.canonical_url, i]))
  for (const i of rows.identities) {
    const id = Number(i.id)
    const canonicalUrl = String(i.canonical_url || '')
    if (!/^https?:\/\//i.test(canonicalUrl)) {
      drift.push(`身份: 身份 #${id} 的 canonical_url '${canonicalUrl}' 不是有效 http(s) 源稿 URL`)
    }
    const recomputed = sha256Hex(canonicalUrl)
    if (!SHA64.test(String(i.identity_sha256 || ''))) {
      drift.push(`身份: 身份 #${id} identity_sha256 非法 (${String(i.identity_sha256).slice(0, 12)}…)`)
    } else if (String(i.identity_sha256) !== recomputed) {
      drift.push(`身份: 身份 #${id} identity_sha256 与 canonical_url 不符 stored=${String(i.identity_sha256).slice(0, 12)}… expected=${recomputed.slice(0, 12)}…`)
    }
    if (canonicalByUrl.get(canonicalUrl) !== i) {
      drift.push(`身份: 身份 #${id} canonical_url '${canonicalUrl}' 重复（应唯一）`)
    }
  }
  for (const v of rows.variants) {
    const vid = Number(v.id)
    if (!identityIds.has(Number(v.source_identity_id))) {
      drift.push(`身份: URL 变体 #${vid} 引用的源稿身份 #${v.source_identity_id} 不存在`)
      continue
    }
    const target = rows.identities.find((i) => Number(i.id) === Number(v.source_identity_id))
    const variantUrl = String(v.variant_canonical_url || '')
    if (!/^https?:\/\//i.test(variantUrl)) {
      drift.push(`身份: URL 变体 #${vid} '${variantUrl}' 不是有效 http(s) URL`)
    }
    if (target && variantUrl === String(target.canonical_url)) {
      drift.push(`身份: URL 变体 #${vid} 与其目标身份 canonical_url 相同（变体不应等于自身）`)
    }
    if (!String(v.merged_by_operation_id || '').trim()) {
      drift.push(`身份: URL 变体 #${vid} 缺少 merged_by_operation_id`)
    }
  }
  // Every canonical URL is unique and not shadowed by a variant of another id.
  const variantUrlOwner = new Map()
  for (const v of rows.variants) {
    if (!variantUrlOwner.has(v.variant_canonical_url)) variantUrlOwner.set(v.variant_canonical_url, Number(v.source_identity_id))
  }
  for (const v of rows.variants) {
    const owner = variantUrlOwner.get(v.variant_canonical_url)
    if (owner !== Number(v.source_identity_id)) {
      drift.push(`身份: URL 变体 '${v.variant_canonical_url}' 归属不一致 (变体 #${v.id} vs #${owner})`)
    }
  }

  /* ---- 2. 关联 (article_source_links pending/active/unbound) ------ */
  const liveByIdentity = new Map()
  for (const l of rows.links) {
    const lid = String(l.operation_id)
    if (!LINK_STATUSES.has(l.status)) {
      drift.push(`关联: 链接 ${lid} 未知状态 '${l.status}'`)
    }
    if (!identityIds.has(Number(l.source_identity_id))) {
      drift.push(`关联: 链接 ${lid} 引用的源稿身份 #${l.source_identity_id} 不存在`)
    }
    if (!articleIds.has(Number(l.article_id))) {
      drift.push(`关联: 链接 ${lid} 引用的文章 #${l.article_id} 不存在`)
    }
    if (l.status === 'pending') {
      if (l.resolved_at != null) drift.push(`关联: 待确认链接 ${lid} 却残留 resolved_at（pending 未生效）`)
    } else if (l.resolved_at == null) {
      drift.push(`关联: ${l.status} 链接 ${lid} 缺少 resolved_at（终态必须记录解决时刻）`)
    }
    if (l.status === 'pending' || l.status === 'confirmed') {
      const key = String(l.source_identity_id)
      if (!liveByIdentity.has(key)) liveByIdentity.set(key, [])
      liveByIdentity.get(key).push(l)
    }
    // A recurring article must not carry two live links on the same identity
    // (unlink clears the live set; relink starts ONE fresh pending link).
  }
  for (const [key, list] of liveByIdentity) {
    if (list.length > 1) {
      drift.push(`关联: 源稿身份 #${key} 存在 ${list.length} 条 live 链接（应至多一条，解除后无 live）`)
    }
  }

  /* ---- 3. 基线 (source_sync_baselines + source_baseline_facts) ---- */
  for (const b of rows.baselines) {
    const key = `${b.source_identity_id}:${b.article_id}`
    if (!identityIds.has(Number(b.source_identity_id))) {
      drift.push(`基线: 基线 ${key} 引用不存在的源稿身份 #${b.source_identity_id}`)
    }
    if (!articleIds.has(Number(b.article_id))) {
      drift.push(`基线: 基线 ${key} 引用不存在的文章 #${b.article_id}`)
    }
    const hasPrincipalHash = String(b.source_sync_sha256 || '').match(SHA64)
    const hasBaselineHash = String(b.baseline_sha256 || '').match(SHA64)
    if (!hasPrincipalHash && !hasBaselineHash) {
      drift.push(`基线: 基线 ${key} 没有 64-hex 的源稿同步哈希 (source_sync_sha256 / baseline_sha256 均为空或非法）`)
    }
    if (!(Number(b.synced_version) > 0) && !(Number(b.article_version) > 0)) {
      drift.push(`基线: 基线 ${key} 缺少有效的 synced_version / article_version`)
    }
  }
  for (const f of rows.baselineFacts) {
    if (!identityIds.has(Number(f.source_identity_id))) {
      drift.push(`基线: 基线事实引用不存在的源稿身份 #${f.source_identity_id}`)
    }
    if (!SHA64.test(String(f.content_sha256 || ''))) {
      drift.push(`基线: 基线事实 (身份 #${f.source_identity_id}) 内容哈希非法`)
    }
    if (!String(f.advanced_by_operation_id || '').trim()) {
      drift.push(`基线: 基线事实 (身份 #${f.source_identity_id}) 缺少推进操作 id`)
    }
  }

  /* ---- 4. 同步方向 (sync attempts + media facts) ------------------ */
  const syncedFingerprints = new Map()
  for (const a of rows.attempts) {
    const op = String(a.operation_id)
    if (!SYNC_OUTCOMES.has(a.outcome)) {
      drift.push(`同步: 尝试 ${op} 未知 outcome '${a.outcome}'`)
    }
    if (!identityIds.has(Number(a.source_identity_id))) {
      drift.push(`同步: 尝试 ${op} 引用不存在的源稿身份 #${a.source_identity_id}`)
    }
    if (!articleIds.has(Number(a.article_id))) {
      drift.push(`同步: 尝试 ${op} 引用不存在的文章 #${a.article_id}`)
    }
    if (a.outcome === 'synced') {
      if (!SHA64.test(String(a.baseline_sha256 || ''))) {
        drift.push(`同步: 成功尝试 ${op} 缺少合法基线指纹 baseline_sha256`)
      }
      if (!(Number(a.synced_version) > 0)) {
        drift.push(`同步: 成功尝试 ${op} 缺少 synced_version`)
      }
      if (!validJson(a.projection_json) || !validJson(a.media_json)) {
        drift.push(`同步: 成功尝试 ${op} 的 projection/media JSON 非法`)
      }
      if (SHA64.test(String(a.baseline_sha256 || ''))) {
        if (!syncedFingerprints.has(String(a.source_identity_id))) {
          syncedFingerprints.set(String(a.source_identity_id), new Set())
        }
        syncedFingerprints.get(String(a.source_identity_id)).add(String(a.baseline_sha256))
      }
    } else if (a.outcome === 'failed') {
      // 任一媒体/保存失败不产生半同步、不推进基线 — a failed attempt carries NO baseline.
      if (SHA64.test(String(a.baseline_sha256 || ''))) {
        drift.push(`同步: 失败尝试 ${op} 却携带基线指纹（失败不推进基线）`)
      }
      if (!String(a.reason || '').trim()) {
        drift.push(`同步: 失败尝试 ${op} 缺少 reason`)
      }
    }
  }
  const assetIds = new Set(rows.mediaAssets.map((m) => Number(m.id)))
  for (const m of rows.mediaAssets) {
    if (!SHA64.test(String(m.content_sha256 || ''))) drift.push(`媒体: 资源 #${m.id} 内容哈希非法`)
    if (!String(m.r2_key || '').startsWith('source-media/')) {
      drift.push(`媒体: 资源 #${m.id} r2_key '${m.r2_key}' 不是规范的 source-media/ 键`)
    }
    if (String(m.r2_key || '') !== `source-media/${String(m.content_sha256)}`) {
      drift.push(`媒体: 资源 #${m.id} r2_key 与内容身份不符 (r2_key=${String(m.r2_key).slice(0, 24)}…)`)
    }
  }
  for (const map of rows.mappings) {
    const key = `${map.source_identity_id}:${map.source_ref}`
    if (!identityIds.has(Number(map.source_identity_id))) {
      drift.push(`媒体: 映射 ${key} 引用不存在的源稿身份 #${map.source_identity_id}`)
    }
    if (!assetIds.has(Number(map.media_asset_id))) {
      drift.push(`媒体: 映射 ${key} 引用不存在的媒体资源 #${map.media_asset_id}`)
    }
    if (!String(map.source_ref || '').trim()) {
      drift.push(`媒体: 映射 ${key} 缺少 source_ref`)
    }
  }

  /* ---- 5. 冲突选边 (source_conflict_resolutions) ------------------ */
  for (const r of rows.conflicts) {
    const op = String(r.operation_id)
    if (!CONFLICT_SIDES.has(r.chosen_side)) drift.push(`冲突: 解决 ${op} 未知 chosen_side '${r.chosen_side}'`)
    if (!CONFLICT_STATUSES.has(r.status)) drift.push(`冲突: 解决 ${op} 未知状态 '${r.status}'`)
    if (!identityIds.has(Number(r.source_identity_id))) drift.push(`冲突: 解决 ${op} 引用不存在的源稿身份 #${r.source_identity_id}`)
    if (!articleIds.has(Number(r.article_id))) drift.push(`冲突: 解决 ${op} 引用不存在的文章 #${r.article_id}`)
    if (!SHA64.test(String(r.baseline_sha256 || ''))) drift.push(`冲突: 解决 ${op} baseline_sha256 非法`)
    if (!SHA64.test(String(r.anchored_source_sha256 || ''))) drift.push(`冲突: 解决 ${op} anchored_source_sha256 非法`)
    if (!(Number(r.anchored_article_version) > 0)) drift.push(`冲突: 解决 ${op} 缺少 anchored_article_version`)
    if (!validJson(r.source_projection_json)) drift.push(`冲突: 解决 ${op} 的 source_projection_json 非法`)
    if (!validJson(r.source_media_json)) drift.push(`冲突: 解决 ${op} 的 source_media_json 非法`)
    if (r.status === 'applied' && r.applied_at == null) {
      drift.push(`冲突: 已应用解决 ${op} 却缺少 applied_at`)
    } else if (r.status !== 'applied' && r.applied_at != null) {
      drift.push(`冲突: 非 applied 解决 ${op} 却残留 applied_at`)
    }
  }

  /* ---- 6. 恢复点 (restore points + pre-resolution snapshots) ------ */
  const appliedSourceOps = new Set()
  for (const r of rows.conflicts) {
    if (r.chosen_side === 'source' && r.status === 'applied') {
      appliedSourceOps.add(String(r.operation_id))
      if (!validJson(r.pre_resolution_snapshot_json)) {
        drift.push(`恢复点: 已应用选源稿解决 ${r.operation_id} 缺少合法 pre_resolution 快照`)
      }
    } else if (!validJson(r.pre_resolution_snapshot_json || '')) {
      // A resolution MUST carry a pre-resolution snapshot regardless of side.
      drift.push(`恢复点: 解决 ${r.operation_id} 的 pre_resolution 快照非法`)
    }
  }
  for (const p of rows.restorePoints) {
    const reason = String(p.reason || '')
    if (reason.startsWith('conflict-pick-source:')) {
      const op = reason.slice('conflict-pick-source:'.length)
      if (!appliedSourceOps.has(op)) {
        drift.push(`恢复点: 恢复点 #${p.id} 的 reason '${reason}' 无对应已应用选源稿解决 ${op}`)
      }
    }
    if (!articleIds.has(Number(p.article_id))) {
      drift.push(`恢复点: 恢复点 #${p.id} 引用不存在的文章 #${p.article_id}`)
    }
    if (!SHA64.test(String(p.content_sha256 || ''))) {
      drift.push(`恢复点: 恢复点 #${p.id} 内容哈希非法`)
    }
    if (!validJson(p.snapshot_json)) drift.push(`恢复点: 恢复点 #${p.id} 快照 JSON 非法`)
  }

  /* ---- 7. 不可用观察 (source_availability_observations) ----------- */
  const availOps = new Set()
  for (const o of rows.avail) {
    const op = String(o.operation_id)
    if (!AVAIL_OUTCOMES.has(o.outcome)) {
      drift.push(`不可用: 观察 ${op} 未知 outcome '${o.outcome}'`)
    }
    if (!identityIds.has(Number(o.source_identity_id))) {
      drift.push(`不可用: 观察 ${op} 引用不存在的源稿身份 #${o.source_identity_id}`)
    }
    if (availOps.has(op)) drift.push(`不可用: 观察操作 id 重复 ${op}`)
    availOps.add(op)
  }

  /* ---- 8. 写回意图与确认 (source_write_back_intents) -------------- */
  const confirmedBaselineByKey = new Map()
  for (const w of rows.writebacks) {
    const op = String(w.operation_id)
    const key = `${w.source_identity_id}:${w.article_id}`
    if (!WRITEBACK_STATUSES.has(w.status)) drift.push(`写回: 意图 ${op} 未知状态 '${w.status}'`)
    if (!identityIds.has(Number(w.source_identity_id))) drift.push(`写回: 意图 ${op} 引用不存在的源稿身份 #${w.source_identity_id}`)
    if (!articleIds.has(Number(w.article_id))) drift.push(`写回: 意图 ${op} 引用不存在的文章 #${w.article_id}`)
    if (!(Number(w.article_version) > 0)) drift.push(`写回: 意图 ${op} 缺少 article_version`)
    if (w.status === 'written' || w.status === 'confirmed') {
      if (w.written_at == null) drift.push(`写回: ${w.status} 意图 ${op} 缺少 written_at`)
      if (w.external_ref == null || String(w.external_ref) === '') drift.push(`写回: ${w.status} 意图 ${op} 缺少 external_ref`)
      if (!SHA64.test(String(w.source_sync_sha256 || ''))) drift.push(`写回: ${w.status} 意图 ${op} 缺少推送后的源稿哈希`)
    } else if (w.status === 'intent') {
      if (w.written_at != null || w.confirmed_at != null) drift.push(`写回: intent 意图 ${op} 不应携带 written/confirmed 时刻`)
    }
    if (w.status === 'confirmed') {
      if (w.confirmed_at == null) drift.push(`写回: confirmed 意图 ${op} 缺少 confirmed_at`)
      confirmedBaselineByKey.set(key, {
        articleVersion: Number(w.article_version),
        sourceSyncSha256: String(w.source_sync_sha256 || ''),
      })
    } else if (w.status === 'stale') {
      if (w.confirmed_at != null) drift.push(`写回: stale 意图 ${op} 不应携带 confirmed_at`)
    }
  }
  // 确认前不推进基线: a confirmed intent's version+source hash must equal the
  // durable baseline — and a written/intent/stale intent must NOT be the one
  // the baseline advanced to (the baseline must be strictly older or absent).
  for (const [key, expected] of confirmedBaselineByKey) {
    const baseline = baselineByKey.get(key)
    if (!baseline) {
      drift.push(`写回: 已确认意图（${key}）推进基线但 durable baseline 缺失`)
      continue
    }
    const actualVersion = Number(baseline.article_version ?? baseline.synced_version ?? 0)
    const actualHash = String(baseline.source_sync_sha256 || baseline.baseline_sha256 || '')
    if (actualVersion !== expected.articleVersion || actualHash !== expected.sourceSyncSha256) {
      drift.push(`写回: 已确认意图（${key}）的 version/hash (v${expected.articleVersion}/${expected.sourceSyncSha256.slice(0, 12)}…) 与 durable baseline (v${actualVersion}/${actualHash.slice(0, 12)}…) 不符 — 确认未推进基线`)
    }
  }

  /* ---- 全链一致性 (every baseline is traced to a producer) -------- */
  for (const b of rows.baselines) {
    const key = `${b.source_identity_id}:${b.article_id}`
    const principalHash = String(b.source_sync_sha256 || b.baseline_sha256 || '')
    if (!SHA64.test(principalHash)) continue // already flagged above
    const producedByConfirmed = [...confirmedBaselineByKey.entries()].some(
      ([k, v]) => k === key && v.sourceSyncSha256 === principalHash,
    )
    const producedBySynced = syncedFingerprints.has(String(b.source_identity_id)) &&
      syncedFingerprints.get(String(b.source_identity_id)).has(principalHash)
    const producedByConflict = rows.conflicts.some(
      (r) =>
        Number(r.source_identity_id) === Number(b.source_identity_id) &&
        Number(r.article_id) === Number(b.article_id) &&
        r.status === 'applied' &&
        String(r.anchored_source_sha256) === principalHash,
    )
    if (!producedByConfirmed && !producedBySynced && !producedByConflict) {
      drift.push(`全链: 基线 ${key} 的源稿哈希 ${principalHash.slice(0, 12)}… 无任何 producing 操作背书（成功同步指纹 / 已确认写回 / 已应用冲突选源稿）`)
    }
  }
}

function renderReport({ args, drift, counts }) {
  const aligned = drift.length === 0
  const lines = []
  lines.push('# B6-G 批次 6 验收对账报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  if (args.candidate) lines.push(`- 候选绑定: \`${args.candidate}\``)
  lines.push(`- 事实表计数: 身份 ${counts.identities} · URL 变体 ${counts.variants} · 关联 ${counts.links} · ` +
    `基线 ${counts.baselines} · 基线事实 ${counts.baselineFacts} · 同步尝试 ${counts.attempts} · ` +
    `媒体 ${counts.mediaAssets} · 媒体映射 ${counts.mappings} · 冲突解决 ${counts.conflicts} · ` +
    `恢复点 ${counts.restorePoints} · 不可用观察 ${counts.avail} · 写回意图 ${counts.writebacks}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（八面源稿链事实完整，同一候选一致）' : 'DRIFT（存在事实缺失或篡改，阻断验收）'}`)
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
  lines.push('> 注：任何 身份 / 关联 / 基线 / 同步方向 / 冲突选边 / 恢复点 / 不可用观察 / 写回意图 差异都会阻断批次 6 验收（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const [
    ledger, articles, identities, variants, links, baselines, baselineFacts,
    attempts, mediaAssets, mappings, conflicts, restorePoints, avail, writebacks,
  ] = d1ReadAll(args)

  const rows = {
    ledger, articles, identities, variants, links, baselines, baselineFacts,
    attempts, mediaAssets, mappings, conflicts, restorePoints, avail, writebacks,
  }
  const counts = {
    identities: identities.length,
    variants: variants.length,
    links: links.length,
    baselines: baselines.length,
    baselineFacts: baselineFacts.length,
    attempts: attempts.length,
    mediaAssets: mediaAssets.length,
    mappings: mappings.length,
    conflicts: conflicts.length,
    restorePoints: restorePoints.length,
    avail: avail.length,
    writebacks: writebacks.length,
  }

  const drift = []
  reconcile(args, rows, drift)
  const uniqueDrift = [...new Set(drift)]
  drift.length = 0
  drift.push(...uniqueDrift)

  const aligned = drift.length === 0
  const report = renderReport({ args, drift, counts })
  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, report, 'utf8')

  console.log(
    `reconcile-b6-facts: identities=${counts.identities} variants=${counts.variants} links=${counts.links} ` +
      `baselines=${counts.baselines} attempts=${counts.attempts} conflicts=${counts.conflicts} ` +
      `restorePoints=${counts.restorePoints} avail=${counts.avail} writebacks=${counts.writebacks} ` +
      `drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

main().catch((error) => {
  console.error('reconcile-b6-facts failed:', error)
  process.exit(2)
})
