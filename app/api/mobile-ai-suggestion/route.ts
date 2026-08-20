/**
 * B8-03 — mobile local-AI suggestion route (issue #62).
 *
 * Thin transport over the mobile local-AI kernel, which in turn reuses the
 * SHARED #38 suggestion protocol (same tables, same commands):
 *
 *   - `POST request`   — the author selects text on mobile and asks for a LOCAL
 *     (mock-AI) suggestion; it is RECORDED as a version-bound `content`
 *     suggestion, never auto-applied and never a live post fact.
 *   - `GET`            — the existing version-bound suggestion list (shared #38
 *     read model). Pending suggestions whose bound body / version moved are
 *     reported `stale`.
 *   - `POST apply`     — apply one suggestion through the shared write kernel
 *     (expected-version save; first apply of a result builds ONE restore point).
 *   - `POST revoke`    — undo an APPLIED suggestion back to its anchored body.
 *   - `POST ignore`    — dismiss a pending suggestion without applying.
 *
 * No business logic lives here; the #38 kernel owns every fact. Request failure
 * is best-effort and never blocks the editor's save/publish path.
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
import { requestMobileSuggestion } from '@/lib/mobile-ai-suggestion'
import {
  applySuggestion,
  revokeSuggestion,
  ignoreSuggestion,
  readSuggestionState,
} from '@/lib/publish-suggestions'

type RouteEnv = RouteDbEnv

function afterCommit(env: RouteEnv) {
  return async () => {
    await invalidatePublicContentCache(env)
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
    if (!articleId) return jsonError('GET /api/mobile-ai-suggestion: articleId 必填', 400)

    const state = await readSuggestionState(db, articleId)
    return jsonOk({ articleId, state })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/mobile-ai-suggestion error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
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
    const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'

    // Request a local AI suggestion for the selected text (mock-AI, version-bound).
    if (action === 'request') {
      const articleId = Number(payload.articleId ?? '')
      const selectedText = typeof payload.selectedText === 'string' ? payload.selectedText : ''
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
      if (!Number.isInteger(articleId) || articleId < 1) return jsonError('request: articleId 必填', 400)
      if (!selectedText.trim()) return jsonError('request: selectedText 必填', 400)
      if (!operationId) return jsonError('request: operationId 必填', 400)
      const result = await requestMobileSuggestion(db, { articleId, selectedText, operationId, actor })
      return jsonOk(result)
    }

    // The three #38 author commands, reused verbatim.
    const suggestionId = typeof payload.suggestionId === 'string' ? payload.suggestionId.trim() : ''
    if (!suggestionId) return jsonError('suggestionId 必填', 400)

    if (action === 'apply') {
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
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
      const result = await ignoreSuggestion(db, { suggestionId, actor })
      return jsonOk(result)
    }

    return jsonError('未知 action (request|apply|revoke|ignore)', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/mobile-ai-suggestion error:', error)
    return jsonError(error instanceof Error ? error.message : '命令失败', 500)
  }
}
