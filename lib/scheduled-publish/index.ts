/**
 * B4-01 — scheduled publish public entry (issue #40).
 *
 * Version-bound schedule intents + the per-minute Cron compensation scan:
 *
 *   - `schedulePublish` — record the author's intent: article identity + exact
 *     confirmed version + absolute time + IANA timezone. One schedule intent
 *     can only ever produce ONE publish event (deterministic intent id).
 *   - `scanDueSchedules` — the Cron wake-up contract: D1 conditional claim
 *     (lease) + route the exact bound version through the existing publish
 *     kernel; version drift / already-live / author blockers are recorded
 *     stale (never misfire, wait for the author to re-confirm in #41);
 *     transient core failures are re-armed for reliable retry.
 *   - `cancelSchedule` — interface seam for issue #41's command surface
 *     (pause / reschedule / re-confirm / immediate publish land there).
 *
 * Zero production: no Cron trigger is configured here — the worker handler
 * (`lib/scheduled-publish/scheduled.ts`) demonstrates the same command the
 * deployed trigger will call in a later batch.
 */

export {
  cancelSchedule,
  scanDueSchedules,
  schedulePublish,
  scheduledIntentId,
  scheduledPrepareId,
  SCHEDULED_PUBLISH_ACTOR,
  SCHEDULED_PUBLISH_DEFAULT_LEASE_SECONDS,
  SCHEDULED_PUBLISH_DEFAULT_TIMEZONE,
} from './kernel'
export type {
  CancelScheduleInput,
  CancelScheduleResult,
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