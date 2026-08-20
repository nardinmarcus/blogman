/**
 * B6-04 — 明确选边解决主要源稿内容冲突 shared types (issue #53).
 *
 * When BOTH sides deviate from the confirmed baseline — the primary source no
 * longer holds the baseline content AND Blogman has moved past the baseline
 * version — the conflict surface PAUSES every sync/write-back entry point and
 * shows the author a diff projection (title / body / media) of each side
 * against the baseline. The author then EXPLICITLY picks one side; the system
 * never auto-merges (允许手工复制但不建复杂合并器).
 *
 *  - 选源稿 (choose source): a restore point is saved first (恢复点), then the
 *    captured source projection is committed through the existing versioned
 *    write kernel with the expected-version precondition, so an old write can
 *    never overwrite newer Blogman content (冲突时旧写入不能覆盖新内容).
 *  - 选 Blogman (choose blogman): the choice is bound to the same operation id
 *    and routed through the B6-03 write-back lifecycle (intent → written →
 *    confirmed); the EXTERNAL confirmation is the only thing that advances the
 *    baseline (确认前不推进基线). A change on EITHER side after the choice
 *    expires it (任一方变化使旧选择过期); late confirmations are refused.
 *
 * The conflict is DERIVED from both sides' projections vs the baseline — never
 * stored as a hand-editable status label (不新增可手改权威状态标签). Formal
 * articles choosing the source only update the pending revision (正式文章选择
 * 源稿只更新待发布修订), never the live projection.
 */

import type { SourceIdentity } from '@/lib/source-identity'
import type { MediaSyncFact, MediaStore, SourceProvider } from '@/lib/source-sync'
import type { SourceWriteProvider, WriteBackIntent } from '@/lib/source-writeback'

/** The side an author explicitly chooses in a conflict. */
export type ConflictChosenSide = 'source' | 'blogman'

/** Durable lifecycle of one explicit resolution (idempotent by operation id). */
export type ConflictResolutionStatus = 'open' | 'applied' | 'expired'

/**
 * The four sync conclusions, in B6-05 wording. `unknown` is used when the
 * source cannot be reliably read, so a client never fabricates a conclusion.
 */
export type DerivedSyncState =
  | 'synced'
  | 'source-ahead'
  | 'blogman-ahead'
  | 'conflict'
  | 'unknown'

/** Baseline authority row the conflict is derived from. */
export interface ConflictBaseline {
  articleVersion: number
  /** Source content fingerprint the source held at the confirmed point. */
  sourceSha256: string
  title: string | null
  markdown: string | null
  html: string | null
  /** The referenced-media facts captured at the confirmed point. */
  media: MediaSyncFact[]
}

/** One source-side media reference compared against the baseline media set. */
export interface MediaItemDiff {
  ref: string
  change: 'added' | 'removed' | 'changed' | 'same'
  baselineSha256: string | null
  currentSha256: string | null
  /** The Blogman asset URL the current ref resolves to (null when removed). */
  assetUrl: string | null
}

/** One side's projection difference against the baseline. */
export interface SideProjectionDiff {
  title: { changed: boolean; baseline: string | null; current: string }
  /** Bounded word-token diff of the body against the baseline markdown. */
  body: BodyDiffToken[]
  bodyChanged: boolean
  media: MediaItemDiff[]
  mediaChanged: boolean
}

/** A bounded word-token diff token (mirrors the editor-workbench shape). */
export interface BodyDiffToken {
  type: 'same' | 'removed' | 'added'
  value: string
}

/** The full title/body/media diff projection — what the author sees to pick. */
export interface DiffProjection {
  source: SideProjectionDiff
  blogman: SideProjectionDiff
}

/** The source snapshot captured at probe/resolve time (used for diff + apply). */
export interface SourceView {
  title: string
  markdown: string
  /** Raw ref → Bytes content-sha256 pairs (source-side, before Blogman URLs). */
  media: MediaSyncFact[]
  /** The source-content fingerprint (source-only; no post metadata / renderer). */
  fingerprint: string
}

/** The Blogman side of the comparison. */
export interface BlogmanView {
  /** The live/blogman version token (version for drafts, revision number for formal). */
  version: number
  title: string
  /** The markdown body Blogman currently holds (raw markdown form). */
  body: string
  /** Content-addressed asset URLs referenced from the Blogman body. */
  mediaUrls: string[]
}

/** A probed (read-only) conflict derivation. */
export interface ConflictProbe {
  outcome: 'probed'
  articleId: number
  sourceIdentityId: number
  state: DerivedSyncState
  conflict: boolean
  sourceChanged: boolean
  blogmanChanged: boolean
  baseline: ConflictBaseline
  source: SourceView
  blogman: BlogmanView
  /** Title/body/media diff projection (always derived; shown on conflict). */
  diff: DiffProjection
}

export type ProbeConflictResult =
  | ConflictProbe
  | { outcome: 'unreadable'; reason: string; articleId: number; sourceUrl: string }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; reason: string; articleId: number }
  | { outcome: 'not-linked'; reason: string; articleId: number; sourceUrl: string }
  | { outcome: 'no-baseline'; reason: string; articleId: number; sourceIdentityId: number }

