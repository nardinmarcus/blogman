/**
 * B2-G — producer/authority rollout control switch (issue #32).
 *
 * The atomic flip that makes version facts authoritative and demotes `posts`
 * to a read-compatible projection.
 *
 * Two independent rollout controls live in the `rollout_controls` ledger table
 * (created by ledger migrations 006/007; this module re-creates them idempotently
 * through the B2-01b DDL channel so the 001..007 canonical freeze stays intact):
 *
 *   - `producer`: the legacy direct-`posts` write producer / "new-write entry".
 *     When DISABLED the versionless write entry is closed — no new rows or
 *     unversioned updates may land on `posts` outside the kernel.
 *   - `authority`: version facts authority. When ENABLED every writer must go
 *     through the version kernel; `posts` is only a read compatibility
 *     projection.
 *
 * Effective state = desired_enabled AND NOT emergency-disabled. Emergency
 * switches are read from the environment (`BLOGMAN_DISABLE_PRODUCER` /
 * `BLOGMAN_DISABLE_AUTHORITY`, values `1`/`true` disable) so an operator can
 * halt a control without touching persisted rows — mirroring
 * `scripts/rollout-safety.mjs`.
 *
 * `switchAuthority` performs the atomic producer/authority flip in ONE D1 batch
 * (both upserts + the immutable audit events move together or not at all) and
 * is idempotent by `operation_id`, so the operator may retry safely. This module
 * never touches production and writes no data on its own — it only reads state
 * and exposes the switch primitives the routes + fixtures drive.
 */

import { createHash } from 'node:crypto'
import type { Database } from '@/lib/repositories/schema'

/** Ledger table names written by this module. */
export const PRODUCER_CONTROL = 'producer' as const
export const AUTHORITY_CONTROL = 'authority' as const

export type RolloutEvidenceState = 'verified' | 'invalid' | 'unavailable'

/** Effective (desired ∧ not-emergency-disabled) rollout state. */
export interface RolloutState {
  /** Legacy direct-`posts` write producer. */
  producer: boolean
  /** Version-facts authority. */
  authority: boolean
}

/** A single persisted/read control row. */
export interface RolloutControlRow {
  control_key: string
  control_kind: string
  desired_enabled: number
  candidate_id: string
  evidence_sha256: string
  evidence_state: string
  actor: string
  reason: string
}

export interface RolloutSwitchRequest {
  /** Desired `producer` enabled state (false = close the legacy new-write entry). */
  producer: boolean
  /** Desired `authority` enabled state (true = version facts authoritative). */
  authority: boolean
  /** Versioned candidate that the operator's reconciliation evidence refers to. */
  candidateId: string
  /** sha256 of the reconciliation/production evidence that gates this switch. */
  evidenceSha256: string
  /** Evidence verification state recorded in the audit trail. */
  evidenceState?: RolloutEvidenceState
  /** Idempotency key — retries replay the original outcome, never double-switch. */
  operationId: string
  /** Operator / automation actor id. */
  actor: string
  /** Human- or machine-readable reason for the switch. */
  reason: string
}

export type RolloutSwitchResult =
  | {
      outcome: 'switched'
      producer: boolean
      authority: boolean
      operationId: string
    }
  | {
      outcome: 'replayed'
      producer: boolean
      authority: boolean
      operationId: string
    }

/* ------------------------------------------------------------------ */
/* Idempotent DDL (B2-01b channel — NOT a ledger migration).           */
/* ------------------------------------------------------------------ */

/**
 * The two rollout tables, mirrored verbatim from ledger migrations 006/007 so
 * a clean-start or ledger-only DB can host the switch without growing the
 * frozen 001..007 canonical set. idempotent: missing tables are created once.
 */
