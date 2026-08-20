#!/usr/bin/env node
/**
 * B7-G — batch-7 acceptance fixture (issue #59).
 *
 * Read-only reconciliation of the CLIP (剪藏) chain's FIVE fact surfaces over
 * ONE immutable candidate (zero production writes). The fixture is meant to
 * run locally / in CI against a D1 state that was migrated, backfilled and
 * driven through the batch-7 command kernels (idempotent Chrome clip →
 * compare-then-confirm explicit source-page refresh) from the same
 * checked-out commit. Only SELECT statements are issued through `wrangler d1
 * execute`; any difference exits 1 and prints a per-item report.
 *
 * Reconciled surfaces (strictly mapped to their owning tables):
 *
 *   1. 身份 (URL 规范化身份) — `source_identities` + `source_url_variants`:
 *       the canonical identity_sha256 == sha256(canonical_url), the URL is a
 *       normalized http(s) source URL, every variant row references a real
 *       identity and never equals its own canonical URL. The CLIP-DERIVED
 *       identity is checked too: a clip article's `draft_ref` ==
 *       `clip:<identity_sha256>` and its `slug` == `clip-<sha12>` converge on
 *       exactly one normalized-source identity (重复剪藏不建重复文章).
 *   2. 关联 (文章关联)      — `article_source_links` with ROLE `clip`: a clip
 *       link is ONLY a reference source (来源网页不成为主要源稿) — role is
 *       always `clip`, status is a valid pending/confirmed/cancelled state
 *       machine, pending ⇒ resolved_at IS NULL and confirmed/cancelled ⇒
 *       resolved_at IS SET, and AT MOST ONE live (pending/confirmed) clip link
 *       per source identity (解除后无 live, 重新剪藏产生新 pending).
 *   3. 比较/确认刷新记录     — `source_refresh_proposals` +
 *       `source_refresh_records`: the propose (FREEZE, never writes the
 *       article) and confirm (apply ONLY after explicit author confirmation)
 *       loop. operation_id UNIQUE ⇒ idempotent replay; role always `clip`;
 *       every record binds to its proposal by identity+article; a `no-diff`
 *       proposal is never confirmed; a `confirmed` proposal is backed by
 *       EXACTLY one refreshed record; a `stale` proposal is never applied.
 *   4. 来源快照 (source snapshot) — every proposal's `snapshot_sha256` (and a
 *       refreshed record's `baseline_sha256`) is REDERIVED through the real
 *       `snapshotFingerprint` (normalized title + rewritten markdown + present
 *       media content hashes) and must equal the stored value — a tampered or
 *       mismatched snapshot blocks acceptance.
 *   5. 媒体身份复用 (media identity reuse) — `media_assets` +
 *       `source_media_mappings`: every NON-removed media fact frozen in a
 *       proposal/record must be addressable by content identity — the durable
 *       mapping (source_identity_id, source_ref) resolves to a media_asset
 *       whose content_sha256 EQUALS the frozen fact's contentSha256, and
 *       `r2_key` == `source-media/<content_sha256>`. Content is reused (not
 *       re-guessed by filename) exactly when its sha256 is verified.
 *
 * Full-chain consistency (全链一致性): every refreshed record's snapshot
 * fingerprint is TRACED to the proposal it confirms, and every confirmed
 * proposal is backed by exactly one refreshed record — a refresh that ends
 * media-failed / stale / save-conflict is never marked complete (媒体失败不得
 * 标完成).
 *
 * Optionally binds the immutable candidate: when `--candidate <sha>` is given
 * the migration ledger's last applied candidate identity must equal it.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-b7-facts.mjs --local \
 *     [--candidate <git-rev>] [--persist-to <dir>] [--database <name>] \
 *     [--config <path>] [--report <path>]
 *
 * Read-only: only SELECT statements are issued through `wrangler d1
 * execute`; any difference exits 1 and prints a per-item report.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATE_BASE = join(homedir(), '.local', 'state', 'blogman', 'b7g')
const DEFAULT_PERSIST = join(STATE_BASE, 'd1-state-b7')
const DEFAULT_REPORT = join(STATE_BASE, 'reconcile-b7-facts-report.md')

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

const SHA64 = /^[0-9a-f]{64}$/

function usage() {
  console.error(
    'usage: node --import tsx scripts/reconcile-b7-facts.mjs --local|--remote ' +
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
/* single read-only wrangler pass (12 SELECT groups, one spawn)        */
/* ------------------------------------------------------------------ */

