/**
 * B4-01 — scheduled publish shared types (issue #40).
 *
 * A schedule is a VERSION-BOUND publish intent: article identity + exact
 * server-saved version + absolute execution time (epoch seconds, comparable in
 * D1) + the IANA timezone the author chose (stored verbatim for echo; the
 * management UI renders fixed to `Asia/Shanghai`). A schedule NEVER means
 * "publish whatever is latest" — on fire, the exact bound version is checked
 * against the live version ledger and the existing publish kernel is invoked
 * only when it still matches; otherwise the schedule is recorded stale and the
 * author must re-confirm / reschedule (issue #41 command surface).
 */

/** Lifecycle of one schedule intent (the scheduler's own terminal bucketing). */
export type ScheduleStatus = 'pending' | 'claimed' | 'fired' | 'stale' | 'cancelled'

export interface ScheduleRow {
  id: number
  schedule_id: string
  article_id: number
  version: number
  scheduled_at: number
  timezone: string
  status: ScheduleStatus
  attempt_count: number
  last_error: string | null
  claimed_at: number | null
  lease_expires_at: number | null
  stale_reason: string | null
  fired_event_id: string | null
  created_at: number
  updated_at: number
}

/* ------------------------------------------------------------------ */
/* scheduling                                                          */
/* ------------------------------------------------------------------ */

export interface SchedulePublishInput {
  /** Author-side idempotency key — one schedule intent produces at most one event. */
  scheduleId: string
  articleId: number
  /** The exact server-saved version the author confirmed (NOT "latest"). */
  version: number
  /** Absolute execution time (epoch seconds) — comparable, timezone-independent. */
  scheduledAt: number
  /** IANA zone the author selected (defaults to `Asia/Shanghai`; stored for echo). */
  timezone?: string
  actor: string
  now?: number
}

export type SchedulePublishResult =
  | {
      outcome: 'scheduled'
      scheduleId: string
      articleId: number
      version: number
      scheduledAt: number
      timezone: string
    }
  | {
      outcome: 'replayed'
      scheduleId: string
      articleId: number
      version: number
      scheduledAt: number
      timezone: string
    }
  | {
      outcome: 'conflict'
      scheduleId: string
      reason: 'payload-mismatch' | 'duplicate-version' | 'already-published' | string
      articleId: number
    }
  | { outcome: 'not-found'; articleId: number }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* cancellation (interface seam for issue #41's command surface)       */
/* ------------------------------------------------------------------ */

export interface CancelScheduleInput {
  scheduleId: string
  actor: string
  now?: number
}

export type CancelScheduleResult =
  | { outcome: 'cancelled'; scheduleId: string; cancelledAt: number }
  | { outcome: 'replayed'; scheduleId: string }
  | { outcome: 'not-found'; scheduleId: string }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'conflict'; scheduleId: string; reason: string }

/* ------------------------------------------------------------------ */
/* per-minute cron compensation scan                                   */
/* ------------------------------------------------------------------ */

export interface ScanInput {
  /** Controlled clock for deterministic tests; defaults to the real wall clock. */
  now?: number
  /** Max schedules processed per scan (bounded batch). */
  limit?: number
  /** Site origin used to compute the public address on a scheduled first publish. */
  siteUrl?: string
  /** Lease duration (seconds) before a crashed runner's claim may be reclaimed. */
  leaseSeconds?: number
}

export interface ScanResult {
  /** Due candidates considered by this scan (pending + expired-lease claims). */
  scanned: number
  /** Rows this scan won the atomic claim for. */
  claimed: number
  /** Schedules that produced (or idempotently replayed) a publish event. */
  fired: number
  /** Schedules recorded stale (version drift / already live / author action needed). */
  stale: number
  /** Transient failures re-armed for a later scan (reliable retry). */
  retried: number
}

export type ScheduleOutcomeKind = 'fired' | 'stale' | 'retried'

export interface ScheduledScanOutcome {
  scheduleId: string
  articleId: number
  version: number
  outcome: ScheduleOutcomeKind
  reason?: string
  eventId?: string
}