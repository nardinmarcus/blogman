/**
 * L2 — canonical public read kernel (issue #67).
 *
 * Pure DB logic that serves every public reading path from canonical D1 facts.
 * No legacy `posts` SELECT drives a visibility / lifecycle / address / pinned
 * decision here — those come from `formal_publications` +
 * `article_versions` (+ `article_slug_addresses` for the single-hop registry).
 * SQLite JSON1 (`json_extract`) reads the latest immutable snapshot's
 * access-control + pinned facts so list filtering and pin-ordering stay
 * canonical and happen in SQL (correct pagination on real D1 / in tests).
 */

import type { Database } from '@/lib/repositories/schema'
import {
  canonicalFactsAvailableForRequest,
  articleFromCanonicalRow,
  CANONICAL_ROW_COLUMNS,
  CANONICAL_LATEST_JOIN,
  MANAGEMENT,
  discoveryConditions,
  readCanonicalRows,
} from './canon'
import { resolveArticleAddress } from '@/lib/slug-address'
import type {
  PublicArticle,
  PublicArticleResolution,
  PublicLifecycle,
  PublicListOptions,
} from './types'

interface FormalRow {
  article_id: number
  version: number
  slug: string
  lifecycle: PublicLifecycle
  first_published_at: number
  published_at: number
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
  // #244 P1 — shared request-scoped probe (swallow semantics preserved).
  return canonicalFactsAvailableForRequest(db)
}

/* ------------------------------------------------------------------ */
/* single-hop detail resolution                                        */
/* ------------------------------------------------------------------ */

interface DetailRow {
  reg_kind: 'current' | 'candidate' | 'historical' | null
  reg_article_id: number | null
  reg_current_slug: string | null
  article_id: number | null
  version: number | null
  slug: string | null
  lifecycle: PublicLifecycle | null
  first_published_at: number | null
  published_at: number | null
  snapshot_json: string | null
  latest_snapshot_json: string | null
  post_ref: number | null
}

/**
 * ONE collapsed detail-resolution read (#244 P0): the slug-address registry
 * (current/candidate/historical + historical single-hop target), the formal
 * publication row (registry miss → formal-slug fallback), the formal version
 * snapshot, the LATEST version snapshot (ADR 0007 management fields) and the
 * legacy post_ref all arrive in a single roundtrip.
 *
 * Semantics preserved vs. the previous six sequential reads:
 *   - `current`    → served directly,
 *   - `historical` → 301 single-hop to the registry's current address
 *     (historical without a registered current → formal-slug fallback),
 *   - `candidate`  → not publicly resolvable,
 *   - registry miss → `formal_publications.slug` fallback (pre-backfill),
 *   - formal row without its frozen version snapshot → no observable article.
 */
const DETAIL_QUERY = `
SELECT
  reg.kind AS reg_kind,
  reg.article_id AS reg_article_id,
  regcur.slug AS reg_current_slug,
  f.article_id, f.version, f.slug AS slug, f.lifecycle,
  f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json,
  COALESCE(a.post_ref, 0) AS post_ref
FROM article_slug_addresses reg
LEFT JOIN article_slug_addresses regcur
  ON regcur.article_id = reg.article_id AND regcur.kind = 'current'
LEFT JOIN formal_publications f ON f.article_id = reg.article_id
LEFT JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
${CANONICAL_LATEST_JOIN}
LEFT JOIN articles a ON a.id = f.article_id
WHERE reg.slug = ?
UNION ALL
SELECT
  NULL, NULL, NULL,
  f.article_id, f.version, f.slug, f.lifecycle,
  f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json,
  COALESCE(a.post_ref, 0)
FROM formal_publications f
JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
${CANONICAL_LATEST_JOIN}
LEFT JOIN articles a ON a.id = f.article_id
WHERE f.slug = ?
  AND NOT EXISTS (SELECT 1 FROM article_slug_addresses WHERE slug = ?)`

/** Formal-only branch — the pre-DDL fallback when the registry is absent. */
const FORMAL_ONLY_QUERY = `
SELECT
  NULL AS reg_kind, NULL AS reg_article_id, NULL AS reg_current_slug,
  f.article_id, f.version, f.slug AS slug, f.lifecycle,
  f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json,
  COALESCE(a.post_ref, 0) AS post_ref
FROM formal_publications f
JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
${CANONICAL_LATEST_JOIN}
LEFT JOIN articles a ON a.id = f.article_id
WHERE f.slug = ?`

