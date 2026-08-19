/**
 * B2-04 — versioned article command route (issue #27).
 *
 * The main editor's write entry into the B2-03 command kernel. It is a thin
 * adapter: it validates/coerces the client payload, dispatches to
 * `create` / `save` / `publishTemp` (lib/article-commands — never modified
 * here), attaches the applied slug / published_at facts the editor needs for
 * its confirmed-save comparison, and runs the out-of-transaction projections
 * (cache invalidation + background index jobs) best-effort.
 *
 * The editor drives all writes through this route: autosave (create/save),
 * the publish action (publishTemp) and the conflict "server version" read
 * (GET). Legacy single-page request sequencing or browser caches are never
 * migrated into server facts — the kernel's operation id / expected version
 * are the only server-side write protocols used.
 */

import type { NextRequest } from 'next/server'
import type { ArticleCommandProjections, ArticleCommandSnapshot } from '@/lib/article-commands'
import { create, publishTemp, save, setPinned, setHidden, setPassword, setCategory, softDelete, restore } from '@/lib/article-commands'
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
import { normalizePostSlug } from '@/lib/post-utils'
import { nanoid } from 'nanoid'
import { getPostBySlug, updatePost } from '@/lib/db'
import { getByPostRef, listVersions } from '@/lib/repositories/articles'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'

type RouteEnv = RouteDbEnv
type RouteCtx = { waitUntil?: (promise: Promise<unknown>) => void }

/** Coerce a raw client snapshot into the kernel's ArticleCommandSnapshot. */
function coerceSnapshot(raw: unknown): ArticleCommandSnapshot {
  const p = (raw ?? {}) as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const content = typeof p.content === 'string' ? p.content.trim() : ''
  const tags = Array.isArray(p.tags)
    ? (p.tags as unknown[])
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 10)
    : []
  return {
    slug: normalizePostSlug(typeof p.slug === 'string' ? p.slug : ''),
    title,
    content,
    html: typeof p.html === 'string' ? p.html.trim() : '',
    description: typeof p.description === 'string' ? p.description.trim() : null,
    category: typeof p.category === 'string' ? p.category.trim() : null,
    tags: tags.length > 0 ? tags : null,
    status: p.status === 'published' ? 'published' : 'draft',
    password: typeof p.password === 'string' && p.password.trim() ? p.password.trim() : null,
    is_pinned: p.is_pinned === 1 ? 1 : 0,
    is_hidden: p.is_hidden === 1 ? 1 : 0,
    cover_image: typeof p.cover_image === 'string' && p.cover_image.trim() ? p.cover_image.trim() : null,
    deleted_at: typeof p.deleted_at === 'number' ? p.deleted_at : null,
    published_at: typeof p.published_at === 'number' ? p.published_at : null,
    updated_at: null,
  }
}

/** Same auto-slug shape as the legacy POST /api/posts (date + nanoid suffix). */
function autoSlug(): string {
  const date = new Date().toISOString().split('T')[0]
  return `${date}-${nanoid(6)}`
}

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

/** Attach applied slug / published_at facts to success results for the editor. */
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

/** B2-06 — the versioned-authority facts for a post. Null when the identity tables are absent (a ledger-only DB that never ran the B2-02 DDL) so existing CRUD never 503s. */
async function versionedAuthority(
  db: D1Database,
  postRef: number,
): Promise<{ articleId: number; version: number } | null> {
  try {
    const identity = await getByPostRef(db, postRef)
    if (!identity) return null
    const versions = await listVersions(db, identity.id)
    if (versions.length === 0) return null
    return { articleId: identity.id, version: versions[0].version }
  } catch {
    return null
  }
}

/** Run the best-effort out-of-transaction projections for a content-affecting result. */
async function runProjectorsFor(
  projections: ArticleCommandProjections,
  result: { postRef: number; operationId: string; existing: boolean } | { postRef: number; operationId: string; existing?: boolean },
  projectionFailures: string[],
): Promise<void> {
  try {
    await projections.afterCommit?.(result as never)
  } catch (error) {
    projectionFailures.push(error instanceof Error ? error.message : String(error))
  }
}

/**
 * B2-06 — shared adapter for the independent (non-body) article-level commands.
 * Once a post is under versioned authority the write goes through the kernel's
 * explicit command (expected version + operation id preconditions). On a
 * ledger-only DB (identity tables absent) the same action falls back to the
 * legacy direct `updatePost` write so nothing 503s.
 */