const READ_STATEMENTS = [
  'SELECT candidate_id FROM migration_ledger ORDER BY number DESC LIMIT 1',
  'SELECT id, post_ref, slug, draft_ref FROM articles ORDER BY id',
  `SELECT id, canonical_url, identity_sha256, created_at
     FROM source_identities ORDER BY id ASC`,
  `SELECT id, source_identity_id, variant_canonical_url, merged_by_operation_id, created_at
     FROM source_url_variants ORDER BY id ASC`,
  `SELECT id, source_identity_id, article_id, status, role, operation_id, created_at, resolved_at
     FROM article_source_links ORDER BY id ASC`,
  `SELECT operation_id, source_identity_id, article_id, post_ref, role, proposed_version,
          status, source_title, source_markdown, source_html, snapshot_sha256,
          diff_json, media_json, created_at
     FROM source_refresh_proposals ORDER BY id ASC`,
  `SELECT operation_id, proposal_operation_id, source_identity_id, article_id, post_ref,
          role, outcome, reason, expected_version, applied_version, applied_revision_id,
          baseline_sha256, projection_json, media_json, diff_json, created_at
     FROM source_refresh_records ORDER BY id ASC`,
  `SELECT id, content_sha256, r2_key, media_type, size, filename
     FROM media_assets ORDER BY id ASC`,
  `SELECT id, source_identity_id, source_ref, media_asset_id
     FROM source_media_mappings ORDER BY id ASC`,
  `SELECT article_id, version FROM formal_publications ORDER BY article_id ASC`,
  `SELECT article_id, version FROM article_versions ORDER BY article_id, version ASC`,
  `SELECT revision_id, article_id, revision_number FROM publish_revisions ORDER BY revision_id ASC`,
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
      `wrangler d1 execute failed (is every batch-7 table present? run the ` +
        `apply-source-sync / apply-source-refresh DDL channels first): ${detail.slice(0, 600)}`,
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
const PROPOSAL_STATUSES = new Set(['proposed', 'no-diff', 'confirmed', 'cancelled', 'stale'])
const RECORD_OUTCOMES = new Set(['refreshed', 'failed'])

function validJson(str) {
  if (str == null) return false
  try {
    const parsed = JSON.parse(String(str))
    return parsed !== null && typeof parsed === 'object'
  } catch {
    return false
  }
}

/** Parse a stored media_json into a RefreshMediaDiff[] (empty on bad JSON). */
function parseMedia(json) {
  try {
    const parsed = JSON.parse(String(json ?? '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Parse a stored diff_json into an object (null on bad JSON). */
function parseDiff(json) {
  try {
    const parsed = JSON.parse(String(json ?? 'null'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The batch-4/5/6 graceful JSON field: some older surfaces store a JSON string
 * wrapped in quotes (e.g. `"{\"...\"}"`). The refresh kernels always store a
 * plain JSON object/array, so we handle the plain case and treat a quoted
 * wrapper as malformed (it never comes from the B7 kernels).
 */
function parseMediaFacts(json) {
  const raw = String(json ?? '[]')
  if (raw.startsWith('"')) return []
  return parseMedia(raw)
}

/** Rederive the frozen source-snapshot fingerprint EXACTLY as the B7-02 kernel. */
export function snapshotFingerprint(title, markdown, mediaFacts) {
  const sorted = (mediaFacts || [])
    .filter((m) => (m.status ?? '') !== 'removed')
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((m) => ({ ref: m.ref, contentSha256: m.contentSha256 }))
  return sha256Hex(JSON.stringify({ title, markdown, media: sorted }))
}

function reconcile(args, rows, drift) {
  const identityIds = new Set(rows.identities.map((i) => Number(i.id)))
  const articleIds = new Set(rows.articles.map((a) => Number(a.id)))
  const identitiesById = new Map(rows.identities.map((i) => [Number(i.id), i]))
  const articlesById = new Map(rows.articles.map((a) => [Number(a.id), a]))
  const assetsById = new Map(rows.mediaAssets.map((m) => [Number(m.id), m]))
  const versionsByArticle = new Map()
  for (const v of rows.versions) {
    const aid = Number(v.article_id)
    if (!versionsByArticle.has(aid)) versionsByArticle.set(aid, new Set())
    versionsByArticle.get(aid).add(Number(v.version))
  }
  const revisionsById = new Map(rows.revisions.map((r) => [String(r.revision_id), r]))
  const formalByArticle = new Set(rows.formals.map((f) => Number(f.article_id)))
  const proposalsByIdentity = new Map()
  for (const p of rows.proposals) {
    const key = String(p.source_identity_id)
    if (!proposalsByIdentity.has(key)) proposalsByIdentity.set(key, [])
    proposalsByIdentity.get(key).push(p)
  }
  const recordsByProposal = new Map()
  for (const r of rows.records) {
    if (!recordsByProposal.has(String(r.proposal_operation_id))) {
      recordsByProposal.set(String(r.proposal_operation_id), [])
    }
    recordsByProposal.get(String(r.proposal_operation_id)).push(r)
  }
  const recordsByOp = new Map(rows.records.map((r) => [String(r.operation_id), r]))
  const proposalsByOp = new Map(rows.proposals.map((p) => [String(p.operation_id), p]))
  const mappingsByKey = new Map()
  for (const m of rows.mappings) {
    mappingsByKey.set(`${m.source_identity_id}:${m.source_ref}`, m)
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

  /* ---- 1. 身份 (URL normalization identity + clip-derived id) ------ */
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
    const target = identitiesById.get(Number(v.source_identity_id))
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

  /* ---- 2. 关联 (clip-role article_source_links state machine) ----- */
  const liveClipByIdentity = new Map()
  for (const l of rows.links) {
    if (l.role !== 'clip') continue // B6 reconciles the primary-role chain
    const op = String(l.operation_id)
    if (!LINK_STATUSES.has(l.status)) {
      drift.push(`关联: clip 链接 ${op} 未知状态 '${l.status}'`)
    }
    if (!identityIds.has(Number(l.source_identity_id))) {
      drift.push(`关联: clip 链接 ${op} 引用的源稿身份 #${l.source_identity_id} 不存在`)
    }
    if (!articleIds.has(Number(l.article_id))) {
      drift.push(`关联: clip 链接 ${op} 引用的文章 #${l.article_id} 不存在`)
    }
    if (l.status === 'pending') {
      if (l.resolved_at != null) drift.push(`关联: 待确认 clip 链接 ${op} 却残留 resolved_at（pending 未生效）`)
    } else if (l.resolved_at == null) {
      drift.push(`关联: ${l.status} clip 链接 ${op} 缺少 resolved_at（终态必须记录解决时刻）`)
    }
    if (l.status === 'pending' || l.status === 'confirmed') {
      const key = String(l.source_identity_id)
      if (!liveClipByIdentity.has(key)) liveClipByIdentity.set(key, [])
      liveClipByIdentity.get(key).push(l)
    }
    // 重复剪藏不建重复文章 — the clip-derived identity converges on one owner.
    const identity = identitiesById.get(Number(l.source_identity_id))
    const article = articlesById.get(Number(l.article_id))
    if (identity && article) {
      const derivedDraft = `clip:${String(identity.identity_sha256)}`
      const derivedSlug = `clip-${String(identity.identity_sha256).slice(0, 12)}`
      if (String(article.draft_ref ?? '') !== derivedDraft) {
        drift.push(`关联: clip 链接 ${op} 的文章 #${l.article_id} draft_ref='${article.draft_ref}' != 派生的 '${derivedDraft}'（重复剪藏应收敛同一文章）`)
      }
      if (String(article.slug ?? '') !== derivedSlug) {
        drift.push(`关联: clip 链接 ${op} 的文章 #${l.article_id} slug='${article.slug}' != 派生的 '${derivedSlug}'`)
      }
    }
  }
  for (const [key, list] of liveClipByIdentity) {
    if (list.length > 1) {
      drift.push(`关联: 源稿身份 #${key} 存在 ${list.length} 条 live clip 链接（应至多一条，解除后无 live）`)
    }
  }

  /* ---- 3. 比较/确认刷新记录 (proposals + records) ----------------- */
  for (const p of rows.proposals) {
    const pop = String(p.operation_id)
    if (p.role !== 'clip') {
      drift.push(`刷新: 提案 ${pop} 的 role='${p.role}' 非 clip（来源网页不成为主要源稿）`)
    }
    if (!PROPOSAL_STATUSES.has(p.status)) {
      drift.push(`刷新: 提案 ${pop} 未知状态 '${p.status}'`)
    }
    if (!identityIds.has(Number(p.source_identity_id))) {
      drift.push(`刷新: 提案 ${pop} 引用不存在的源稿身份 #${p.source_identity_id}`)
    }
    if (!articleIds.has(Number(p.article_id))) {
      drift.push(`刷新: 提案 ${pop} 引用不存在的文章 #${p.article_id}`)
    }
    if (!(Number(p.proposed_version) > 0)) {
      drift.push(`刷新: 提案 ${pop} 缺少有效 proposed_version`)
    }
    if (!SHA64.test(String(p.snapshot_sha256 || ''))) {
      drift.push(`刷新: 提案 ${pop} snapshot_sha256 非法 (${String(p.snapshot_sha256).slice(0, 12)}…)`)
    }
    if (!String(p.source_title || '').trim()) {
      drift.push(`刷新: 提案 ${pop} 缺少来源标题`)
    }
    if (!validJson(p.diff_json) || !validJson(p.media_json)) {
      drift.push(`刷新: 提案 ${pop} 的 diff/media JSON 非法`)
      continue
    }
    const media = parseMediaFacts(p.media_json)
    const diff = parseDiff(p.diff_json)

    // 4. 来源快照 — re-derive the fingerprint from the frozen facts.
    const expectedFingerprint = snapshotFingerprint(String(p.source_title), String(p.source_markdown), media)
    if (SHA64.test(String(p.snapshot_sha256 || '')) && String(p.snapshot_sha256) !== expectedFingerprint) {
      drift.push(`刷新: 提案 ${pop} 来源快照指纹篡改 stored=${String(p.snapshot_sha256).slice(0, 12)}… expected=${expectedFingerprint.slice(0, 12)}…`)
    }
    if (diff && SHA64.test(String(diff.sourceSnapshotSha256 || '')) && String(diff.sourceSnapshotSha256) !== String(p.snapshot_sha256)) {
      drift.push(`刷新: 提案 ${pop} diff.sourceSnapshotSha256 != snapshot_sha256`)
    }
    if (diff) {
      const derived = Boolean(diff.titleChanged) || Boolean(diff.bodyChanged) || Boolean(diff.mediaChanged)
      if (Boolean(diff.changed) !== derived) {
        drift.push(`刷新: 提案 ${pop} diff.changed=${diff.changed} 与 title/body/media 变更不一致`)
      }
      if (p.status === 'no-diff' && diff.changed) {
        drift.push(`刷新: 提案 ${pop} 状态 no-diff 但 diff 标记有变更（无差异才可 no-diff）`)
      }
      if ((p.status === 'proposed' || p.status === 'confirmed') && !diff.changed) {
        drift.push(`刷新: 提案 ${pop} 状态 '${p.status}' 但 diff 无变更`)
      }
    } else {
      drift.push(`刷新: 提案 ${pop} diff_json 解析失败`)
    }
  }

  // Proposals that were confirmed must be backed by EXACTLY one refreshed
  // record; a no-diff / stale / cancelled proposal must never be applied.
  for (const p of rows.proposals) {
    const pop = String(p.operation_id)
    const recs = recordsByProposal.get(pop) ?? []
    const refreshed = recs.filter((r) => r.outcome === 'refreshed')
    if (p.status === 'confirmed') {
      if (refreshed.length !== 1) {
        drift.push(`刷新: 已确认提案 ${pop} 有 ${refreshed.length} 条 refreshed 记录（应恰好一条）`)
      }
    } else if (refreshed.length > 0) {
      drift.push(`刷新: ${p.status} 提案 ${pop} 却有 ${refreshed.length} 条 refreshed 记录（未可确认的提案不会被应用）`)
    }
    if (p.status === 'no-diff' && recs.length > 0) {
      drift.push(`刷新: no-diff 提案 ${pop} 不应存在任何刷新记录（无差异无可确认）`)
    }
  }

  for (const r of rows.records) {
    const op = String(r.operation_id)
    if (r.role !== 'clip') {
      drift.push(`刷新: 记录 ${op} 的 role='${r.role}' 非 clip`)
    }
    if (!RECORD_OUTCOMES.has(r.outcome)) {
      drift.push(`刷新: 记录 ${op} 未知 outcome '${r.outcome}'`)
    }
    if (!identityIds.has(Number(r.source_identity_id))) {
      drift.push(`刷新: 记录 ${op} 引用不存在的源稿身份 #${r.source_identity_id}`)
    }
    if (!articleIds.has(Number(r.article_id))) {
      drift.push(`刷新: 记录 ${op} 引用不存在的文章 #${r.article_id}`)
    }
    if (!(Number(r.expected_version) > 0)) {
      drift.push(`刷新: 记录 ${op} 缺少有效 expected_version`)
    }
    const proposal = proposalsByOp.get(String(r.proposal_operation_id))
    if (!proposal) {
      drift.push(`刷新: 记录 ${op} 引用不存在的提案 ${r.proposal_operation_id}`)
      continue
    }
    if (Number(proposal.source_identity_id) !== Number(r.source_identity_id) ||
        Number(proposal.article_id) !== Number(r.article_id)) {
      drift.push(`刷新: 记录 ${op} 的 identity/article 与其提案 ${r.proposal_operation_id} 不一致`)
    }
    if (Number(proposal.proposed_version) !== Number(r.expected_version)) {
      drift.push(`刷新: 记录 ${op} expected_version=${r.expected_version} != 提案 ${r.proposal_operation_id} proposed_version=${proposal.proposed_version}`)
    }
    if (r.outcome === 'refreshed') {
      if (proposal.status !== 'confirmed') {
        drift.push(`刷新: 已刷新记录 ${op} 的提案 ${r.proposal_operation_id} 状态为 '${proposal.status}'（应为 confirmed）`)
      }
      if (!(Number(r.applied_version) > 0)) {
        drift.push(`刷新: 已刷新记录 ${op} 缺少 applied_version`)
      }
      if (!SHA64.test(String(r.baseline_sha256 || ''))) {
        drift.push(`刷新: 已刷新记录 ${op} 缺少合法 baseline_sha256`)
      } else if (String(r.baseline_sha256) !== String(proposal.snapshot_sha256)) {
        drift.push(`刷新: 已刷新记录 ${op} baseline_sha256 != 提案 ${r.proposal_operation_id} snapshot_sha256`)
      }
      if (!validJson(r.projection_json) || !validJson(r.media_json) || !validJson(r.diff_json)) {
        drift.push(`刷新: 已刷新记录 ${op} 的 projection/media/diff JSON 非法`)
      }
      const formal = formalByArticle.has(Number(r.article_id))
      if (formal) {
        // 正式文章只形成修订 — the applied revision must exist and match.
        if (r.applied_revision_id == null || String(r.applied_revision_id) === '') {
          drift.push(`刷新: 正式文章 #${r.article_id} 的刷新记录 ${op} 缺少 applied_revision_id（正式只形成修订）`)
        } else {
          const rev = revisionsById.get(String(r.applied_revision_id))
          if (!rev) {
            drift.push(`刷新: 刷新记录 ${op} 引用不存在的修订 ${r.applied_revision_id}`)
          } else if (Number(rev.article_id) !== Number(r.article_id)) {
            drift.push(`刷新: 刷新记录 ${op} 的修订 ${r.applied_revision_id} 属于其他文章`)
          } else if (Number(rev.revision_number) !== Number(r.applied_version)) {
            drift.push(`刷新: 刷新记录 ${op} applied_version=${r.applied_version} != 修订 ${r.applied_revision_id} revision_number=${rev.revision_number}`)
          }
        }
      } else {
        // 草稿形成新版本 — the applied version must be a real next version.
        if (r.applied_revision_id != null) {
          drift.push(`刷新: 草稿文章 #${r.article_id} 的刷新记录 ${op} 不应携带 applied_revision_id`)
        }
        const versions = versionsByArticle.get(Number(r.article_id))
        const hasApplied = versions?.has(Number(r.applied_version)) ?? false
        if (!hasApplied) {
          drift.push(`刷新: 草稿文章 #${r.article_id} 刷新记录 ${op} applied_version=${r.applied_version} 无该版本事实`)
        } else if (Number(r.applied_version) !== Number(r.expected_version) + 1) {
          drift.push(`刷新: 草稿文章 #${r.article_id} 刷新记录 ${op} applied_version=${r.applied_version} != expected_version+1 (${Number(r.expected_version) + 1})`)
        }
      }
    } else if (r.outcome === 'failed') {
      // 媒体失败不得标完成 — a failed record never carries applied facts.
      if (String(r.reason || '').trim() === '') {
        drift.push(`刷新: 失败记录 ${op} 缺少 reason`)
      }
      if (r.applied_version != null || r.baseline_sha256 != null) {
        drift.push(`刷新: 失败记录 ${op} 却携带 applied_version/baseline（失败不完成, 不产生半记录）`)
      }
    }
  }

  /* ---- 5. 媒体身份复用 (content-identity media reuse) ------------- */
  for (const m of rows.mediaAssets) {
    const id = Number(m.id)
    if (!SHA64.test(String(m.content_sha256 || ''))) {
      drift.push(`媒体: 资源 #${id} 内容哈希非法`)
    }
    const expectedKey = `source-media/${String(m.content_sha256)}`
    if (String(m.r2_key || '') !== expectedKey) {
      drift.push(`媒体: 资源 #${id} r2_key '${String(m.r2_key).slice(0, 24)}…' != 内容身份键 '${expectedKey.slice(0, 24)}…'`)
    }
  }
  for (const map of rows.mappings) {
    const key = `${map.source_identity_id}:${map.source_ref}`
    if (!identityIds.has(Number(map.source_identity_id))) {
      drift.push(`媒体: 映射 ${key} 引用不存在的源稿身份 #${map.source_identity_id}`)
    }
    if (!assetsById.has(Number(map.media_asset_id))) {
      drift.push(`媒体: 映射 ${key} 引用不存在的媒体资源 #${map.media_asset_id}`)
    }
    if (!String(map.source_ref || '').trim()) {
      drift.push(`媒体: 映射 ${key} 缺少 source_ref`)
    }
  }
  // Every NON-removed media fact frozen in a proposal must be content-addressed
  // to a durable mapping with the EXACT content (不凭文件名推断).
  const factsSeen = new Set()
  for (const p of rows.proposals) {
    const media = parseMediaFacts(p.media_json)
    for (const fact of media) {
      if ((fact.status ?? '') === 'removed') continue
      const factKey = `${p.source_identity_id}:${fact.ref}`
      if (factsSeen.has(factKey)) continue
      factsSeen.add(factKey)
      const map = mappingsByKey.get(factKey)
      if (!map) {
        drift.push(`媒体: 提案 ${p.operation_id} 冻结媒体 ${fact.ref} 无持久映射（媒体按内容身份寻址）`)
        continue
      }
      const asset = assetsById.get(Number(map.media_asset_id))
      if (!asset) {
        drift.push(`媒体: 提案 ${p.operation_id} 媒体 ${fact.ref} 的映射指向不存在的资源`)
      } else if (String(asset.content_sha256) !== String(fact.contentSha256)) {
        drift.push(`媒体: 提案 ${p.operation_id} 媒体 ${fact.ref} 映射内容哈希 ${String(asset.content_sha256).slice(0, 12)}… != 冻结事实 ${String(fact.contentSha256).slice(0, 12)}…`)
      }
    }
  }
}

function renderReport({ args, drift, counts }) {
  const aligned = drift.length === 0
  const lines = []
  lines.push('# B7-G 批次 7 验收对账报告')
  lines.push('')
  lines.push(`- D1 模式: ${args.local ? 'local' : 'remote'} (persist-to: \`${args.persistTo}\`)`)
  if (args.candidate) lines.push(`- 候选绑定: \`${args.candidate}\``)
  lines.push(`- 事实表计数: 身份 ${counts.identities} · URL 变体 ${counts.variants} · 关联 ${counts.links} · ` +
    `提案 ${counts.proposals} · 刷新记录 ${counts.records} · 媒体 ${counts.mediaAssets} · ` +
    `媒体映射 ${counts.mappings} · 正式发布 ${counts.formals} · 版本 ${counts.versions} · 修订 ${counts.revisions}`)
  lines.push(`- 差异 drift: ${drift.length}`)
  lines.push(`- 结论: ${aligned ? 'ALIGNED（五面剪藏链事实完整，同一候选一致）' : 'DRIFT（存在事实缺失或篡改，阻断验收）'}`)
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
  lines.push('> 注：任何 身份 / 关联 / 比较确认刷新 / 来源快照 / 媒体身份复用 差异都会阻断批次 7 验收（接受标准）。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(args.report), { recursive: true })

  const [
    ledger, articles, identities, variants, links, proposals, records,
    mediaAssets, mappings, formals, versions, revisions,
  ] = d1ReadAll(args)

  const rows = {
    ledger, articles, identities, variants, links, proposals, records,
    mediaAssets, mappings, formals, versions, revisions,
  }
  const counts = {
    identities: identities.length,
    variants: variants.length,
    links: links.length,
    proposals: proposals.length,
    records: records.length,
    mediaAssets: mediaAssets.length,
    mappings: mappings.length,
    formals: formals.length,
    versions: versions.length,
    revisions: revisions.length,
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
    `reconcile-b7-facts: identities=${counts.identities} variants=${counts.variants} links=${counts.links} ` +
      `proposals=${counts.proposals} records=${counts.records} mediaAssets=${counts.mediaAssets} ` +
      `mappings=${counts.mappings} formals=${counts.formals} versions=${counts.versions} ` +
      `revisions=${counts.revisions} drift=${drift.length} verdict=${aligned ? 'ALIGNED' : 'DRIFT'} report=${args.report}`,
  )

  process.exit(aligned ? 0 : 1)
}

main().catch((error) => {
  console.error('reconcile-b7-facts failed:', error)
  process.exit(2)
})
