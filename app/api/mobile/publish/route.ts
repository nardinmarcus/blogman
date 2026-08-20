/**
 * B8-05 — mobile full-page publish confirmation API (issue #64).
 *
 * A THIN authenticated adapter around the SHARED #33/#34 publish kernels. The
 * server re-reads D1, re-verifies the exact version / path / lifecycle, then
 * dispatches through `confirmMobilePublish` (which runs prepare+confirm for a
 * first publish, or promote for a revision, with deterministic
 * idempotency) and re-reads the 博客/排期/渠道 receipt surfaces.
 *
 * GET  ?articleId=:  authoritative full-page confirmation (path, exact version
 *                    content, blocker status, existing public address).
 * POST:               run ONE mobile publish confirm through the shared kernel,
 *                    returning the normalized result + combined receipt.
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
import { invalidatePublicContentCache } from '@/lib/cache'
import { getSiteUrl } from '@/lib/site-config'
import { confirmMobilePublish, getMobilePublishConfirmation } from '@/lib/mobile-publish'
import type { MobilePublishPath } from '@/lib/mobile-publish'

export async function GET(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { db } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const url = new URL(req.url)
    const rawArticleId = Number(url.searchParams.get('articleId') ?? '')
    if (!Number.isInteger(rawArticleId) || rawArticleId <= 0) {
      return jsonError('GET /api/mobile/publish: articleId 必填', 400)
    }

    const confirmation = await getMobilePublishConfirmation(db, rawArticleId)
    if (!confirmation) return jsonOk({ confirmation: null })
    return jsonOk({ confirmation })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/mobile/publish error:', error)
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

    if (action === 'confirm') {
      const rawArticleId = Number(payload.articleId)
      const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : 0
      const path = (typeof payload.path === 'string' && (payload.path === 'first' || payload.path === 'revision')
        ? payload.path
        : 'first') as MobilePublishPath
      const rawExpected = Number(payload.expectedVersion)
      if (!articleId) return jsonError('confirm: articleId 必填', 400)
      if (!Number.isInteger(rawExpected) || rawExpected <= 0) {
        return jsonError('confirm: expectedVersion 必填', 400)
      }

      const result = await confirmMobilePublish(db, {
        articleId,
        path,
        expectedVersion: rawExpected,
        actor: 'mobile-publish',
        siteUrl: (env.NEXT_PUBLIC_SITE_URL?.trim() || getSiteUrl()).replace(/\/+$/, ''),
        afterCommit: async () => {
          await invalidatePublicContentCache(env)
        },
      })
      return jsonOk(result)
    }

    return jsonError('未知 action', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/mobile/publish error:', error)
    return jsonError(error instanceof Error ? error.message : '命令失败', 500)
  }
}
