/**
 * L2 — canonical public read kernel (issue #67).
 *
 * Pure DB logic that serves every public reading path from canonical D1 facts.
 * No legacy `posts` SELECT drives a visibility / lifecycle / address / pinned
 * decision here — those come from `formal_publications` +
 * `article_versions` (+ `article_slug_addresses` for the single-hop registry).
 * HTML/SQLite JSON1 (`json_extract`) reads the frozen version snapshot's
 * access-control + pinned facts so list filtering and pin-ordering stay
 * canonical and happen in SQL (correct pagination on real D1 / in tests).
 */

import type { Database } from '@/lib/repositories/schema'
import { resolveArticleAddress } from '@/lib/slug-address'
import type {
  PublicArticle,
  PublicArticleResolution,
  PublicLifecycle,
  PublicListOptions,
} from './types'

/** Snapshot JSON field paths surfaced by the LATEST frozen article version.
 *
 * Management / access-control state (password, pin, hide, soft-delete,
 * category) takes effect IMMEDIATELY when an article-level command appends a
 * new immutable version — so these paths always read the latest snapshot,
 * never the formal one (ADR 0007). Content-bearing fields stay anchored to
 * the formal version: only a promoted revision changes the public body.
 */
const F = {
  password: "json_extract(lv.snapshot_json, '$.fields.password')",
  is_hidden: "json_extract(lv.snapshot_json, '$.fields.is_hidden')",
  is_pinned: "json_extract(lv.snapshot_json, '$.fields.is_pinned')",
  deleted_at: "json_extract(lv.snapshot_json, '$.fields.deleted_at')",
  title: "json_extract(v.snapshot_json, '$.fields.title')",
  description: "json_extract(v.snapshot_json, '$.fields.description')",
  category: "json_extract(lv.snapshot_json, '$.fields.category')",
  cover_image: "json_extract(v.snapshot_json, '$.fields.cover_image')",
  updated_at: "json_extract(lv.snapshot_json, '$.fields.updated_at')",
  original_content: "json_extract(v.snapshot_json, '$.original_content')",
  original_html: "json_extract(v.snapshot_json, '$.original_html')",
} as const

interface FormalRow {
  article_id: number
  version: number
  slug: string
  lifecycle: PublicLifecycle
  first_published_at: number
  published_at: number
}

interface VersionRow {
  snapshot_json: string
  content_snapshot_sha256: string | null
}

interface PostRefRow {
  post_ref: number
}

