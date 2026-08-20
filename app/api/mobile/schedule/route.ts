/**
 * B8-04 — mobile schedule management API (issue #63).
 *
 * A THIN, authenticated adapter around the SHARED #41 schedule-control kernel.
 * Every action re-reads D1, dispatches through `dispatchMobileScheduleAction`
 * (which computes a deterministic operation id server-side and records an
 * audit notification), then re-reads the schedule — so responses always carry
 * post-action D1 facts and never depend on client-optimistic state.
 *
 * GET  <scheduleId>: authoritative read of one schedule + its article facts.
 * POST <scheduleId>: run one mobile action (pause / reconfirm / reschedule /
 *                    cancel / publish_now) through the shared kernel.
 */

import type { NextRequest } from 'next/server'
import {
  ensureAuthenticatedRequest,
  getRouteContextWithDb,
  jsonError,
  jsonOk,
  parseJsonBody,
} from '@/lib/server/route-helpers'
import { migrationRequiredResponse, rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { ensureScheduleControlTables } from '@/lib/schedule-control'
import {
  dispatchMobileScheduleAction,
  getMobileScheduleView,
  type MobileScheduleAction,
} from '@/lib/mobile-schedule'

const ALLOWED_ACTIONS: MobileScheduleAction[] = [
  'pause',
  'reconfirm',
  'reschedule',
  'cancel',
  'publish_now',
]

export async function GET(req: NextRequest) {
  const scheduleId = new URL(req.url).searchParams.get('scheduleId')
  if (!scheduleId) return jsonError('scheduleId is required', 400)

  const ctx = await getRouteContextWithDb()
  if (!ctx.ok) return ctx.response

  const auth = await ensureAuthenticatedRequest(req, ctx.db)
  if (auth) return auth

  let schedule: Awaited<ReturnType<typeof getMobileScheduleView>> | null = null
  try {
    schedule = await getMobileScheduleView(ctx.db, scheduleId)
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    console.error('mobile schedule read error:', error)
    return jsonError('读取排期失败', 500)
  }
  if (!schedule) return jsonError('排期不存在', 404)
  return jsonOk({ schedule })
}

export async function POST(req: NextRequest) {
  const ctx = await getRouteContextWithDb()
  if (!ctx.ok) return ctx.response

  const auth = await ensureAuthenticatedRequest(req, ctx.db)
  if (auth) return auth

  let payload: Record<string, unknown>
  try {
    payload = (await parseJsonBody<Record<string, unknown>>(req)) ?? {}
  } catch {
    return jsonError('请求体不是有效 JSON', 400)
  }

  // Guarantee the shared operation-ledger table exists (idempotent DDL).
  try {
    await ensureScheduleControlTables(ctx.db)
  } catch (error) {
    const response = migrationRequiredResponse(error)
    if (response) return response
    return jsonError('数据库就绪失败', 500)
  }

  const scheduleId = typeof payload.scheduleId === 'string' ? payload.scheduleId.trim() : ''
  const action = payload.action as MobileScheduleAction
  if (!scheduleId) return jsonError('scheduleId is required', 400)
  if (!ALLOWED_ACTIONS.includes(action)) return jsonError('不支持的动作', 400)

  const result = await dispatchMobileScheduleAction(ctx.db, {
    scheduleId,
    action,
    newScheduledAt: typeof payload.newScheduledAt === 'number' ? payload.newScheduledAt : undefined,
    timezone: typeof payload.timezone === 'string' ? payload.timezone : undefined,
    newVersion: typeof payload.newVersion === 'number' ? payload.newVersion : undefined,
    actor: 'mobile-schedule',
  })

  if (result.outcome === 'not-found') return jsonError('排期不存在', 404)
  if (result.outcome === 'invalid') return jsonError(result.reason, 400)

  // Surface the kernel outcome + the authoritative post-action schedule.
  return jsonOk({ result: result.result, schedule: result.schedule, operationId: result.operationId })
}