/** The explicit resolution command envelope. */
export interface ResolveConflictInput {
  sourceUrl: string
  articleId: number
  chosenSide: ConflictChosenSide
  /** The article version the author saw; re-verified before any write. */
  expectedVersion: number
  /** Idempotency key — replaying it returns the original resolution facts. */
  operationId: string
  actor: string
  /** Reads the source content + referenced media (mock in tests — 零生产). */
  provider: SourceProvider
  /** R2-isomorphic media sink — only used when choosing the source. */
  mediaStore: MediaStore
  /** External source writer — only used when choosing Blogman. */
  writeProvider: SourceWriteProvider
  /** Frozen epoch clock for deterministic timestamps. */
  now?: number
}

/** A durable explicit resolution (idempotent by operation id). */
export interface ConflictResolution {
  operationId: string
  sourceIdentityId: number
  articleId: number
  chosenSide: ConflictChosenSide
  baselineVersion: number
  baselineSha256: string
  /** The source fingerprint the author's choice was anchored to. */
  anchoredSourceSha256: string
  /** The Blogman version the author's choice was anchored to. */
  anchoredArticleVersion: number
  /** The captured source projection (title/markdown/html) chosen at resolve time. */
  sourceProjection: { title: string; markdown: string; html: string }
  /** The captured source media facts chosen at resolve time. */
  sourceMedia: MediaSyncFact[]
  /** Blogman's full editable snapshot before the resolution (the 恢复点). */
  preResolutionSnapshotJson: string
  /** The content pushed back to the source (blogman choice), for confirm. */
  writeBackContent: { title: string; body: string; html: string } | null
  status: ConflictResolutionStatus
  createdAt: number
  appliedAt: number | null
}

export type ResolveConflictResult =
  | {
      outcome: 'resolved-source'
      resolution: ConflictResolution
      articleId: number
      version: number
      revisionId: string | null
      restorePointId: string | null
      baselineSha256: string
      media: MediaSyncFact[]
    }
  | {
      outcome: 'intent'
      resolution: ConflictResolution
      intent: WriteBackIntent
      articleId: number
    }
  | {
      outcome: 'replayed'
      resolution: ConflictResolution
      existing: true
      articleId: number
    }
  | {
      outcome: 'media-failed'
      resolution: ConflictResolution
      articleId: number
      reason: string
      /** Media reconciled before the failure — stored facts stay reusable. */
      completed: MediaSyncFact[]
    }
  | {
      outcome: 'save-conflict'
      resolution: ConflictResolution
      articleId: number
      expectedVersion: number
      serverVersion: number
    }
  | {
      outcome: 'stale-choice'
      resolution: ConflictResolution
      reason: 'source-changed' | 'version-changed'
    }
  | { outcome: 'refused'; resolution: ConflictResolution; reason: string }
  | {
      outcome: 'not-conflict'
      articleId: number
      state: Exclude<DerivedSyncState, 'conflict' | 'unknown'>
      sourceChanged: boolean
      blogmanChanged: boolean
    }
  | { outcome: 'no-baseline'; reason: string; articleId: number; sourceIdentityId: number }
  | { outcome: 'link-not-confirmed'; articleId: number; sourceIdentityId: number; reason: string }
  | { outcome: 'version-moved'; articleId: number; expectedVersion: number; serverVersion: number }
  | { outcome: 'unreadable'; reason: string; articleId: number; sourceUrl: string }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; reason: string; articleId: number }
  | { outcome: 'not-linked'; reason: string; articleId: number; sourceUrl: string }

/** Execute the blogman write-back for a previously recorded resolution. */
export interface ExecuteConflictWriteBackInput {
  operationId: string
}

export type ExecuteConflictWriteBackResult =
  | { outcome: 'written'; resolution: ConflictResolution; intent: WriteBackIntent }
  | { outcome: 'replayed'; resolution: ConflictResolution; intent: WriteBackIntent; existing: true }
  | { outcome: 'stale'; resolution: ConflictResolution; reason: 'version-changed' | 'source-changed' }
  | { outcome: 'source-changed'; resolution: ConflictResolution }
  | { outcome: 'provider-error'; resolution: ConflictResolution; intent: WriteBackIntent }
  | { outcome: 'refused'; resolution: ConflictResolution; reason: string }
  | { outcome: 'not-found' }

/** Confirm the blogman write-back — the ONLY baseline-advancing step. */
export interface ConfirmConflictWriteBackInput {
  operationId: string
}

export type ConfirmConflictWriteBackResult =
  | { outcome: 'confirmed'; resolution: ConflictResolution; intent: WriteBackIntent }
  | { outcome: 'replayed'; resolution: ConflictResolution; intent: WriteBackIntent; existing: true }
  | { outcome: 'stale'; resolution: ConflictResolution; reason: 'version-changed' | 'source-changed' }
  | { outcome: 'refused'; resolution: ConflictResolution; reason: string }
  | { outcome: 'not-found' }

export type {
  MediaStore,
  MediaSyncFact,
  SourceIdentity,
  SourceProvider,
  SourceWriteProvider,
  WriteBackIntent,
}