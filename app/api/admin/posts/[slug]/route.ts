import { deletePost, getPostBySlug, updatePost } from '@/lib/db'
import { isAdminAuthenticated, COOKIE_NAME } from '@/lib/admin-auth'
import { invalidatePublicContentCache } from '@/lib/cache'
import { getByPostRef, listVersions } from '@/lib/repositories/articles'
import {
  buildAutoDescription,
  extractMarkdownDescription,
  normalizePostSlug,
  stripMarkdownFrontmatter,
} from '@/lib/post-utils'
import { enqueueBackgroundJob } from '@/lib/background-jobs'
import { getRouteContextWithDb, jsonError, jsonOk, parseJsonBody } from '@/lib/server/route-helpers'
import { rethrowIfDatabaseMigrationRequired, withDatabaseErrorResponse } from '@/lib/database-errors'
import { versionedWriteGuard } from '@/lib/rollout-controls'
import type { NextRequest } from 'next/server'

async function checkAuth(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  return isAdminAuthenticated(token)
}

type Ctx = { params: Promise<{ slug: string }> }

// 获取单篇文章（编辑用）
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

// 更新文章
async function updatePostRoute(req: NextRequest, { params }: Ctx) {
  if (!(await checkAuth(req))) {
    return jsonError('Unauthorized', 401)
  }

  const { slug } = await params
  const route = await getRouteContextWithDb('DB not configured')
  if (!route.ok) return route.response
  const { env, db, ctx } = route

  const post = await getPostBySlug(db, slug)
  if (!post) return jsonError('文章不存在', 404)

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

    // B2-06: once an article is under versioned authority (identity + >=1 version
    // snapshot), the generic field PATCH may no longer touch lifecycle/status or
    // article-level state directly — those go through the explicit command route
    // (/api/article-commands) with expected version + operation id preconditions.
    // Content writes (title/html/content) were already rejected by B2-05. When the
    // identity shadow tables are absent (e.g. a ledger-only test DB that never ran
    // the article-identity DDL), the article has not switched to versioned
    // authority — keep the legacy compatible path instead of 503'ing.
    const hasVersionedAuthority = await (async () => {
      try {
        const identity = await getByPostRef(db, post.id)
        if (!identity) return false
        const versions = await listVersions(db, identity.id)
        return versions.length > 0
      } catch {
        return false
      }
    })()
    if (!hasVersionedAuthority) {
      // Ledger-only DB — this is a versionless legacy write. B2-G: once the
      // rollout closes the legacy producer or enables authority, the direct
      // `posts` write is refused (management writes go through the kernel).
      const guard = await versionedWriteGuard(db, { requireProducer: true })
      if (guard.refused) return jsonError(guard.message!, 409)
    }

    if (hasVersionedAuthority) {
      const lifecycleFields = ['status', 'is_pinned', 'is_hidden', 'password', 'category'] as const
      const blocked = lifecycleFields.filter((field) => field in body)
      if (blocked.length > 0) {
        return jsonError(
          `这篇文章已启用版本化写入，请通过 /api/article-commands 的显式命令修改: ${blocked.join(', ')}（携带 expectedVersion + operationId）`,
          409,
        )
      }
      if ('title' in body || 'html' in body || 'content' in body) {
        return jsonError('这篇文章已启用版本化写入，请使用版本化保存入口', 409)
      }
    }

    const {
      slug: nextSlugRaw,
      title,
      content,
      html,
      category,
      status,
      password,
      is_pinned,
      is_hidden,
      cover_image,
      tags,
      description,
    } = body

    const nextSlug = typeof nextSlugRaw === 'string' ? normalizePostSlug(nextSlugRaw) : ''
    const rawContent = typeof content === 'string' ? content : ''
    const normalizedContent = typeof content === 'string' ? stripMarkdownFrontmatter(content) : undefined
    const normalizedDescription = typeof description === 'string' && description.trim()
      ? description.trim()
      : typeof content === 'string'
        ? extractMarkdownDescription(rawContent) || buildAutoDescription(rawContent)
        : undefined

    await updatePost(db, post.id, {
      slug: nextSlug || undefined,
      title,
      content: normalizedContent,
      html,
      category,
      status,
      password,
      is_pinned,
      is_hidden,
      cover_image,
      tags,
      description: normalizedDescription,
    })

    // 清除 KV 缓存（失败不影响保存结果）
    try {
      await invalidatePublicContentCache(env)
    } catch (cacheErr) {
      console.warn('Cache invalidation failed:', cacheErr)
    }

    await enqueueBackgroundJob(
      env,
      {
        type: 'sync-post-related-index',
        postId: post.id,
      },
      {
        waitUntil: ctx?.waitUntil?.bind(ctx),
      },
    )

    return jsonOk({ success: true, slug: nextSlug || slug })
  } catch (err) {
    rethrowIfDatabaseMigrationRequired(err)
    if (err instanceof Error && /UNIQUE constraint failed: posts\.slug/i.test(err.message)) {
      return jsonError('slug 已存在，请换一个', 409)
    }
    console.error('PUT /api/admin/posts/[slug] error:', err)
    return jsonError(err instanceof Error ? err.message : '保存失败', 500)
  }
}

// 删除文章
async function deletePostRoute(req: NextRequest, { params }: Ctx) {
  if (!(await checkAuth(req))) {
    return jsonError('Unauthorized', 401)
  }

  const { slug } = await params
  const route = await getRouteContextWithDb('DB not configured')
  if (!route.ok) return route.response
  const { env, db, ctx } = route

  try {
    const post = await getPostBySlug(db, slug)
    if (!post) {
      return jsonError('文章不存在', 404)
    }

    await deletePost(db, slug)

    // 清除 KV 缓存（失败不影响删除结果）
    try {
      await invalidatePublicContentCache(env)
    } catch (cacheErr) {
      console.warn('Cache invalidation failed:', cacheErr)
    }

    await enqueueBackgroundJob(
      env,
      {
        type: 'delete-post-related-index',
        postId: post.id,
      },
      {
        waitUntil: ctx?.waitUntil?.bind(ctx),
      },
    )

    return jsonOk({ success: true })
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
