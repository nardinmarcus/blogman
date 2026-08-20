/**
 * B4-02 — schedule control public entry (issue #41).
 *
 * Independent, operation-id idempotent control commands over scheduled-publish
 * intents: pause, re-confirm (bind an exact new saved version), reschedule,
 * cancel, and publish-now (fires the bound version through the EXISTING B3-01
 * publish kernel). Cancel / pause / re-confirm / reschedule never DELETE a
 * schedule row and never touch article or publish facts; publish-now never
 * bypasses the shared kernel. Zero production by design — this surface has no
 * HTTP/Cron wiring.
 */

export {
  cancelScheduleControl,
  pauseSchedule,
  publishNowSchedule,
  reconfirmSchedule,
  rescheduleSchedule,
  scheduledControlIntentId,
  scheduledControlPrepareId,
} from './kernel'
export type {
  PauseScheduleInput,
  ReconfirmScheduleInput,
  RescheduleScheduleInput,
  ScheduleControlAction,
  ScheduleControlInput,
  ScheduleControlOpRow,
  ScheduleControlResult,
  ScheduleIntentFacts,
  ScheduleRowLike,
} from './types'
export { ensureScheduleControlTables, SCHEDULE_CONTROL_DDL_STATEMENTS } from './ddl'
