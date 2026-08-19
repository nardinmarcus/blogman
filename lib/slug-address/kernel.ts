/**
 * B3-04 — permanent slug address registry kernel (issue #36).
 *
 * Pure-ish DB logic that owns the exclusivity + rotation + resolution of every
 * public address bound to an article identity. It never guesses history: only
 * Addresses that were actually live (`current`) are ever demoted to
 * `historical`, and a `candidate` slug becomes `current` only when the revision
 * that carries it is promoted inside the SAME transaction as the address
 * rotation (so go-live and address registration are one atomic fact).
 *
 * Summary of the lifecycle:
 *
 *   - a revision whose slug differs from the formal current slug reserves that
 *     address as `candidate` at SAVE time (exclusive, but never served) — the
 *     author may close the candidate edit without releasing the address,
 *   - promotion first rotates addresses in the SAME D1 batch that raises the
 *     formal version: the old live slug becomes `historical` (only when the
 *     slug actually changed) and the promoted slug becomes `current`,
 *   - a `historical` address ALWAYS resolves directly to the article's
 *     `current` address (single hop, no redirect chain), while a `candidate`
 *     is not publicly resolvable before go-live,
 *   - backfill registers only current observable slugs and no invented
 *     history (`backfillCurrentAddresses`).
 */

import type { Database } from '@/lib/repositories/schema'

export type AddressKind = 'current' | 'candidate' | 'historical'

export interface AddressRow {
  id: number
  slug: string
  article_id: number
  kind: AddressKind
  created_at: number
  updated_at: number
}

export interface AddressResolution {
  articleId: number
  /** The article's live public address — the single-hop target. */
  currentSlug: string
  /** True only when the requested slug is a historical (superseded) address. */
  redirect: boolean
}

export type ReserveCandidateResult =
  | { outcome: 'reserved' }
  | { outcome: 'no-change' }
  | { outcome: 'conflict' }

export type BackfillResult = { registered: number; skipped: number }

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

async function findSlugRow(db: Database, slug: string): Promise<AddressRow | null> {
  return db
    .prepare(
      'SELECT id, slug, article_id, kind, created_at, updated_at FROM article_slug_addresses WHERE slug = ?',
    )
    .bind(slug)
    .first<AddressRow>()
}

async function findCurrentByArticle(db: Database, articleId: number): Promise<AddressRow | null> {
  return db
    .prepare(
      `SELECT id, slug, article_id, kind, created_at, updated_at
       FROM article_slug_addresses WHERE article_id = ? AND kind = 'current'`,
    )
    .bind(articleId)
    .first<AddressRow>()
}

/* ------------------------------------------------------------------ */
/* exclusivity helpers (public — also reused by the promote gate)      */
/* ------------------------------------------------------------------ */

/**
 * True when `slug` is already occupied by a DIFFERENT article (as current,
 * candidate or historical). Used to block a promote / save whose candidate
 * slug would violate "按文章身份独占".
 */
export async function isSlugOwnedByOther(
  db: Database,
  slug: string,
  articleId: number,
): Promise<boolean> {
  const row = await findSlugRow(db, slug)
  return row !== null && row.article_id !== articleId
}

/** True when `slug` is this article's own historical address (a revert). */
export async function isOwnHistorical(
  db: Database,
  slug: string,
  articleId: number,
): Promise<boolean> {
  const row = await findSlugRow(db, slug)
  return row !== null && row.article_id === articleId && row.kind === 'historical'
}

/* ------------------------------------------------------------------ */
/* candidate reservation (save-time)                                   */
/* ------------------------------------------------------------------ */

/**
 * Reserve a pending revision's slug as a `candidate` address. Called by the
 * shared save router whenever a revision carries a slug different from the
 * current live one. `no-change` when the slug equals the current address
 * (nothing to reserve); `conflict` when the slug is already occupied by a
 * different article OR by this article's own current/historical address.
 * Idempotent: a re-save of the same candidate returns `reserved` without
 * creating a second row. Never releases an already-registered address.
 */
export async function reserveCandidate(
  db: Database,
  input: { articleId: number; currentSlug?: string; candidateSlug: string; now?: number },
): Promise<ReserveCandidateResult> {
  const { articleId, candidateSlug, currentSlug } = input
  const now = input.now ?? unixNow()
  if (!candidateSlug || candidateSlug.trim() === '') return { outcome: 'conflict' }
  if (currentSlug && candidateSlug === currentSlug) return { outcome: 'no-change' }

  // Pre-check against every registered kind (deterministic fast path).
  const existing = await findSlugRow(db, candidateSlug)
  if (existing) {
    if (existing.article_id === articleId && existing.kind === 'candidate') {
      return { outcome: 'reserved' }
    }
    // owned by another article, or this article's own current/historical → block.
    return { outcome: 'conflict' }
  }

  // Guarded insert: a racing writer that registered this slug wins; we re-read.
  try {
    await db
      .prepare(
        `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
         SELECT ?, ?, 'candidate', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM article_slug_addresses WHERE slug = ?)`,
      )
      .bind(candidateSlug, articleId, now, now, candidateSlug)
      .run()
    return { outcome: 'reserved' }
  } catch {
    const raced = await findSlugRow(db, candidateSlug)
    if (raced && raced.article_id === articleId && raced.kind === 'candidate') {
      return { outcome: 'reserved' }
    }
    return { outcome: 'conflict' }
  }
}

/* ------------------------------------------------------------------ */
/* promotion rotation (guarded statements for the go-live batch)       */
/* ------------------------------------------------------------------ */

