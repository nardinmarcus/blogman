/**
 * B3-01 — first formal publish route (issue #33).
 *
 * Thin adapter over the first-publish command kernel:
 *
 *   - `POST prepare`  — deterministic workbench preparation (evaluates and
 *     persists the four blockers for the confirmed server version).
 *   - `POST confirm`  — single-transaction first publish: re-checks version /
 *     lifecycle / slug / four blockers, writes the first publish time, the
 *     single event and the outbox row, then runs external I/O after commit.
 *   - `POST cancel`   — aborts a prepared-but-not-committed plan.
 *   - `POST receipt`  — the independent blog verifier posts back the receipt
 *     bound to the event that produced the public address.
 *   - `GET`           — read the full publication state for the workbench /
 *     editor confirmation surface.
 *
 * No business logic lives here; the kernel owns every fact.
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
import {
  cancelPrepare,
  confirmPublish,
  preparePublish,
  readPublicationState,
  recordReceipt,
} from '@/lib/first-publish'
import { getSiteUrl } from '@/lib/site-config'
import { normalizePostSlug } from '@/lib/post-utils'
import { getPostBySlug } from '@/lib/db'

type RouteEnv = RouteDbEnv

/** Best-effort external I/O after a committed confirm (cache invalidation). */
function afterConfirm(env: RouteEnv) {
  return async (_outbox: { event_id: string; article_id: number; payload: string }) => {
    await invalidatePublicContentCache(env)
    // The independent blog verifier reads the outbox row and posts the receipt
    // back through POST /api/first-publish (action=receipt).
  }
}

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db } = route

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const action = payload.action

    if (action === 'receipt') {
      // Independent verifier endpoint: a shared secret gates the receipt write.
      const token = (env as unknown as Record<string, string | undefined>).RECEIPT_TOKEN
      if (token) {
        const provided = req.headers.get('x-receipt-token') ?? ''
        if (provided !== token) return jsonError('receipt: unauthorized', 401)
      }
      const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : ''
      const verified = payload.verified === true || payload.verified === 1
      const receiptPayload = JSON.stringify(payload.receipt ?? { verified })
      if (!eventId) return jsonError('receipt: eventId 不能为空', 400)
      const result = await recordReceipt(db, { eventId, verified, receiptPayload })
      return jsonOk(result)
    }

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    if (action === 'prepare') {
      const prepareId = typeof payload.prepareId === 'string' ? payload.prepareId.trim() : ''
      const articleId = Number(payload.articleId)
      const confirmedVersion = Number(payload.confirmedVersion)
      const slug = normalizePostSlug(typeof payload.slug === 'string' ? payload.slug : '')
      const title = typeof payload.title === 'string' ? payload.title.trim() : ''
      const contentSha256 = typeof payload.contentSha256 === 'string' ? payload.contentSha256.trim().toLowerCase() : ''
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!prepareId || !Number.isInteger(articleId) || !Number.isInteger(confirmedVersion)) {
        return jsonError('prepare: prepareId / articleId / confirmedVersion 无效', 400)
      }
      const result = await preparePublish(db, {
        prepareId,
        articleId,
        confirmedVersion,
        slug,
        title,
        contentSha256,
        actor,
      })
      return jsonOk(result)
    }

    if (action === 'confirm') {
      const intentId = typeof payload.intentId === 'string' ? payload.intentId.trim() : ''
      const prepareId = typeof payload.prepareId === 'string' ? payload.prepareId.trim() : ''
      const articleId = Number(payload.articleId)
      const expectedVersion = Number(payload.expectedVersion)
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!intentId || !prepareId || !Number.isInteger(articleId) || !Number.isInteger(expectedVersion)) {
        return jsonError('confirm: intentId / prepareId / articleId / expectedVersion 无效', 400)
      }
      const result = await confirmPublish(db, {
        intentId,
        prepareId,
        articleId,
        expectedVersion,
        actor,
        siteUrl: (env.NEXT_PUBLIC_SITE_URL?.trim() || getSiteUrl()).replace(/\/+$/, ''),
        afterCommit: afterConfirm(env),
      })
      return jsonOk(result)
    }

    if (action === 'cancel') {
      const prepareId = typeof payload.prepareId === 'string' ? payload.prepareId.trim() : ''
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!prepareId) return jsonError('cancel: prepareId 不能为空', 400)
      const result = await cancelPrepare(db, prepareId, actor)
      return jsonOk(result)
    }

    return jsonError('未知 action', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/first-publish error:', error)
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
    const slug = url.searchParams.get('slug')

    let articleId = 0
    if (Number.isInteger(rawArticleId) && rawArticleId > 0) {
      articleId = rawArticleId
    } else if (slug) {
      const post = await getPostBySlug(db, normalizePostSlug(slug))
      if (!post) return jsonOk({ articleId: null, state: null })
      const article = await db
        .prepare('SELECT id FROM articles WHERE post_ref = ?')
        .bind(post.id)
        .first<{ id: number }>()
      if (!article) return jsonOk({ articleId: null, state: null })
      articleId = article.id
    }
    if (!articleId) return jsonError('GET /api/first-publish: articleId 或 slug 必填', 400)

    const state = await readPublicationState(db, articleId)
    return jsonOk({ articleId, state })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/first-publish error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
  }
}