async function dispatchArticleLevelAction(
  params: {
    action: string
    slug: string
    articleId: number
    expectedVersion: number
    operationId: string
    payload: Record<string, unknown>
    env: RouteEnv
    db: D1Database
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void }
  },
): Promise<Response> {
  const { action, slug, articleId, expectedVersion, operationId, payload, env, db, ctx } = params
  if (!slug || !Number.isInteger(articleId) || !Number.isInteger(expectedVersion) || !operationId.trim()) {
    return jsonError(`${action}: slug / articleId / expectedVersion / operationId 无效`, 400)
  }

  const post = await getPostBySlug(db, slug)
  if (!post) return jsonError(`${action}: 文章不存在 (${slug})`, 404)

  const projections = afterCommit(env, ctx)
  const failures: string[] = []
  const legacyWrite = async (data: Record<string, unknown>) => {
    await updatePost(db, post.id, data as Parameters<typeof updatePost>[2])
  }

  const authority = await versionedAuthority(db, post.id)
  if (!authority) {
    // Ledger-only DB — legacy compatible direct write, no version conditions exist.
    if (action === 'setPinned') await legacyWrite({ is_pinned: payload.is_pinned === 1 ? 1 : 0 })
    else if (action === 'setHidden') await legacyWrite({ is_hidden: payload.is_hidden === 1 ? 1 : 0 })
    else if (action === 'setPassword') await legacyWrite({ password: typeof payload.password === 'string' && payload.password.trim() ? payload.password.trim() : null })
    else if (action === 'setCategory') await legacyWrite({ category: typeof payload.category === 'string' && payload.category.trim() ? payload.category.trim() : null })
    else if (action === 'softDelete') await legacyWrite({ status: 'deleted' })
    else if (action === 'restore') await legacyWrite({ status: 'draft' })
    else return jsonError(`${action}: 未知动作`, 400)
    await runProjectorsFor(projections, { postRef: post.id, operationId, existing: false }, failures)
    return jsonOk({ outcome: 'legacy-applied', articleId, postRef: post.id, version: null, operationId, existing: false, projectionFailures: failures })
  }

  if (authority.articleId !== articleId) {
    return jsonError(`${action}: articleId 与 slug 不匹配 (期望 ${authority.articleId})`, 409)
  }

  const input = { articleId, expectedVersion, operationId }
  let result: { outcome: string; postRef: number; operationId: string; existing: boolean; projectionFailures: string[] }
  switch (action) {
    case 'setPinned':
      result = (await setPinned(db, { ...input, is_pinned: payload.is_pinned === 1 ? 1 : 0 })) as never
      break
    case 'setHidden':
      result = (await setHidden(db, { ...input, is_hidden: payload.is_hidden === 1 ? 1 : 0 })) as never
      break
    case 'setPassword':
      result = (await setPassword(db, { ...input, password: typeof payload.password === 'string' ? payload.password : null })) as never
      break
    case 'setCategory':
      result = (await setCategory(db, { ...input, category: typeof payload.category === 'string' ? payload.category : null })) as never
      break
    case 'softDelete':
      result = (await softDelete(db, input)) as never
      break
    case 'restore':
      result = (await restore(db, input)) as never
      break
    default:
      return jsonError(`${action}: 未知动作`, 400)
  }
  if (result.outcome === 'applied' || result.outcome === 'replayed') {
    await runProjectorsFor(projections, result, result.projectionFailures)
  }
  return jsonOk(result)
}

/**
 * B2-06 — batch classification. Every article keeps its own version
 * precondition + operation id; conflicts are reported per article and never
 * silently overwritten. On a ledger-only DB each item falls back to the legacy
 * direct write (no version conditions exist there).
 */
