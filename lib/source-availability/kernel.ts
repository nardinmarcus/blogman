/**
 * B6-05 — 保留关系地报告主要源稿不可用 command kernel (issue #54).
 *
 * Owns the availability-observation side of the writable-primary-source facts,
 * WITHOUT touching article content, the source↔article link, or the baseline:
 *
 *   - `reportableFromProbe`      — pure: map a provider read outcome to the
 *     gated, reportable availability. readable → 'readable'; timeout /
 *     permission / network → 'temporarily-unavailable'; perma 404/410 →
 *     'confirmed-missing'. Never fabricates a status.
 *   - `gateSyncConclusion`       — pure: the four sync conclusions
 *     (synced / source-ahead / blogman-ahead / conflict) are exposed ONLY when
 *     the source is reliably readable; otherwise the gateway returns null and
 *     the operator sees 未知/不可确认, never a fake "synced".
 *   - `observeSourceAvailability`— durable, idempotent append of one provider
 *     read attempt. An observation NEVER mutates the link, the baseline, or
 *     any article.
 *   - `guardedAdvanceBaseline`   — advances the durable sync baseline ONLY
 *     after a reliable readable read AND an explicit author advance request.
 *     When the source is temporarily unavailable / confirmed missing /
 *     unknown the advance is REFUSED with zero baseline or version movement
 *     (不可用不推进版本或基线).
 *   - `confirmSourceMissing`     — durable, explicit confirmation that a
 *     source is definitively missing. It PRESERVES the article link and the
 *     relationship's media references — it never unlinks and never deletes
 *     media (确认缺失不删除关系媒体).
 *   - `reportSourceAvailability` — read-only surface. Availability observation
 *     and sync facts stay separate; when probing is disabled or the most recent
 *     read is too stale to be reliable, it reports `unknown` (不伪装已同步).
 *     Runtime is never authoritative — after recovery the report re-derives
 *     from the durable `source_baseline_facts` original baseline.
 *
 * All commands are idempotent by `operation_id`: replaying the same stable
 * operation returns the original outcome with zero new rows.
 */

import type { Database } from '@/lib/repositories/schema'
import { liveLinkForUrl, resolveSourceUrl } from '@/lib/source-identity'
import type { SourceLink } from '@/lib/source-identity'
import type {
  AvailabilityObservation,
  BaselineFact,
  PreservedMedia,
  ProbeReadOutcome,
  ReportableAvailability,
  SourceProbe,
  SourceReadAttempt,
  SyncComparison,
  SyncConclusion,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* Pure mapping — availability observation ≠ sync facts                */
/* ------------------------------------------------------------------ */

/** Map a provider read outcome to the gated reportable availability. */
export function reportableFromProbe(outcome: ProbeReadOutcome): ReportableAvailability {
  switch (outcome.outcome) {
    case 'readable':
      return { availability: 'readable' }
    case 'temporarily-unavailable':
      return { availability: 'temporarily-unavailable', reason: outcome.reason, status: outcome.status }
    case 'confirmed-missing':
      return { availability: 'confirmed-missing', status: outcome.status }
  }
}

/**
 * Gate the four sync conclusions on reliable readability. When the source
 * cannot be reliably read the gateway closes: the operator is never shown one
 * of the four conclusions (not even "synced") — 不可确认, never 伪装已同步.
 */
export function gateSyncConclusion(
  availability: ReportableAvailability,
  comparison: SyncComparison | null,
): SyncConclusion | null {
  if (availability.availability !== 'readable') return null
  return comparison?.sync ?? null
}

/** Is this reportable availability backed by a reliable readable read? */
export function isReliablyReadable(availability: ReportableAvailability): boolean {
  return availability.availability === 'readable'
}

/** Is this reportable availability backed by a probabilistic negative (not confirmed)? */
export function isTentativelyUnavailable(availability: ReportableAvailability): boolean {
  return availability.availability === 'temporarily-unavailable'
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

interface ObservationRow {
  id: number
  source_identity_id: number
  operation_id: string
  outcome: string
  detail: string | null
  observed_at: number
}

function mapObservation(row: ObservationRow): AvailabilityObservation {
  return {
    id: row.id,
    sourceIdentityId: row.source_identity_id,
    operationId: row.operation_id,
    outcome: row.outcome as AvailabilityObservation['outcome'],
    detail: row.detail,
    observedAt: row.observed_at,
  }
}

async function observationByOperation(db: Database, operationId: string): Promise<AvailabilityObservation | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, operation_id, outcome, detail, observed_at
       FROM source_availability_observations WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<ObservationRow>()
  return row ? mapObservation(row) : null
}

/** Most recent observation for an identity observed at-or-after `sinceSec`. */
async function latestObservation(db: Database, sourceIdentityId: number, sinceSec: number): Promise<AvailabilityObservation | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, operation_id, outcome, detail, observed_at
       FROM source_availability_observations
       WHERE source_identity_id = ? AND observed_at >= ?
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .bind(sourceIdentityId, sinceSec)
    .first<ObservationRow>()
  return row ? mapObservation(row) : null
}

