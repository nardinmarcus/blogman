/**
 * B4-02 — schedule control shared types (issue #41).
 *
 * One independent, operation-id idempotent command per follow-up action on a
 * scheduled-publish intent. Each action owns its own status precondition and
 * carries a deterministic `operationId` (the idempotency + audit key): a
 * repeated operation replays the first recorded result, so "重复命令幂等"
 * holds and no action can ever double-apply.
 *
 *   - pause       suspend a pending/claimed intent; RETAINS the original
 *                 `scheduled_at` and the bound version (nothing is deleted),
 *   - reconfirm   bind an EXACT new saved version and re-arm to `pending`
 *                 (never silent — checks the version is saved + no conflict),
 *   - reschedule  move an intent to a new absolute time (re-arms to pending),
 *   - cancel      terminal: pending/claimed/paused → cancelled (fact-preserving),
 *   - publish-now fire the bound version immediately through the EXISTING B3-01
 *                 publish kernel (prepare + confirm) — never bypasses it.
 *
 * The publish_schedules status machine now includes `paused` (see
 * lib/scheduled-publish/ddl.ts). The scan kernel ignores `paused` rows until
 * the author re-confirms / reschedules.
 */

/** The five independent control actions. */
export type ScheduleControlAction = 'pause' | 'reconfirm' | 'reschedule' | 'cancel' | 'publish_now'

/** Common command envelope: target schedule + operation id + actor. */
export interface ScheduleControlInput {
  scheduleId: string
  /** Deterministic idempotency + audit key for THIS action. */
  operationId: string
  actor: string
  now?: number
}

export interface PauseScheduleInput extends ScheduleControlInput {
  /** Free-form author note recorded verbatim for audit (optional). */
  reason?: string
}

export interface ReconfirmScheduleInput extends ScheduleControlInput {
  /** The exact new server-saved version the author CONFIRMS (never "latest"). */
  newVersion: number
}

export interface RescheduleScheduleInput extends ScheduleControlInput {
  /** New absolute execution time (epoch seconds) — must be in the future. */
  newScheduledAt: number
  /** IANA zone for the new time (defaults to the schedule's stored zone). */
  timezone?: string
}

/** Snapshot of the schedule intent as a concrete result carries. */
export interface ScheduleIntentFacts {
  scheduleId: string
  articleId: number
  version: number
  scheduledAt: number
  timezone: string
}

export type ScheduleControlResult =
  | ({ outcome: 'paused'; pausedAt: number; reason: string | null } & ScheduleIntentFacts)
  | ({ outcome: 'reconfirmed'; reconfirmedAt: number } & ScheduleIntentFacts)
  | ({ outcome: 'rescheduled'; rescheduledAt: number } & ScheduleIntentFacts)
  | { outcome: 'cancelled'; scheduleId: string; cancelledAt: number }
  | { outcome: 'published'; scheduleId: string; articleId: number; version: number; eventId: string; publishedAt: number }
  | {
      outcome: 'replayed'
      scheduleId: string
      operationId: string
      action: ScheduleControlAction
      existing: true
      /** The exact result the first run of this operation recorded. */
      result: Record<string, unknown>
    }
  | { outcome: 'not-found'; scheduleId: string }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'conflict'; scheduleId: string; reason: string }

/** Row of the operation ledger (audit + idempotency). */
export interface ScheduleControlOpRow {
  id: number
  operation_id: string
  schedule_id: string
  action: ScheduleControlAction
  result: string
  created_at: number
}

/** One row of a schedule intent (used internally for preconditions). */
export interface ScheduleRowLike {
  id: number
  schedule_id: string
  article_id: number
  version: number
  scheduled_at: number
  timezone: string
  status: string
  stale_reason: string | null
  last_error: string | null
  claimed_at: number | null
  lease_expires_at: number | null
}
