/**
 * B6-01 — 幂等建立主要源稿身份与待确认关联 command kernel (issue #50).
 *
 * Owns the writable-primary-source facts that B6-02/B6-03 will drive, WITHOUT
 * touching article content:
 *
 *   - `resolveSourceUrl`      — normalize → find-or-create the source identity
 *     (幂等识别: same URL → same identity; duplicate recording → zero new rows).
 *   - `linkSourceToArticle`   — create a PENDING association (not auto-
 *     effective). A URL already live-linked to ANOTHER article is refused as a
 *     collision (作者选归属 — never guessed). Replays by operation id are no-ops.
 *   - `confirmSourceLink` / `cancelSourceLink` — the pending-link state machine
 *     (pending → confirmed / pending → cancelled). Repeated transitions replay;
 *     transitions off a terminal state are refused. "写回失败" never leaves a
 *     hidden orphan: the pending link stays visible and confirmable/cancellable.
 *   - `mergeSourceVariant`    — explicit author merge of a semantic URL variant
 *     into an identity (不猜身份: variants are NEVER auto-merged).
 *
 * D1 unique constraints are the convergence backstop: `source_identities`
 * canonical_url / sha256 UNIQUE collapses concurrent identity inserts and
 * `article_source_links.operation_id` UNIQUE + the live-link partial unique
 * index collapse concurrent link inserts onto one row.
 */

import type { Database } from '@/lib/repositories/schema'
import { normalizeSourceUrl } from './url'
import type {
  AttachSourceInput,
  CancelLinkInput,
  CancelLinkResult,
  ConfirmLinkInput,
  ConfirmLinkResult,
  LinkResult,
  MergeVariantInput,
  MergeVariantResult,
  SourceFacts,
  SourceIdentity,
  SourceLink,
  SourceLinkRole,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

async function findIdentityById(db: Database, id: number): Promise<SourceIdentity | null> {
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

interface IdentityRow {
  id: number
  canonical_url: string
  identity_sha256: string
  created_at: number
}

async function identityByCanonical(db: Database, canonicalUrl: string): Promise<IdentityRow | null> {
  return db
    .prepare('SELECT id, canonical_url, identity_sha256, created_at FROM source_identities WHERE canonical_url = ?')
    .bind(canonicalUrl)
    .first<IdentityRow>()
}

async function identityBySha256(db: Database, sha256: string): Promise<IdentityRow | null> {
  return db
    .prepare('SELECT id, canonical_url, identity_sha256, created_at FROM source_identities WHERE identity_sha256 = ?')
    .bind(sha256)
    .first<IdentityRow>()
}

interface VariantRow {
  source_identity_id: number
}

async function variantTarget(db: Database, variantCanonicalUrl: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT source_identity_id FROM source_url_variants WHERE variant_canonical_url = ?')
    .bind(variantCanonicalUrl)
    .first<VariantRow>()
  return row?.source_identity_id ?? null
}

interface LinkRow {
  id: number
  source_identity_id: number
  article_id: number
  status: string
  role: string | null
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
    role: (row.role ?? 'primary') as SourceLinkRole,
    operationId: row.operation_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

async function linkByOperation(db: Database, operationId: string): Promise<SourceLink | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, article_id, status, role, operation_id, created_at, resolved_at
       FROM article_source_links WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<LinkRow>()
  return row ? mapLink(row) : null
}

async function liveLinkForIdentity(db: Database, sourceIdentityId: number): Promise<SourceLink | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, article_id, status, role, operation_id, created_at, resolved_at
       FROM article_source_links
       WHERE source_identity_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId)
    .first<LinkRow>()
  return row ? mapLink(row) : null
}

/** The live link for (identity, article), if any (pending or confirmed). */
async function liveLinkForPair(
  db: Database,
  sourceIdentityId: number,
  articleId: number,
): Promise<SourceLink | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, article_id, status, role, operation_id, created_at, resolved_at
       FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<LinkRow>()
  return row ? mapLink(row) : null
}

/* ------------------------------------------------------------------ */
/* resolveSourceUrl — 幂等规范化识别                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve a raw URL to its source identity, creating the identity row on first
 * sight. Variant merges are honored (explicit author decision wins over a
 * standalone identity). Same URL → same identity with `existing: true`.
 */