export interface PromoteAddressInput {
  articleId: number
  oldSlug: string
  newSlug: string
  /** The promoted version fact that guards every rotation statement. */
  promotedVersion: number
  operationId: string
  now?: number
}

/**
 * The guarded address-rotation statements to append INSIDE the promotion D1
 * batch. Every statement only applies when the promoted version fact (written
 * by an earlier statement in the same batch) exists — so a failed/pre-empted
 * promotion leaves zero address changes:
 *
 *   - old live slug → `historical` (only when the slug actually changed),
 *   - promoted candidate slug → `current` (falls back to registering the slug
 *     as `current` directly when no candidate row exists, e.g. a legacy
 *     revision that pre-dates save-time reservation).
 */
export function promoteAddressStatements(
  db: Database,
  input: PromoteAddressInput,
): D1PreparedStatement[] {
  const { articleId, oldSlug, newSlug, promotedVersion, operationId } = input
  const now = input.now ?? unixNow()
  const versionFact = `EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ? AND operation_id = ?)`
  const vfArgs = [articleId, promotedVersion, operationId]

  return [
    // (1) Register the old live slug as historical when it was never in the
    //     registry (pre-backfill / first rename) and the slug actually changed.
    db
      .prepare(
        `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
         SELECT ?, ?, 'historical', ?, ?
         WHERE ? != ?
           AND NOT EXISTS (SELECT 1 FROM article_slug_addresses WHERE slug = ?)
           AND ${versionFact}`,
      )
      .bind(oldSlug, articleId, now, now, newSlug, oldSlug, oldSlug, ...vfArgs),
    // (2) Demote an existing current row for the old slug to historical.
    db
      .prepare(
        `UPDATE article_slug_addresses SET kind = 'historical', updated_at = ?
         WHERE article_id = ? AND kind = 'current' AND slug = ?
           AND ? != ?
           AND ${versionFact}`,
      )
      .bind(now, articleId, oldSlug, newSlug, oldSlug, ...vfArgs),
    // (3) Promote the reserved candidate slug to current.
    db
      .prepare(
        `UPDATE article_slug_addresses SET kind = 'current', updated_at = ?
         WHERE article_id = ? AND kind = 'candidate' AND slug = ?
           AND ? != ?
           AND ${versionFact}`,
      )
      .bind(now, articleId, newSlug, newSlug, oldSlug, ...vfArgs),
    // (4) Register the new slug as current directly when no candidate row
    //     exists (stays a no-op when (3) already made it current).
    db
      .prepare(
        `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
         SELECT ?, ?, 'current', ?, ?
         WHERE ? != ?
           AND NOT EXISTS (SELECT 1 FROM article_slug_addresses WHERE slug = ?)
           AND ${versionFact}`,
      )
      .bind(newSlug, articleId, now, now, newSlug, oldSlug, newSlug, ...vfArgs),
  ]
}

/* ------------------------------------------------------------------ */
/* public resolution (single-hop, no chain)                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve a requested public address to the article's current live address.
 *
 *   - `current`  → served directly (`redirect: false`),
 *   - `historical` → single-hop to the SAME article's current address
 *     (`redirect: true`) — never to an intermediate slug,
 *   - `candidate` → NULL (a pending slug is not publicly resolvable until it
 *     actually goes live),
 *   - unknown   → NULL (not an address this registry knows).
 */
export async function resolveArticleAddress(
  db: Database,
  slug: string,
): Promise<AddressResolution | null> {
  if (!slug) return null
  const row = await findSlugRow(db, slug)
  if (!row) return null
  if (row.kind === 'current') {
    return { articleId: row.article_id, currentSlug: row.slug, redirect: false }
  }
  if (row.kind === 'historical') {
    const current = await findCurrentByArticle(db, row.article_id)
    if (!current) return null
    return { articleId: row.article_id, currentSlug: current.slug, redirect: true }
  }
  // candidate — not yet live.
  return null
}

/* ------------------------------------------------------------------ */
/* backfill (migration: only current observable slugs, no guesswork)   */
/* ------------------------------------------------------------------ */

/**
 * Register every CURRENT observable public address from the formal first-publish
 * surface (`formal_publications`) as a `current` address. It never invents
 * history (historical addresses can only be produced by real promotions), and
 * it never overwrites or releases an address already claimed by an article.
 * Idempotent.
 */
export async function backfillCurrentAddresses(db: Database): Promise<BackfillResult> {
  const { results } = await db
    .prepare(
      `SELECT article_id, slug FROM formal_publications
       ORDER BY article_id ASC`,
    )
    .all<{ article_id: number; slug: string }>()

  let registered = 0
  let skipped = 0
  const now = unixNow()
  for (const row of results ?? []) {
    try {
      await db
        .prepare(
          `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
           SELECT ?, ?, 'current', ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM article_slug_addresses WHERE slug = ?)
             AND NOT EXISTS (SELECT 1 FROM article_slug_addresses
                             WHERE article_id = ? AND kind = 'current')`,
        )
        .bind(row.slug, row.article_id, now, now, row.slug, row.article_id)
        .run()
      const wrote = await db
        .prepare('SELECT id FROM article_slug_addresses WHERE slug = ? AND article_id = ?')
        .bind(row.slug, row.article_id)
        .first<{ id: number }>()
      if (wrote) registered += 1
      else skipped += 1
    } catch {
      // A rival article claimed this slug' — leave it untouched.
      skipped += 1
    }
  }
  return { registered, skipped }
}
