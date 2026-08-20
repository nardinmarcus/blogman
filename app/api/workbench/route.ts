/**
 * B4-04 — today workbench read-model route (issue #43).
 *
 * GET returns the "today" workbench projection grouped by responsible party
 * (author drafts / author schedules / system in-progress / author todos).
 * Read-only projection: every entry references an authoritative source and the
 * UI深链s by identity; rebuilding just re-queries authoritative facts.
 *
 *   ?focus=<key> — optional entry key the UI may route to (deep link re-reads
 *   current state; see lib/deep-link for the resolver doing the navigation).
 */

import type { NextRequest } from 'next/server'
import {
  ensureAuthenticatedRequest,
  getRouteContextWithDb,
  jsonError,
  jsonOk,
} from '@/lib/server/route-helpers'
import { migrationRequiredResponse } from '@/lib/database-errors'
import { buildTodayWorkbench } from '@/lib/workbench'

export async function GET(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { db } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const workbench = await buildTodayWorkbench(db)
    return jsonOk(workbench)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/workbench error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
  }
}
