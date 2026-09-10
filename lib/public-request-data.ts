/**
 * #244 P1 — request-scoped public read dedup.
 *
 * `generateMetadata` and the page body each need the same canonical article
 * resolution within ONE request render. This module collapses them onto a
 * single `resolvePublicArticle` execution per (db, slug) pair per request:
 *
 *   - React `cache()` scopes the per-request lookup table to ONE server
 *     render — it is reset between requests, so no cross-request stale cache
 *     can bleed (proven at the real RSC seam in
 *     tests/lib/public-request-data.test.ts),
 *   - the table is keyed by the DB binding identity, so a different DB
 *     instance can never observe another binding's cached promise,
 *   - the cache key is the stable primitive `slug`,
 *   - failures are not cached: a rejected promise is evicted so a transient
 *     DB error can be retried within the same request.
 *
 * This is deliberately NOT a process-global TTL cache: every request still
 * executes its own reads.
 */

import { cache } from 'react'
import type { Database } from '@/lib/repositories/schema'
import { resolvePublicArticle } from '@/lib/public-read'
import type { PublicArticleResolution } from '@/lib/public-read'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'

/**
 * The FIXED public setting allowlist (#244). Exactly these keys are ever
 * read through the batched public path — never `SELECT *` over
 * site_settings, which holds admin/credential-bearing configuration.
 */
export const PUBLIC_SETTING_KEYS = [
  'custom_js',
  'body_font',
  'default_theme',
  'nav_links',
  'category_order',
] as const

export type PublicSettingKey = (typeof PUBLIC_SETTING_KEYS)[number]

/**
 * ONE parameterized SELECT for the fixed public key set. Semantics mirror
 * repositories.getSetting: a migration-required DB rethrows; any other
 * fault degrades to "all keys unset" (public pages keep their defaults).
 * Uncached — the per-request wrapper below adds the React-cache scope;
 * write-path callers (admin category reorder) use this raw form so a
 * setSetting inside the same request is never shadowed by a stale map.
 */
export async function getPublicSettingsBatch(db: Database): Promise<Map<PublicSettingKey, string | null>> {
  const map = new Map<PublicSettingKey, string | null>(PUBLIC_SETTING_KEYS.map((key) => [key, null]))
  try {
    const placeholders = PUBLIC_SETTING_KEYS.map(() => '?').join(', ')
    const { results } = await db
      .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
      .bind(...PUBLIC_SETTING_KEYS)
      .all<{ key: string; value: string | null }>()
    for (const row of results ?? []) {
      if ((PUBLIC_SETTING_KEYS as readonly string[]).includes(row.key)) {
        map.set(row.key as PublicSettingKey, row.value ?? null)
      }
    }
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
  }
  return map
}

/** Request-scoped batched settings (one SELECT per request, per DB). */
const perRequestSettingsBatch = cache((db: Database) => getPublicSettingsBatch(db))

export function getPublicSettingsForRequest(db: Database): Promise<Map<PublicSettingKey, string | null>> {
  return perRequestSettingsBatch(db)
}

export async function getPublicSettingForRequest(db: Database, key: PublicSettingKey): Promise<string | null> {
  return (await getPublicSettingsForRequest(db)).get(key) ?? null
}

/** One per-(request, db) slug → pending resolution map. The `db` argument is
 * the React cache KEY (binding identity) only — intentionally not read. */
const perRequestMaps = cache((db: Database) => {
  void db
  return new Map<string, Promise<PublicArticleResolution>>()
})

export function getPublicArticleForRequest(db: Database, slug: string): Promise<PublicArticleResolution> {
  const perDb = perRequestMaps(db)
  const pending = perDb.get(slug)
  if (pending) return pending

  const resolution = resolvePublicArticle(db, slug).catch((error: unknown) => {
    // Do not pin failures inside the request scope.
    perDb.delete(slug)
    throw error
  })
  perDb.set(slug, resolution)
  return resolution
}

export { canonicalFactsAvailableForRequest, canonicalFactsAvailableStrictForRequest } from '@/lib/public-read/canon'