/** Formal-only WITHOUT the articles join but WITH the registry columns —
 * `articles` pre-DDL fallback; the legacy post_ref lookup failed silently
 * (id → 0) while registry resolution/redirect still worked. */
const REGISTRY_NO_REF_QUERY = `
SELECT
  reg.kind AS reg_kind,
  reg.article_id AS reg_article_id,
  regcur.slug AS reg_current_slug,
  f.article_id, f.version, f.slug AS slug, f.lifecycle,
  f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json,
  0 AS post_ref
FROM article_slug_addresses reg
LEFT JOIN article_slug_addresses regcur
  ON regcur.article_id = reg.article_id AND regcur.kind = 'current'
JOIN formal_publications f ON f.article_id = reg.article_id
JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
${CANONICAL_LATEST_JOIN}
WHERE reg.slug = ?`

/** Formal-only WITHOUT the articles join — registry AND articles both absent;
 * post_ref degrades to 0 and no registry resolution exists. */
const FORMAL_ONLY_NO_REF_QUERY = `
SELECT
  NULL AS reg_kind, NULL AS reg_article_id, NULL AS reg_current_slug,
  f.article_id, f.version, f.slug AS slug, f.lifecycle,
  f.first_published_at, f.published_at,
  v.snapshot_json,
  lv.snapshot_json AS latest_snapshot_json,
  0 AS post_ref
FROM formal_publications f
JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
${CANONICAL_LATEST_JOIN}
WHERE f.slug = ?`

/** True ONLY for a missing-table error naming EXACTLY `table` (full-name
 * match — `articles_archive` must not count as `articles`); any other
 * failure is a real DB fault that must propagate. */
function isMissingTableError(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return new RegExp(`no such table:? ${table}(?![\\w])`, 'i').test(message)
}

/**
 * Terminal degraded resolution for a missing fact table (mirrors the base
 * per-read silent catches):
 *   - `article_versions` absent → the article is not observable; a
 *     historical address still redirects through the registry read.
 *   - any other KNOWN fact table absent → unresolvable, no redirect.
 * Unknown faults PROPAGATE.
 */
