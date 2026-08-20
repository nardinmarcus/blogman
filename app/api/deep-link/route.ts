/**
 * B4-04 — safe deep-link resolution route (issue #43).
 *
 * POST accepts ONLY an identity (`sourceType` + `sourceId`) and returns the
 * current-state navigation resolved from live authoritative facts. It never
 * trusts stale parameters and never writes — expired identities fall through
 * to current reality (list / live article URL). The caller then navigates to
 * the returned `navigation.href`.
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
import { resolveDeepLink } from '@/lib/deep-link'

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { db } = route
    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const sourceType = payload.sourceType
    const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId.trim() : ''
    if (sourceType !== 'article' && sourceType !== 'schedule') {
      return jsonError('sourceType 必须是 article|schedule', 400)
    }
    if (!sourceId) return jsonError('sourceId 必填', 400)

    const resolution = await resolveDeepLink(db, { sourceType, sourceId })
    return jsonOk({ resolution })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/deep-link error:', error)
    return jsonError(error instanceof Error ? error.message : '解析失败', 500)
  }
}
