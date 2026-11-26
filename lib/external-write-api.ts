/**
 * B2-08 — external write API protocol (issue #31).
 *
 * The Bearer/Agent/Obsidian/Chrome write surface (`/api/posts`) is a thin
 * adapter over the B2-03 version kernel — external writes never bypass
 * `lib/article-commands`. Two protocols share the entry:
 *
 *   - `protocol: 'v1'` (upgraded clients): the same action envelope as the
 *     editor (`create` / `save` / `publishTemp`) with identity
 *     (creation id / article id), expected version, operation id and a full
 *     authoring snapshot. Creation always lands as a DRAFT; transitions go
 *     through `publishTemp`. Retries reuse the same creation/operation id so
 *     the kernel replays instead of duplicating.
 *   - legacy (no protocol marker): versionless writes are rejected; the
 *     response carries a machine-readable upgrade signal.
 *
 * This module carries no production side effects and is unit-testable with a
 * mocked `db`; the route wires the real D1 + out-of-transaction projections.
 */

import { nanoid } from 'nanoid'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkHtml from 'remark-html'
import type { Database } from '@/lib/repositories/schema'
import type {
  ArticleCommandProjections,
  ArticleCommandSnapshot,
  CreateResult,
  PublishTempResult,
  SaveResult,
} from '@/lib/article-commands'
import { create, publishTemp, save } from '@/lib/article-commands'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import {
  buildAutoDescription,
  extractMarkdownDescription,
  normalizePostSlug,
} from '@/lib/post-utils'

export const EXTERNAL_WRITE_PROTOCOL = 'v1' as const

export interface UpgradeSignal {
  protocol: string
  required: boolean
  endpoint: string
  message: string
}

/** Machine-readable upgrade signal every legacy response carries. */
export function upgradeSignal(required: boolean, message: string): UpgradeSignal {
  return {
    protocol: EXTERNAL_WRITE_PROTOCOL,
    required,
    endpoint: '/api/posts',
    message,
  }
}

/** True when the payload opt-in to the versioned protocol. */
export function isVersionedProtocol(payload: Record<string, unknown>): boolean {
  return payload.protocol === EXTERNAL_WRITE_PROTOCOL
}

/* ------------------------------------------------------------------ */
/* Snapshot coercion                                                   */
/* ------------------------------------------------------------------ */

async function renderHtml(markdown: string): Promise<string> {
  return (
    await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(markdown)
  ).toString()
}

interface CoercedSnapshot {
  snapshot: ArticleCommandSnapshot
  autoSlug: boolean
}

/** Coerce a full authoring snapshot (versioned protocol payload). */
export async function coerceVersionedSnapshot(raw: unknown): Promise<CoercedSnapshot> {
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
  const html =
    typeof p.html === 'string' && p.html.trim()
      ? p.html.trim()
      : content
        ? await renderHtml(content)
        : ''
  const description =
    typeof p.description === 'string' && p.description.trim()
      ? p.description.trim()
      : content
        ? extractMarkdownDescription(content) || buildAutoDescription(content)
        : null
  const slug = normalizePostSlug(typeof p.slug === 'string' ? p.slug : '')
  return {
    autoSlug: !slug,
    snapshot: {
      // B2-08: external creation always lands as a draft; transitions use
      // `publishTemp`. The snapshot's requested status is never honored at
      // create time.
      slug,
      title,
      content,
      html,
      description,
      category: typeof p.category === 'string' && p.category.trim() ? p.category.trim() : '未分类',
      tags: tags.length > 0 ? tags : null,
      status: 'draft',
      password: typeof p.password === 'string' && p.password.trim() ? p.password.trim() : null,
      is_pinned: p.is_pinned === 1 ? 1 : 0,
      is_hidden: p.is_hidden === 1 ? 1 : 0,
      cover_image:
        typeof p.cover_image === 'string' && p.cover_image.trim() ? p.cover_image.trim() : null,
      deleted_at: typeof p.deleted_at === 'number' ? p.deleted_at : null,
      published_at: null,
      updated_at: null,
    },
  }
}

/** Same auto-slug shape as the versioned POST /api/posts (date + nanoid suffix). */
export function autoSlug(): string {
  const date = new Date().toISOString().split('T')[0]
  return `${date}-${nanoid(6)}`
}

/* ------------------------------------------------------------------ */
/* Article resolution (for legacy update through the kernel)          */
/* ------------------------------------------------------------------ */

export interface ResolvedArticle {
  articleId: number
  postRef: number
  version: number
  snapshot: ArticleCommandSnapshot
}

