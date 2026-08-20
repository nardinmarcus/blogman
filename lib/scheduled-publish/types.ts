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
  /** Per-claim lease ownership token — only the runner holding it proceeds. */
  lease_token: string | null
  /** Task revision — bumped on every state transition (optimistic guard). */
  revision: number
  /** Earliest instant a re-armed schedule may be claimed again (backoff). */
  next_attempt_at: number | null
  stale_reason: string | null
  fired_event_id: string | null
  created_at: number
  updated_at: number
}

/* ------------------------------------------------------------------ */
/* immutable attempt facts                                             */
/* ------------------------------------------------------------------ */

/**
 * Result classification of ONE execution of a schedule (written once).
 * `fired` delivered the event; `stale` hit a business mismatch; `retried`
 * failed transiently below the cap; `failed` exhausted the retry cap;
 * `abandoned` was reclaimed after a crash (lease expiry); `cancelled` was
 * terminated by the author while claimed.
 */
export type AttemptOutcome = 'fired' | 'stale' | 'retried' | 'failed' | 'abandoned' | 'cancelled'

export interface AttemptRow {
  id: number
  attempt_key: string
  schedule_id: string
  attempt_no: number
  started_at: number
  finished_at: number | null
  outcome: AttemptOutcome | null
  error: string | null
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
  /** Retry cap — a schedule stops retrying after this many execution attempts. */
  maxAttempts?: number
  /** Base backoff (seconds) after the first failed attempt. */
  retryBackoffSeconds?: number
  /** Exponential growth factor per retry attempt (attempt n waits base*factor^(n-1)). */
  retryBackoffFactor?: number
  /** Ceiling (seconds) for a single retry wait. */
  retryBackoffMaxSeconds?: number
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
  /** Schedules stopped after exhausting the retry cap (author todo). */
  failed: number
}

export type ScheduleOutcomeKind = 'fired' | 'stale' | 'retried' | 'failed'

export interface ScheduledScanOutcome {
  scheduleId: string
  articleId: number
  version: number
  outcome: ScheduleOutcomeKind
  reason?: string
  eventId?: string
}

/* ------------------------------------------------------------------ */
/* lease heartbeat                                                    */
/* ------------------------------------------------------------------ */

export interface HeartbeatInput {
  scheduleId: string
  /** The per-claim lease token this runner holds — proves ownership. */
  leaseToken: string
  /** New lease window (seconds) counted from `now`. */
  leaseSeconds?: number
  now?: number
}

export type HeartbeatResult =
  | {
      outcome: 'extended'
      scheduleId: string
      leaseExpiresAt: number
      /** The row's revision after the heartbeat (each transition bumps it). */
      revision: number
    }
  | {
      outcome: 'lost'
      scheduleId: string
      /** `not-claimed` row gone/not claimed; `reclaimed` another runner owns it; `lease-expired` our lease already lapsed. */
      reason: 'not-claimed' | 'reclaimed' | 'lease-expired'
    }