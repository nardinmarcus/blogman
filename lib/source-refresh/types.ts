/**
 * B7-02 — 比较后显式刷新来源网页 shared types (issue #58).
 *
 * The compare-then-confirm refresh loop for a CLIP (reference) source page:
 *
 *   1. 提出 (propose) — fetch the source through the injected provider (mock in
 *      tests, 零生产), reconcile media by content identity, compute the diff
 *      against the CURRENT article (标题/正文/媒体) and FREEZE it into a
 *      persistable proposal BOUND to the article's current version
 *      (`proposed_version`). Nothing is written to the article.
 *   2. 确认 (confirm) — ONLY after the author explicitly confirms does the
 *      apply path commit through the versioned write kernel
 *      (`article-commands.save`) with that bound version as the expected
 *      version + a confirm operation id (幂等). A DRAFT writes a NEW version
 *      (草稿形成新版本); a FORMAL article routes to its UNIQUE active revision
 *      (正式文章只形成修订, 线上版本保持).
 *
 * The command NEVER promotes the clip source to `primary` (来源网页不取得持续
 * 写作权威): the role stays `clip`, the link is never auto-confirmed, and the
 * B6 primary-source baseline/chain is never advanced by a refresh.
 *
 * Idempotency contract:
 *   - propose replay by `proposalOperationId` → original snapshot, zero rows,
 *   - confirm replay by `operationId` → original refresh record, zero writes,
 *   - 版本变化要求重新比较: confirm refuses a proposal whose bound version no
 *     longer matches the article's current version (or the caller's expected
 *     version) → the author must re-propose,
 *   - 媒体失败不得标完成: any media/provider failure in propose OR confirm
 *     returns non-complete and never writes the article version.
 */

import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import type { MediaStore, SourceProvider } from '@/lib/source-sync'

/** One media item's diff status, content-identity based (不凭文件名推断). */
export type RefreshMediaStatus = 'added' | 'changed' | 'unchanged' | 'removed'

/** One media item in the diff. */
export interface RefreshMediaDiff {
  ref: string
  contentType: string
  filename: string
  contentSha256: string
  assetUrl: string
  /** True when the content already existed and was reused (content identity), not re-stored. */
  reused: boolean
  status: RefreshMediaStatus
}

/** The full 标题/正文/媒体 diff of a proposal vs the current article. */
export interface RefreshDiff {
  titleChanged: boolean
  currentTitle: string
  sourceTitle: string
  bodyChanged: boolean
  currentContent: string
  sourceMarkdown: string
  mediaChanged: boolean
  media: RefreshMediaDiff[]
  /** True when ANY of title/body/media changed. */
  changed: boolean
  /** sha256 of the frozen source snapshot (title+markdown+media facts). */
  sourceSnapshotSha256: string
}

/** The frozen source snapshot a proposal carries. */
export interface SourceRefreshProjection {
  title: string
  markdown: string
  html: string
  snapshotSha256: string
}

/** The durable solved-facts surface of a proposed (or replayed) refresh. */
export interface ProposedRefreshFacts {
  articleId: number
  postRef: number
  proposalOperationId: string
  /** The article version the proposal is BOUND to (must match at confirm). */
  proposedVersion: number
  diff: RefreshDiff
  projection: SourceRefreshProjection
  /** Media facts reconciled during propose (content-identity dedup). */
  media: RefreshMediaDiff[]
}

export interface ProposeRefreshInput {
  /** The clip (reference) source URL — identity resolved via the B6-01 surface. */
  sourceUrl: string
  articleId: number
  /** Idempotency key for the propose — replay returns the original proposal. */
  operationId: string
  provider: SourceProvider
  mediaStore: MediaStore
  now?: number
}

export type ProposeRefreshResult =
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; reason: string; articleId: number }
  | {
      outcome: 'not-linked'
      reason: string
      articleId: number
      sourceUrl: string
    }
  | {
      outcome: 'media-failed'
      reason: string
      articleId: number
      sourceUrl: string
      operationId: string
      /** Media reconciled before the failure — durable facts stay reusable (不丢事实). */
      completed: RefreshMediaDiff[]
    }
  | {
      outcome: 'no-diff'
      existing: boolean
      articleId: number
      postRef: number
      proposalOperationId: string
      proposedVersion: number
      diff: RefreshDiff
      projection: SourceRefreshProjection
      media: RefreshMediaDiff[]
    }
  | ({ outcome: 'proposed'; existing: false } & ProposedRefreshFacts)
  | ({ outcome: 'replayed'; existing: true } & ProposedRefreshFacts)

export interface ConfirmRefreshInput {
  /** The clip (reference) source URL. */
  sourceUrl: string
  articleId: number
  /** Which proposal (its propose operation id) the author confirms. */
  proposalOperationId: string
  /**
   * The version the refresh applies on. MUST equal the proposal's bound
   * version AND the article's current version — otherwise stale → 重新比较.
   */
  expectedVersion: number
  /** Idempotency key for the confirm — replay returns the original record. */
  operationId: string
  provider: SourceProvider
  mediaStore: MediaStore
  now?: number
}

/** The durable solved-facts surface of a completed (or replayed) refresh. */
export interface RefreshFacts {
  articleId: number
  postRef: number
  proposalOperationId: string
  /** The Blogman version / revision number the refresh landed on. */
  version: number
  /** For a formal article: the unique active revision id; null for a draft. */
  revisionId: string | null
  operationId: string
  /** Fingerprint of the frozen source snapshot. */
  snapshotSha256: string
  diff: RefreshDiff
  projection: SourceRefreshProjection
  media: RefreshMediaDiff[]
}

export type ConfirmRefreshResult =
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; reason: string; articleId: number }
  | {
      outcome: 'not-linked'
      reason: string
      articleId: number
      sourceUrl: string
    }
  | {
      outcome: 'proposal-missing'
      reason: string
      articleId: number
      proposalOperationId: string
    }
  | {
      outcome: 'stale'
      reason: string
      articleId: number
      proposalOperationId: string
      proposedVersion: number
      currentVersion: number
    }
  | {
      outcome: 'no-diff'
      reason: string
      articleId: number
      proposalOperationId: string
    }
  | {
      outcome: 'media-failed'
      reason: string
      articleId: number
      sourceUrl: string
      operationId: string
      proposalOperationId: string
      completed: RefreshMediaDiff[]
    }
  | {
      outcome: 'save-conflict'
      reason: string
      articleId: number
      expectedVersion: number
      serverVersion: number
      operationId: string
      proposalOperationId: string
    }
  | ({ outcome: 'refreshed'; existing: false } & RefreshFacts)
  | ({ outcome: 'replayed'; existing: true } & RefreshFacts)

export type { ArticleCommandSnapshot }
