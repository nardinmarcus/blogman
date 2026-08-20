/**
 * B6-06 — 安全解除并显式重新关联主要源稿 shared command types (issue #55).
 *
 * The author-facing lifecycle surface for an ESTABLISHED writable-primary-
 * source relationship (builds on the B6-01 identity/link tables and the B6-04
 * union baseline — this batch adds NO new tables):
 *
 *   - `unlinkSourceFromArticle` — 作者显式解除源稿关联. Transitions the live
 *     link (pending OR confirmed) to `cancelled`, PRESERVING every historical
 *     fact: the article, the source identity, and the baseline row are never
 *     deleted (保留历史事实, 不删身份/基线). While unlinked there is NO live link,
 *     so every write / sync / probe path is refused (`not-linked` /
 *     `link-not-confirmed`) and the sync conclusion is empty (解除后同步结论清空).
 *     Idempotent by `operationId` — the cancelled link row records the unlink
 *     operation, so replaying the same operation returns the original outcome
 *     with zero new rows.
 *   - `relinkSourceToArticle` — 作者显式重新关联. Re-establishes a NEW PENDING
 *     association by delegating to the B6-01 #50 identity chain
 *     (`linkSourceToArticle`): the normalized URL resolves to the SAME identity,
 *     and a fresh pending link is created (the old cancelled link stays as
 *     history). It does NOT auto-sync (重新关联不自动同步) and does NOT inherit
 *     the old baseline as the new sync authority — any comparison / re-baseline
 *     is an explicit follow-up (B6-04 probe + side choice, or a B6-02 sync).
 *     Refused with `already-linked` if a live link already exists for the pair
 *     (explicit: 必须先解除, never silently duplicates).
 *
 * The lifecycle is purely additive: no new table is created, nothing shipped
 * in earlier batches is altered, and nothing is ever dropped.
 */

import type { SourceIdentity, SourceLink } from '@/lib/source-identity'

/** Explicitly terminate the source↔article relationship (pending or confirmed). */
export interface UnlinkSourceInput {
  /** Stable idempotency key — replay returns the original cancellation. */
  operationId: string
  sourceUrl: string
  articleId: number
  /** Frozen epoch clock for deterministic timestamps. */
  now?: number
}

/** Explicitly re-associate a terminated source↔article relationship. */
export interface RelinkSourceInput {
  /** Stable idempotency key — replay returns the original pending link. */
  operationId: string
  sourceUrl: string
  articleId: number
  now?: number
}

/** Whether the source may currently WRITE (B6-03 requires a confirmed link). */
export type LiveWriteAccess =
  | { allowed: true; kind: 'confirmed-link' }
  | { allowed: false; reason: 'pending-link' }
  | { allowed: false; reason: 'unlinked' }
  | { allowed: false; reason: 'no-identity' }

export type UnlinkSourceResult =
  | {
      outcome: 'unlinked'
      /** The now-cancelled link (termination history — the row is preserved). */
      link: SourceLink
      sourceIdentity: SourceIdentity
      /** The durable baseline row was retained (never deleted), not its conclusion. */
      baselinePreserved: boolean
      /** The sync conclusion is always empty after unlink (解除后同步结论清空). */
      conclusion: null
    }
  /** Replaying the same operation id returns the original cancellation. */
  | { outcome: 'replayed'; link: SourceLink; sourceIdentity: SourceIdentity; baselinePreserved: boolean }
  /** No live link exists for the pair — nothing mutated (measurable refusal). */
  | { outcome: 'not-linked'; articleId: number; sourceUrl: string }
  | { outcome: 'invalid-source'; url: string }
  | { outcome: 'not-found'; reason: string; articleId: number }

export type RelinkSourceResult =
  | {
      outcome: 'relinked'
      /** The NEW pending link (via the #50 identity chain). */
      link: SourceLink
      sourceIdentity: SourceIdentity
      /** The terminated prior link, if any (history retained). */
      priorLink: SourceLink | null
      /** A relink never inherits the old baseline as the new sync authority. */
      baselineInherited: false
      /** Relink only creates a pending association — it never auto-syncs. */
      autoSynced: false
    }
  /** Replaying the same operation id returns the original pending link. */
  | { outcome: 'replayed'; link: SourceLink; sourceIdentity: SourceIdentity; existing: true }
  /** A live link already exists for the pair — 必须先解除, never silently duplicated. */
  | { outcome: 'already-linked'; link: SourceLink; sourceIdentity: SourceIdentity }
  /** The URL now lives on a DIFFERENT article — the author must pick ownership. */
  | { outcome: 'collision'; sourceIdentity: SourceIdentity; existingLink: SourceLink; articleId: number }
  | { outcome: 'invalid-source'; url: string }
  | { outcome: 'not-found'; reason: string; articleId: number }

/** One durable lifecycle row for a source↔article pair (read-only history). */
export interface RelationshipHistoryEntry {
  linkId: number
  status: SourceLink['status']
  operationId: string
  createdAt: number
  resolvedAt: number | null
}

/**
 * Read-only relationship state — the measurable answer to "is the old source
 * still able to update the article" (旧身份更新被拒绝且可度量). The B6-06 surface
 * never derives the four-way content state itself (that is B6-04's probe); it
 * reports the RELATIONSHIP-level facts and that the sync conclusion is empty /
 * not-yet-available.
 */
export interface SourceRelationState {
  sourceIdentity: SourceIdentity | null
  /** The live (pending/confirmed) link, or null once unlinked. */
  liveLink: SourceLink | null
  liveStatus: 'pending' | 'confirmed' | 'none'
  /** The retained durable baseline row (read-only; never auto-inherited). */
  baseline: { exists: boolean; sha256: string | null } | null
  /** Always null here — a concrete content conclusion requires a B6-04 probe. */
  syncConclusion: null
  conclusionReason: 'not-linked' | 'unlinked' | 'no-baseline' | 'baselined'
  writeAccess: LiveWriteAccess
  /** Full lifecycle history (pending/confirmed/cancelled rows) for the pair. */
  history: RelationshipHistoryEntry[]
}

export type { SourceIdentity, SourceLink }
