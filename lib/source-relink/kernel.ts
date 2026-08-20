/**
 * B6-06 — 安全解除并显式重新关联主要源稿 command kernel (issue #55).
 *
 * Owns the author-facing TERMINATION / RE-ASSOCIATION lifecycle of an
 * established writable-primary-source relationship, WITHOUT touching article
 * content, media, versions, or the identity row (零生产, purely additive):
 *
 *   - `unlinkSourceFromArticle` — 解除源稿关联 (保留历史事实, 不删身份/基线):
 *     the live link (pending OR confirmed) is transitioned to `cancelled` and
 *     the durable `source_sync_baselines` row is PRESERVED (never deleted).
 *     While unlinked the pair has NO live link, so every write / sync / probe
 *     path is refused (`not-linked` / `link-not-confirmed`) and the sync
 *     conclusion is empty (解除后同步结论清空). Idempotent by `operationId`:
 *     the cancelled link row records the unlink operation, so replaying the
 *     same operation returns the original cancellation with zero new rows, and
 *     a later different operation over an already-cancelled pair is a
 *     no-op `not-linked` refusal.
 *   - `relinkSourceToArticle` — 重新关联 via the B6-01 #50 identity chain
 *     (`linkSourceToArticle`): the normalized URL resolves to the SAME
 *     identity and a fresh PENDING link is created; the old cancelled link
 *     remains as termination history. It does NOT auto-sync (重新关联不自动同步)
 *     and does NOT inherit the old baseline as the new sync authority (新关系不沿
 *     用旧基线) — a comparison / re-baseline is an explicit follow-up. Refused
 *     `already-linked` when a live link already exists for the pair, and
 *     surfaced `collision` when the URL now owns a different article.
 *   - `sourceRelationState` — read-only, measurable: whether the old source
 *     can still update the article (write access), the retained identity /
 *     baseline, and the full lifecycle history. The sync conclusion is null
 *     (empty) at the relationship level.
 */