async function dispatchBatchSetCategory(
  env: RouteEnv,
  db: D1Database,
  ctx: { waitUntil?: (promise: Promise<unknown>) => void } | undefined,
  payload: Record<string, unknown>,
): Promise<Response> {
  const rawItems = Array.isArray(payload.items) ? (payload.items as Record<string, unknown>[]) : []
  if (rawItems.length === 0) return jsonError('batchSetCategory: items 不能为空', 400)

  const projections = afterCommit(env, ctx)
  const items = []
  for (const raw of rawItems) {
    const articleId = Number(raw.articleId)
    const expectedVersion = Number(raw.expectedVersion)
    const operationId = typeof raw.operationId === 'string' ? raw.operationId.trim() : ''
    const slug = typeof raw.slug === 'string' ? raw.slug : ''
    const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null
    if (!Number.isInteger(articleId) || !Number.isInteger(expectedVersion) || !operationId || !slug) {
      items.push({ outcome: 'invalid', articleId, expectedVersion, operationId, reason: '参数不完整' })
      continue
    }

    const post = await getPostBySlug(db, slug)
    if (!post) {
      items.push({ outcome: 'not-found', articleId, expectedVersion, operationId, slug })
      continue
    }
    const authority = await versionedAuthority(db, post.id)
    if (!authority) {
      await updatePost(db, post.id, { category } as Parameters<typeof updatePost>[2])
      items.push({ outcome: 'legacy-applied', articleId, postRef: post.id, version: null, operationId, existing: false, slug, projectionFailures: [] })
      continue
    }
    if (authority.articleId !== articleId) {
      items.push({ outcome: 'conflict', articleId, postRef: post.id, expectedVersion, serverVersion: authority.version, slug, facts: null })
      continue
    }
    try {
      const result = await setCategory(db, { articleId, expectedVersion, operationId, category })
      if (result.outcome === 'applied' || result.outcome === 'replayed') {
        await runProjectorsFor(projections, result, result.projectionFailures)
      }
      items.push({ ...result, slug })
    } catch (error) {
      items.push({ outcome: 'error', articleId, expectedVersion, operationId, slug, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return jsonOk({ items })
}

export async function POST(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const action = payload.action
    const projections = afterCommit(env, ctx)

    if (action === 'create') {
      const creationId = typeof payload.creationId === 'string' ? payload.creationId.trim() : ''
      if (!creationId) return jsonError('create: creationId 不能为空', 400)
      const snapshot = coerceSnapshot(payload.snapshot)
      // The kernel requires a slug; a blank editor auto-assigns one (as legacy POST did).
      if (!snapshot.slug) snapshot.slug = autoSlug()
      const result = await create(db, { creationId, snapshot, projections })
      return jsonOk(await attachFacts(db, result))
    }

    if (action === 'save') {
      const articleId = Number(payload.articleId)
      const expectedVersion = Number(payload.expectedVersion)
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
      if (!Number.isInteger(articleId) || !Number.isInteger(expectedVersion) || !operationId) {
        return jsonError('save: articleId / expectedVersion / operationId 无效', 400)
      }
      const snapshot = coerceSnapshot(payload.snapshot)
      const result = await save(db, { articleId, expectedVersion, operationId, snapshot, projections })
      return jsonOk(await attachFacts(db, result))
    }

    if (action === 'publishTemp') {
      const articleId = Number(payload.articleId)
      const expectedVersion = Number(payload.expectedVersion)
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
      const currentStatus = typeof payload.currentStatus === 'string' ? payload.currentStatus : 'draft'
      const status = payload.status === 'published' ? 'published' : 'draft'
      if (!Number.isInteger(articleId) || !Number.isInteger(expectedVersion) || !operationId) {
        return jsonError('publishTemp: articleId / expectedVersion / operationId 无效', 400)
      }
      const result = await publishTemp(db, {
        articleId,
        expectedVersion,
        currentStatus,
        operationId,
        status,
        projections,
      })
      return jsonOk(await attachFacts(db, result))
    }

    if (action === 'setPinned' || action === 'setHidden' || action === 'setPassword' || action === 'setCategory' || action === 'softDelete' || action === 'restore') {
      return dispatchArticleLevelAction({
        action,
        slug: typeof payload.slug === 'string' ? payload.slug : '',
        articleId: Number(payload.articleId),
        expectedVersion: Number(payload.expectedVersion),
        operationId: typeof payload.operationId === 'string' ? payload.operationId : '',
        payload,
        env,
        db,
        ctx,
      })
    }

    if (action === 'batchSetCategory') {
      return dispatchBatchSetCategory(env, db, ctx, payload)
    }

    return jsonError('未知 action', 400)
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('POST /api/article-commands error:', error)
    return jsonError(error instanceof Error ? error.message : '命令失败', 500)
  }
}

/** Read the current server version facts for an article (conflict "server version" / restore). */
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

    let article: { id: number; post_ref: number } | null = null
    if (Number.isInteger(rawArticleId) && rawArticleId > 0) {
      article = await db
        .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
        .bind(rawArticleId)
        .first<{ id: number; post_ref: number }>()
    } else if (slug) {
      const post = await db
        .prepare('SELECT id FROM posts WHERE slug = ?')
        .bind(normalizePostSlug(slug))
        .first<{ id: number }>()
      if (post) {
        article = await db
          .prepare('SELECT id, post_ref FROM articles WHERE post_ref = ?')
          .bind(post.id)
          .first<{ id: number; post_ref: number }>()
      }
    }

    if (!article) return jsonOk({ articleId: null, version: null, snapshot: null })

    const latest = await db
      .prepare(
        `SELECT version, snapshot_json FROM article_versions
         WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .bind(article.id)
      .first<{ version: number; snapshot_json: string }>()
    if (!latest) return jsonOk({ articleId: article.id, version: null, snapshot: null })

    let record: ArticleIdentitySnapshot | null = null
    try {
      record = JSON.parse(latest.snapshot_json) as ArticleIdentitySnapshot
    } catch {
      record = null
    }
    if (!record) return jsonOk({ articleId: article.id, version: latest.version, snapshot: null })

    const fields = record.fields
    return jsonOk({
      articleId: article.id,
      version: latest.version,
      snapshot: {
        slug: fields.slug,
        title: fields.title,
        html: record.original_html ?? '',
        content: record.original_content ?? '',
        description: fields.description ?? '',
        category: fields.category ?? '',
        tags: parseTags(fields.tags),
        coverImage: fields.cover_image ?? '',
        status: fields.status === 'published' ? 'published' : 'draft',
        password: fields.password,
        isHidden: fields.is_hidden ?? 0,
        publishedAt: record.published_at ?? fields.published_at ?? null,
      },
    })
  } catch (error) {
    const migrationResponse = migrationRequiredResponse(error)
    if (migrationResponse) return migrationResponse
    console.error('GET /api/article-commands error:', error)
    return jsonError(error instanceof Error ? error.message : '读取失败', 500)
  }
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : []
  } catch {
    return []
  }
}
