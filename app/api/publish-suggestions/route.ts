/**
 * B3-06 — version-bound publish suggestion route (issue #38).
 *
 * Thin adapter over the suggestion kernel:
 *
 *   - `GET`                 — preview: the per-article current preparation
 *     result + every version-bound suggestion with its live status (pending
 *     suggestions whose bound version / body / field moved are reported stale).
 *   - `POST apply`          — the author explicitly applies ONE suggestion.
 *     The change flows through the shared article write kernel; the first apply
 *     of a result builds exactly ONE restore point (reused by the rest).
 *   - `POST revoke`         — undo an APPLIED suggestion (revert the field to
 *     its analysis-time baseline) through the write kernel.
 *   - `POST ignore`         — dismiss a pending suggestion without applying.
 *
 * No business logic lives here; the kernel owns every fact. The background AI
 * records suggestions itself (never through this route) and never writes a live
 * post fact.
 */

import type { NextRequest } from 'next/server'
import {
  ensureAuthenticatedRequest,
  getRouteContextWithDb,
  jsonError,
  jsonOk,
  parseJsonBody,
  type RouteDbEnv,
} from '@/lib/server/route-helpers'
import { migrationRequiredResponse } from '@/lib/database-errors'
import { invalidatePublicContentCache } from '@/lib/cache'
import { applySuggestion, ignoreSuggestion, readSuggestionState, revokeSuggestion } from '@/lib/publish-suggestions'

type RouteEnv = RouteDbEnv

function afterCommit(env: RouteEnv) {
  return async () => {
    await invalidatePublicContentCache(env)
  }
}

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const action = payload.action
    const suggestionId = typeof payload.suggestionId === 'string' ? payload.suggestionId.trim() : ''
    const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'

    if (action === 'apply') {
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
      if (!suggestionId) return jsonError('apply: suggestionId 必填', 400)
      if (!operationId) return jsonError('apply: operationId 必填', 400)
      const result = await applySuggestion(db, {
        suggestionId,
        actor,
        operationId,
        projections: { afterCommit: afterCommit(env) },
      })
      return jsonOk(result)
    }

    if (action === 'revoke') {
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
      if (!suggestionId) return jsonError('revoke: suggestionId 必填', 400)
      if (!operationId) return jsonError('revoke: operationId 必填', 400)
      const result = await revokeSuggestion(db, {
        suggestionId,
        actor,
        operationId,
        projections: { afterCommit: afterCommit(env) },
      })
      return jsonOk(result)
    }

    if (action === 'ignore') {
      if (!suggestionId) return jsonError('ignore: suggestionId 必填', 400)
      const result = await ignoreSuggestion(db, { suggestionId, actor })
      return jsonOk(result)
    }

    return jsonError('未知 action (apply|revoke|ignore)', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/publish-suggestions error:', error)
    return jsonError(error instanceof Error ? error.message : '命令失败', 500)
  }
}

export async function GET(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { db } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const url = new URL(req.url)
    const rawArticleId = Number(url.searchParams.get('articleId') ?? '')
    const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : 0
    if (!articleId) return jsonError('GET /api/publish-suggestions: articleId 必填', 400)

    const state = await readSuggestionState(db, articleId)
    return jsonOk({ articleId, state })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/publish-suggestions error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
  }
}