import type { Database } from '@/lib/repositories/schema'
import { linkSourceToArticle, resolveSourceUrl } from '@/lib/source-identity'
import type { SourceIdentity, SourceLink } from '@/lib/source-identity'
import type {
  LiveWriteAccess,
  RelinkSourceInput,
  RelinkSourceResult,
  RelationshipHistoryEntry,
  SourceRelationState,
  UnlinkSourceInput,
  UnlinkSourceResult,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface LinkRow {
  id: number
  source_identity_id: number
  article_id: number
  status: string
  operation_id: string
  created_at: number
  resolved_at: number | null
}

function mapLink(row: LinkRow): SourceLink {
  return {
    id: row.id,
    sourceIdentityId: row.source_identity_id,
    articleId: row.article_id,
    status: row.status as SourceLink['status'],
    operationId: row.operation_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

const LINK_COLUMNS = `id, source_identity_id, article_id, status, operation_id, created_at, resolved_at`

async function findArticle(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db.prepare('SELECT id, post_ref FROM articles WHERE id = ?').bind(articleId).first<ArticleRow>()
}

async function identityById(db: Database, id: number): Promise<SourceIdentity | null> {
  const row = await db
    .prepare('SELECT id, canonical_url, identity_sha256, created_at FROM source_identities WHERE id = ?')
    .bind(id)
    .first<{ id: number; canonical_url: string; identity_sha256: string; created_at: number }>()
  if (!row) return null
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    identitySha256: row.identity_sha256,
    existing: true,
    createdAt: row.created_at,
  }
}

/** The link whose `operation_id` equals this value (idempotency backstop). */
async function linkByOperation(db: Database, operationId: string): Promise<SourceLink | null> {
  const row = await db
    .prepare(`SELECT ${LINK_COLUMNS} FROM article_source_links WHERE operation_id = ?`)
    .bind(operationId)
    .first<LinkRow>()
  return row ? mapLink(row) : null
}

/** The live (pending/confirmed) link for an identity↔article pair. */
async function liveLinkForPair(db: Database, sourceIdentityId: number, articleId: number): Promise<SourceLink | null> {
  const row = await db
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<LinkRow>()
  return row ? mapLink(row) : null
}

/** Every lifecycle row for the pair, oldest first (termination history). */
async function linkHistoryForPair(db: Database, sourceIdentityId: number, articleId: number): Promise<RelationshipHistoryEntry[]> {
  const rows = await db
    .prepare(
      `SELECT id, status, operation_id, created_at, resolved_at
       FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ?
       ORDER BY id ASC`,
    )
    .bind(sourceIdentityId, articleId)
    .all<{ id: number; status: string; operation_id: string; created_at: number; resolved_at: number | null }>()
  return (rows.results ?? []).map((r) => ({
    linkId: r.id,
    status: r.status as RelationshipHistoryEntry['status'],
    operationId: r.operation_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }))
}

/** The most recent cancelled link for the pair (the terminated prior relationship). */
async function lastCancelledForPair(db: Database, sourceIdentityId: number, articleId: number): Promise<SourceLink | null> {
  const row = await db
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status = 'cancelled'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<LinkRow>()
  return row ? mapLink(row) : null
}

interface BaselineRow {
  baseline_sha256: string | null
}

/** The retained durable baseline for the pair (read-only; never deleted). */
async function baselineForPair(db: Database, sourceIdentityId: number, articleId: number): Promise<{ exists: boolean; sha256: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT baseline_sha256 FROM source_sync_baselines
       WHERE source_identity_id = ? AND article_id = ? LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<BaselineRow>()
  if (!row) return null
  return { exists: true, sha256: row.baseline_sha256 }
}

/* ------------------------------------------------------------------ */
/* unlinkSourceFromArticle — 作者显式解除关联 (保留历史事实)             */
/* ------------------------------------------------------------------ */

/**
 * Explicitly terminate the source↔article association. The live link (pending
 * OR confirmed) is cancelled — the row is PRESERVED as termination history.
 * The article, the source identity, and the durable baseline row are never
 * deleted. While unlinked the pair has no live link, so every write / sync /
 * probe path is refused and the sync conclusion is empty. Idempotent by
 * `operationId` (replay returns the original cancellation; a different
 * operation over an already-cancelled pair is a no-op `not-linked` refusal).
 */
export async function unlinkSourceFromArticle(
  db: Database,
  input: UnlinkSourceInput,
): Promise<UnlinkSourceResult> {
  const { operationId, sourceUrl, articleId, now = unixNow() } = input
  if (!operationId || operationId.trim() === '' || !sourceUrl || !articleId) {
    return { outcome: 'invalid-source', url: sourceUrl }
  }

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }

  // Idempotent replay: the same unlink operation already cancelled this link.
  const byOp = await linkByOperation(db, operationId)
  if (byOp && byOp.status === 'cancelled') {
    const identity = await identityById(db, byOp.sourceIdentityId)
    const baselinePreserved = (await baselineForPair(db, byOp.sourceIdentityId, byOp.articleId))?.exists ?? false
    if (!identity) return { outcome: 'not-found', reason: `source identity ${byOp.sourceIdentityId} not found`, articleId }
    return { outcome: 'replayed', link: byOp, sourceIdentity: identity, baselinePreserved }
  }

  const resolved = await resolveSourceUrl(db, sourceUrl)
  if (resolved.outcome !== 'resolved') return { outcome: 'invalid-source', url: sourceUrl }
  const identity = resolved.identity

  const link = await liveLinkForPair(db, identity.id, articleId)
  if (!link) {
    // No live link → measurable `not-linked` refusal; nothing mutated. The
    // identity (same URL → same id) and any history are preserved intact.
    return { outcome: 'not-linked', articleId, sourceUrl }
  }

  // Transition the live (pending|confirmed) link to cancelled, recording the
  // unlink operation id on the row (the B6-01 idempotency convention).
  try {
    await db
      .prepare(
        `UPDATE article_source_links
           SET status = 'cancelled', resolved_at = ?, operation_id = ?
         WHERE id = ? AND status != 'cancelled'`,
      )
      .bind(now, operationId, link.id)
      .run()
  } catch {
    const fresh = await liveLinkForPair(db, identity.id, articleId)
    if (fresh) return { outcome: 'not-linked', articleId, sourceUrl }
    const raced = await linkByOperation(db, operationId)
    if (raced && raced.status === 'cancelled') {
      return { outcome: 'replayed', link: raced, sourceIdentity: identity, baselinePreserved: (await baselineForPair(db, identity.id, articleId))?.exists ?? false }
    }
    return { outcome: 'not-linked', articleId, sourceUrl }
  }

  const updated = await linkByOperation(db, operationId)
  if (!updated || updated.status !== 'cancelled') {
    return { outcome: 'not-linked', articleId, sourceUrl }
  }
  return {
    outcome: 'unlinked',
    link: updated,
    sourceIdentity: identity,
    baselinePreserved: (await baselineForPair(db, identity.id, articleId))?.exists ?? false,
    conclusion: null,
  }
}

/* ------------------------------------------------------------------ */
/* relinkSourceToArticle — 重新关联 via the #50 identity chain         */
/* ------------------------------------------------------------------ */

/**
 * Explicitly re-associate a terminated source↔article relationship. Delegates
 * to the B6-01 #50 identity chain (`linkSourceToArticle`) so the normalized
 * URL resolves to the SAME identity and a fresh PENDING link is created; the
 * terminated prior link stays as history. A relink never auto-syncs and never
 * inherits the old baseline — any comparison / re-baseline is an explicit
 * follow-up. Refused `already-linked` when a live link already exists, and
 * surfaced `collision` when the URL owns a different article. Idempotent by
 * `operationId` (replay returns the original pending link).
 */
export async function relinkSourceToArticle(
  db: Database,
  input: RelinkSourceInput,
): Promise<RelinkSourceResult> {
  const { operationId, sourceUrl, articleId } = input
  if (!operationId || operationId.trim() === '' || !sourceUrl || !articleId) {
    return { outcome: 'invalid-source', url: sourceUrl }
  }

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }

  const resolved = await resolveSourceUrl(db, sourceUrl)
  if (resolved.outcome !== 'resolved') return { outcome: 'invalid-source', url: sourceUrl }
  const identity = resolved.identity

  // Idempotent replay: the same relink operation already created this pending link.
  const byOp = await linkByOperation(db, operationId)
  if (byOp) return { outcome: 'replayed', link: byOp, sourceIdentity: identity, existing: true }

  // Explicit: a live link already exists for the pair → 必须先解除.
  const forPair = await liveLinkForPair(db, identity.id, articleId)
  if (forPair) return { outcome: 'already-linked', link: forPair, sourceIdentity: identity }

  // 走 #50 身份链 — the B6-01 link command (pending, not auto-effective).
  const linked = await linkSourceToArticle(db, { operationId, url: sourceUrl, articleId })
  if (linked.outcome === 'invalid-source') return { outcome: 'invalid-source', url: sourceUrl }
  if (linked.outcome === 'collision') {
    return { outcome: 'collision', sourceIdentity: linked.sourceIdentity, existingLink: linked.existingLink, articleId }
  }
  if (linked.outcome === 'replayed') {
    return { outcome: 'replayed', link: linked.link, sourceIdentity: identity, existing: true }
  }
  if (linked.outcome !== 'applied') return { outcome: 'not-found', reason: 'relink: unexpected link outcome', articleId }

  const priorLink = await lastCancelledForPair(db, identity.id, articleId)
  return {
    outcome: 'relinked',
    link: linked.link,
    sourceIdentity: identity,
    priorLink,
    baselineInherited: false,
    autoSynced: false,
  }
}