export async function resolveSourceUrl(
  db: Database,
  url: string,
): Promise<{ outcome: 'resolved'; identity: SourceIdentity } | InvalidSourceLike> {
  const normalized = normalizeSourceUrl(url)
  if (!normalized) return { outcome: 'invalid-source', url }

  // Explicit author variant mapping wins over a standalone identity.
  const variantTargetId = await variantTarget(db, normalized.canonicalUrl)
  if (variantTargetId !== null) {
    const identity = await findIdentityById(db, variantTargetId)
    if (!identity) return { outcome: 'invalid-source', url }
    return { outcome: 'resolved', identity }
  }

  let row = await identityByCanonical(db, normalized.canonicalUrl)
  let existing = true
  if (!row) {
    // Concurrent insert converges on the UNIQUE constraint — re-read on error.
    try {
      await db
        .prepare('INSERT INTO source_identities (canonical_url, identity_sha256, created_at) VALUES (?, ?, ?)')
        .bind(normalized.canonicalUrl, normalized.identitySha256, unixNow())
        .run()
    } catch {
      // duplicate from a concurrent identical recording — converge, don't fail
    }
    row = (await identityByCanonical(db, normalized.canonicalUrl)) ?? (await identityBySha256(db, normalized.identitySha256))
    existing = false
  }
  if (!row) return { outcome: 'invalid-source', url }

  return {
    outcome: 'resolved',
    identity: {
      id: row.id,
      canonicalUrl: row.canonical_url,
      identitySha256: row.identity_sha256,
      existing,
      createdAt: row.created_at,
    },
  }
}

type InvalidSourceLike = { outcome: 'invalid-source'; url: string }

/* ------------------------------------------------------------------ */
/* linkSourceToArticle — 建立待确认关联 (pending, not auto-effective)   */
/* ------------------------------------------------------------------ */

/**
 * Create a PENDING link from a source identity to an article. The link does
 * NOT take effect until confirmed (待确认关联). If the URL already has a live
 * link to a DIFFERENT article the association is refused as a `collision` —
 * the author must pick ownership; the system never guesses.
 */