/**
 * Resolve a slug to the current versioned article facts. Returns null when
 * the post has no identity or is not under versioned authority yet.
 */
export async function resolveArticleBySlug(
  db: Database,
  slug: string,
): Promise<ResolvedArticle | null> {
  const bySlug = await db
    .prepare('SELECT article_id FROM article_slug_addresses WHERE slug = ?')
    .bind(normalizePostSlug(slug))
    .first<{ article_id: number }>()
  if (!bySlug) return null
  const article = await db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(bySlug.article_id)
    .first<{ id: number; post_ref: number }>()
  if (!article) return null
  const latest = await db
    .prepare(
      `SELECT version, snapshot_json FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(article.id)
    .first<{ version: number; snapshot_json: string }>()
  if (!latest) return null

  let record: ArticleIdentitySnapshot | null = null
  try {
    record = JSON.parse(latest.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    record = null
  }
  if (!record) return null

  const f = record.fields
  return {
    articleId: article.id,
    postRef: article.post_ref,
    version: latest.version,
    snapshot: {
      slug: f.slug,
      title: f.title,
      content: record.original_content ?? '',
      html: record.original_html ?? '',
      description: f.description ?? null,
      category: f.category ?? null,
      tags: parseTags(f.tags),
      status: f.status === 'published' ? 'published' : 'draft',
      password: f.password ?? null,
      is_pinned: f.is_pinned ?? 0,
      is_hidden: f.is_hidden ?? 0,
      cover_image: f.cover_image ?? null,
      deleted_at: f.deleted_at ?? null,
      published_at: record.published_at ?? f.published_at ?? null,
      updated_at: f.updated_at ?? null,
    },
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

/* ------------------------------------------------------------------ */
/* Command dispatch                                                    */
/* ------------------------------------------------------------------ */

/** Versioned action dispatch over the kernel for the external entry. */
export async function dispatchExternalWrite(
  db: Database,
  action: string,
  payload: Record<string, unknown>,
  projections?: ArticleCommandProjections,
): Promise<CreateResult | SaveResult | PublishTempResult | { error: string; status: number }> {
  if (action === 'create') {
    const creationId =
      typeof payload.creationId === 'string' ? payload.creationId.trim() : ''
    if (!creationId) return { error: 'create: creationId 不能为空', status: 400 }
    const { snapshot, autoSlug: needsAutoSlug } = await coerceVersionedSnapshot(payload.snapshot)
    if (!snapshot.slug && needsAutoSlug) snapshot.slug = autoSlug()
    // B6-01 — optional writable-primary-source URL (issue #50): when present the
    // kernel records the 源稿 identity + a pending (not auto-effective) link.
    const sourceUrl =
      typeof payload.source === 'object' && payload.source !== null
        ? (payload.source as { url?: unknown }).url
        : undefined
    const source =
      typeof sourceUrl === 'string' && sourceUrl.trim()
        ? { url: sourceUrl.trim() }
        : undefined
    return await create(db, { creationId, snapshot, projections, ...(source ? { source } : {}) })
  }

  if (action === 'save') {
    const articleId = Number(payload.articleId)
    const expectedVersion = Number(payload.expectedVersion)
    const operationId =
      typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
    if (!Number.isInteger(articleId) || !Number.isInteger(expectedVersion) || !operationId) {
      return { error: 'save: articleId / expectedVersion / operationId 无效', status: 400 }
    }
    const { snapshot } = await coerceVersionedSnapshot(payload.snapshot)
    if (!snapshot.slug) return { error: 'save: snapshot.slug 不能为空', status: 400 }
    return await save(db, { articleId, expectedVersion, operationId, snapshot, projections })
  }

  if (action === 'publishTemp') {
    const articleId = Number(payload.articleId)
    const expectedVersion = Number(payload.expectedVersion)
    const operationId =
      typeof payload.operationId === 'string' ? payload.operationId.trim() : ''
    const currentStatus = typeof payload.currentStatus === 'string' ? payload.currentStatus : 'draft'
    const status = payload.status === 'published' ? 'published' : 'draft'
    if (!Number.isInteger(articleId) || !Number.isInteger(expectedVersion) || !operationId) {
      return { error: 'publishTemp: articleId / expectedVersion / operationId 无效', status: 400 }
    }
    return await publishTemp(db, {
      articleId,
      expectedVersion,
      currentStatus,
      operationId,
      status,
      projections,
    })
  }

  return { error: '未知 action', status: 400 }
}