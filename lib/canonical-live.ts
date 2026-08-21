/**
 * #234 Phase A — canonical live authoring state.
 *
 * The legacy `posts` row was the "current state" read by peripheral kernels
 * (deep-link, source-sync/refresh/conflict, publish-suggestions,
 * background-jobs, external write API). With the projection retired (ADR 0008)
 * the same facts resolve from the LATEST frozen version snapshot. Management
 * / access fields therefore reflect article-level commands immediately
 * (ADR 0007); content-bearing fields mirror the latest saved body.
 */

import type { Database } from '@/lib/repositories/schema'

export interface CanonicalLiveState {
  slug: string
  title: string
  category: string | null
  tags: string | null
  description: string | null
  password: string | null
  is_pinned: number | null
  is_hidden: number | null
  cover_image: string | null
  status: string | null
  published_at: number | null
  deleted_at: number | null
  updated_at: number | null
}

interface SnapshotRow {
  snapshot_json: string
}

function materialise(row: SnapshotRow | null): CanonicalLiveState | null {
  if (!row) return null
  try {
    const parsed = JSON.parse(row.snapshot_json) as {
      fields?: Record<string, unknown>
      original_content?: string | null
      original_html?: string | null
    }
    const f = parsed.fields ?? {}
    return {
      slug: (f.slug as string) ?? '',
      title: (f.title as string) ?? '',
      category: (f.category as string | null) ?? null,
      tags: (f.tags as string | null) ?? null,
      description: (f.description as string | null) ?? null,
      password: (f.password as string | null) ?? null,
      is_pinned: (f.is_pinned as number | null) ?? 0,
      is_hidden: (f.is_hidden as number | null) ?? 0,
      cover_image: (f.cover_image as string | null) ?? null,
      status: (f.status as string) ?? null,
      published_at: (f.published_at as number | null) ?? null,
      deleted_at: (f.deleted_at as number | null) ?? null,
      updated_at: (f.updated_at as number | null) ?? null,
    }
  } catch {
    return null
  }
}

const LATEST_BY_ARTICLE = `
  SELECT snapshot_json FROM article_versions
  WHERE article_id = ? ORDER BY version DESC LIMIT 1`

/** Live state of an article, resolved by article identity id. */
export async function findLiveStateByArticleId(
  db: Database,
  articleId: number,
): Promise<CanonicalLiveState | null> {
  const row = await db
    .prepare(LATEST_BY_ARTICLE)
    .bind(articleId)
    .first<SnapshotRow>()
  return materialise(row)
}

/** Live state of an article, resolved by its legacy numeric post_ref. */
export async function findLiveStateByPostRef(
  db: Database,
  postRef: number,
): Promise<CanonicalLiveState | null> {
  const row = await db
    .prepare(
      `SELECT v.snapshot_json FROM articles a
       JOIN article_versions v ON v.article_id = a.id
        AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
       WHERE a.post_ref = ?`,
    )
    .bind(postRef)
    .first<SnapshotRow>()
  return materialise(row)
}
