/**
 * B4-01/B4-03 — scheduled publish public entry (issues #40 + #42).
 *
 * Version-bound schedule intents + the per-minute Cron compensation scan with
 * durable, immutable execution attempts:
 *
 *   - `schedulePublish` — record the author's intent: article identity + exact
 *     confirmed version + absolute time + IANA timezone. One schedule intent
 *     can only ever produce ONE publish event (deterministic intent id).
 *   - `scanDueSchedules` — the Cron wake-up contract: D1 conditional claim
 *     under a lease (per-claim `lease_token`, expiry reclaim, heartbeat), a
 *     fresh IMMUTABLE attempt row per execution, then route the exact bound
 *     version through the existing publish kernel; version drift / already-
 *     live / author blockers are recorded stale (never misfire, wait for the
 *     author to re-confirm in #41); transient core failures retry under a
 *     cap + exponential backoff (`next_attempt_at`), stopping as an author
 *     todo when the cap is exhausted. Every error fact is sanitized.
 *   - `heartbeatScheduleLease` — extend a lease while THIS runner still owns
 *     it (anti-resurrection after a reclaim rotates the token).
 *   - `cancelSchedule` — interface seam for issue #41's command surface
 *     (pause / reschedule / re-confirm / immediate publish land there).
 *
 * Zero production: no Cron trigger is configured here — the worker handler
 * (`lib/scheduled-publish/scheduled.ts`) demonstrates the same command the
 * deployed trigger will call in a later batch, and the executor can be
 * switched off through an env flag without losing any task/attempt facts.
 */

export {
  cancelSchedule,
  heartbeatScheduleLease,
  retryBackoffSeconds,
  sanitizeError,
  scanDueSchedules,
  schedulePublish,
  scheduledAttemptKey,
  scheduledIntentId,
  scheduledPrepareId,
  SCHEDULED_PUBLISH_ACTOR,
  SCHEDULED_PUBLISH_DEFAULT_LEASE_SECONDS,
  SCHEDULED_PUBLISH_DEFAULT_MAX_ATTEMPTS,
  SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_FACTOR,
  SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_MAX_SECONDS,
  SCHEDULED_PUBLISH_DEFAULT_RETRY_BACKOFF_SECONDS,
  SCHEDULED_PUBLISH_DEFAULT_TIMEZONE,
} from './kernel'
export type {
  AttemptOutcome,
  AttemptRow,
  CancelScheduleInput,
  CancelScheduleResult,
  HeartbeatInput,
  HeartbeatResult,
  ScanInput,
  ScanResult,
  ScheduleOutcomeKind,
  SchedulePublishInput,
  SchedulePublishResult,
  ScheduleRow,
  ScheduleStatus,
  ScheduledScanOutcome,
} from './types'
export { ensureScheduledPublishTables, SCHEDULED_PUBLISH_DDL_STATEMENTS } from './ddl'