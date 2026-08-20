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
 *   - legacy (no protocol marker): every create is routed through the kernel
 *     too — as a DRAFT even when `published` was requested — and the response
 *     carries a machine-readable upgrade signal. Legacy telemetry records
 *     only client type / operation category / timestamp; never content or
 *     credentials. After the external-write authority switch, legacy
 *     versionless writes are rejected outright.
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
  stripMarkdownFrontmatter,
} from '@/lib/post-utils'
import { isAuthorityEnabled } from '@/lib/rollout-controls'

export const EXTERNAL_WRITE_PROTOCOL = 'v1' as const
export const LEGACY_TELEMETRY_KEY = 'legacy_external_write_telemetry' as const
export const AUTHORITY_KEY = 'external_write_authority' as const
/** Value that flips the external-write authority to versioned-only. */
export const AUTHORITY_VERSIONED = 'versioned' as const

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

/**
 * Client-type classification for telemetry. Prefers an explicit header, then
 * falls back to User-Agent sniffing for the known external clients.
 */
export function resolveClientType(req: {
  headers?: { get?: (name: string) => string | null } | null
}): string {
  const headers = req?.headers
  if (headers?.get) {
    const explicit = headers.get('x-blogman-client')?.trim()
    if (explicit) return explicit.slice(0, 64)
    const ua = (headers.get('user-agent') ?? '').toLowerCase()
    if (ua.includes('obsidian')) return 'obsidian'
    if (ua.includes('chrome') || ua.includes('chromium')) return 'chrome'
    if (ua.includes('curl') || ua.includes('wget')) return 'cli'
    if (ua.includes('node') || ua.includes('python') || ua.includes('go-http')) return 'agent'
  }
  return 'unknown'
}

/**
 * True once the external-write authority flips to versioned-only.
 *
 * Source of truth is the B2-G `rollout_controls.authority` (issue #32); the
 * legacy `site_settings` flag from B2-08 remains a tolerated backward-compat
 * signal so pre-switch deployments keep their existing gate until the rollout
 * control rows exist. Reading a ledger-only D1 (no rollout tables, no identity
 * tables yet) reports disabled without crashing.
 */
