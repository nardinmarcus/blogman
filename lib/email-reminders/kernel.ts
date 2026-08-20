/**
 * B4-05 — email reminder executor kernel (issue #44).
 *
 * Consumes the #43 D1-backed notification facts (`activity_notifications`)
 * and decides, per run, which open + unacknowledged items deserve an EXTERNAL
 * reminder:
 *
 *   1. threshold   — important unresolved items ONLY: must have stayed open
 *                    (unresolved, unacknowledged) past `thresholdSeconds`,
 *   2. quiet hours — inside the window NOTHING is sent (不外发); eligible items
 *                    remain eligible and the next run outside the window picks
 *                    them up (补发), never silently dropped by quiet hours,
 *   3. dedup       — all eligible sources are MERGED into ONE digest email per
 *                    recipient (同源通知聚合/合并), and a source successfully
 *                    sent within `cooldownSeconds` is skipped (重复来源不轰炸).
 *
 * Failure semantics ("外发失败不丢事实"):
 *   - provider rejection/throw records `last_status='failed'` + bounded error
 *     on the additive `email_deliveries` row; the notification fact is NEVER
 *     touched and the source stays retryable on the next run,
 *   - only provider ACCEPTANCE is recorded as `sent` (provider non-authoritative),
 *   - failures never recursively notify ("失败不递归通知").
 *
 * 「已知晓」semantics carried over from #43: `acknowledged = 1` stops the
 * EXTERNAL reminder only — the notification stays `open` and resolving stays
 * a separate explicit action.
 *
 * Race safety: same guarded-claim pattern as #43 — each run claims a source
 * through a token-stamped conditional UPDATE on the delivery UNIQUE
 * (source_type, source_id) row; exactly one concurrent winner proceeds, the
 * loser replays. Orphaned in-flight claims expire after CLAIM_TTL_SECONDS so a
 * crashed runner never wedges a source.
 *
 * Unconfigured (no config row, no recipients, or no provider adapter bound)
 * is explicitly IN-SITE ONLY — the executor never sends and never throws.
 */

import type { Database } from '@/lib/repositories/schema'
import { buildDigestSubject, buildDigestText, inCooldown, isQuietHours, thresholdMet } from './policy'
import type {
  DigestItem,
  EmailDeliveryRow,
  EmailProvider,
  EmailReminderConfigRow,
  EmailReminderPolicy,
  EmailRemindersRunInput,
  EmailRemindersRunResult,
  EmailReminderSummary,
  EmailSendResult,
  SetEmailRemindersConfigInput,
  SetEmailRemindersConfigResult,
} from './types'

export const EMAIL_REMINDERS_CONFIG_KEY = 'email-reminders' as const
/** A claim not finished (crashed before markSent/markFailed) is reclaimable after this. */
export const CLAIM_TTL_SECONDS = 300
const EMAIL_REMINDER_ERROR_LIMIT = 512

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/** Bound + sanitise a provider error for the retry-visible fact row. */
export function sanitizeEmailError(message: string, maxLength = EMAIL_REMINDER_ERROR_LIMIT): string {
  const cleaned = message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

const CONFIG_COLUMNS = `id, key, enabled, recipients_json, from_address, threshold_seconds,
  quiet_start_minute, quiet_end_minute, utc_offset_minutes, cooldown_seconds, updated_at`

export function policyFromConfigRow(row: EmailReminderConfigRow): EmailReminderPolicy {
  let recipients: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.recipients_json)
    if (Array.isArray(parsed)) {
      recipients = parsed
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .map((r) => r.trim())
    }
  } catch {
    recipients = []
  }
  const quiet =
    row.quiet_start_minute === row.quiet_end_minute
      ? null
      : { startMinute: row.quiet_start_minute, endMinute: row.quiet_end_minute }
  return {
    recipients,
    fromAddress: row.from_address,
    thresholdSeconds: row.threshold_seconds,
    quietHours: quiet,
    utcOffsetMinutes: row.utc_offset_minutes,
    cooldownSeconds: row.cooldown_seconds,
  }
}

/** Read the single executor config row; `null` = never configured (in-site only). */
export async function getEmailRemindersConfig(
  db: Database,
): Promise<{ enabled: boolean; policy: EmailReminderPolicy } | null> {
  const row = await db
    .prepare(`SELECT ${CONFIG_COLUMNS} FROM email_reminder_config WHERE key = ?`)
    .bind(EMAIL_REMINDERS_CONFIG_KEY)
    .first<EmailReminderConfigRow>()
  if (!row) return null
  return { enabled: row.enabled === 1, policy: policyFromConfigRow(row) }
}