async function degradeDetail(
  db: Database,
  slug: string,
  error: unknown,
): Promise<{ row: DetailRow | null; redirectSlug: string | null }> {
  if (isMissingTableError(error, 'article_versions')) {
    const address = await resolveArticleAddress(db, slug).catch(() => null)
    return { row: null, redirectSlug: address?.redirect ? address.currentSlug : null }
  }
  for (const table of ['formal_publications', 'article_slug_addresses', 'articles'] as const) {
    if (isMissingTableError(error, table)) {
      return { row: null, redirectSlug: null }
    }
  }
  throw error
}

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

  // Single collapsed fact read: registry resolution + formal row + formal
  // version + latest version + post_ref (#244 P0 query budget), with the
  // base implementation's per-table silent-catch semantics preserved when an
  // individual fact table is absent (pre-DDL DB):
  //   registry missing → formal fallback; articles missing → post_ref 0;
  //   versions missing → not observable; formal missing → unresolvable.
  // ANY other error propagates.
  let row: DetailRow | null = null
  let degradedRedirectSlug: string | null = null
  try {
    const { results } = await db
      .prepare(DETAIL_QUERY)
      .bind(slug, slug, slug)
      .all<DetailRow>()
    row = results?.[0] ?? null
  } catch (error) {
    if (isMissingTableError(error, 'article_slug_addresses')) {
      try {
        const { results } = await db.prepare(FORMAL_ONLY_QUERY).bind(slug).all<DetailRow>()
        row = results?.[0] ?? null
      } catch (fallbackError) {
        if (isMissingTableError(fallbackError, 'articles')) {
          try {
            const { results } = await db.prepare(FORMAL_ONLY_NO_REF_QUERY).bind(slug).all<DetailRow>()
            row = results?.[0] ?? null
          } catch (noRefError) {
            const degraded = await degradeDetail(db, slug, noRefError)
            row = degraded.row
            degradedRedirectSlug = degraded.redirectSlug
          }
        } else {
          const degraded = await degradeDetail(db, slug, fallbackError)
          row = degraded.row
          degradedRedirectSlug = degraded.redirectSlug
        }
      }
    } else if (isMissingTableError(error, 'articles')) {
      try {
        const { results } = await db.prepare(REGISTRY_NO_REF_QUERY).bind(slug).all<DetailRow>()
        row = results?.[0] ?? null
      } catch (regNoRefError) {
        if (isMissingTableError(regNoRefError, 'article_slug_addresses')) {
          // Registry absent too → no address resolution at all.
          try {
            const { results } = await db.prepare(FORMAL_ONLY_NO_REF_QUERY).bind(slug).all<DetailRow>()
            row = results?.[0] ?? null
          } catch (noRefError) {
            const degraded = await degradeDetail(db, slug, noRefError)
            row = degraded.row
            degradedRedirectSlug = degraded.redirectSlug
          }
        } else {
          const degraded = await degradeDetail(db, slug, regNoRefError)
          row = degraded.row
          degradedRedirectSlug = degraded.redirectSlug
        }
      }
    } else {
      const degraded = await degradeDetail(db, slug, error)
      row = degraded.row
      degradedRedirectSlug = degraded.redirectSlug
    }
  }
  if (!row) {
    return { article: null, redirectSlug: degradedRedirectSlug }
  }

  const regKind = row.reg_kind
  // A reserved candidate is not publicly resolvable before go-live.
  if (regKind === 'candidate') {
    return { article: null, redirectSlug: null }
  }
  // Historical address whose article has no registered current address:
  // serve only through the formal live slug (pre-backfill semantics).
  if (regKind === 'historical' && !row.reg_current_slug) {
    if (row.article_id == null || row.slug !== slug) {
      return { article: null, redirectSlug: null }
    }
  }
  // Historical single-hop carries the article's CURRENT address for the 301.
  const redirectSlug = regKind === 'historical' ? row.reg_current_slug ?? null : null
  // No formal publication fact, or no frozen version snapshot → not observable.
  if (
    row.article_id == null ||
    row.version == null ||
    !row.snapshot_json ||
    row.lifecycle == null ||
    row.slug == null ||
    row.first_published_at == null ||
    row.published_at == null
  ) {
    return { article: null, redirectSlug }
  }

  const formal: FormalRow = {
    article_id: row.article_id,
    version: row.version,
    slug: row.reg_current_slug ?? row.slug,
    lifecycle: row.lifecycle,
    first_published_at: row.first_published_at,
    published_at: row.published_at,
  }
  // Management fields come from the LATEST version (immediate article-level
  // commands); content stays anchored to the formal version.
  const article = articleFromCanonicalRow({
    ...formal,
    snapshot_json: row.snapshot_json,
    post_ref: row.post_ref ?? 0,
    latest_snapshot_json: row.latest_snapshot_json,
  })

  // A historical single-hop must carry the CURRENT slug, never the old one.
  if (redirectSlug) {
    article.slug = redirectSlug
  }
  return { article, redirectSlug }
}

/* ------------------------------------------------------------------ */
/* canonical public list (home / category / feed / sitemap)            */
/* ------------------------------------------------------------------ */

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

  const conditions = discoveryConditions({ includePassword, includeHidden })
  const params: unknown[] = []
  if (category && category.trim()) {
    conditions.push(`COALESCE(${MANAGEMENT.category}, '') = ?`)
    params.push(category)
  }

  const where = conditions.join(' AND ')
  const rows = await readCanonicalRows(
    db,
    `SELECT ${CANONICAL_ROW_COLUMNS}
     FROM formal_publications f
     JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
     ${CANONICAL_LATEST_JOIN}
     JOIN articles a ON a.id = f.article_id
     WHERE ${where}
     ORDER BY COALESCE(${MANAGEMENT.is_pinned}, 0) DESC, f.first_published_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  return rows.map(articleFromCanonicalRow)
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
  const conditions = discoveryConditions({ includePassword, includeHidden })
  const params: unknown[] = []
  if (category && category.trim()) {
    conditions.push(`COALESCE(${MANAGEMENT.category}, '') = ?`)
    params.push(category)
  }
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
     FROM formal_publications f
     JOIN article_versions v ON v.article_id = f.article_id AND v.version = f.version
     ${CANONICAL_LATEST_JOIN}
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
