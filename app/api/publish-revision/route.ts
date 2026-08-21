/**
 * B3-02 — formal-article revision-loop route (issue #34).
 *
 * Thin adapter over the revision kernel:
 *
 *   - `POST promote`  — single-transaction go-live: writes the restore point
 *     first, then raises the active revision (new formal version + posts
 *     projection + public address) and writes the promotion event; external
 *     I/O (cache invalidation) runs only after the commit. Idempotent by
 *     revision id.
 *   - `POST discard`  — drops the active revision with zero live change.
 *   - `GET`           — read the full revision-loop state (formal anchor,
 *     active revision, promotion history, latest restore point) for the
 *     editor / workbench / guard.
 *
 * No business logic lives here; the kernel owns every fact. Editing itself
 * flows through the shared `/api/article-commands` save (which routes formal
 * articles into the revision surface), so the browser autosave never touches
 * the live row until a promote commits.
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
import { discardRevision, promoteRevision, readRevisionState, compareRevision, restoreRevisionSnapshot, saveRestorePoint, undoRestoreOperation } from '@/lib/publish-revision'
import { getSiteUrl } from '@/lib/site-config'
import { normalizePostSlug } from '@/lib/post-utils'
import { resolveArticleAddress } from '@/lib/slug-address'

type RouteEnv = RouteDbEnv

/** Best-effort external I/O after a committed promotion (cache invalidation). */
function afterPromote(env: RouteEnv) {
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

    if (action === 'promote') {
      const revisionId = typeof payload.revisionId === 'string' ? payload.revisionId.trim() : ''
      const rawArticleId = Number(payload.articleId)
      const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : undefined
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!revisionId && !articleId) {
        return jsonError('promote: revisionId 或 articleId 必填', 400)
      }
      const result = await promoteRevision(db, {
        revisionId: revisionId || undefined,
        articleId,
        actor,
        siteUrl: (env.NEXT_PUBLIC_SITE_URL?.trim() || getSiteUrl()).replace(/\/+$/, ''),
        afterCommit: afterPromote(env),
      })
      return jsonOk(result)
    }

    if (action === 'discard') {
      const revisionId = typeof payload.revisionId === 'string' ? payload.revisionId.trim() : ''
      const rawArticleId = Number(payload.articleId)
      const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : undefined
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!revisionId && !articleId) {
        return jsonError('discard: revisionId 或 articleId 必填', 400)
      }
      const result = await discardRevision(db, {
        revisionId: revisionId || undefined,
        articleId,
        actor,
      })
      return jsonOk(result)
    }

    // B3-03 (issue #35): compare / restore / undo / preflight snapshot.
    if (action === 'compare') {
      const rawArticleId = Number(payload.articleId)
      const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : undefined
      const expectedVersion = Number(payload.expectedVersion)
      const revisionId = typeof payload.revisionId === 'string' ? payload.revisionId.trim() : undefined
      if (!articleId || !Number.isInteger(expectedVersion)) {
        return jsonError('compare: articleId 与 expectedVersion 必填', 400)
      }
      const result = await compareRevision(db, {
        articleId,
        expectedVersion,
        revisionId: revisionId || undefined,
      })
      return jsonOk(result)
    }

    if (action === 'restore') {
      const restorePointId = typeof payload.restorePointId === 'string' ? payload.restorePointId.trim() : ''
      const rawArticleId = Number(payload.articleId)
      const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : undefined
      const rawVersion = Number(payload.expectedVersion)
      const expectedVersion = Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : undefined
      const target = payload.target === 'draft' ? 'draft' : payload.target === 'revision' ? 'revision' : undefined
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!restorePointId || !target) {
        return jsonError('restore: restorePointId 与 target(revision|draft) 必填', 400)
      }
      const result = await restoreRevisionSnapshot(db, {
        restorePointId,
        articleId,
        expectedVersion,
        target,
        actor,
      })
      return jsonOk(result)
    }

    if (action === 'undo-restore') {
      const restoreOperationId = typeof payload.restoreOperationId === 'string' ? payload.restoreOperationId.trim() : ''
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!restoreOperationId) {
        return jsonError('undo-restore: restoreOperationId 必填', 400)
      }
      const result = await undoRestoreOperation(db, { restoreOperationId, actor })
      return jsonOk(result)
    }

    if (action === 'save-restore-point') {
      const rawArticleId = Number(payload.articleId)
      const articleId = Number.isInteger(rawArticleId) && rawArticleId > 0 ? rawArticleId : undefined
      const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : 'manual'
      const actor = typeof payload.actor === 'string' && payload.actor.trim() ? payload.actor.trim() : 'admin'
      if (!articleId) {
        return jsonError('save-restore-point: articleId 必填', 400)
      }
      const result = await saveRestorePoint(db, { articleId, actor, reason })
      return jsonOk(result)
    }

    return jsonError('未知 action', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/publish-revision error:', error)
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
      // Slug resolution through the permanent address registry (ADR 0009) —
      // historical addresses single-hop to the article's current address.
      const resolved = await resolveArticleAddress(db, normalizePostSlug(slug))
      if (!resolved) return jsonOk({ articleId: null, state: null })
      articleId = resolved.articleId
    }
    if (!articleId) return jsonError('GET /api/publish-revision: articleId 或 slug 必填', 400)

    const state = await readRevisionState(db, articleId)
    return jsonOk({ articleId, state })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/publish-revision error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
  }
}