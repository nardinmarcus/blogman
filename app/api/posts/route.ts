/**
 * B2-08 — external write API adapter (issue #31).
 *
 * The Bearer/Agent/Obsidian/Chrome write entry. Writes go through the B2-03
 * version kernel (`lib/article-commands`) whenever the versioned schema is
 * present. Two protocols:
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
 * Ledger-only D1 compat: before the identity DDL has been applied the kernel
 * cannot run — there is no versioned authority to honour yet. In that state we
 * keep the original direct posts write (createPost / updatePostBySlug +
 * envelope dual-write) so pre-versioned deployments and ledger-only test DBs
 * keep working, while still returning the upgrade signal and recording
 * privacy-safe legacy telemetry (mirrors the admin route's B2-05 tolerance).
 *
 * Projections (cache invalidation + background index/AI jobs) run
 * out-of-transaction and are never fatal, matching the editor command route.
 */

import { nanoid } from 'nanoid'
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
import { createPost, updatePostBySlug } from '@/lib/db'
import {
  buildContentEnvelopeFields,
  missingContentEnvelopeColumns,
} from '@/lib/content-envelope-columns'
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
import {
  buildAutoDescription,
  extractMarkdownDescription,
  normalizePostSlug,
  stripMarkdownFrontmatter,
} from '@/lib/post-utils'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkHtml from 'remark-html'

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

/** True when the version kernel's schema (articles + article_versions) exists. */
async function hasIdentitySchema(db: D1Database): Promise<boolean> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('articles', 'article_versions')")
    .all<{ name: string }>()
  return tables.results.length === 2
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

/**
 * Ledger-only compat: the identity tables are absent, so the version kernel
 * cannot run. Keep the original direct posts write (envelope dual-write, FTS
 * triggers) and return the B2-08 upgrade signal + telemetry.
 */
async function legacyCompatCreate(
  env: RouteEnv,
  ctx: { waitUntil?: (promise: Promise<unknown>) => void },
  db: D1Database,
  payload: Record<string, unknown>,
  clientType: string,
) {
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  const rawContent = typeof payload.content === 'string' ? payload.content.trim() : ''
  const content = stripMarkdownFrontmatter(rawContent).trim()
  const rawHtml = typeof payload.html === 'string' ? payload.html.trim() : ''
  const payloadCategory = typeof payload.category === 'string' ? payload.category.trim() : ''
  const customSlug = typeof payload.slug === 'string' ? normalizePostSlug(payload.slug) : ''
  const status = payload.status === 'draft' ? 'draft' : 'published'
  const password = typeof payload.password === 'string' && payload.password.trim() ? payload.password.trim() : null
  const is_hidden = payload.is_hidden === 1 ? 1 : 0
  const description = typeof payload.description === 'string' && payload.description.trim()
    ? payload.description.trim()
    : extractMarkdownDescription(rawContent) || buildAutoDescription(content)
  const tags = Array.isArray(payload.tags)
    ? (payload.tags as unknown[])
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 10)
    : []
  const coverImage = typeof payload.cover_image === 'string' && payload.cover_image.trim()
    ? payload.cover_image.trim()
    : null
  if (!title || !content) return jsonError('标题和内容不能为空', 400)

  const date = new Date().toISOString().split('T')[0]
  const slug = customSlug || `${date}-${nanoid(6)}`
  const htmlContent = rawHtml || (
    await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content)
  ).toString()

  const missingEnvelopeColumns = await missingContentEnvelopeColumns(db)
  if (missingEnvelopeColumns.length > 0) {
    return jsonError(
      `content envelope 列缺失: ${missingEnvelopeColumns.join(', ')}。请先运行 scripts/apply-content-envelope-ddl.mjs`,
      503,
    )
  }
  const envelopeFields = buildContentEnvelopeFields(content)

  const postId = await createPost(db, {
    slug,
    title,
    content,
    html: htmlContent,
    description,
    category: payloadCategory || '未分类',
    tags,
    status,
    password,
    is_hidden,
    cover_image: coverImage,
    ...envelopeFields,
  })

  await invalidatePublicContentCache(env)
  await enqueueBackgroundJob(env, { type: 'process-post-ai', postId }, { waitUntil: ctx?.waitUntil?.bind(ctx) })
  await enqueueBackgroundJob(env, { type: 'sync-post-related-index', postId }, { waitUntil: ctx?.waitUntil?.bind(ctx) })

  await recordLegacyWrite(db, { clientType, operation: 'create' })
  return jsonOk({
    success: true,
    slug,
    id: postId,
    category: payloadCategory || '未分类',
    tags,
    description,
    cover_image: coverImage,
    status,
    legacy: true,
    upgrade: upgradeSignal(false, '服务器尚未启用版本化写入内核：本次已按原协议写入，请先运行 scripts/apply-article-identity-ddl.mjs 后升级到 protocol=v1'),
  })
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
    const clientType = resolveClientType(req)

    // Ledger-only D1 (no identity tables yet): the kernel can't run — keep the
    // original compatible write instead of failing closed.
    if (!(await hasIdentitySchema(db))) {
      return await legacyCompatCreate(env, ctx, db, payload, clientType)
    }

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

