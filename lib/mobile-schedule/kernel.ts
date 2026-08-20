/**
 * B8-04 — mobile schedule management D1 adapter (issue #63).
 *
 * A THIN adapter between the mobile UI and the B4-02 (#41) schedule-control
 * commands. The only DB reads here rebuild an authoritative, fresh schedule
 * view from D1 (never a client-supplied optimistic state); every action re-reads
 * the schedule, dispatches to the SHARED #41 kernel command (which re-evaluates
 * its own status precondition + idempotency ledger), records an activity
 * notification through the B4-04 (#43) kernel for audit, then re-reads the
 * schedule so the response always carries post-action D1 facts.
 *
 * No new schedule fact table is created here — mobile scheduling reuses the
 * existing `publish_schedules` / `schedule_control_ops` schema exactly.
 */

import type { Database } from '@/lib/repositories/schema'
import {
  cancelScheduleControl,
  pauseSchedule,
  publishNowSchedule,
  reconfirmSchedule,
  rescheduleSchedule,
} from '@/lib/schedule-control'
import { recordNotification } from '@/lib/notifications'
import {
  getMobileScheduleView,
  type MobileScheduleView,
} from './view'
import {
  deterministicActionOperationId,
  type MobileScheduleAction,
} from './model'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

export interface MobileActionRequest {
  scheduleId: string
  action: MobileScheduleAction
  /** epoch seconds for reschedule (required when action === 'reschedule'). */
  newScheduledAt?: number
  /** IANA zone for reschedule (optional; defaults to the schedule's stored zone). */
  timezone?: string
  /** exact saved version for reconfirm (required when action === 'reconfirm'). */
  newVersion?: number
  /** audit actor label (optional; defaults to 'mobile-schedule'). */
  actor?: string
  /** epoch-second clock (test injection). */
  now?: number
}

export type MobileActionOutcome =
  | { outcome: 'ok'; result: unknown; schedule: MobileScheduleView | null; operationId: string }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'not-found'; scheduleId: string }

async function recordAudit(
  db: Database,
  scheduleId: string,
  action: MobileScheduleAction,
  now: number,
): Promise<void> {
  // Best-effort audit trail via the shared notification kernel (dedup by source).
  try {
    await recordNotification(db, {
      notificationId: `b8-04:${action}:${scheduleId}`,
      sourceType: 'schedule',
      sourceId: scheduleId,
      title: `移动端排期操作：${action}`,
      detail: `已通过 #41 命令执行 ${action}`,
      now,
    })
  } catch {
    /* audit must never break the command — ignore */
  }
}

/** Dispatch a mobile schedule action onto the shared #41 command kernel. */
export async function dispatchMobileScheduleAction(
  db: Database,
  req: MobileActionRequest,
): Promise<MobileActionOutcome> {
  const now = req.now ?? unixNow()
  const actor = (req.actor ?? 'mobile-schedule').trim()

  if (!req.scheduleId || !req.scheduleId.trim()) {
    return { outcome: 'invalid', reason: 'scheduleId is required' }
  }

  // Re-read the schedule BEFORE acting — never trust a stale client object.
  const before = await getMobileScheduleView(db, req.scheduleId)
  if (!before) return { outcome: 'not-found', scheduleId: req.scheduleId }

  // Deterministic operation id computed SERVER-side (idempotency + audit).
  const seed =
    req.action === 'reschedule' ? req.newScheduledAt : req.action === 'reconfirm' ? req.newVersion : undefined
  const operationId = deterministicActionOperationId(req.scheduleId, req.action, seed)

  let result: unknown
  switch (req.action) {
    case 'pause':
      result = await pauseSchedule(db, { scheduleId: req.scheduleId, operationId, actor, now })
      break
    case 'reconfirm': {
      if (!Number.isInteger(req.newVersion) || (req.newVersion as number) <= 0) {
        return { outcome: 'invalid', reason: 'newVersion must be a positive integer' }
      }
      result = await reconfirmSchedule(db, {
        scheduleId: req.scheduleId,
        operationId,
        actor,
        newVersion: req.newVersion as number,
        now,
      })
      break
    }
    case 'reschedule': {
      if (!Number.isInteger(req.newScheduledAt) || (req.newScheduledAt as number) <= 0) {
        return { outcome: 'invalid', reason: 'newScheduledAt must be a positive epoch second' }
      }
      result = await rescheduleSchedule(db, {
        scheduleId: req.scheduleId,
        operationId,
        actor,
        newScheduledAt: req.newScheduledAt as number,
        timezone: req.timezone,
        now,
      })
      break
    }
    case 'cancel':
      result = await cancelScheduleControl(db, { scheduleId: req.scheduleId, operationId, actor, now })
      break
    case 'publish_now':
      result = await publishNowSchedule(db, { scheduleId: req.scheduleId, operationId, actor, now })
      break
    default:
      return { outcome: 'invalid', reason: `unknown action '${String(req.action)}'` }
  }

  await recordAudit(db, req.scheduleId, req.action, now)

  // Re-read AFTER the command so the response reflects D1, not client state.
  const after = await getMobileScheduleView(db, req.scheduleId)
  return { outcome: 'ok', result, schedule: after, operationId }
}