/* ------------------------------------------------------------------ */
/* sourceRelationState — 只读, 可度量                                    */
/* ------------------------------------------------------------------ */

/**
 * Read-only relationship state: measurable answer to "can the old source still
 * update the article". The retained identity resolves for the same URL, the
 * baseline row is preserved, the live link + full lifecycle history are
 * surfaced, and the relationship-level sync conclusion is null (empty). The
 * concrete four-way content state is B6-04's probe, not derived here.
 */
export async function sourceRelationState(
  db: Database,
  input: { sourceUrl: string; articleId: number },
): Promise<SourceRelationState> {
  const { sourceUrl, articleId } = input
  const resolved = await resolveSourceUrl(db, sourceUrl)
  if (resolved.outcome !== 'resolved') {
    return {
      sourceIdentity: null,
      liveLink: null,
      liveStatus: 'none',
      baseline: null,
      syncConclusion: null,
      conclusionReason: 'not-linked',
      writeAccess: { allowed: false, reason: 'no-identity' },
      history: [],
    }
  }
  const identity = resolved.identity
  const liveLink = await liveLinkForPair(db, identity.id, articleId)
  const history = await linkHistoryForPair(db, identity.id, articleId)
  const baseline = await baselineForPair(db, identity.id, articleId)

  const liveStatus: SourceRelationState['liveStatus'] = liveLink
    ? liveLink.status === 'confirmed'
      ? 'confirmed'
      : 'pending'
    : 'none'

  let writeAccess: LiveWriteAccess
  if (!liveLink) writeAccess = { allowed: false, reason: 'unlinked' }
  else if (liveLink.status === 'confirmed') writeAccess = { allowed: true, kind: 'confirmed-link' }
  else writeAccess = { allowed: false, reason: 'pending-link' }

  const conclusionReason: SourceRelationState['conclusionReason'] = !liveLink
    ? history.length > 0
      ? 'unlinked'
      : 'not-linked'
    : baseline?.exists
      ? 'baselined'
      : 'no-baseline'

  return {
    sourceIdentity: identity,
    liveLink,
    liveStatus,
    baseline,
    syncConclusion: null,
    conclusionReason,
    writeAccess,
    history,
  }
}
