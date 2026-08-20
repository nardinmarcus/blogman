/**
 * B6-03 — 显式写回 Blogman 领先内容到主要源稿: shared command types (issue #52).
 *
 * The author-initiated write-back surface. A write-back is bound once to the
 * article version + source identity + operation id; the synchronous-baseline
 * advances ONLY after an external confirmation. A lost response is answered by
 * re-reading the same operation id, and a stale baseline / version change is
 * rejected (never auto-overwritten).
 */

/** Lifecycle of one write-back intent. */
export type WriteBackStatus = 'intent' | 'written' | 'confirmed' | 'stale'

/** One `source_sync_baselines` row surface (the confirmed sync authority). */
export interface SourceSyncBaseline {
  id: number
  sourceIdentityId: number
  articleId: number
  /** Blogman article version the source was last confirmed in sync with. */
  articleVersion: number
  /** Source content hash the primary source held at that confirmed point. */
  sourceSyncSha256: string
  createdAt: number
  updatedAt: number
}

/** One `source_write_back_intents` row surface. */
export interface WriteBackIntent {
  id: number
  sourceIdentityId: number
  articleId: number
  /** Article version being written back (fixed at initiate time). */
  articleVersion: number
  /** Baseline version the intent was anchored to (detects version change). */
  baselineVersion: number
  /** Stable idempotency key — re-querying it returns the original outcome. */
  operationId: string
  status: WriteBackStatus
  externalRef: string | null
  /** Source content hash after the external push (becomes the new baseline on confirm). */
  sourceSyncSha256: string | null
  intentAt: number
  writtenAt: number | null
  confirmedAt: number | null
}

/**
 * The external primary-source adapter a write-back executes against. In
 * B6-03 it is always a mock (zero production); the boundary only ever moves
 * blogman-leading content to the source and reads the source's current hash.
 */
export interface SourceWriteProvider {
  /**
   * The source-side content hash the primary source currently holds for the
   * source URL. Throws when the source/device is unavailable.
   */
  readSourceHash(sourceUrl: string): Promise<string>
  /**
   * Push blogman-leading title/body to the primary source. Throws when the
   * source/device is unavailable. Returns the source content hash that the
   * source now holds plus a provider-side reference for later confirmation.
   */
  pushWriteBack(
    sourceUrl: string,
    content: { title: string; body: string },
  ): Promise<{ externalRef: string; sourceSyncSha256: string }>
}

/** Author explicitly initiates a write-back (source==baseline, blogman leading). */
export interface InitiateWriteBackInput {
  articleId: number
  sourceIdentityId: number
  /** Idempotency key — replays return the original intent. */
  operationId: string
}

export type InitiateWriteBackResult =
  | { outcome: 'intent'; intent: WriteBackIntent }
  | { outcome: 'replayed'; intent: WriteBackIntent; existing: true }
  | { outcome: 'no-baseline' }
  | { outcome: 'not-leading' }
  | { outcome: 'link-not-confirmed' }
  | { outcome: 'source-diverged' }
  | { outcome: 'source-unavailable' }
  | InvalidWriteBackSource

export interface ExecuteWriteBackInput {
  operationId: string
}

export type ExecuteWriteBackResult =
  | { outcome: 'written'; intent: WriteBackIntent }
  | { outcome: 'confirmed'; intent: WriteBackIntent }
  | { outcome: 'stale'; intent: WriteBackIntent }
  | { outcome: 'provider-error'; intent: WriteBackIntent }
  | { outcome: 'source-diverged'; intent: WriteBackIntent }
  | { outcome: 'not-found' }

export interface ConfirmWriteBackInput {
  operationId: string
}

export type ConfirmWriteBackResult =
  | { outcome: 'confirmed'; intent: WriteBackIntent }
  | { outcome: 'replayed'; intent: WriteBackIntent; existing: true }
  | { outcome: 'stale'; intent: WriteBackIntent }
  | { outcome: 'transition-refused'; intent: WriteBackIntent }
  | { outcome: 'not-found' }

export interface InvalidWriteBackSource {
  outcome: 'invalid-source'
  sourceIdentityId: number
}
