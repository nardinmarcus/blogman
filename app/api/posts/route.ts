/**
 * B2-08 → L1 — external write API adapter (issues #31 / #66).
 *
 * The Bearer/Agent/Obsidian/Chrome write entry. After the L1 legacy-writer
 * demolition this route is the single versioned entry: every write (create /
 * save / publishTemp) is dispatched to the B2-03 version kernel
 * (`lib/article-commands`) with identity + expected version + operation id +
 * full snapshot.
 *
 * Legacy (no `protocol: 'v1'`) writes are rejected outright with a
 * machine-readable upgrade signal. There is no ledger-only direct-`posts`
 * compat fallback and no legacy draft adapter: when the versioned schema is
 * absent the kernel fails and `migrationRequiredResponse` returns a closed
 * 503. The `posts` table is retained purely as a read projection for slug /
 * published_at fact attachment.
 *
 * Projections (cache invalidation + background index/AI jobs) run
 * out-of-transaction and are never fatal, matching the editor command route.
 */

import type { NextRequest } from 'next/server'
import type { ArticleCommandProjections } from '@/lib/article-commands'
import {
  dispatchExternalWrite,
  isVersionedProtocol,
  resolveArticleBySlug,
} from '@/lib/external-write-api'
import { upgradeSignal, EXTERNAL_WRITE_PROTOCOL } from '@/lib/external-write-api'
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

/** Out-of-transaction projections: cache + background index jobs, best-effort. */
function afterCommit(env: RouteEnv, ctx?: { waitUntil?: (promise: Promise<unknown>) => void }): ArticleCommandProjections {
  return {
    afterCommit: async (result) => {
      await invalidatePublicContentCache(env)
      if (result.postRef) {
        await enqueueBackgroundJob(
          env,
          { type: 'sync-post-related-index', postId: result.postRef },
          { waitUntil: ctx?.waitUntil?.bind(ctx) },
        )
        if (result.operationId.startsWith('create:') && !result.existing) {
          await enqueueBackgroundJob(
            env,
            { type: 'process-post-ai', postId: result.postRef },
            { waitUntil: ctx?.waitUntil?.bind(ctx) },
          )
        }
      }
    },
  }
}

/** Attach the applied slug / published_at facts from CANONICAL sources:
 *  the current registry address + the latest frozen version snapshot. */
async function attachFacts<T>(db: D1Database, result: T): Promise<T & { slug?: string; publishedAt?: number | null }> {
  const r = result as T & { postRef?: number; slug?: string; publishedAt?: number | null }
  const outcome = (result as unknown as { outcome?: string }).outcome
  if (
    r.postRef !== undefined &&
    (outcome === 'applied' || outcome === 'created' || outcome === 'replayed' || outcome === 'existing')
  ) {
    const post = await db
      .prepare(
        `SELECT COALESCE(
            (SELECT slug FROM article_slug_addresses WHERE article_id = a.id AND kind = 'current'),
            json_extract(v.snapshot_json, '$.fields.slug')) AS slug,
          json_extract(v.snapshot_json, '$.fields.published_at') AS published_at
         FROM articles a
         JOIN article_versions v ON v.article_id = a.id
          AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
         WHERE a.post_ref = ?`,
      )
      .bind(r.postRef)
      .first<{ slug: string; published_at: number | null }>()
    if (post) {
      r.slug = post.slug
      r.publishedAt = post.published_at ?? null
    }
  }
  return r
}

/** Legacy (unversioned) requests are rejected outright with an upgrade signal. */
function rejectLegacyWrite(path: string): Response {
  return Response.json(
    {
      error: `${path}: legacy 无版本写入已停用，请使用 protocol=v1（含创建幂等键 / expectedVersion / operationId 与完整快照）`,
      upgrade: upgradeSignal(true, 'legacy 写入适配器已移除，请升级到 protocol=v1 版本化协议'),
    },
    { status: 409 },
  )
}

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const projections = afterCommit(env, ctx)

    // Versioned protocol only: editor-style action envelope over the kernel.
    if (!isVersionedProtocol(payload)) {
      return rejectLegacyWrite('POST')
    }

    const action = typeof payload.action === 'string' ? payload.action : ''
    const result = await dispatchExternalWrite(db, action, payload, projections)
    const error = (result as { error?: string; status?: number }).error
    if (error) return jsonError(error, (result as { status?: number }).status ?? 400)
    const attached = (await attachFacts(db, result)) as Record<string, unknown>
    return jsonOk({ protocol: EXTERNAL_WRITE_PROTOCOL, ...attached })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/posts error:', error)
    return jsonError(error instanceof Error ? error.message : '保存失败', 500)
  }
}

// PATCH: versioned save (by articleId or resolved slug). Legacy versionless
// updates are rejected outright — there is no legacy update adapter anymore.
export async function PATCH(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const projections = afterCommit(env, ctx)

    if (!isVersionedProtocol(payload)) {
      return rejectLegacyWrite('PATCH')
    }

    const articleId = Number(payload.articleId)
    const resolved =
      Number.isInteger(articleId) && articleId > 0
        ? null
        : await resolveArticleBySlug(
            db,
            typeof payload.current_slug === 'string'
              ? payload.current_slug
              : (typeof payload.slug === 'string' ? payload.slug : ''),
          )
    const finalArticleId = Number.isInteger(articleId) && articleId > 0
      ? articleId
      : resolved?.articleId ?? NaN
    const expectedVersion = Number(payload.expectedVersion)
    const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
    if (!Number.isInteger(finalArticleId) || !Number.isInteger(expectedVersion) || !operationId) {
      return jsonError('save: articleId / expectedVersion / operationId 无效', 400)
    }
    const result = await dispatchExternalWrite(db, 'save', {
      articleId: finalArticleId,
      expectedVersion,
      operationId,
      snapshot: payload.snapshot,
    }, projections)
    const error = (result as { error?: string; status?: number }).error
    if (error) return jsonError(error, (result as { status?: number }).status ?? 400)
    const attached = (await attachFacts(db, result)) as Record<string, unknown>
    return jsonOk({ protocol: EXTERNAL_WRITE_PROTOCOL, ...attached })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('PATCH /api/posts error:', error)
    return jsonError(error instanceof Error ? error.message : '自动保存失败', 500)
  }
}