interface BaselineRow {
  source_identity_id: number
  content_sha256: string
  advanced_by_operation_id: string
  advanced_at: number
}

function mapBaseline(row: BaselineRow): BaselineFact {
  return {
    sourceIdentityId: row.source_identity_id,
    contentSha256: row.content_sha256,
    advancedByOperationId: row.advanced_by_operation_id,
    advancedAt: row.advanced_at,
  }
}

/** The durable baseline fact for a source identity (read-only — preservation). */
export async function baselineForIdentity(db: Database, sourceIdentityId: number): Promise<BaselineFact | null> {
  const row = await db
    .prepare(
      `SELECT source_identity_id, content_sha256, advanced_by_operation_id, advanced_at
       FROM source_baseline_facts WHERE source_identity_id = ?`,
    )
    .bind(sourceIdentityId)
    .first<BaselineRow>()
  return row ? mapBaseline(row) : null
}

/* ------------------------------------------------------------------ */
/* observeSourceAvailability — durable availability observation fact   */
/* ------------------------------------------------------------------ */

export interface ObserveAvailabilityInput {
  operationId: string
  url: string
  probe: SourceProbe
  now?: number
}

export type ObserveAvailabilityResult =
  | {
      outcome: 'observed'
      sourceIdentityId: number
      canonicalUrl: string
      reported: ReportableAvailability
      observation: AvailabilityObservation
    }
  | {
      outcome: 'replayed'
      sourceIdentityId: number
      canonicalUrl: string
      reported: ReportableAvailability
      observation: AvailabilityObservation
    }
  | { outcome: 'invalid-source'; url: string }

/**
 * Run one provider read and durably append the availability observation.
 * Idempotent by `operationId`. An observation NEVER mutates the link, the
 * baseline, or any article — it is a fact about readability, nothing more.
 */
