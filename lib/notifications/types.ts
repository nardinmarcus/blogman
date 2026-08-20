/**
 * B4-04 — activity notification types (issue #43).
 *
 * Notifications are D1-BACKED (the notification table is the source of record,
 * never derived on the fly) and reference an authoritative SOURCE by type + id
 * (`source_type` / `source_id`) so the UI can深链 and re-read current state.
 *
 * The irreducible lifecycle invariant: `acknowledged` ONLY silences external
 * reminders — it NEVER resolves the underlying fact. Resolving is a separate
 * explicit action (`resolveNotification`) that marks the item handled. Each
 * notification is deduplicated by `(source_type, source_id)` so re-recording
 * the same source replays the existing row instead of creating a duplicate.
 */

export type NotificationStatus = 'open' | 'resolved'

export interface NotificationRow {
  id: number
  notification_id: string
  source_type: string
  source_id: string
  title: string
  detail: string | null
  status: NotificationStatus
  acknowledged: number
  created_at: number
  updated_at: number
}

export interface RecordNotificationInput {
  /** Author-side idempotency key (dedup + audit). */
  notificationId: string
  /** Authoritative source kind the notification points at. */
  sourceType: string
  /** Authoritative source id the notification points at. */
  sourceId: string
  title: string
  detail?: string | null
  now?: number
}

export type RecordNotificationResult =
  | { outcome: 'recorded'; notificationId: string; dedupKey: string; created: true; createdAt: number }
  | { outcome: 'replayed'; notificationId: string; dedupKey: string; existing: true; existingId: number }

export interface ResolveNotificationInput {
  sourceType: string
  sourceId: string
  actor?: string
  now?: number
}

export type ResolveNotificationResult =
  | { outcome: 'resolved'; dedupKey: string; resolvedAt: number; wasAcknowledged: boolean }
  | { outcome: 'replayed'; dedupKey: string; alreadyResolved: true }
  | { outcome: 'not-found'; dedupKey: string }

/** "已知晓" — mark the item known. Only stops EXTERNAL reminders, never the fact. */
export interface AcknowledgeNotificationInput {
  sourceType: string
  sourceId: string
  now?: number
}

export type AcknowledgeNotificationResult =
  | { outcome: 'acknowledged'; dedupKey: string; acknowledgedAt: number; status: NotificationStatus }
  | { outcome: 'replayed'; dedupKey: string; alreadyAcknowledged: true; status: NotificationStatus }
  | { outcome: 'not-found'; dedupKey: string }

/** Dedup key wiring — one notification per (source_type, source_id). */
export function notificationDedupKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`
}
