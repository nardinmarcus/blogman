/**
 * B4-04 — activity notification route (issue #43).
 *
 * Thin adapter over the D1-backed notification kernel:
 *   - GET          — list all notifications (D1 is the source of record),
 *   - POST record  — record a notification reference (dedup by source),
 *   - POST ack     — "已知晓": silence EXTERNAL reminder only, never resolves,
 *   - POST resolve — explicit, separate — mark the underlying item handled.
 *
 * No business logic lives here; the kernel owns the lifecycle invariants.
 */

import type { NextRequest } from 'next/server'
import {
  ensureAuthenticatedRequest,
  getRouteContextWithDb,
  jsonError,
  jsonOk,
  parseJsonBody,
} from '@/lib/server/route-helpers'
import { migrationRequiredResponse } from '@/lib/database-errors'
import {
  acknowledgeNotification,
  listNotifications,
  recordNotification,
  resolveNotification,
} from '@/lib/notifications'

export async function GET(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { db } = route
    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError
    const notifications = await listNotifications(db)
    return jsonOk({ notifications })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/notifications error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { db } = route
    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const action = payload.action

    if (action === 'record') {
      const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId.trim() : ''
      const sourceType = typeof payload.sourceType === 'string' ? payload.sourceType.trim() : ''
      const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId.trim() : ''
      const title = typeof payload.title === 'string' ? payload.title.trim() : ''
      const detail = typeof payload.detail === 'string' && payload.detail.trim() ? payload.detail.trim() : null
      if (!notificationId || !sourceType || !sourceId || !title) {
        return jsonError('record: notificationId/sourceType/sourceId/title 必填', 400)
      }
      return jsonOk(await recordNotification(db, { notificationId, sourceType, sourceId, title, detail }))
    }

    if (action === 'ack' || action === 'resolve') {
      const sourceType = typeof payload.sourceType === 'string' ? payload.sourceType.trim() : ''
      const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId.trim() : ''
      if (!sourceType || !sourceId) return jsonError(`${action}: sourceType/sourceId 必填`, 400)
      const result =
        action === 'ack'
          ? await acknowledgeNotification(db, { sourceType, sourceId })
          : await resolveNotification(db, { sourceType, sourceId })
      return jsonOk(result)
    }

    return jsonError('未知 action (record|ack|resolve)', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/notifications error:', error)
    return jsonError(error instanceof Error ? error.message : '命令失败', 500)
  }
}
