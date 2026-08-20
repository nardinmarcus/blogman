/**
 * B6-02 — 源稿领先内容安全写入 Blogman shared types (issue #51).
 *
 * The sync surface pulls a source-ahead primary source INTO Blogman: the
 * normalized title, the Markdown body, and every referenced media item. It is
 * the mirror of B6-03 (which writes Blogman-ahead content back out); both drive
 * the same B6-01 writable-primary-source identity.
 *
 * The command is DEFENSIVE by construction — 全部成功才推进基线:
 *
 *   - every referenced media item is collected (provider mock in tests, real
 *     source in a later batch) and persisted with a PATH-AGNOSTIC content
 *     identity (`media_assets.content_sha256`), so content is reused across
 *     article paths WITHOUT ever inferring reuse from a filename (既有 R2 仅在
 *     内容身份可验证时复用, 不凭文件名推断),
 *   - the synced body is committed through the existing versioned write kernel
 *     (`article-commands.save`), so a draft writes a NEW version and a formal
 *     article routes to its UNIQUE active revision (正式文章线上版本保持, 变化只
 *     进修订) — with the same expected-version precondition + operation-id
 *     idempotency,
 *   - the sync projection/baseline only advances when EVERY media item AND the
 *     final save succeed; ANY media/save failure returns without advancing the
 *     baseline and without touching the article body (任一媒体/保存失败不产生
 *     半同步). Media facts already stored stay durable and reusable (不丢事实).
 */

import type { SourceIdentity } from '@/lib/source-identity'

/** One media item referenced from the source Markdown body. */
export interface SourceMediaRef {
  /** The source-side reference token found in the Markdown (e.g. `assets/hero.png`). */
  ref: string
  contentType: string
  filename: string
}

/** The full source-ahead snapshot a provider hands the sync. */
export interface SourceContent {
  title: string
  markdown: string
  media: SourceMediaRef[]
}

/** Raw bytes of one referenced media item (fetched lazily by ref). */
export interface SourceMediaBytes {
  bytes: ArrayBuffer
  contentType: string
}

/**
 * The writable-primary-source adapter. THIS BATCH SHIPS THE MOCK ONLY — zero
 * production wiring (零生产). In tests a `MockSourceProvider` injects canned
 * content / media and injectable failures; a real source reader is deferred to
 * a later batch.
 */
export interface SourceProvider {
  readonly kind: string
  /** Read the source's current normalized-title + Markdown body + referenced media set. */
  readSource(options: { sourceUrl: string }): Promise<SourceContent>
  /** Fetch the raw bytes of one referenced media item (throws on failure). */
  readMediaBytes(ref: string): Promise<SourceMediaBytes>
}

/**
 * The durable media sink (R2 in production, in-memory mock in tests). Media is
 * keyed by its content identity, so the same bytes never land twice and reuse
 * is verifiable, never filename-guessed.
 */
export interface MediaStore {
  readonly kind: string
  /** Persist one deduplicated media asset (throws on failure). */
  put(opts: {
    r2Key: string
    bytes: ArrayBuffer
    contentType: string
    filename: string
  }): Promise<void>
}

export interface SyncSourceInput {
  /** The writable-primary-source URL — identity resolved via the B6-01 surface. */
  sourceUrl: string
  articleId: number
  /** The Blogman version the sync anchors on (draft version / formal base version). */
  expectedVersion: number
  /** Idempotency key — replaying the same operation returns the original facts. */
  operationId: string
  provider: SourceProvider
  mediaStore: MediaStore
  /** Frozen epoch clock for deterministic timestamps. */
  now?: number
}

/** One reconciled media item (dedup by content identity). */
export interface MediaSyncFact {
  ref: string
  contentSha256: string
  r2Key: string
  assetUrl: string
  /** True when the content already existed and was reused, not re-stored. */
  reused: boolean
}

/** The synced source projection (normalized title + rewritten Markdown + rendered HTML). */
export interface SourceProjection {
  title: string
  markdown: string
  html: string
}

/** The facts carried by a successful (`synced`) or replayed (`replayed`) sync. */
export interface SyncSourceSyncedFacts {
  articleId: number
  postRef: number
  /** The Blogman version / revision number the sync landed on. */
  version: number
  /** For a formal article: the unique active revision id; null for a draft. */
  revisionId: string | null
  operationId: string
  /** The advanced baseline fingerprint (source-content-only; no post metadata / renderer). */
  baselineSha256: string
  projection: SourceProjection
  media: MediaSyncFact[]
}

export type SyncSourceResult =
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; reason: string; articleId: number }
  | { outcome: 'not-linked'; reason: string; articleId: number; sourceUrl: string }
  | {
      outcome: 'media-failed'
      reason: string
      articleId: number
      sourceUrl: string
      operationId: string
      /** Media reconciled before the failure — stored facts stay reusable (不丢事实). */
      completed: MediaSyncFact[]
    }
  | {
      outcome: 'save-conflict'
      reason: string
      articleId: number
      expectedVersion: number
      serverVersion: number
      operationId: string
    }
  | ({ outcome: 'synced'; existing: false } & SyncSourceSyncedFacts)
  | ({ outcome: 'replayed'; existing: true } & SyncSourceSyncedFacts)

export type { SourceIdentity }
