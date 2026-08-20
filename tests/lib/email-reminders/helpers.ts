/**
 * B4-05 — isolated-D1 fixtures + mock email provider (issue #44).
 *
 * Layers the B4-04 notification facts (real #43 kernel + DDL) plus the new
 * additive email-reminder tables over the shared in-process Miniflare D1 —
 * exactly what the DDL channel does. Zero production: the only provider here
 * is an in-memory mock recording accepted submissions with injectable
 * outcomes (accept / reject / throw), so tests cover threshold, quiet hours,
 * dedup aggregation and failure retry without ever touching a real mail
 * service.
 */

import { bootstrapB404State, createDatabase, query, teardownState } from '@/tests/lib/workbench/helpers'
import { ensureEmailReminderTables } from '@/lib/email-reminders/ddl'
import type { EmailProvider, EmailReminderPolicy, EmailSendInput, EmailSendResult } from '@/lib/email-reminders/types'

export { bootstrapB404State, createDatabase, query, teardownState }

/** Boot B4-00..B4-04 then the email-reminder tables (DDL runs twice: idempotency). */
export async function bootstrapB405State(stateDir: string): Promise<void> {
  await bootstrapB404State(stateDir)
  await ensureEmailReminderTables(createDatabase())
  await ensureEmailReminderTables(createDatabase())
}

/** In-memory provider: injectable outcome queue, records ACCEPTED submissions only. */
export class MockEmailProvider implements EmailProvider {
  readonly kind = 'mock'
  readonly sent: EmailSendInput[] = []
  totalCalls = 0
  private outcomes: Array<EmailSendResult | Error>

  constructor(outcomes: Array<EmailSendResult | Error> = [{ accepted: true }]) {
    this.outcomes = [...outcomes]
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    this.totalCalls += 1
    const outcome = this.outcomes.shift() ?? { accepted: true }
    if (outcome instanceof Error) throw outcome
    if (outcome.accepted) this.sent.push(input)
    return outcome
  }
}

/** Default B4-05 policy — 1h threshold, no quiet hours, 1h cooldown. */
export function defaultPolicy(overrides: Partial<EmailReminderPolicy> = {}): EmailReminderPolicy {
  return {
    recipients: ['author@example.test'],
    fromAddress: 'blogman@example.test',
    thresholdSeconds: 3600,
    quietHours: null,
    utcOffsetMinutes: 0,
    cooldownSeconds: 3600,
    ...overrides,
  }
}