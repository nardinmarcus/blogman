import { getPostBySlug } from '@/lib/db'
import { isAdminAuthenticated, COOKIE_NAME } from '@/lib/admin-auth'
import { invalidatePublicContentCache } from '@/lib/cache'
import {
  restore,
  setCategory,
  setHidden,
  setPassword,
  setPinned,
  softDelete,
} from '@/lib/article-commands'
import { getRouteContextWithDb, jsonError, jsonOk, parseJsonBody } from '@/lib/server/route-helpers'
import { rethrowIfDatabaseMigrationRequired, withDatabaseErrorResponse } from '@/lib/database-errors'
import { resolveArticleIdBySlug } from '@/lib/server/resolve-article'
import type { NextRequest } from 'next/server'

async function checkAuth(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  return isAdminAuthenticated(token)
}

type Ctx = { params: Promise<{ slug: string }> }

// 获取单篇文章（编辑用）— canonical read model
async function getPost(req: NextRequest, { params }: Ctx) {
  if (!(await checkAuth(req))) {
    return jsonError('Unauthorized', 401)
  }

  const { slug } = await params
  const route = await getRouteContextWithDb('DB not configured')
  if (!route.ok) return route.response

  const post = await getPostBySlug(route.db, slug)
  if (!post) return jsonError('文章不存在', 404)

  return jsonOk(post)
}

/**
 * 更新文章 — #234 Phase A: the legacy direct posts write is retired (ADR 0008).
 * Article-level field changes map onto the explicit command kernels
 * (expected version resolved from canonical facts server-side), so existing
 * admin UI calls keep working without carrying version tokens. Content edits
 * are refused: they belong to the versioned save entry.
 */
async function updatePostRoute(req: NextRequest, { params }: Ctx) {
  if (!(await checkAuth(req))) {
    return jsonError('Unauthorized', 401)
  }

  const { slug } = await params
  const route = await getRouteContextWithDb('DB not configured')
  if (!route.ok) return route.response
  const { env, db, ctx } = route

  const articleId = await resolveArticleIdBySlug(db, slug)
  if (!articleId) return jsonError('文章不存在', 404)

  try {
    const body = await parseJsonBody<{
      slug?: string
      title?: string
      content?: string
      html?: string
      category?: string
      status?: 'draft' | 'published' | 'deleted'
      password?: string | null
      is_pinned?: number
      is_hidden?: number
      cover_image?: string | null
      tags?: string[]
      description?: string
    }>(req)

    const contentFields = ['slug', 'title', 'content', 'html', 'cover_image', 'tags', 'description'] as const
    const touchedContent = contentFields.filter((field) => body[field] !== undefined)
    if (touchedContent.length > 0) {
      return jsonError('内容字段请通过版本化保存入口修改', 409)
    }

    // Resolve the current version fact for the command preconditions.
    const vRow = await db
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
      .bind(articleId)
      .first<{ version: number }>()
    const expectedVersion = vRow?.version ?? 0
    if (expectedVersion === 0) {
      // No canonical version facts — the legacy write surface is retired.
      return jsonError('文章尚未启用版本化写入', 409)
    }
    const operationId = `admin-put:${articleId}:${Date.now()}`

    const runCommand = async (
      command: (db: unknown, input: never) => Promise<{ outcome: string }>,
      input: Record<string, unknown>,
    ) => command(db, { articleId, expectedVersion, operationId, ...input } as never)

    let result: { outcome: string }
    if (body.is_pinned !== undefined) {
      result = await runCommand(setPinned as never, { is_pinned: body.is_pinned === 1 ? 1 : 0 })
    } else if (body.is_hidden !== undefined) {
      result = await runCommand(setHidden as never, { is_hidden: body.is_hidden === 1 ? 1 : 0 })
    } else if (body.password !== undefined) {
      result = await runCommand(setPassword as never, {
        password: typeof body.password === 'string' && body.password.trim() ? body.password.trim() : null,
      })
    } else if (body.category !== undefined) {
      result = await runCommand(setCategory as never, {
        category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null,
      })
    } else if (body.status === 'deleted') {
      result = await runCommand(softDelete as never, {})
    } else if (body.status === 'draft') {
      result = await runCommand(restore as never, {})
    } else if (body.status === 'published') {
      // Lifecycle transitions go through the explicit lifecycle surface.
      return jsonError('发布/下线请通过发布流程或 /api/article-lifecycle', 409)
    } else {
      return jsonError('没有可应用的字段', 400)
    }

    // Best-effort cache invalidation after an applied/replayed command.
    if (result.outcome === 'applied' || result.outcome === 'replayed') {
      try {
        await invalidatePublicContentCache(env)
      } catch (cacheErr) {
        console.warn('Cache invalidation failed:', cacheErr)
      }
    }
    void ctx
    return jsonOk({ success: true, outcome: result.outcome, slug })
  } catch (err) {
    rethrowIfDatabaseMigrationRequired(err)
    console.error('PUT /api/admin/posts/[slug] error:', err)
    return jsonError(err instanceof Error ? err.message : '保存失败', 500)
  }
}

// 删除文章 — soft delete through the explicit command (reversible; the hard
// delete of canonical rows is out of scope for the admin surface).
async function deletePostRoute(req: NextRequest, { params }: Ctx) {
  if (!(await checkAuth(req))) {
    return jsonError('Unauthorized', 401)
  }

  const { slug } = await params
  const route = await getRouteContextWithDb('DB not configured')
  if (!route.ok) return route.response
  const { env, db, ctx } = route

  try {
    const articleId = await resolveArticleIdBySlug(db, slug)
    if (!articleId) {
      return jsonOk({ success: false, error: '文章不存在' })
    }

    const vRow = await db
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
      .bind(articleId)
      .first<{ version: number }>()
    const expectedVersion = vRow?.version ?? 0
    if (expectedVersion === 0) {
      return jsonOk({ success: false, error: '文章尚未启用版本化写入' })
    }

    const result = await softDelete(db, {
      articleId,
      expectedVersion,
      operationId: `admin-delete:${articleId}:${Date.now()}`,
    })

    try {
      await invalidatePublicContentCache(env)
    } catch (cacheErr) {
      console.warn('Cache invalidation failed:', cacheErr)
    }

    void ctx
    return jsonOk({ success: true, outcome: result.outcome })
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    console.error('Delete post failed:', error)
    return jsonOk(
      {
        success: false,
        error: error instanceof Error ? error.message : '删除失败，请重试',
      },
      500,
    )
  }
}

export const GET = withDatabaseErrorResponse(getPost)
export const PUT = withDatabaseErrorResponse(updatePostRoute)
export const DELETE = withDatabaseErrorResponse(deletePostRoute)
