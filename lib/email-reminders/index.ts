/**
 * B4-05 — email reminders public entry (issue #44).
 *
 * Email is a notification task adapter over the #43 D1-backed notification
 * facts: threshold / quiet hours / dedup aggregation decide WHO and WHEN, and
 * every send attempt is recorded additively (`email_deliveries`,
 * acceptance-only, non-authoritative provider, retryable on failure). Never
 * configured / disabled ⇒ explicit in-site only — the notification surface is
 * untouched either way.
 */

export {
  CLAIM_TTL_SECONDS,
  EMAIL_REMINDERS_CONFIG_KEY,
  getEmailRemindersConfig,
  listEmailDeliveries,
  runEmailReminders,
  sanitizeEmailError,
  setEmailRemindersConfig,
} from './kernel'
export type {
  DigestItem,
  EmailDeliveryRow,
  EmailProvider,
  EmailReminderConfigRow,
  EmailReminderPolicy,
  EmailRemindersRunInput,
  EmailRemindersRunResult,
  EmailReminderSummary,
  EmailSendInput,
  EmailSendResult,
  QuietHours,
  SetEmailRemindersConfigInput,
  SetEmailRemindersConfigResult,
} from './types'
export { ensureEmailReminderTables, EMAIL_REMINDERS_DDL_STATEMENTS } from './ddl'
export { buildDigestSubject, buildDigestText, inCooldown, isQuietHours, minuteOfDay, thresholdMet } from './policy'
export { runEmailRemindersWake } from './scheduled'
export type { EmailRemindersEnv, EmailRemindersWakeResult } from './scheduled'