/** Parse a frozen snapshot into its full record + metadata `fields` block. */
function parseSnapshot(snapshotJson: string): { record: Record<string, unknown>; fields: Record<string, unknown> } {
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

function isLive(lifecycle: PublicLifecycle, deletedAt: number): boolean {
  return lifecycle === 'published' && deletedAt === 0
}

function deriveStatus(lifecycle: PublicLifecycle, deletedAt: number): 'draft' | 'published' | 'deleted' {
  if (deletedAt !== 0) return 'deleted'
  if (lifecycle === 'published') return 'published'
  return 'draft'
}

/* ------------------------------------------------------------------ */
/* degraded behavior (canonical tables absent)                         */
/* ------------------------------------------------------------------ */

/**
 * True when the canonical fact tables exist on this DB. Canonical read paths
 * DEGRADE rather than soft-switch: when the migration/DDL is not yet applied
 * (or the tables were dropped after retirement) the legacy `posts` projection
 * is NOT queried anymore (posts is retired from the public runtime). Readers
 * return empty / degraded results so they never 500 on a missing table.
 */
async function canonicalAvailable(db: Database): Promise<boolean> {
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

/**
 * Materialize a `PublicArticle` from canonical formal row + version snapshots.
 *
 * Content comes from the FORMAL version; management / access-control fields
 * come from the LATEST version (immediate effect of article-level commands,
 * ADR 0007). `latestJson` falls back to the formal snapshot when absent.
 */
function buildPublicArticle(
  formal: FormalRow,
  snapshotJson: string,
  postRef: number,
  viewCount = 0,
  latestJson?: string | null,
): PublicArticle {
  const { record } = parseSnapshot(snapshotJson)
  const fields = parseSnapshot(latestJson ?? snapshotJson).fields
  const deletedAt = toStatus(fields.deleted_at)
  const updatedAt = toStatus(fields.updated_at) || formal.published_at

  return {
    id: postRef,
    articleId: formal.article_id,
    slug: formal.slug,
    version: formal.version,
    lifecycle: formal.lifecycle,
    live: isLive(formal.lifecycle, deletedAt),
    status: deriveStatus(formal.lifecycle, deletedAt),
    deleted_at: deletedAt !== 0 ? deletedAt : null,
    title: typeof fields.title === 'string' ? fields.title : formal.slug,
    content: typeof record.original_content === 'string' ? record.original_content : '',
    html: typeof record.original_html === 'string' ? record.original_html : '',
    description: typeof fields.description === 'string' ? fields.description : null,
    category: typeof fields.category === 'string' ? fields.category : null,
    tags: toTags(fields.tags),
    password: typeof fields.password === 'string' && fields.password ? fields.password : null,
    is_pinned: toStatus(fields.is_pinned),
    is_hidden: toStatus(fields.is_hidden),
    cover_image: typeof fields.cover_image === 'string' ? fields.cover_image : null,
    first_published_at: formal.first_published_at,
    published_at: formal.first_published_at,
    updated_at: updatedAt,
    view_count: viewCount,
  }
}

async function findPostRef(db: Database, articleId: number): Promise<number> {
  const row = await db
    .prepare('SELECT post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<PostRefRow>()
    .catch(() => null)
  return row?.post_ref ?? 0
}

async function findFormalByArticle(db: Database, articleId: number): Promise<FormalRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, slug, lifecycle, first_published_at, published_at
       FROM formal_publications WHERE article_id = ?`,
    )
    .bind(articleId)
    .first<FormalRow>()
    .catch(() => null)
}

async function findFormalBySlug(db: Database, slug: string): Promise<FormalRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, slug, lifecycle, first_published_at, published_at
       FROM formal_publications WHERE slug = ?`,
    )
    .bind(slug)
    .first<FormalRow>()
    .catch(() => null)
}

async function findVersion(db: Database, articleId: number, version: number): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = ?`,
    )
    .bind(articleId, version)
    .first<VersionRow>()
    .catch(() => null)
}

async function findLatestVersionRow(db: Database, articleId: number): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<VersionRow>()
    .catch(() => null)
}

/* ------------------------------------------------------------------ */
/* single-hop detail resolution                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve a requested public address to its CANONICAL article:
 *
 *   1. single-hop via the slug-address registry (historical → current, 301),
 *   2. fall back to `formal_publications.slug` when the registry is not yet
 *      backfilled on this DB (post-migration safety),
 *   3. load the frozen `article_versions` snapshot at the formal version.
 *
 * Returns `redirectSlug` for a historical address so the route can issue a
 * permanent redirect without chaining. Returns `null` for unknown addresses
 * and un-registered candidates (not yet live → 404).
 */
export async function resolvePublicArticle(
  db: Database,
  slug: string,
): Promise<PublicArticleResolution> {
  // Degraded: without the canonical fact tables the address is unresolvable
  // (posts is retired from the public runtime — no legacy read).
  if (!(await canonicalAvailable(db))) {
    return { article: null, redirectSlug: null }
  }

  const address = await resolveArticleAddress(db, slug).catch(() => null)

  let articleId: number | null = address?.articleId ?? null
  const redirectSlug: string | null = address?.redirect ? address.currentSlug : null
  const targetSlug = address?.currentSlug ?? slug

  let formal: FormalRow | null = null
  if (articleId !== null) {
    formal = await findFormalByArticle(db, articleId)
  }
  // Registry unknown → try the live formal slug directly (covers legacy slugs
  // before address backfill; still fully canonical via formal_publications).
  if (!formal) {
    formal = await findFormalBySlug(db, targetSlug)
    if (formal) articleId = formal.article_id
  }
  if (!formal) {
    return { article: null, redirectSlug }
  }

  // Historical address must resolve to the article's CURRENT address; the
  // formatted slug may change even when the registry is accurate — trust it.
  const version = await findVersion(db, formal.article_id, formal.version)
  if (!version) {
    // No frozen version fact — the article is not observable yet. Only the raw
    // formal row exists; treat as not publicly resolvable (no body).
    return { article: null, redirectSlug }
  }

  const postRef = await findPostRef(db, formal.article_id)
  // Management fields come from the LATEST version (immediate article-level
  // commands); content stays anchored to the formal version.
  const latest = await findLatestVersionRow(db, formal.article_id)
  // view_count is not carried by canonical facts (only unstably mirrored to
  // `posts`); drop the legacy read so the detail path has no `FROM posts`.
  const article = buildPublicArticle(formal, version.snapshot_json, postRef, 0, latest?.snapshot_json ?? null)

  // A historical single-hop must carry the CURRENT slug, never the old one.
  if (redirectSlug) {
    article.slug = redirectSlug
  }
  return { article, redirectSlug }
}

/* ------------------------------------------------------------------ */
/* canonical public list (home / category / feed / sitemap)            */
/* ------------------------------------------------------------------ */

const LIST_COLUMNS = `
  f.article_id, f.version, f.slug, f.lifecycle,
  f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json,
  COALESCE(a.post_ref, 0) AS post_ref
`

/** The LATEST version join — management fields read from it (ADR 0007). */
const LATEST_JOIN = `
  LEFT JOIN article_versions lv ON lv.article_id = f.article_id
   AND lv.version = (SELECT MAX(version) FROM article_versions WHERE article_id = f.article_id)`

/**
 * List the CANONICAL public articles: lifecycle published (from
 * `formal_publications`), non-deleted, and — unless told otherwise — public
 * (no password, not hidden — read from the frozen version snapshot JSON via
 * JSON1). Ordered by pinned first, then first-published descending, so the
 * projection/FTS ordering and pagination are stable across rebuilds.
 */
export async function listPublicArticles(
  db: Database,
  options: PublicListOptions = {},
): Promise<PublicArticle[]> {
  const {
    limit = 50,
    offset = 0,
    includePassword = false,
    includeHidden = false,
    category,
  } = options

  // Degraded: posts is retired from the public runtime — empty list.
  if (!(await canonicalAvailable(db))) {
    return []
  }

  const conditions: string[] = [
    `f.lifecycle = 'published'`,
    `COALESCE(${F.deleted_at}, 0) = 0`,
  ]
  const params: unknown[] = []
  if (!includePassword) {
    conditions.push(`COALESCE(${F.password}, '') = ''`)
  }
  if (!includeHidden) {
    conditions.push(`COALESCE(${F.is_hidden}, 0) = 0`)
  }
  if (category && category.trim()) {
    conditions.push(`COALESCE(${F.category}, '') = ?`)
    params.push(category)
  }

  const where = conditions.join(' AND ')
  interface ListRow extends FormalRow, VersionRow {
    post_ref: number
    latest_snapshot_json: string | null
  }

  const { results } = await db
    .prepare(
      `SELECT ${LIST_COLUMNS}
       FROM formal_publications f
       JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
       ${LATEST_JOIN}
       JOIN articles a ON a.id = f.article_id
       WHERE ${where}
       ORDER BY COALESCE(${F.is_pinned}, 0) DESC, f.first_published_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<ListRow>()

  return (results ?? []).map((row) =>
    buildPublicArticle(row, row.snapshot_json, row.post_ref, 0, row.latest_snapshot_json),
  )
}

