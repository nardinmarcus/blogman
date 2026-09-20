import { cache } from 'react'
import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'
import type { PublicArticle } from './types'

export type CanonicalLifecycle = 'published' | 'unpublished'

/**
 * One canonical fact row for a formally-published article, projected so the
 * $snapshot_json can be materialised locally without a `posts` read.
 */
export interface CanonicalPublicRow {
  post_ref: number
  article_id: number
  version: number
  slug: string
  lifecycle: CanonicalLifecycle
  first_published_at: number
  published_at: number
  snapshot_json: string
  /** The LATEST version snapshot — management fields read from it (ADR 0007). */
  latest_snapshot_json?: string | null
}

/**
 * STRICT canonical-facts probe: rethrows migration-required DB faults (the
 * site header / categories contract relies on it) while a merely MISSING
 * table degrades to `false`. The ONLY sqlite_master probe — the lenient
 * variant below and every canonical read path share this one cached read.
 */
export const canonicalFactsAvailableStrictForRequest = cache(async (db: Database): Promise<boolean> => {
  try {
    const row = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='formal_publications'`,
      )
      .first<{ name: string }>()
    return Boolean(row)
  } catch (error) {
    const { rethrowIfDatabaseMigrationRequired } = await import('@/lib/database-errors')
    rethrowIfDatabaseMigrationRequired(error)
    return false
  }
})

/**
 * LENIENT canonical-facts probe — the historical swallow semantics of this
 * module (any error → `false`, degrade rather than 500). Shares the strict
 * probe's single per-request sqlite_master read.
 */
export async function canonicalFactsAvailableForRequest(db: Database): Promise<boolean> {
  try {
    return await canonicalFactsAvailableStrictForRequest(db)
  } catch {
    return false
  }
}

export async function canonicalFactsAvailable(db: Database): Promise<boolean> {
  return canonicalFactsAvailableForRequest(db)
}

/** Parse a frozen snapshot into its full record + metadata `fields` block. */
function parseCanonicalSnapshot(
  snapshotJson: string,
): { record: Record<string, unknown>; fields: Record<string, unknown> } {
  try {
    const record = JSON.parse(snapshotJson) as { fields?: Record<string, unknown> }
    return { record: record ?? {}, fields: record?.fields ?? {} }
  } catch {
    return { record: {}, fields: {} }
  }
}

function toStatus(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function toTags(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : [value]
    } catch {
      return value.trim() ? [value] : []
    }
  }
  return []
}

/**
 * Materialise a legacy-compatible `PostWithTags` from canonical facts. Only
 * the retired `view_count` counter is fixed at 0; every decision
 * field (lifecycle / address / access-control / content) comes from
 * `formal_publications` + the frozen `article_versions` snapshot.
 */
export function postFromCanonicalRow(row: CanonicalPublicRow): PostWithTags {
  const { record, fields: content } = parseCanonicalSnapshot(row.snapshot_json)
  // Management / access-control fields come from the LATEST version
  // (immediate article-level commands, ADR 0007); content stays formal.
  const { fields } = parseCanonicalSnapshot(row.latest_snapshot_json ?? row.snapshot_json)
  const deletedAt = toStatus(fields.deleted_at)
  const status: PostWithTags['status'] =
    deletedAt !== 0 ? 'deleted' : row.lifecycle === 'published' ? 'published' : 'draft'
  return {
    id: row.post_ref,
    slug: row.slug,
    title: typeof content.title === 'string' ? content.title : row.slug,
    content: typeof record.original_content === 'string' ? record.original_content : '',
    html: typeof record.original_html === 'string' ? record.original_html : '',
    description: typeof content.description === 'string' ? content.description : null,
    category: typeof fields.category === 'string' ? fields.category : null,
    tags: toTags(content.tags),
    status,
    password: typeof fields.password === 'string' && fields.password ? fields.password : null,
    is_pinned: toStatus(fields.is_pinned),
    is_hidden: toStatus(fields.is_hidden),
    cover_image: typeof content.cover_image === 'string' ? content.cover_image : null,
    deleted_at: deletedAt !== 0 ? deletedAt : null,
    published_at: row.first_published_at,
    updated_at: toStatus(fields.updated_at) || row.published_at,
    view_count: 0,
  }
}

/**
 * BASE admin compatibility: body/HTML remain formal, while display metadata
 * and the preferred slug come from latest. The supplied row.slug must be the
 * formal slug, preserving the original fallback even if the registry differs.
 * This mapping is intentionally unavailable through the public read interface.
 */
export function postFromAdminRow(row: CanonicalPublicRow): PostWithTags {
  const post = postFromCanonicalRow(row)
  const { fields } = parseCanonicalSnapshot(row.latest_snapshot_json ?? row.snapshot_json)
  return {
    ...post,
    slug: typeof fields.slug === 'string' && fields.slug ? fields.slug : row.slug,
    title: typeof fields.title === 'string' ? fields.title : row.slug,
    description: typeof fields.description === 'string' ? fields.description : null,
    tags: toTags(fields.tags),
    cover_image: typeof fields.cover_image === 'string' ? fields.cover_image : null,
  }
}

/** Registry current address wins; formal slug is the pre-backfill fallback. */
export const LIVE_SLUG = `COALESCE((SELECT slug FROM article_slug_addresses
  WHERE article_id = f.article_id AND kind = 'current'), f.slug)`

/** Internal projection shared by all full-article discovery reads. */
export const CANONICAL_ROW_COLUMNS = `
  a.post_ref,
  f.article_id, f.version, ${LIVE_SLUG} AS slug, f.lifecycle, f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json`

/** The LATEST version join — management fields read from it (ADR 0007). */
export const CANONICAL_LATEST_JOIN = `
  LEFT JOIN article_versions lv ON lv.article_id = f.article_id
   AND lv.version = (SELECT MAX(version) FROM article_versions WHERE article_id = f.article_id)`

/** Internal policy: discovery defaults, with explicit listing exceptions. */
export const MANAGEMENT = {
  password: "json_extract(lv.snapshot_json, '$.fields.password')",
  is_hidden: "json_extract(lv.snapshot_json, '$.fields.is_hidden')",
  is_pinned: "json_extract(lv.snapshot_json, '$.fields.is_pinned')",
  deleted_at: "json_extract(lv.snapshot_json, '$.fields.deleted_at')",
  category: "json_extract(lv.snapshot_json, '$.fields.category')",
} as const

export function discoveryConditions(options: { includePassword?: boolean; includeHidden?: boolean } = {}): string[] {
  const conditions = ["f.lifecycle = 'published'", `COALESCE(${MANAGEMENT.deleted_at}, 0) = 0`]
  if (!options.includePassword) conditions.push(`COALESCE(${MANAGEMENT.password}, '') = ''`)
  if (!options.includeHidden) conditions.push(`COALESCE(${MANAGEMENT.is_hidden}, 0) = 0`)
  return conditions
}

/** All content-bearing public results share this materialization. */
export function articleFromCanonicalRow(row: CanonicalPublicRow): PublicArticle {
  const post = postFromCanonicalRow(row)
  return {
    ...post,
    articleId: row.article_id,
    version: row.version,
    lifecycle: row.lifecycle,
    live: post.status === 'published',
    first_published_at: row.first_published_at,
  }
}

/** Preserve pre-registry reads without adding a normal-path schema probe. */
export async function readCanonicalRows(db: Database, sql: string, params: unknown[]): Promise<CanonicalPublicRow[]> {
  try {
    return (await db.prepare(sql).bind(...params).all<CanonicalPublicRow>()).results ?? []
  } catch (error) {
    if (!(error instanceof Error) || !/no such table:? article_slug_addresses(?![\w])/i.test(error.message)) throw error
    return (await db.prepare(sql.replaceAll(LIVE_SLUG, 'f.slug')).bind(...params).all<CanonicalPublicRow>()).results ?? []
  }
}
