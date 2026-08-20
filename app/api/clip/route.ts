/**
 * B7-01 — Chrome 剪藏 entry route (issue #57).
 *
 * The dedicated Chrome clip endpoint. It normalizes the source URL to an
 * idempotent identity, creates the DRAFT article + a pending `clip`-role source
 * link on first clip, and returns the EXISTING article identity on a repeated
 * clip (不重复建). The clipped page is a reference source — it NEVER becomes the
 * primary source, and existing articles are never backfilled.
 *
 * This route is the sole producer of the clip source link: Agent/API create
 * (B6) stays `primary`, so only the Chrome entry builds a reference relationship.
 */

import type { NextRequest } from 'next/server'
import { clipArticle } from '@/lib/clip'
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
import { enqueueBackgroundJob } from '@/lib/background-jobs'

type RouteEnv = RouteDbEnv

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const url = typeof payload.url === 'string' ? payload.url : ''
    const title = typeof payload.title === 'string' ? payload.title : ''
    const content = typeof payload.content === 'string' ? payload.content : ''
    const html = typeof payload.html === 'string' ? payload.html : undefined
    if (!url.trim()) return jsonError('url 不能为空', 400)

    const result = await clipArticle(db, {
      url,
      title,
      content,
      ...(html ? { html } : {}),
      projections: {
        afterCommit: async (r) => {
          await invalidatePublicContentCache(env)
          await enqueueBackgroundJob(
            env,
            { type: 'sync-post-related-index', postId: r.postRef },
            { waitUntil: ctx?.waitUntil?.bind(ctx) },
          )
          if (!r.existing) {
            await enqueueBackgroundJob(
              env,
              { type: 'process-post-ai', postId: r.postRef },
              { waitUntil: ctx?.waitUntil?.bind(ctx) },
            )
          }
        },
      },
    })

    if (result.outcome === 'invalid-source') {
      return jsonError('无法识别的来源 URL：仅支持 http(s) 绝对地址', 400)
    }
    if (result.outcome === 'skipped') {
      return jsonError('剪藏内容为空：请提供标题或正文', 400)
    }

    return jsonOk({
      outcome: result.outcome,
      articleId: result.articleId,
      postRef: result.postRef,
      version: result.version,
      creationId: result.creationId,
      existing: result.existing,
      source: result.source
        ? {
            canonicalUrl: result.source.sourceIdentity.canonicalUrl,
            identitySha256: result.source.sourceIdentity.identitySha256,
            link: result.source.link
              ? {
                  status: result.source.link.status,
                  role: result.source.link.role,
                  operationId: result.source.link.operationId,
                }
              : null,
          }
        : null,
    })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/clip error:', error)
    return jsonError(error instanceof Error ? error.message : '剪藏失败', 500)
  }
}