/** Canonical public count (honours the same access-control options). */
export async function countPublicArticles(
  db: Database,
  options: Omit<PublicListOptions, 'limit' | 'offset'> = {},
): Promise<number> {
  const { includePassword = false, includeHidden = false, category } = options

  // Degraded: posts is retired from the public runtime — zero count.
  if (!(await canonicalAvailable(db))) {
    return 0
  }
  const conditions: string[] = [
    `f.lifecycle = 'published'`,
    `COALESCE(${F.deleted_at}, 0) = 0`,
  ]
  const params: unknown[] = []
  if (!includePassword) conditions.push(`COALESCE(${F.password}, '') = ''`)
  if (!includeHidden) conditions.push(`COALESCE(${F.is_hidden}, 0) = 0`)
  if (category && category.trim()) {
    conditions.push(`COALESCE(${F.category}, '') = ?`)
    params.push(category)
  }
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM formal_publications f
       JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
       ${LATEST_JOIN}
       WHERE ${conditions.join(' AND ')}`,
    )
    .bind(...params)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Search the public surface. FTS (`posts_fts`) is a REBUILDABLE projection —
 * it locates candidate rows, then each hit is re-anchored to the canonical
 * formal set (`formal_publications` + `article_versions`) and access-control
 * rules are re-applied. A hit whose canonical lifecycle is unpublished /
 * deleted / hidden / passworded is dropped.
 */
export async function searchPublicArticles(
  db: Database,
  query: string,
  limit = 50,
): Promise<PublicArticle[]> {
  if (!query.trim()) return []

  // Degraded: posts is retired from the public runtime — no search results.
  if (!(await canonicalAvailable(db))) {
    return []
  }

  let candidates: { post_ref: number }[] = []
  try {
    const { results } = await db
      .prepare(
        `SELECT a.post_ref AS post_ref FROM article_fts
         JOIN articles a ON a.id = article_fts.rowid
         WHERE article_fts MATCH ?
         LIMIT ?`,
      )
      .bind(query, limit * 4)
      .all<{ post_ref: number }>()
    candidates = results ?? []
  } catch {
    // FTS missing/parse error → fall back to a LIKE scan is NOT canonical-safe
    // here; return empty (search remains a rebuildable, best-effort surface).
    return []
  }
  if (candidates.length === 0) return []

  const all = await listPublicArticles(db, { limit: 1000, includeHidden: false, includePassword: false })
  const byPostRef = new Map<number, PublicArticle>()
  for (const article of all) byPostRef.set(article.id, article)

  const matched: PublicArticle[] = []
  for (const candidate of candidates) {
    const article = byPostRef.get(candidate.post_ref)
    if (article?.live) matched.push(article)
    if (matched.length >= limit) break
  }
  // Keep deterministic ordering (pinned + recency) for stable results.
  return matched
}
