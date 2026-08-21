/**
 * #234 Phase A — resolve an article id by slug through the permanent address
 * registry (ADR 0009), falling back to the identity slug for pre-registry
 * rows. Shared by the admin routes; lives server-side only.
 */

import type { Database } from '@/lib/repositories/schema'
import { normalizePostSlug } from '@/lib/post-utils'

export async function resolveArticleIdBySlug(
  db: Database,
  slug: string,
): Promise<number | null> {
  const normalized = normalizePostSlug(slug)
  if (!normalized) return null
  // Errors propagate: a missing/broken schema must surface as the fixed safe
  // 503 (migration-required), never as a silent 404.
  const byRegistry = await db
    .prepare('SELECT article_id FROM article_slug_addresses WHERE slug = ?')
    .bind(normalized)
    .first<{ article_id: number }>()
  if (byRegistry) return byRegistry.article_id
  const byIdentity = await db
    .prepare('SELECT id FROM articles WHERE slug = ?')
    .bind(normalized)
    .first<{ id: number }>()
  return byIdentity?.id ?? null
}
