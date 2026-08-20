/**
 * B4-04 — activity notifications public entry (issue #43).
 *
 * D1 is the source of record for notifications; each references an
 * authoritative source type+id. `acknowledge` ("已知晓") only silences EXTERNAL
 * reminders and never fakes a resolution; `resolve` is explicit and separate.
 * Rebuild reconciles the set against current authoritative facts.
 */

export {
  acknowledgeNotification,
  listNotifications,
  rebuildNotifications,
  recordNotification,
  resolveNotification,
} from './kernel'
export type {
  AcknowledgeNotificationInput,
  AcknowledgeNotificationResult,
  NotificationRow,
  NotificationStatus,
  RecordNotificationInput,
  RecordNotificationResult,
  ResolveNotificationInput,
  ResolveNotificationResult,
} from './types'
export { notificationDedupKey } from './types'
export { ensureNotificationTables, NOTIFICATIONS_DDL_STATEMENTS } from './ddl'