/** Configure or flip off the executor. Additive; never touches a notification/source fact. */
export async function setEmailRemindersConfig(
  db: Database,
  input: SetEmailRemindersConfigInput,
): Promise<SetEmailRemindersConfigResult> {
  const now = input.now ?? unixNow()
  const recipientsJson = JSON.stringify(input.policy.recipients)
  const quiet = input.policy.quietHours ?? null
  await db
    .prepare(
      `INSERT INTO email_reminder_config
         (key, enabled, recipients_json, from_address, threshold_seconds,
          quiet_start_minute, quiet_end_minute, utc_offset_minutes, cooldown_seconds, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         enabled = excluded.enabled,
         recipients_json = excluded.recipients_json,
         from_address = excluded.from_address,
         threshold_seconds = excluded.threshold_seconds,
         quiet_start_minute = excluded.quiet_start_minute,
         quiet_end_minute = excluded.quiet_end_minute,
         utc_offset_minutes = excluded.utc_offset_minutes,
         cooldown_seconds = excluded.cooldown_seconds,
         updated_at = excluded.updated_at`,
    )
    .bind(
      EMAIL_REMINDERS_CONFIG_KEY,
      input.enabled ? 1 : 0,
      recipientsJson,
      input.policy.fromAddress ?? null,
      input.policy.thresholdSeconds,
      quiet?.startMinute ?? 0,
      quiet?.endMinute ?? 0,
      input.policy.utcOffsetMinutes,
      input.policy.cooldownSeconds,
      now,
    )
    .run()
  return {
    outcome: 'configured',
    key: EMAIL_REMINDERS_CONFIG_KEY,
    enabled: input.enabled,
    updatedAt: now,
    policy: input.policy,
  }
}

/* ------------------------------------------------------------------ */
/* delivery + dedup facts                                              */
/* ------------------------------------------------------------------ */

const DELIVERY_COLUMNS = `id, source_type, source_id, last_attempt_at, last_sent_at,
  sent_count, last_status, last_error, updated_at`

async function findDelivery(db: Database, sourceType: string, sourceId: string): Promise<EmailDeliveryRow | null> {
  return db
    .prepare(`SELECT ${DELIVERY_COLUMNS} FROM email_deliveries WHERE source_type = ? AND source_id = ?`)
    .bind(sourceType, sourceId)
    .first<EmailDeliveryRow>()
}

/**
 * Claim this source's attempt. Exactly one concurrent run wins: the conditional
 * UPDATE only succeeds while the row is unattempted, last seen failed, or its
 * claim is older than CLAIM_TTL_SECONDS; the winner is verified by re-reading
 * its unique token — the same ownership pattern as #43.
 */
async function claimSendAttempt(db: Database, sourceType: string, sourceId: string, now: number): Promise<boolean> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO email_deliveries
         (source_type, source_id, sent_count, last_status, updated_at)
       VALUES (?, ?, 0, 'skipped', ?)`,
    )
    .bind(sourceType, sourceId, now)
    .run()
  const token = `${now}`
  await db
    .prepare(
      `UPDATE email_deliveries
       SET last_attempt_at = ?, updated_at = ?
       WHERE source_type = ? AND source_id = ?
         AND (last_status = 'failed' OR last_attempt_at IS NULL OR last_attempt_at < ?)`,
    )
    .bind(now, token, sourceType, sourceId, now - CLAIM_TTL_SECONDS)
    .run()
  const row = await findDelivery(db, sourceType, sourceId)
  return row !== null && String(row.updated_at) === token
}

async function markSent(
  db: Database,
  sourceType: string,
  sourceId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE email_deliveries
       SET sent_count = sent_count + 1, last_sent_at = ?, last_status = 'sent',
           last_error = NULL, updated_at = ?
       WHERE source_type = ? AND source_id = ?`,
    )
    .bind(now, `${now}`, sourceType, sourceId)
    .run()
}

async function markFailed(db: Database, sourceType: string, sourceId: string, now: number, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE email_deliveries
       SET last_status = 'failed', last_error = ?, updated_at = ?
       WHERE source_type = ? AND source_id = ?`,
    )
    .bind(sanitizeEmailError(error), `${now}`, sourceType, sourceId)
    .run()
}

/** Read the additive delivery surface (observability / tests). */
export async function listEmailDeliveries(db: Database): Promise<EmailDeliveryRow[]> {
  const { results } = await db
    .prepare(`SELECT ${DELIVERY_COLUMNS} FROM email_deliveries ORDER BY updated_at DESC`)
    .all<EmailDeliveryRow>()
  return results ?? []
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

interface OpenNotificationRow {
  source_type: string
  source_id: string
  title: string
  detail: string | null
  acknowledged: number
  created_at: number
}

async function listOpenNotifications(db: Database): Promise<OpenNotificationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT source_type, source_id, title, detail, acknowledged, created_at
       FROM activity_notifications
       WHERE status = 'open'
       ORDER BY created_at ASC`,
    )
    .all<OpenNotificationRow>()
  return results ?? []
}