export async function isExternalWriteAuthoritySwitched(db: Database): Promise<boolean> {
  if (await isAuthorityEnabled(db)) return true
  try {
    const row = await db
      .prepare('SELECT value FROM site_settings WHERE key = ?')
      .bind(AUTHORITY_KEY)
      .first<{ value: string }>()
    return row?.value === AUTHORITY_VERSIONED
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Legacy telemetry — client type / operation category / time only.   */
/* ------------------------------------------------------------------ */

export interface LegacyTelemetryEntry {
  /** client type (obsidian / chrome / agent / cli / unknown) */
  clientType: string
  /** operation category ('create' | 'update') */
  operation: 'create' | 'update'
  /** unix seconds (defaults to now) */
  at?: number
}

interface DailyCounts {
  daily: Record<string, Record<string, Record<string, number>>>
  total: number
  updatedAt: number
}

const TELEMETRY_RETENTION_DAYS = 90

function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

function emptyTelemetry(): DailyCounts {
  return { daily: {}, total: 0, updatedAt: 0 }
}

/** Append one legacy-write observation; prunes days older than retention. */
export async function recordLegacyWrite(
  db: Database,
  entry: LegacyTelemetryEntry,
): Promise<void> {
  const at = entry.at ?? Math.floor(Date.now() / 1000)
  const row = await db
    .prepare('SELECT value FROM site_settings WHERE key = ?')
    .bind(LEGACY_TELEMETRY_KEY)
    .first<{ value: string }>()
  let telemetry: DailyCounts = emptyTelemetry()
  if (row?.value) {
    try {
      telemetry = JSON.parse(row.value) as DailyCounts
    } catch {
      telemetry = emptyTelemetry()
    }
  }
  const key = dayKey(at)
  const day = (telemetry.daily[key] ??= {})
  const client = (day[entry.clientType] ??= {})
  client[entry.operation] = (client[entry.operation] ?? 0) + 1
  telemetry.total += 1
  telemetry.updatedAt = at
  // Prune stale days so the blob stays bounded.
  const cutoff = at - TELEMETRY_RETENTION_DAYS * 86400
  for (const d of Object.keys(telemetry.daily)) {
    if (new Date(`${d}T00:00:00Z`).getTime() / 1000 < cutoff) delete telemetry.daily[d]
  }
  await db.prepare('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)')
    .bind(LEGACY_TELEMETRY_KEY, JSON.stringify(telemetry))
    .run()
}

/** Read the legacy-write telemetry blob (diagnostics / seven-day-zero gate). */
export async function readLegacyTelemetry(db: Database): Promise<DailyCounts> {
  const row = await db
    .prepare('SELECT value FROM site_settings WHERE key = ?')
    .bind(LEGACY_TELEMETRY_KEY)
    .first<{ value: string }>()
  if (!row?.value) return emptyTelemetry()
  try {
    return JSON.parse(row.value) as DailyCounts
  } catch {
    return emptyTelemetry()
  }
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

/**
 * Coerce a legacy (unversioned) create payload into a draft-only kernel
 * snapshot. Retains the old payload semantics (frontmatter strip, markdown
 * rendering, auto-description, `未分类` default) so existing integrations keep
 * their byte-level behaviour — minus the status honouring, which is forced to
 * draft.
 */
export async function coerceLegacySnapshot(raw: unknown): Promise<CoercedSnapshot> {
  const p = (raw ?? {}) as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const rawContent = typeof p.content === 'string' ? p.content.trim() : ''
  const content = stripMarkdownFrontmatter(rawContent).trim()
  const customSlug =
    typeof p.slug === 'string' ? normalizePostSlug(p.slug) : ''
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
        ? extractMarkdownDescription(rawContent) || buildAutoDescription(content)
        : null
  return {
    autoSlug: !customSlug,
    snapshot: {
      slug: customSlug,
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
      deleted_at: null,
      published_at: null,
      updated_at: null,
    },
  }
}

/** Same auto-slug shape as the legacy POST /api/posts (date + nanoid suffix). */
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
  const post = await db
    .prepare('SELECT id FROM posts WHERE slug = ?')
    .bind(normalizePostSlug(slug))
    .first<{ id: number }>()
  if (!post) return null
  const article = await db
    .prepare('SELECT id, post_ref FROM articles WHERE post_ref = ?')
    .bind(post.id)
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
/* Legacy draft-only adapter (still routed through the kernel)        */
/* ------------------------------------------------------------------ */

/**
 * The create outcomes a legacy draft can actually produce. A legacy (one-shot)
 * create never carries a `source`, so it can never return `invalid-source` or
 * `source-linked` — this narrow keeps the legacy route's post-condition checks
 * sound without spurious union members.
 */
export type UnsourcedCreateResult = Exclude<
  CreateResult,
  { outcome: 'invalid-source' } | { outcome: 'source-linked' }
>

/** Legacy create → kernel draft-only create with a server-side idempotency key. */
export async function createLegacyDraft(
  db: Database,
  raw: unknown,
  projections?: ArticleCommandProjections,
): Promise<{ result: UnsourcedCreateResult; snapshot: ArticleCommandSnapshot; creationId: string }> {
  const { snapshot, autoSlug: needsAutoSlug } = await coerceLegacySnapshot(raw)
  if (needsAutoSlug) snapshot.slug = autoSlug()
  const creationId = `legacy:${nanoid(16)}`
  // No `source` is ever passed for a legacy one-shot draft, so the result can
  // never be `invalid-source` or `source-linked`.
  const result = (await create(db, { creationId, snapshot, projections })) as UnsourcedCreateResult
  return { result, snapshot, creationId }
}

/**
 * Legacy PATCH → full-snapshot merge routed through kernel `save` with the
 * server-resolved version. Draft-only. Returns null when the article is not
 * under versioned authority (caller should reject with an upgrade signal).
 */
export async function updateLegacyDraft(
  db: Database,
  currentSlug: string,
  raw: Record<string, unknown>,
  projections?: ArticleCommandProjections,
): Promise<{ result: SaveResult; snapshot: ArticleCommandSnapshot } | null> {
  const resolved = await resolveArticleBySlug(db, currentSlug)
  if (!resolved) return null

  const s = resolved.snapshot
  const rawContent = typeof raw.content === 'string' ? raw.content.trim() : s.content
  const nextContent =
    typeof raw.content === 'string' && raw.content.trim()
      ? stripMarkdownFrontmatter(rawContent).trim()
      : s.content
  s.slug =
    typeof raw.new_slug === 'string' && raw.new_slug.trim()
      ? normalizePostSlug(raw.new_slug)
      : s.slug
  if (typeof raw.title === 'string') s.title = raw.title.trim()
  if (typeof raw.content === 'string') s.content = nextContent
  if (typeof raw.html === 'string') s.html = raw.html.trim()
  if (typeof raw.description === 'string') {
    const d = raw.description.trim()
    s.description = d || (nextContent ? nextContent : s.description)
  }
  if (typeof raw.category === 'string') s.category = raw.category.trim() || s.category
  if (Array.isArray(raw.tags)) s.tags = raw.tags as string[]
  if (typeof raw.cover_image === 'string') s.cover_image = raw.cover_image.trim() || null
  if (raw.is_hidden === 0 || raw.is_hidden === 1) s.is_hidden = raw.is_hidden
  if (typeof raw.password === 'string') {
    s.password = raw.password.trim() ? raw.password.trim() : null
  }
  s.status = 'draft' // legacy 更新永不直接发布。

  const result = await save(db, {
    articleId: resolved.articleId,
    expectedVersion: resolved.version,
    operationId: `legacy:${nanoid(16)}`,
    snapshot: s,
    projections,
  })
  return { result, snapshot: s }
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