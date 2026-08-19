/**
 * B2-08 — external write API adapter (issue #31).
 *
 * The Bearer/Agent/Obsidian/Chrome write entry. Every write flows through the
 * B2-03 version kernel (`lib/article-commands`) — this file never touches the
 * kernel internals. Two protocols:
 *
 *   - `protocol: 'v1'` → the editor-style action envelope
 *     (create / save / publishTemp) dispatched straight to the kernel with
 *     identity + expected version + operation id + full snapshot.
 *   - legacy (no protocol marker) → routed through the kernel too, but always
 *     as a DRAFT (even when `published` was requested), with a machine-readable
 *     upgrade signal and privacy-safe telemetry (client type / operation /
 *     time only). Once the external-write authority is switched to versioned,
 *     legacy versionless writes are rejected outright.
 *
 * Projections (cache invalidation + background index/AI jobs) run
 * out-of-transaction and are never fatal, matching the editor command route.
 */

import type { NextRequest } from 'next/server'
import type { ArticleCommandProjections } from '@/lib/article-commands'
import {
  createLegacyDraft,
  dispatchExternalWrite,
  isExternalWriteAuthoritySwitched,
  isVersionedProtocol,
  recordLegacyWrite,
  resolveArticleBySlug,
  resolveClientType,
  updateLegacyDraft,
  upgradeSignal,
  EXTERNAL_WRITE_PROTOCOL,
} from '@/lib/external-write-api'
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
type RouteCtx = { waitUntil?: (promise: Promise<unknown>) => void }

/** Out-of-transaction projections: cache + background index jobs, best-effort. */
function afterCommit(env: RouteEnv, ctx?: RouteCtx): ArticleCommandProjections {
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

/** Fail closed when the version kernel's schema is absent (never bypass it). */
async function identitySchemaMissing(db: D1Database): Promise<boolean> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('articles', 'article_versions')")
    .all<{ name: string }>()
  return tables.results.length !== 2
}

/** Attach the applied slug / published_at facts from the live posts projection. */
async function attachFacts<T>(db: D1Database, result: T): Promise<T & { slug?: string; publishedAt?: number | null }> {
  const r = result as T & { postRef?: number; slug?: string; publishedAt?: number | null }
  const outcome = (result as unknown as { outcome?: string }).outcome
  if (
    r.postRef !== undefined &&
    (outcome === 'applied' || outcome === 'created' || outcome === 'replayed' || outcome === 'existing')
  ) {
    const post = await db
      .prepare('SELECT slug, published_at FROM posts WHERE id = ?')
      .bind(r.postRef)
      .first<{ slug: string; published_at: number | null }>()
    if (post) {
      r.slug = post.slug
      r.publishedAt = post.published_at ?? null
    }
  }
  return r
}

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    if (await identitySchemaMissing(db)) {
      return jsonError('版本化写入内核未就绪：请先运行 scripts/apply-article-identity-ddl.mjs', 503)
    }

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const projections = afterCommit(env, ctx)
    const clientType = resolveClientType(req)

    // Versioned protocol: editor-style action envelope over the kernel.
    if (isVersionedProtocol(payload)) {
      const action = typeof payload.action === 'string' ? payload.action : ''
      const result = await dispatchExternalWrite(db, action, payload, projections)
      const error = (result as { error?: string; status?: number }).error
      if (error) return jsonError(error, (result as { status?: number }).status ?? 400)
      const attached = (await attachFacts(db, result)) as Record<string, unknown>
      return jsonOk({ protocol: EXTERNAL_WRITE_PROTOCOL, ...attached })
    }

    // Legacy create: draft-only through the kernel + upgrade signal + telemetry.
    if (await isExternalWriteAuthoritySwitched(db)) {
      return jsonError(
        '外部写入已切换到 versioned 协议：legacy 无版本写入已停用，请使用 protocol=v1（含创建幂等键与版本信息）',
        409,
      )
    }
    if (typeof payload.title !== 'string' || typeof payload.content !== 'string'
      || !payload.title.trim() || !payload.content.trim()) {
      return jsonError('标题和内容不能为空', 400)
    }

    const { result, snapshot } = await createLegacyDraft(db, payload, projections)
    if (result.outcome === 'slug-conflict') {
      return jsonError('slug 已存在，请换一个', 409)
    }
    if (result.outcome === 'skipped') {
      return jsonError('标题和内容不能为空', 400)
    }

    await recordLegacyWrite(db, { clientType, operation: 'create' })
    const attached = await attachFacts(db, result)
    return jsonOk({
      success: true,
      id: attached.postRef,
      articleId: result.articleId,
      slug: attached.slug ?? snapshot.slug,
      status: 'draft',
      version: result.version,
      category: snapshot.category,
      legacy: true,
      upgrade: upgradeSignal(false, '服务器已接受本次草稿创建，但 legacy 写入将随 authority 切换停用，请升级到 protocol=v1'),
    })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/posts error:', error)
    return jsonError(error instanceof Error ? error.message : '保存失败', 500)
  }
}

// PATCH: versioned save / legacy draft-only update (both through the kernel).
export async function PATCH(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    if (await identitySchemaMissing(db)) {
      return jsonError('版本化写入内核未就绪：请先运行 scripts/apply-article-identity-ddl.mjs', 503)
    }

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const projections = afterCommit(env, ctx)
    const clientType = resolveClientType(req)

    if (isVersionedProtocol(payload)) {
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
    }

    // Legacy update: rejected outright once the authority is versioned.
    if (await isExternalWriteAuthoritySwitched(db)) {
      return jsonError(
        '外部写入已切换到 versioned 协议：legacy 无版本更新已停用，请使用 protocol=v1（expectedVersion + operationId + 完整快照）',
        409,
      )
    }

    const currentSlug =
      typeof payload.current_slug === 'string'
        ? payload.current_slug.trim()
        : (typeof payload.slug === 'string' ? payload.slug.trim() : '')
    if (!currentSlug) return jsonError('slug 不能为空', 400)

    const updated = await updateLegacyDraft(db, currentSlug, payload, projections)
    if (!updated) {
      return jsonError(
        '该文章不在版本化写入门下：legacy 无版本更新无法应用，请用 protocol=v1 重新创建或更新',
        409,
      )
    }
    const { result, snapshot } = updated

    if (result.outcome === 'slug-conflict') {
      return jsonError('slug 已存在，请换一个', 409)
    }
    if (result.outcome === 'conflict') {
      return jsonOk({
        success: false,
        legacy: true,
        error: '并发版本冲突：请用 protocol=v1 带上 expectedVersion 重试',
        serverVersion: result.serverVersion,
        upgrade: upgradeSignal(false, '请升级到 protocol=v1 以处理版本冲突'),
      }, 409)
    }

    await recordLegacyWrite(db, { clientType, operation: 'update' })
    const attached = await attachFacts(db, result)
    return jsonOk({
      success: true,
      slug: (attached.slug ?? snapshot.slug) as string,
      status: 'draft',
      version: result.version,
      legacy: true,
      upgrade: upgradeSignal(false, '服务器已接受本次草稿更新，但 legacy 无版本更新将随 authority 切换停用，请升级到 protocol=v1'),
    })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('PATCH /api/posts error:', error)
    return jsonError(error instanceof Error ? error.message : '自动保存失败', 500)
  }
}