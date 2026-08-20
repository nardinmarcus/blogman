/**
 * B6-05 — 保留关系地报告主要源稿不可用 (issue #54).
 *
 * The availability-observation command surface for a writable primary source.
 * Availability observation is kept STRICTLY SEPARATE from sync facts
 * (可用性观察与同步事实分离): a probe read attempt becomes a durable
 * `source_availability_observations` row, while the sync projection lives in
 * `source_baseline_facts`. Every report preserves the source identity, the
 * article relationship and the baseline — unavailability never unlinks,
 * never edits an article, never deletes relationship media and never advances
 * the version/baseline, and it never blocks publishing.
 *
 * The four sync conclusions (四种同步结论 — synced / source-ahead /
 * blogman-ahead / conflict) are surfaced ONLY when the source is reliably
 * readable. When it cannot be reliably read — temporarily unavailable,
 * confirmed missing, probing disabled, or too stale — the report shows
 * `unknown` / 不可确认 and never masquerades as synced. The runtime reading is
 * never authoritative; after recovery the report re-derives from the durable
 * baseline facts, not from a cache.
 */

/** One controllable source-provider read attempt. */
export interface SourceReadAttempt {
  sourceIdentityId: number
  canonicalUrl: string
}

/** A single provider read outcome returned to the kernel. */
export type ProbeReadOutcome =
  | { outcome: 'readable' }
  | {
      outcome: 'temporarily-unavailable'
      /** Timeout / permission — the source still exists but can't be read now. */
      reason: 'timeout' | 'permission' | 'network'
      status?: number
    }
  /** Definitive missing — a perma 404 / 410, NOT an ambiguous failure. */
  | { outcome: 'confirmed-missing'; status: number }

/** Real adapter over the actual primary source; tests substitute a mock. */
export interface SourceProbe {
  readSource(attempt: SourceReadAttempt): Promise<ProbeReadOutcome>
}

/**
 * The four sync conclusions (四种同步结论). These are the ONLY sync statuses
 * an operator may be shown, and each is gated behind a reliable readable read.
 */
export type SyncConclusion = 'synced' | 'source-ahead' | 'blogman-ahead' | 'conflict'

/** Comparison facts the B6-02/B6-03 sync layer feeds into the report. */
export interface SyncComparison {
  /** Which side has diverged from the baseline (if any). */
  sync: SyncConclusion
}

/** Coarse availability surfaced to the operator. */
export type Availability =
  | 'readable'
  | 'temporarily-unavailable'
  | 'confirmed-missing'
  | 'unknown'

export type AvailabilityReason =
  | 'timeout'
  | 'permission'
  | 'network'
  | 'unprobed'
  | 'stale'
  | 'no-reliable-read'

/** The gated, reportable result of an availability observation. */
export type ReportableAvailability =
  | { availability: 'readable' }
  | {
      availability: 'temporarily-unavailable'
      reason: 'timeout' | 'permission' | 'network'
      status?: number
    }
  | { availability: 'confirmed-missing'; status: number }
  | { availability: 'unknown'; reason: 'unprobed' | 'stale' | 'no-reliable-read' }

/** One durable `source_availability_observations` row surface. */
export interface AvailabilityObservation {
  id: number
  sourceIdentityId: number
  operationId: string
  outcome: 'readable' | 'temporarily-unavailable' | 'confirmed-missing'
  detail: string | null
  observedAt: number
}

/** The durable sync-projection baseline fact (never advanced on unavailability). */
export interface BaselineFact {
  sourceIdentityId: number
  contentSha256: string
  advancedByOperationId: string
  advancedAt: number
}

/** A relationship's preserved media references — read back, never deleted. */
export interface PreservedMedia {
  /** Remote/asset references kept intact by an unavailability report. */
  refs: readonly string[]
}
