/**
 * B2-02 — article identity / version repository (shadow layer).
 *
 * Low-level D1 access to the `articles` + `article_versions` tables. The legacy
 * `posts` table remains authoritative; this layer only records immutable
 * identities and monotonic version snapshots. `appendVersion` is idempotent by
 * `operation_id` and monotonic by per-article version ordering.
 */

import type { Database } from '@/lib/repositories/schema'

export interface ArticleIdentity {
  id: number
  post_ref: number
  /** Nullable identity columns — NOT guessed during backfill (all left NULL). */
  slug: string | null
  draft_ref: string | null
  source_page_identity: string | null
  created_at: number
}

export interface ArticleVersion {
  id: number
  article_id: number
  version: number
  operation_id: string
  snapshot_json: string
  content_snapshot_sha256: string
  published_at: number | null
  created_at: number
}

export interface AppendVersionInput {
  operationId: string
  snapshotJson: string
  contentSnapshotSha256: string
  publishedAt: number | null
}

/** Canonical ordered projection of an article identity. */
export async function getByPostRef(db: Database, postRef: number): Promise<ArticleIdentity | null> {
  const row = await db
    .prepare(
      `SELECT id, post_ref, slug, draft_ref, source_page_identity, created_at
       FROM articles WHERE post_ref = ?`,
    )
    .bind(postRef)
    .first<ArticleIdentity>()
  return row ?? null
}

/** All versions for an article, newest first. */
export async function listVersions(db: Database, articleId: number): Promise<ArticleVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT id, article_id, version, operation_id, snapshot_json,
              content_snapshot_sha256, published_at, created_at
       FROM article_versions WHERE article_id = ? ORDER BY version DESC`,
    )
    .bind(articleId)
    .all<ArticleVersion>()
  return results
}

/**
 * Append a version for an article. Idempotent: if `operationId` already exists,
 * the existing version is returned and no new row is inserted. Otherwise the
 * new version number is MAX(version)+1 for that article (monotonic).
 */
export async function appendVersion(
  db: Database,
  articleId: number,
  input: AppendVersionInput,
): Promise<ArticleVersion> {
  const existing = await db
    .prepare(
      `SELECT id, article_id, version, operation_id, snapshot_json,
              content_snapshot_sha256, published_at, created_at
       FROM article_versions WHERE operation_id = ?`,
    )
    .bind(input.operationId)
    .first<ArticleVersion>()
  if (existing) return existing

  await db
    .prepare(
      `INSERT INTO article_versions
         (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
       SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
       FROM article_versions WHERE article_id = ?
         AND NOT EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)`,
    )
    .bind(
      articleId,
      input.operationId,
      input.snapshotJson,
      input.contentSnapshotSha256,
      input.publishedAt,
      articleId,
      input.operationId,
    )
    .run()

  const inserted = await db
    .prepare(
      `SELECT id, article_id, version, operation_id, snapshot_json,
              content_snapshot_sha256, published_at, created_at
       FROM article_versions WHERE operation_id = ?`,
    )
    .bind(input.operationId)
    .first<ArticleVersion>()
  if (!inserted) {
    throw new Error(
      `appendVersion: could not resolve version for operation_id '${input.operationId}'`,
    )
  }
  return inserted
}
