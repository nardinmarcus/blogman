/**
 * B4-05 — email reminder shared types (issue #44).
 *
 * Email is a NOTIFICATION TASK ADAPTER with restricted recipient addresses:
 * it CONSUMES the #43 D1-backed notification facts (`activity_notifications`)
 * and never invents its own facts. The email provider is NON-AUTHORITATIVE —
 * only provider ACCEPTANCE of a submission is recorded (`last_status='sent'`),
 * never delivery/receipt. A failed submission records `last_status='failed'`
 * plus a bounded error and stays RETRYABLE; it never recursively notifies
 * ("失败不递归通知") and never touches the underlying notification or publish
 * facts.
 *
 * Delivery + dedup facts (`email_deliveries`) are ADDITIVE, keyed by the same
 * `(source_type, source_id)` the notification kernel uses, so repeated runs
 * can never bombard a source ("重复来源不轰炸") and the notification table
 * remains the source of record.
 */

/** One submission to the email provider — the kernel never sends anything else. */
export interface EmailSendInput {
  to: string
  from: string | null
  subject: string
  text: string
}

/**
 * Provider answer. Only `accepted` is recorded as fact — the provider is not
 * authoritative for delivery. `errorMessage` is bounded and stashed for retry
 * diagnostics when a submission is rejected or the call throws.
 */
export interface EmailSendResult {
  accepted: boolean
  errorMessage?: string | null
  providerMessageId?: string | null
}

/**
 * The email-provider seam. THIS BATCH IS ZERO-PRODUCTION: only the interface
 * exists here; real adapters land in a later batch and are contract/smoke
 * tested there. Tests inject in-memory mocks.
 */
export interface EmailProvider {
  readonly kind: string
  send(input: EmailSendInput): Promise<EmailSendResult>
}

/** Quiet-hours window expressed in minute-of-day in the policy timezone. */
export interface QuietHours {
  /** Minute of day (0..1439) when the quiet window starts. */
  startMinute: number
  /** Minute of day (0..1439) when the quiet window ends (exclusive). */
  endMinute: number
}

/**
 * The reminder policy. Threshold gates WHO is reminded (important unresolved
 * items only — must stay unacknowledged AND open past `thresholdSeconds`);
 * quiet hours gate WHEN (不外发 — inside the window nothing is sent and items
 * stay eligible for the next run outside it); the cooldown dedups repeated
 * runs ("重复来源不轰炸") — a successfully sent source is not re-sent within
 * `cooldownSeconds`. Overnight windows are expressed as startMinute > endMinute.
 */
export interface EmailReminderPolicy {
  /** Restricted recipient addresses — an empty list means unconfigured (in-site only). */
  recipients: string[]
  fromAddress?: string | null
  /** Item must have been open (unresolved) this long before any reminder. */
  thresholdSeconds: number
  /** Suppress sending inside this window; null disables quiet hours. */
  quietHours: QuietHours | null
  /** UTC offset applied to the controlled clock before computing minute-of-day. */
  utcOffsetMinutes: number
  /** After a successful send, do not re-send the same source within this window. */
  cooldownSeconds: number
}

/* ------------------------------------------------------------------ */
/* persisted shapes                                                    */
/* ------------------------------------------------------------------ */

export interface EmailReminderConfigRow {
  id: number
  key: string
  enabled: number
  recipients_json: string
  from_address: string | null
  threshold_seconds: number
  quiet_start_minute: number
  quiet_end_minute: number
  utc_offset_minutes: number
  cooldown_seconds: number
  updated_at: number
}

/**
 * Per-source delivery + dedup facts. `last_status` is `skipped` (never
 * attempted), `sent` (provider ACCEPTED — acceptance-only, non-authoritative)
 * or `failed` (submission rejected/threw — retryable). `sent_count` counts
 * accepted submissions so a failed run can never look "delivered".
 */
export interface EmailDeliveryRow {
  id: number
  source_type: string
  source_id: string
  last_attempt_at: number | null
  last_sent_at: number | null
  sent_count: number
  last_status: 'skipped' | 'sent' | 'failed'
  last_error: string | null
  updated_at: number
}

/* ------------------------------------------------------------------ */
/* commands & results                                                  */
/* ------------------------------------------------------------------ */

export interface SetEmailRemindersConfigInput {
  enabled: boolean
  policy: EmailReminderPolicy
  now?: number
}

export type SetEmailRemindersConfigResult = {
  outcome: 'configured'
  key: 'email-reminders'
  enabled: boolean
  updatedAt: number
  policy: EmailReminderPolicy
}

export interface EmailRemindersRunInput {
  /** Controlled clock (epoch seconds) — same convention as every kernel. */
  now?: number
  /** Injectable provider. `null` means "no adapter bound — in-site only". */
  provider: EmailProvider | null
}

/** One digest line — an authoritative notification each run decided to email. */
export interface DigestItem {
  sourceType: string
  sourceId: string
  title: string
  detail: string | null
}

export interface EmailReminderSummary {
  /** Open (unresolved) notifications at run start — acknowledged or not. */
  open: number
  /** Open but「已知晓」 — silences EXTERNAL reminders only, fact stays open. */
  acknowledgedSkipped: number
  /** Open, unacknowledged, but not yet past the threshold. */
  thresholdSkipped: number
  /** Open + unacknowledged + threshold met — would be reminded now. */
  eligible: number
  /** Eligible but suppressed by quiet hours (nothing sent; retried next run). */
  quietSkipped: number
  /** Eligible but successfully sent within the cooldown window (no bombardment). */
  cooldownSkipped: number
  /** Sources this run claimed and attempted. */
  attempted: number
  /** Provider-accepted submissions. */
  sent: number
  /** Rejected/thrown submissions — recorded failed, retryable. */
  failed: number
  /** Provider calls made this run (one digest per recipient). */
  digestEmails: number
  recipients: string[]
}

export type EmailRemindersRunResult =
  | {
      outcome: 'unconfigured'
      key: 'email-reminders'
      reason: string
    }
  | {
      outcome: 'disabled'
      key: 'email-reminders'
      reason: string
    }
  | {
      outcome: 'quiet-hours'
      key: 'email-reminders'
      reason: string
      summary: EmailReminderSummary
    }
  | {
      outcome: 'ran'
      key: 'email-reminders'
      summary: EmailReminderSummary
    }