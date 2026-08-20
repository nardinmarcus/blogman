/**
 * B4-05 — email-reminder worker wake contract (issue #44).
 *
 * The deferred Cron wiring target, mirroring the scheduled-publish contract
 * (#40): when a later batch adds the `[triggers]` entry and a real provider
 * adapter, this is the exact command the worker's `scheduled` handler calls.
 *
 * THIS BATCH IS ZERO-PRODUCTION: the provider adapter is injected via `deps`
 * and is `null` by default — a missing binding, a missing DB, OR the
 * `EMAIL_REMINDERS_DISABLED` kill-switch each resolve deterministically to a
 * skip/unconfigured outcome WITHOUT sending anything and WITHOUT touching any
 * notification or source fact. 站内通知保持 — only external email stops.
 */

import { runEmailReminders } from './kernel'
import type { EmailProvider, EmailRemindersRunResult } from './types'

export interface EmailRemindersEnv extends Partial<CloudflareEnv> {
  DB?: D1Database
  /** Truthy value disables the email executor while retaining notification facts. */
  EMAIL_REMINDERS_DISABLED?: string
}

export type EmailRemindersWakeResult =
  | { skipped: true; reason: string }
  | { skipped: false; result: EmailRemindersRunResult }

/** Truthy if the runner wants the scheduled executor switched off. */
function executorDisabled(env: EmailRemindersEnv): boolean {
  const flag = (env.EMAIL_REMINDERS_DISABLED ?? '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
}

/**
 * The single contract the Cron trigger will call. Deterministic on the same
 * controlled-clock kernel used everywhere else; provider is injected by the
 * wiring batch (`null` here ⇒ in-site only).
 */
export async function runEmailRemindersWake(
  env: EmailRemindersEnv,
  deps: { provider?: EmailProvider | null; now?: number } = {},
): Promise<EmailRemindersWakeResult> {
  if (executorDisabled(env)) {
    return { skipped: true, reason: 'email reminder executor disabled — notifications retained, in-site only' }
  }
  const db = env.DB
  if (!db) {
    return { skipped: true, reason: 'DB unavailable — email reminders skipped' }
  }
  const result = await runEmailReminders(db, { provider: deps.provider ?? null, now: deps.now })
  return { skipped: false, result }
}