export const ROLLOUT_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS rollout_controls (
    control_key TEXT PRIMARY KEY,
    control_kind TEXT NOT NULL CHECK(control_kind IN ('producer', 'authority', 'executor')),
    desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN (0, 1)),
    candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0),
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    evidence_state TEXT NOT NULL CHECK(evidence_state IN ('verified', 'invalid', 'unavailable')),
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    reason TEXT NOT NULL CHECK(length(reason) > 0),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK(
      (control_kind = 'producer' AND control_key = 'producer')
      OR (control_kind = 'authority' AND control_key = 'authority')
      OR (
        control_kind = 'executor'
        AND control_key GLOB 'executor:[a-z0-9_-]*'
        AND length(control_key) > length('executor:')
      )
    )
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS rollout_control_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
    control_key TEXT NOT NULL,
    control_kind TEXT NOT NULL CHECK(control_kind IN ('producer', 'authority', 'executor')),
    previous_enabled INTEGER CHECK(previous_enabled IS NULL OR previous_enabled IN (0, 1)),
    desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN (0, 1)),
    candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0),
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    evidence_state TEXT NOT NULL CHECK(evidence_state IN ('verified', 'invalid', 'unavailable')),
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    reason TEXT NOT NULL CHECK(length(reason) > 0),
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`,
]

/** Idempotently create the rollout tables if absent. Never drops or alters. */
export async function ensureRolloutTables(db: Database): Promise<void> {
  for (const statement of ROLLOUT_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}

/* ------------------------------------------------------------------ */
/* Read state                                                          */
/* ------------------------------------------------------------------ */

/** Emergency env override value → disabled boolean. Empty/0/false = enabled. */
function emergencyDisabled(envName: string, env: Record<string, string | undefined>): boolean {
  const value = env[envName]
  if (value === undefined || value === '' || value === '0' || value === 'false') return false
  return true // '1' / 'true' → disabled
}

/** Read the two effective rollout controls, honoring emergency env switches. */
export async function readRolloutState(
  db: Database,
  env: Record<string, string | undefined> = process.env,
): Promise<RolloutState> {
  let rows: RolloutControlRow[] = []
  try {
    const { results } = await db
      .prepare(`SELECT control_key, control_kind, desired_enabled, candidate_id, evidence_sha256, evidence_state, actor, reason
                FROM rollout_controls
                WHERE control_key IN ('producer', 'authority')`)
      .all<RolloutControlRow>()
    rows = results ?? []
  } catch {
    rows = []
  }
  const map = new Map<string, number>()
  for (const row of rows) map.set(row.control_key, row.desired_enabled)

  // Pre-switch default: until a row is explicitly flipped, producer stays open
  // (legacy compatibility preserved) and authority stays off. Explicit rows
  // override: producer desired=0 closes the legacy new-write entry; authority
  // desired=1 makes version facts authoritative.
  const enabled = (key: 'producer' | 'authority', envName: string, explicit: boolean, explicitEnabled: boolean): boolean => {
    const desired = explicit ? explicitEnabled : key === 'producer'
    return desired && !emergencyDisabled(envName, env)
  }

  return {
    producer: enabled('producer', 'BLOGMAN_DISABLE_PRODUCER', map.has('producer'), map.get('producer') === 1),
    authority: enabled('authority', 'BLOGMAN_DISABLE_AUTHORITY', map.has('authority'), map.get('authority') === 1),
  }
}

/** True when the legacy new-write (production) entry is open. */
export async function isProducerEnabled(db: Database): Promise<boolean> {
  return (await readRolloutState(db)).producer
}

/** True when version facts are authoritative and versionless writes are rejected. */
export async function isAuthorityEnabled(db: Database): Promise<boolean> {
  return (await readRolloutState(db)).authority
}

/* ------------------------------------------------------------------ */
/* Atomic switch                                                       */
/* ------------------------------------------------------------------ */

/** Canonical sha256 for an evidence string (used to build the audit digest). */
export function evidenceDigest(evidence: string): string {
  return createHash('sha256').update(evidence, 'utf8').digest('hex')
}

interface ControlPrevious {
  [key: string]: number | null
}

/**
 * Atomically flip the producer/authority controls and record the immutable
 * audit events — one D1 batch, so the whole switch moves together.
 *
 * Idempotent by `operationId`: a retry with the same key replays the original
 * outcome (no re-write, no duplicate event). Reads the previous enabled state
 * for the audit trail, then upserts both controls and inserts both events.
 */
export async function switchAuthority(
  db: Database,
  request: RolloutSwitchRequest,
): Promise<RolloutSwitchResult> {
  const { producer, authority, candidateId, evidenceSha256, evidenceState = 'verified', operationId, actor, reason } = request
  if (!operationId || operationId.trim() === '') throw new Error('switchAuthority: operationId is required')
  if (!actor || actor.trim() === '') throw new Error('switchAuthority: actor is required')
  if (!reason || reason.trim() === '') throw new Error('switchAuthority: reason is required')
  if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) {
    throw new Error('switchAuthority: evidenceSha256 must be a 64-char hex digest')
  }

  // Idempotent replay: same operation id already switched.
  const existing = await db
    .prepare('SELECT control_key FROM rollout_control_events WHERE operation_id = ?')
    .bind(`${operationId}:producer`)
    .first<{ control_key: string }>()
  if (existing) {
    return { outcome: 'replayed', producer, authority, operationId }
  }

  // Capture previous enabled for the audit trail.
  const prevRows = await db
    .prepare(`SELECT control_key, desired_enabled FROM rollout_controls
              WHERE control_key IN ('producer', 'authority')`)
    .all<{ control_key: string; desired_enabled: number }>()
  const previous: ControlPrevious = {}
  for (const row of prevRows.results ?? []) previous[row.control_key] = row.desired_enabled

  const controls: Array<{ key: 'producer' | 'authority'; kind: string; desired: number }> = [
    { key: 'producer', kind: 'producer', desired: producer ? 1 : 0 },
    { key: 'authority', kind: 'authority', desired: authority ? 1 : 0 },
  ]

  const batch: D1PreparedStatement[] = []
  for (const control of controls) {
    batch.push(
      db
        .prepare(
          `INSERT INTO rollout_controls
             (control_key, control_kind, desired_enabled, candidate_id, evidence_sha256, evidence_state, actor, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(control_key) DO UPDATE SET
             control_kind = excluded.control_kind,
             desired_enabled = excluded.desired_enabled,
             candidate_id = excluded.candidate_id,
             evidence_sha256 = excluded.evidence_sha256,
             evidence_state = excluded.evidence_state,
             actor = excluded.actor,
             reason = excluded.reason,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .bind(control.key, control.kind, control.desired, candidateId, evidenceSha256, evidenceState, actor, reason),
    )
    batch.push(
      db
        .prepare(
          `INSERT INTO rollout_control_events
             (operation_id, control_key, control_kind, previous_enabled, desired_enabled, candidate_id, evidence_sha256, evidence_state, actor, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${operationId}:${control.key}`,
          control.key,
          control.kind,
          previous[control.key] ?? null,
          control.desired,
          candidateId,
          evidenceSha256,
          evidenceState,
          actor,
          reason,
        ),
    )
  }

  try {
    await db.batch(batch)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    // Atomic abort (e.g. a concurrent identical switch beat us to the events).
    const raced = await db
      .prepare('SELECT control_key FROM rollout_control_events WHERE operation_id = ?')
      .bind(`${operationId}:producer`)
      .first<{ control_key: string }>()
    if (raced) {
      return { outcome: 'replayed', producer, authority, operationId }
    }
    throw new Error(`switchAuthority: batch failure (${raw})`)
  }

  return { outcome: 'switched', producer, authority, operationId }
}

