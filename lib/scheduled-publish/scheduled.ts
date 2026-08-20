/**
 * B4-01 — scheduled-publish worker handler (issue #40).
 *
 * The deferred Cron wiring target: when the per-minute `[triggers]` is added
 * by a later batch, the deployed worker wakes on `scheduled` and calls
 * `runScheduledPublishScan` — which invokes the SAME D1 scan command the tests
 * exercise (scheduled 契约调用同一命令). The handler itself is zero-production
 * by design: it only reads the DB binding, and it is fully covered by the
 * Miniflare `scheduled` dispatch test in this module's suite.
 */

import { scanDueSchedules } from './kernel'
import type { ScanResult } from './types'

export interface ScheduledPublishEnv extends Partial<CloudflareEnv> {
  DB?: D1Database
}

export interface ScheduledScanRun {
  skipped: boolean
  reason?: string
  result?: ScanResult
}

/**
 * The single contract the Cron trigger will call every minute. Resolves
 * deterministically on the same controlled-clock command used everywhere else;
 * a missing DB binding disables the scan without throwing.
 */
export async function runScheduledPublishScan(
  env: ScheduledPublishEnv,
  opts: { now?: number } = {},
): Promise<ScheduledScanRun> {
  const db = env.DB
  if (!db) {
    return { skipped: true, reason: 'DB unavailable — scheduled scan disabled' }
  }
  const siteUrl = (env.NEXT_PUBLIC_SITE_URL ?? '').trim() || undefined
  const result = await scanDueSchedules(db, { now: opts.now, siteUrl })
  return { skipped: false, result }
}