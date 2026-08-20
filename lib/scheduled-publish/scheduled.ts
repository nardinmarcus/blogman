/**
 * B4-01/B4-03 — scheduled-publish worker handler (issues #40 + #42).
 *
 * The deferred Cron wiring target: when the per-minute `[triggers]` is added
 * by a later batch, the deployed worker wakes on `scheduled` and calls
 * `runScheduledPublishScan` — which invokes the SAME D1 scan command the tests
 * exercise (scheduled 契约调用同一命令). The handler itself is zero-production
 * by design: it only reads the DB binding, and it is fully covered by the
 * Miniflare `scheduled` dispatch test in this module's suite.
 *
 * B4-03 adds the executor kill-switch: `SCHEDULED_PUBLISH_DISABLED` (any
 * truthy value) skips the scan WITHOUT touching any task or attempt fact —
 * tasks and attempts are retained, and a later enabled run converges.
 */

import { scanDueSchedules } from './kernel'
import type { ScanResult } from './types'

export interface ScheduledPublishEnv extends Partial<CloudflareEnv> {
  DB?: D1Database
  /** Truthy value disables the executor while retaining task/attempt facts. */
  SCHEDULED_PUBLISH_DISABLED?: string
}

export interface ScheduledScanRun {
  skipped: boolean
  reason?: string
  result?: ScanResult
}

/** Truthy if the runner wants the scheduled executor switched off. */
function executorDisabled(env: ScheduledPublishEnv): boolean {
  const flag = (env.SCHEDULED_PUBLISH_DISABLED ?? '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
}

/**
 * The single contract the Cron trigger will call every minute. Resolves
 * deterministically on the same controlled-clock command used everywhere else;
 * a missing DB binding OR an explicit executor kill-switch disables the scan
 * without throwing and without touching any task/attempt fact.
 */
export async function runScheduledPublishScan(
  env: ScheduledPublishEnv,
  opts: { now?: number } = {},
): Promise<ScheduledScanRun> {
  if (executorDisabled(env)) {
    return { skipped: true, reason: 'scheduled publish executor disabled — tasks and attempts retained' }
  }
  const db = env.DB
  if (!db) {
    return { skipped: true, reason: 'DB unavailable — scheduled scan disabled' }
  }
  const siteUrl = (env.NEXT_PUBLIC_SITE_URL ?? '').trim() || undefined
  const result = await scanDueSchedules(db, { now: opts.now, siteUrl })
  return { skipped: false, result }
}