export async function observeSourceAvailability(
  db: Database,
  input: ObserveAvailabilityInput,
): Promise<ObserveAvailabilityResult> {
  const { operationId, url, probe, now = unixNow() } = input
  if (!operationId || !url) return { outcome: 'invalid-source', url }

  const replay = await observationByOperation(db, operationId)
  if (replay) {
    const reported = reportableFromProbe(replayProbeOutcome(replay))
    return {
      outcome: 'replayed',
      sourceIdentityId: replay.sourceIdentityId,
      canonicalUrl: url,
      reported,
      observation: replay,
    }
  }

  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return { outcome: 'invalid-source', url }
  const identity = resolved.identity

  const attempt: SourceReadAttempt = { sourceIdentityId: identity.id, canonicalUrl: identity.canonicalUrl }
  let probeOutcome: ProbeReadOutcome
  try {
    probeOutcome = await probe.readSource(attempt)
  } catch {
    probeOutcome = { outcome: 'temporarily-unavailable', reason: 'timeout' }
  }

  const reported = reportableFromProbe(probeOutcome)
  const detail = JSON.stringify(probeOutcome)

  try {
    await db
      .prepare(
        `INSERT INTO source_availability_observations
           (source_identity_id, operation_id, outcome, detail, observed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(identity.id, operationId, reported.availability, detail, now)
      .run()
  } catch {
    // Concurrent identical observation converged on the UNIQUE operation_id.
    const raced = await observationByOperation(db, operationId)
    if (raced) {
      return {
        outcome: 'replayed',
        sourceIdentityId: identity.id,
        canonicalUrl: identity.canonicalUrl,
        reported,
        observation: raced,
      }
    }
    throw new Error(`observeSourceAvailability: unexpected insert failure for '${operationId}'`)
  }

  const observation = await observationByOperation(db, operationId)
  if (!observation) throw new Error(`observeSourceAvailability: observation '${operationId}' not found`)
  return {
    outcome: 'observed',
    sourceIdentityId: identity.id,
    canonicalUrl: identity.canonicalUrl,
    reported,
    observation,
  }
}

/* ------------------------------------------------------------------ */
/* guardedAdvanceBaseline — 不可用不推进版本或基线                      */
/* ------------------------------------------------------------------ */

export interface AdvanceBaselineInput {
  operationId: string
  url: string
  /** sha256 of the source content the sync projection captured on a good read. */
  contentSha256: string
  probe: SourceProbe
  now?: number
}

export type AdvanceBaselineResult =
  | { outcome: 'advanced'; baseline: BaselineFact; reported: ReportableAvailability }
  | { outcome: 'replayed'; baseline: BaselineFact; reported: ReportableAvailability }
  | {
      outcome: 'refused-unavailable'
      url: string
      sourceIdentityId: number
      reported: ReportableAvailability
    }
  | { outcome: 'invalid-source'; url: string }
  | { outcome: 'invalid-hash'; url: string }

/**
 * Advance the durable sync baseline ONLY when the source is reliably readable
 * AND the author explicitly requests it. When the source is temporarily
 * unavailable, confirmed missing, or unknown the advance is REFUSED with zero
 * version/baseline movement (不可用不推进版本或基线). Advancing also records the
 * readable observation so a later report can derive from the original baseline.
 * Idempotent by `operationId` (replay returns the achieved baseline).
 */
export async function guardedAdvanceBaseline(
  db: Database,
  input: AdvanceBaselineInput,
): Promise<AdvanceBaselineResult> {
  const { operationId, url, contentSha256, probe, now = unixNow() } = input
  if (!operationId || !url) return { outcome: 'invalid-source', url }
  if (!/^[0-9a-f]{64}$/i.test(contentSha256)) return { outcome: 'invalid-hash', url }

  const replay = await baselineForIdentityByOperation(db, operationId)
  if (replay) return { outcome: 'replayed', baseline: replay, reported: { availability: 'readable' } }

  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return { outcome: 'invalid-source', url }
  const identity = resolved.identity

  // Reliability gate FIRST: an advance requires a readable read now.
  let probeOutcome: ProbeReadOutcome
  try {
    probeOutcome = await probe.readSource({ sourceIdentityId: identity.id, canonicalUrl: identity.canonicalUrl })
  } catch {
    probeOutcome = { outcome: 'temporarily-unavailable', reason: 'timeout' }
  }
  const reported = reportableFromProbe(probeOutcome)

  if (!isReliablyReadable(reported)) {
    // Record the (non-readable) observation as a fact, then refuse with no movement.
    await recordObservation(db, identity.id, `${operationId}:obs`, reported, now)
    return {
      outcome: 'refused-unavailable',
      url,
      sourceIdentityId: identity.id,
      reported,
    }
  }

  // Readable → the author's explicit advance may move the baseline.
  await recordObservation(db, identity.id, `${operationId}:obs`, { availability: 'readable' }, now)
  try {
    await db
      .prepare(
        `INSERT INTO source_baseline_facts
           (source_identity_id, content_sha256, advanced_by_operation_id, advanced_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_identity_id) DO UPDATE SET
           content_sha256 = excluded.content_sha256,
           advanced_by_operation_id = excluded.advanced_by_operation_id,
           advanced_at = excluded.advanced_at`,
      )
      .bind(identity.id, contentSha256, operationId, now)
      .run()
  } catch {
    const raced = await baselineForIdentityByOperation(db, operationId)
    if (raced) return { outcome: 'replayed', baseline: raced, reported }
    throw new Error(`guardedAdvanceBaseline: unexpected upsert failure for '${operationId}'`)
  }

  const baseline = await baselineForIdentity(db, identity.id)
  if (!baseline) throw new Error(`guardedAdvanceBaseline: baseline for identity ${identity.id} not found`)
  return { outcome: 'advanced', baseline, reported }
}

/** Idempotent replay probe for an advance: baseline already achieved by op id. */
async function baselineForIdentityByOperation(db: Database, operationId: string): Promise<BaselineFact | null> {
  const row = await db
    .prepare(
      `SELECT source_identity_id, content_sha256, advanced_by_operation_id, advanced_at
       FROM source_baseline_facts WHERE advanced_by_operation_id = ?`,
    )
    .bind(operationId)
    .first<BaselineRow>()
  return row ? mapBaseline(row) : null
}

async function recordObservation(
  db: Database,
  sourceIdentityId: number,
  operationId: string,
  reported: ReportableAvailability,
  now: number,
): Promise<void> {
  const outcome =
    reported.availability === 'confirmed-missing' || reported.availability === 'temporarily-unavailable'
      ? reported.availability
      : 'readable'
  const detail = JSON.stringify(reported)
  try {
    await db
      .prepare(
        `INSERT INTO source_availability_observations
           (source_identity_id, operation_id, outcome, detail, observed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(sourceIdentityId, operationId, outcome, detail, now)
      .run()
  } catch {
    // concurrent/duplicate — idempotent no-op
  }
}

/* ------------------------------------------------------------------ */
/* confirmSourceMissing — 确认缺失不删除关系媒体                        */
/* ------------------------------------------------------------------ */

export interface ConfirmMissingInput {
  operationId: string
  url: string
  /** The relationship's media references to preserve (never deleted). */
  mediaRefs: readonly string[]
  status?: number
  now?: number
}

export type ConfirmMissingResult =
  | {
      outcome: 'confirmed-missing'
      sourceIdentityId: number
      canonicalUrl: string
      /** The preserved relationship link — read back, never unlinked. */
      link: SourceLink | null
      /** Media refs preserved identically — nothing deleted. */
      preservedMedia: PreservedMedia
      reported: ReportableAvailability
    }
  | { outcome: 'replayed'; sourceIdentityId: number; canonicalUrl: string; preservedMedia: PreservedMedia }
  | { outcome: 'invalid-source'; url: string }

/**
 * Explicitly confirm a source is definitively missing. Records a durable
 * confirmed-missing observation and returns the preserved article link and the
 * relationship's media references unchanged — it never unlinks (不自动解绑) and
 * never deletes media (确认缺失不删除关系媒体). Idempotent by `operationId`.
 */
export async function confirmSourceMissing(
  db: Database,
  input: ConfirmMissingInput,
): Promise<ConfirmMissingResult> {
  const { operationId, url, mediaRefs = [], status = 404, now = unixNow() } = input
  if (!operationId || !url) return { outcome: 'invalid-source', url }

  const replay = await observationByOperation(db, operationId)
  if (replay) {
    return {
      outcome: 'replayed',
      sourceIdentityId: replay.sourceIdentityId,
      canonicalUrl: url,
      preservedMedia: { refs: mediaRefs },
    }
  }

  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return { outcome: 'invalid-source', url }
  const identity = resolved.identity

  const reported: ReportableAvailability = { availability: 'confirmed-missing', status }
  await recordObservation(db, identity.id, operationId, reported, now)

  // Preserve the live relationship link (read-only; nothing deleted).
  const link = await liveLinkForUrl(db, identity.canonicalUrl)

  return {
    outcome: 'confirmed-missing',
    sourceIdentityId: identity.id,
    canonicalUrl: identity.canonicalUrl,
    link,
    preservedMedia: { refs: [...mediaRefs] },
    reported,
  }
}

/* ------------------------------------------------------------------ */
/* reportSourceAvailability — 可用性观察与同步事实分离                   */
/* ------------------------------------------------------------------ */

export interface ReportInput {
  url: string
  /** Absent → probing disabled → report unknown/unprobed (不伪装已同步). */
  probe?: SourceProbe
  /** Four-state comparison facts offered by the sync layer (B6-02/03). */
  comparison?: SyncComparison | null
  /** Wall-clock in MILLISECONDS (default Date.now()). */
  now?: number
  /** Readability window; a readable read older than this is too stale. */
  maxAgeMs?: number
}

export interface SourceAvailabilityReport {
  sourceIdentityId: number
  canonicalUrl: string
  reported: ReportableAvailability
  /** The four sync conclusions — present ONLY on a reliable readable read. */
  syncConclusion: SyncConclusion | null
  /** Preserved relationship link (read-only, never auto-unlinked). */
  link: SourceLink | null
  /** Preserved durable baseline (read-only; recovery re-derives from this). */
  baseline: BaselineFact | null
}

/**
 * Produce a read-only, gated availability report for a source identity.
 *
 * Availability observation and sync facts stay separate. When probing is
 * disabled the report is `unknown`/unprobed and never claims "synced". When
 * the most recent observation is older than `maxAgeMs` and a probe is present
 * it re-reads the source; without a probe a stale read stays `unknown`
 * (runtime is never authoritative). After recovery the report re-derives from
 * the durable `source_baseline_facts` original baseline.
 */
export async function reportSourceAvailability(
  db: Database,
  input: ReportInput,
): Promise<SourceAvailabilityReport | { outcome: 'invalid-source'; url: string }> {
  const { url, probe, comparison = null, now = Date.now(), maxAgeMs = 5 * 60 * 1000 } = input

  const resolved = await resolveSourceUrl(db, url)
  if (resolved.outcome !== 'resolved') return { outcome: 'invalid-source', url }
  const identity = resolved.identity

  const link = await liveLinkForUrl(db, identity.canonicalUrl)
  const baseline = await baselineForIdentity(db, identity.id)

  if (!probe) {
    // Probing disabled → 显示未知/不可确认，不伪装已同步.
    const reported: ReportableAvailability = { availability: 'unknown', reason: 'unprobed' }
    return {
      sourceIdentityId: identity.id,
      canonicalUrl: identity.canonicalUrl,
      reported,
      syncConclusion: gateSyncConclusion(reported, comparison),
      link,
      baseline,
    }
  }

  // Only an observation inside the freshness window is reliable enough to surface.
  const sinceSec = Math.floor((now - maxAgeMs) / 1000)
  const fresh = await latestObservation(db, identity.id, sinceSec)

  let reported: ReportableAvailability
  if (fresh) {
    reported = reportableFromProbe(observationToProbeOutcome(fresh))
  } else {
    // Nothing reliable in the window → attempt a fresh read now.
    let probeOutcome: ProbeReadOutcome
    try {
      probeOutcome = await probe.readSource({ sourceIdentityId: identity.id, canonicalUrl: identity.canonicalUrl })
    } catch {
      probeOutcome = { outcome: 'temporarily-unavailable', reason: 'timeout' }
    }
    reported = reportableFromProbe(probeOutcome)
  }

  return {
    sourceIdentityId: identity.id,
    canonicalUrl: identity.canonicalUrl,
    reported,
    syncConclusion: gateSyncConclusion(reported, comparison),
    link,
    baseline,
  }
}

function observationToProbeOutcome(obs: AvailabilityObservation): ProbeReadOutcome {
  // Prefer the faithful stored detail; fall back to the coarse outcome column.
  if (obs.detail) {
    try {
      const parsed = JSON.parse(obs.detail) as ProbeReadOutcome
      if (parsed && typeof parsed.outcome === 'string') return parsed
    } catch {
      // ignore malformed detail and fall through
    }
  }
  switch (obs.outcome) {
    case 'readable':
      return { outcome: 'readable' }
    case 'confirmed-missing':
      return { outcome: 'confirmed-missing', status: 404 }
    default:
      return { outcome: 'temporarily-unavailable', reason: 'timeout' }
  }
}

/** Reconstruct the original provider outcome from a stored observation. */
function replayProbeOutcome(obs: AvailabilityObservation): ProbeReadOutcome {
  return observationToProbeOutcome(obs)
}