function emptySummary(policy: EmailReminderPolicy): EmailReminderSummary {
  return {
    open: 0,
    acknowledgedSkipped: 0,
    thresholdSkipped: 0,
    eligible: 0,
    quietSkipped: 0,
    cooldownSkipped: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    digestEmails: 0,
    recipients: [...policy.recipients],
  }
}

/**
 * The single executor entry. Deterministic on the controlled clock; consumes
 * only open + unacknowledged notification facts; merges every eligible source
 * into one digest email per recipient; records additive delivery facts; never
 * writes to `activity_notifications` or any publish/source table.
 */
export async function runEmailReminders(
  db: Database,
  input: EmailRemindersRunInput,
): Promise<EmailRemindersRunResult> {
  const now = input.now ?? unixNow()

  const config = await getEmailRemindersConfig(db)
  if (config === null) {
    return {
      outcome: 'unconfigured',
      key: EMAIL_REMINDERS_CONFIG_KEY,
      reason: 'email reminders never configured — in-site notifications only',
    }
  }
  if (!config.enabled) {
    return {
      outcome: 'disabled',
      key: EMAIL_REMINDERS_CONFIG_KEY,
      reason: 'email reminder executor disabled — notifications retained, in-site only',
    }
  }
  const policy = config.policy
  if (policy.recipients.length === 0) {
    return {
      outcome: 'unconfigured',
      key: EMAIL_REMINDERS_CONFIG_KEY,
      reason: 'no recipient addresses configured — in-site notifications only',
    }
  }
  const provider: EmailProvider | null = input.provider
  if (provider === null) {
    return {
      outcome: 'unconfigured',
      key: EMAIL_REMINDERS_CONFIG_KEY,
      reason: 'no email provider adapter bound — in-site notifications only',
    }
  }

  const summary = emptySummary(policy)
  const open = await listOpenNotifications(db)
  summary.open = open.length

  const toSend: DigestItem[] = []
  for (const notification of open) {
    if (notification.acknowledged === 1) {
      summary.acknowledgedSkipped += 1 // 「已知晓」只停外部提醒 — fact stays open
      continue
    }
    if (!thresholdMet(notification.created_at, now, policy)) {
      summary.thresholdSkipped += 1
      continue
    }
    const delivery = await findDelivery(db, notification.source_type, notification.source_id)
    if (delivery !== null && inCooldown(delivery.last_sent_at, now, policy)) {
      summary.cooldownSkipped += 1
      continue
    }
    toSend.push({
      sourceType: notification.source_type,
      sourceId: notification.source_id,
      title: notification.title,
      detail: notification.detail,
    })
  }
  summary.eligible = toSend.length

  // Quiet hours: 不外发 — nothing sent; eligible items stay eligible and the
  // next run outside the window picks them up (补发), never silently dropped.
  if (isQuietHours(now, policy)) {
    summary.quietSkipped = toSend.length
    return {
      outcome: 'quiet-hours',
      key: EMAIL_REMINDERS_CONFIG_KEY,
      reason: 'inside quiet hours — nothing sent, eligible items retried on the next run',
      summary,
    }
  }

  if (toSend.length === 0) {
    return { outcome: 'ran', key: EMAIL_REMINDERS_CONFIG_KEY, summary }
  }

  // Claim EVERY eligible source first (one guarded winner per source), then
  // submit ONE merged digest per recipient.
  const claimed: DigestItem[] = []
  for (const item of toSend) {
    if (await claimSendAttempt(db, item.sourceType, item.sourceId, now)) claimed.push(item)
  }
  if (claimed.length === 0) {
    return { outcome: 'ran', key: EMAIL_REMINDERS_CONFIG_KEY, summary }
  }

  summary.attempted = claimed.length
  const subject = buildDigestSubject(claimed.length)
  const text = buildDigestText(claimed, now)
  let acceptedCount = 0
  let rejected: { error: string } | null = null
  for (const recipient of policy.recipients) {
    summary.digestEmails += 1
    let result: EmailSendResult
    try {
      result = await provider.send({ to: recipient, from: policy.fromAddress ?? null, subject, text })
    } catch (error) {
      result = { accepted: false, errorMessage: error instanceof Error ? error.message : String(error) }
    }
    if (result.accepted) acceptedCount += 1
    else if (rejected === null) rejected = { error: result.errorMessage ?? 'provider rejected the submission' }
  }

  // Merge into one submission outcome: every recipient accepted → all claimed
  // sources are `sent`; otherwise `failed` (retryable) with the first error.
  // Provider is non-authoritative; acceptance-only recording.
  if (acceptedCount === policy.recipients.length) {
    for (const item of claimed) {
      await markSent(db, item.sourceType, item.sourceId, now)
    }
    summary.sent = claimed.length
  } else {
    for (const item of claimed) {
      await markFailed(db, item.sourceType, item.sourceId, now, rejected?.error ?? 'unknown provider error')
    }
    summary.failed = claimed.length
  }

  return { outcome: 'ran', key: EMAIL_REMINDERS_CONFIG_KEY, summary }
}