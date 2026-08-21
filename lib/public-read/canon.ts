/**
 * L2 — canonical row materialisers (issue #67 follow-up).
 *
 * Shared helpers used by every public read path that is NOT yet inside
 * `lib/public-read/kernel.ts` (currently `lib/repositories/search.ts` and
 * `lib/related-content.ts`). They turn a canonical fact row
 * (`formal_publications` + `article_versions`, anchored via `articles`) into a
 * legacy-compatible `PostWithTags` so downstream legacy-shaped code (scoring,
 * index-token building, search responses) keeps working unchanged.
 *
 * Snapshot field access mirrors the JSON1 paths in `kernel.ts`.
 */

import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'

export type CanonicalLifecycle = 'published' | 'unpublished'

/**
 * One canonical fact row for a formally-published article, projected so the
 * $snapshot_json can be materialised locally without a `posts` read.
 */
export interface CanonicalPublicRow {
  post_ref: number
  article_id: number
  slug: string
  lifecycle: CanonicalLifecycle
  first_published_at: number
  published_at: number
  snapshot_json: string
  /** The LATEST version snapshot — management fields read from it (ADR 0007). */
  latest_snapshot_json?: string | null
}

/**
 * True when the canonical fact tables are present on this DB. Every canonical
 * read path SOFT-SWITCHES: when the migration/DDL is not yet applied it falls
 * back to the legacy `posts` projection so a read never 500s just because a
 * new table is missing.
 */
export async function canonicalFactsAvailable(db: Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='formal_publications'`,
      )
      .first<{ name: string }>()
    return Boolean(row)
  } catch {
    return false
  }
}

/** Parse a frozen snapshot into its full record + metadata `fields` block. */
export function parseCanonicalSnapshot(
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
 * the monotonic `view_count` counter is not carried here (0); every decision
 * field (lifecycle / address / access-control / content) comes from
 * `formal_publications` + the frozen `article_versions` snapshot.
 */
export function postFromCanonicalRow(row: CanonicalPublicRow): PostWithTags {
  const { record } = parseCanonicalSnapshot(row.snapshot_json)
  // Management / access-control fields come from the LATEST version
  // (immediate article-level commands, ADR 0007); content stays formal.
  const { fields } = parseCanonicalSnapshot(row.latest_snapshot_json ?? row.snapshot_json)
  const deletedAt = toStatus(fields.deleted_at)
  const status: PostWithTags['status'] =
    deletedAt !== 0 ? 'deleted' : row.lifecycle === 'published' ? 'published' : 'draft'
  return {
    id: row.post_ref,
    slug: typeof fields.slug === 'string' && fields.slug ? fields.slug : row.slug,
    title: typeof fields.title === 'string' ? fields.title : row.slug,
    content: typeof record.original_content === 'string' ? record.original_content : '',
    html: typeof record.original_html === 'string' ? record.original_html : '',
    description: typeof fields.description === 'string' ? fields.description : null,
    category: typeof fields.category === 'string' ? fields.category : null,
    tags: toTags(fields.tags),
    status,
    password: typeof fields.password === 'string' && fields.password ? fields.password : null,
    is_pinned: toStatus(fields.is_pinned),
    is_hidden: toStatus(fields.is_hidden),
    cover_image: typeof fields.cover_image === 'string' ? fields.cover_image : null,
    deleted_at: deletedAt !== 0 ? deletedAt : null,
    published_at: row.first_published_at,
    updated_at: toStatus(fields.updated_at) || row.published_at,
    view_count: 0,
  }
}

/**
 * The shared canonical fact projection SELECT (columns) used everywhere a
 * public read wants one full article per formal row without touching `posts`.
 * JOINs `articles` → `formal_publications` (one row per article) →
 * `article_versions` (exactly the formal version), plus the LATEST version
 * for management fields (ADR 0007). Pair with CANONICAL_LATEST_JOIN.
 */
export const CANONICAL_ROW_COLUMNS = `
  a.post_ref,
  f.article_id, f.slug, f.lifecycle, f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json`

/** The LATEST version join — management fields read from it (ADR 0007). */
export const CANONICAL_LATEST_JOIN = `
  LEFT JOIN article_versions lv ON lv.article_id = f.article_id
   AND lv.version = (SELECT MAX(version) FROM article_versions WHERE article_id = f.article_id)`