export async function linkSourceToArticle(
  db: Database,
  input: AttachSourceInput,
): Promise<LinkResult> {
  const { operationId, url, articleId, role = 'primary' } = input
  if (!operationId || !url || !articleId) {
    return { outcome: 'invalid-source', url }
  }
  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return resolved

  const identity = resolved.identity

  // Idempotent replay by operation id → return original link, zero new rows.
  const byOp = await linkByOperation(db, operationId)
  if (byOp) return { outcome: 'replayed', link: byOp, existing: true }

  // Already live-linked to THIS article → converge (same source, zero side effects).
  const forPair = await liveLinkForPair(db, identity.id, articleId)
  if (forPair) return { outcome: 'replayed', link: forPair, existing: true }

  // Already live-linked to ANOTHER article → collision (作者选归属).
  const other = await liveLinkForIdentity(db, identity.id)
  if (other && other.articleId !== articleId) {
    return { outcome: 'collision', sourceIdentity: identity, existingLink: other }
  }

  try {
    await db
      .prepare(
        `INSERT INTO article_source_links
           (source_identity_id, article_id, status, role, operation_id, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(identity.id, articleId, role, operationId, unixNow())
      .run()
  } catch {
    // Concurrent identical registration converged on a UNIQUE constraint.
    const replayedOp = await linkByOperation(db, operationId)
    if (replayedOp) return { outcome: 'replayed', link: replayedOp, existing: true }
    const replayedPair = await liveLinkForPair(db, identity.id, articleId)
    if (replayedPair) return { outcome: 'replayed', link: replayedPair, existing: true }
    const raced = await liveLinkForIdentity(db, identity.id)
    if (raced && raced.articleId !== articleId) {
      return { outcome: 'collision', sourceIdentity: identity, existingLink: raced }
    }
    throw new Error(
      `linkSourceToArticle: unexpected insert failure for article ${articleId} operation '${operationId}'`,
    )
  }

  const link = await linkByOperation(db, operationId)
  if (!link) {
    throw new Error(`linkSourceToArticle: link for operation '${operationId}' not found after insert`)
  }
  return { outcome: 'applied', link, existing: false }
}

/** Surface articles + source facts after a create (replay keeps zero new rows). */
export async function sourceFactsFor(db: Database, url: string, articleId: number): Promise<SourceFacts | null> {
  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return null
  const link = await liveLinkForPair(db, resolved.identity.id, articleId)
  return { sourceIdentity: resolved.identity, link: link ?? null }
}

/** The single live link (pending/confirmed) for a normalized source URL, if owned. */
export async function liveLinkForUrl(db: Database, url: string): Promise<SourceLink | null> {
  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return null
  return liveLinkForIdentity(db, resolved.identity.id)
}

/* ------------------------------------------------------------------ */
/* confirmSourceLink / cancelSourceLink — pending-link state machine   */
/* ------------------------------------------------------------------ */

export async function confirmSourceLink(db: Database, input: ConfirmLinkInput): Promise<ConfirmLinkResult> {
  const { sourceIdentityId, articleId, operationId, expectedStatus } = input
  const link = await liveLinkForPair(db, sourceIdentityId, articleId)
  if (!link) return { outcome: 'not-found' }

  if (link.status === 'confirmed') {
    // A repeated confirm (any operation id) is a no-op: the outcome is reached.
    return { outcome: 'replayed', link, existing: true }
  }
  if (link.status === 'cancelled' || link.status !== expectedStatus) {
    return { outcome: 'transition-refused', link }
  }

  try {
    await db
      .prepare(
        `UPDATE article_source_links
           SET status = 'confirmed', resolved_at = ?, operation_id = ?
         WHERE id = ? AND status = ? AND operation_id = ?`,
      )
      .bind(unixNow(), operationId, link.id, 'pending', link.operationId)
      .run()
  } catch {
    const fresh = await liveLinkForPair(db, sourceIdentityId, articleId)
    if (!fresh) return { outcome: 'not-found' }
    if (fresh.status === 'confirmed') return { outcome: 'already-final', link: fresh }
    return { outcome: 'transition-refused', link: fresh }
  }

  const updated = await linkByOperation(db, operationId)
  if (!updated) {
    const fresh = await liveLinkForPair(db, sourceIdentityId, articleId)
    if (!fresh) return { outcome: 'not-found' }
    if (fresh.status === 'confirmed') return { outcome: 'already-final', link: fresh }
    return { outcome: 'transition-refused', link: fresh }
  }
  return { outcome: 'confirmed', link: updated }
}

export async function cancelSourceLink(db: Database, input: CancelLinkInput): Promise<CancelLinkResult> {
  const { sourceIdentityId, articleId, operationId, expectedStatus } = input
  const link = await liveLinkForPair(db, sourceIdentityId, articleId)
  if (!link) return { outcome: 'not-found' }

  if (link.status === 'cancelled') {
    return { outcome: 'replayed', link, existing: true }
  }
  if (link.status !== expectedStatus) {
    return { outcome: 'already-final', link }
  }

  try {
    await db
      .prepare(
        `UPDATE article_source_links
           SET status = 'cancelled', resolved_at = ?, operation_id = ?
         WHERE id = ? AND status = 'pending' AND operation_id = ?`,
      )
      .bind(unixNow(), operationId, link.id, link.operationId)
      .run()
  } catch {
    const fresh = await liveLinkForPair(db, sourceIdentityId, articleId)
    if (!fresh) return { outcome: 'not-found' }
    if (fresh.status === 'cancelled') return { outcome: 'replayed', link: fresh, existing: true }
    return { outcome: 'already-final', link: fresh }
  }

  const updated = await linkByOperation(db, operationId)
  if (!updated) return { outcome: 'not-found' }
  return { outcome: 'cancelled', link: updated }
}

/* ------------------------------------------------------------------ */
/* mergeSourceVariant — 显式合并 URL 变体 (不猜身份)                     */
/* ------------------------------------------------------------------ */

export async function mergeSourceVariant(db: Database, input: MergeVariantInput): Promise<MergeVariantResult> {
  const { operationId, variantUrl, targetIdentityId } = input
  if (!operationId || !variantUrl) return { outcome: 'target-not-found' }

  const identity = await findIdentityById(db, targetIdentityId)
  if (!identity) return { outcome: 'target-not-found' }

  // Idempotent by operation id.
  const replayed = await db
    .prepare('SELECT id FROM source_url_variants WHERE merged_by_operation_id = ?')
    .bind(operationId)
    .first<{ id: number }>()
  if (replayed) return { outcome: 'replayed', targetIdentityId }

  const normalized = normalizeSourceUrl(variantUrl)
  if (!normalized) return { outcome: 'invalid-source', url: variantUrl }

  // The variant is already the target's own canonical URL — nothing to record.
  if (normalized.canonicalUrl === identity.canonicalUrl || normalized.identitySha256 === identity.identitySha256) {
    return { outcome: 'unchanged', targetIdentityId }
  }

  // Already recorded as a variant of this target → no-op.
  const existingForTarget = await db
    .prepare(
      `SELECT id FROM source_url_variants
       WHERE source_identity_id = ? AND variant_canonical_url = ?`,
    )
    .bind(targetIdentityId, normalized.canonicalUrl)
    .first<{ id: number }>()
  if (existingForTarget) return { outcome: 'replayed', targetIdentityId }

  // Already a variant of a DIFFERENT identity → explicit conflict.
  const otherTarget = await variantTarget(db, normalized.canonicalUrl)
  if (otherTarget !== null && otherTarget !== targetIdentityId) {
    return { outcome: 'variant-conflict', targetIdentityId, variantCanonicalUrl: normalized.canonicalUrl }
  }

  try {
    await db
      .prepare(
        `INSERT INTO source_url_variants
           (source_identity_id, variant_canonical_url, merged_by_operation_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(targetIdentityId, normalized.canonicalUrl, operationId, unixNow())
      .run()
  } catch {
    const raced = await variantTarget(db, normalized.canonicalUrl)
    if (raced === targetIdentityId) return { outcome: 'replayed', targetIdentityId }
    if (raced !== null) {
      return { outcome: 'variant-conflict', targetIdentityId, variantCanonicalUrl: normalized.canonicalUrl }
    }
    throw new Error(`mergeSourceVariant: unexpected insert failure for operation '${operationId}'`)
  }

  return { outcome: 'merged', targetIdentityId, variantCanonicalUrl: normalized.canonicalUrl }
}