/**
 * Ledger-only compat PATCH: direct updatePostBySlug (metadata toggles + content)
 * when the version kernel cannot run; envelope dual-write on content updates.
 */
async function legacyCompatUpdate(
  env: RouteEnv,
  db: D1Database,
  payload: Record<string, unknown>,
  clientType: string,
) {
  const currentSlug = typeof payload.current_slug === 'string'
    ? payload.current_slug.trim()
    : (typeof payload.slug === 'string' ? payload.slug.trim() : '')
  const nextSlug = typeof payload.new_slug === 'string'
    ? normalizePostSlug(payload.new_slug)
    : ''
  if (!currentSlug) return jsonError('slug 不能为空', 400)

  const updates: Record<string, unknown> = {}
  if (nextSlug && nextSlug !== currentSlug) updates.slug = nextSlug
  if (payload.title !== undefined) updates.title = payload.title
  const rawContent = typeof payload.content === 'string' ? payload.content : ''
  if (payload.content !== undefined) updates.content = stripMarkdownFrontmatter(rawContent)
  if (payload.html !== undefined) updates.html = payload.html
  if (payload.description !== undefined) {
    const rawDescription = typeof payload.description === 'string' ? payload.description.trim() : ''
    updates.description = rawDescription || extractMarkdownDescription(rawContent) || buildAutoDescription(rawContent)
  }
  if (payload.category !== undefined) updates.category = payload.category
  if (payload.tags !== undefined) updates.tags = payload.tags
  if (payload.cover_image !== undefined) updates.cover_image = payload.cover_image
  if (payload.status === 'draft' || payload.status === 'published' || payload.status === 'deleted') {
    updates.status = payload.status
  }

  if (typeof payload.content === 'string') {
    const missingEnvelopeColumns = await missingContentEnvelopeColumns(db)
    if (missingEnvelopeColumns.length > 0) {
      return jsonError(
        `content envelope 列缺失: ${missingEnvelopeColumns.join(', ')}。请先运行 scripts/apply-content-envelope-ddl.mjs`,
        503,
      )
    }
    Object.assign(updates, buildContentEnvelopeFields(updates.content as string))
  }

  if (Object.keys(updates).length === 0) {
    return jsonOk({ success: true, slug: currentSlug })
  }

  await updatePostBySlug(db, currentSlug, updates)
  await invalidatePublicContentCache(env)

  await recordLegacyWrite(db, { clientType, operation: 'update' })
  return jsonOk({
    success: true,
    slug: nextSlug || currentSlug,
    legacy: true,
    upgrade: upgradeSignal(false, '服务器尚未启用版本化写入内核：本次已按原协议更新，请先运行 scripts/apply-article-identity-ddl.mjs 后升级到 protocol=v1'),
  })
}

// PATCH: versioned save / legacy draft-only update (both through the kernel),
// with a ledger-only compat path when the identity tables are absent.
export async function PATCH(req: NextRequest) {
  try {
    const route = await getRouteContextWithDb('数据库未配置')
    if (!route.ok) return route.response
    const { env, db, ctx } = route

    const authError = await ensureAuthenticatedRequest(req, db)
    if (authError) return authError

    const payload = await parseJsonBody<Record<string, unknown>>(req)
    const projections = afterCommit(env, ctx)
    const clientType = resolveClientType(req)

    if (!(await hasIdentitySchema(db))) {
      return await legacyCompatUpdate(env, db, payload, clientType)
    }

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