/* ------------------------------------------------------------------ */
/* Enforcement helpers (routes / adapters).                            */
/* ------------------------------------------------------------------ */

/** Human-readable reason a versionless write is refused under authority. */
export function versionlessWriteRefusedReason(detail: string): string {
  return `版本事实已切换为权威：${detail}（请通过 /api/article-commands 或 protocol=v1 的版本化写入入口，携带 expectedVersion + operationId）`
}

/**
 * Write-entry guard for the version kernel. Returns an error message (non-null)
 * ONLY when a versionless write must be refused:
 *
 *   - `authority` ON  → all writes must be versioned (no versionless writes).
 *   - `producer` OFF  → the legacy new-write entry is closed (no direct
 *     `posts` writes, incl. the ledger-only compat path when identity DDL is
 *     absent).
 *
 * When null, the caller may proceed with a versioned write.
 */
export async function versionedWriteGuard(
  db: Database,
  opts: { requireProducer?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ refused: boolean; message: string | null; state: RolloutState }> {
  const state = await readRolloutState(db, opts.env)
  if (state.authority) {
    return { refused: true, message: versionlessWriteRefusedReason('legacy 无版本写入已停用'), state }
  }
  if (opts.requireProducer && !state.producer) {
    return { refused: true, message: versionlessWriteRefusedReason('新写入口已关闭（producer=disabled）'), state }
  }
  return { refused: false, message: null, state }
}
