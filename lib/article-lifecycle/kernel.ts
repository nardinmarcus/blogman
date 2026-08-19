/**
 * B3-05 — article lifecycle command kernel (issue #37).
 *
 * 取消发布、重新上线与软删除恢复 — the independent lifecycle commands over a
 * formally published article. Each command carries the B2-06 style precondition
 * envelope (article id + expected body version + operation id) PLUS a status
 * precondition, and records its transition immutably in `article_lifecycles`.
 *
 *   - `unpublish`  — published -> unpublished. The live post drops to draft and
 *     the formal lifecycle flips to `unpublished` in ONE guarded batch. No
 *     version, active revision, restore point or history is created or deleted:
 *     the article simply leaves the public surface. Safe to reverse with
 *     `relive`.
 *   - `relive`     — unpublished -> published.
 *       * source `formal`   (default, and the ONLY path without an active
 *         revision): the LAST OFFICIAL version is re-listed — posts.status ->
 *         published, lifecycle -> published, no new version written.
 *       * source `revision`: the CURRENT pending revision is raised (new
 *         formal version + restore point + promotion event via the B3-02
 *         promote kernel) and the lifecycle flips back to published.
 *
 * Soft-delete restore ("软删后恢复为未发布") stays the B2-06 `restore` command:
 * it puts a deleted post back to `draft` (未发布) with no deletion timestamp and
 * never re-publishes it — unpublish/relive own the live/offline transition and
 * deliberately do NOT touch slug history (#36) or the comparison UI (#35).
 *
 * Atomicity/idempotency model (same as the B2-03/B2-06 kernels): statements
 * are guarded so a failed precondition no-ops the whole batch; hard UNIQUE
 * constraints (operation_id) abort and roll back on a dup; outcomes are
 * resolved by re-reading the live state after the batch (the wrangler CLI does
 * not surface `changes`/`last_row_id`), so behaviour is identical on
 * production D1 and in the in-process tests.
 */

import { createHash } from 'node:crypto'
import type { Database } from '@/lib/repositories/schema'
import type {
  LifecycleAppliedResult,
  LifecycleReplayedResult,
  LifecycleRow,
  ReliveInput,
  ReliveResult,
  UnpublishInput,
  UnpublishResult,
} from './types'
import { FIRST_PUBLISH_DEFAULT_SITE_URL } from '@/lib/first-publish'
import { findActiveRevision, promoteRevision } from '@/lib/publish-revision'

interface ArticleRow {
  id: number
  post_ref: number
}

interface PostRow {
  id: number
  status: string | null
  deleted_at: number | null
  published_at: number | null
}

interface FormalRow {
  article_id: number
  version: number
  slug: string
  lifecycle: string
  public_url: string
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/** Deterministic evidence digest over a canonical lifecycle payload. */
export function evidenceDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

const LIFECYCLE_ROW_COLUMNS = `id, operation_id, article_id, post_ref, version, direction,
  lifecycle_before, lifecycle_after, source_version, public_url,
  evidence_sha256, payload, actor, created_at`

async function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<ArticleRow>()
}

async function latestVersion(db: Database, articleId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
    .bind(articleId)
    .first<{ version: number }>()
  return row?.version ?? 0
}

async function findPostById(db: Database, postRef: number): Promise<PostRow | null> {
  return db
    .prepare('SELECT id, status, deleted_at, published_at FROM posts WHERE id = ?')
    .bind(postRef)
    .first<PostRow>()
}

async function findFormalByArticle(db: Database, articleId: number): Promise<FormalRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, slug, lifecycle, public_url
       FROM formal_publications WHERE article_id = ?`,
    )
    .bind(articleId)
    .first<FormalRow>()
}

async function findLifecycleByOperation(db: Database, operationId: string): Promise<LifecycleRow | null> {
  return db
    .prepare(`SELECT ${LIFECYCLE_ROW_COLUMNS} FROM article_lifecycles WHERE operation_id = ?`)
    .bind(operationId)
    .first<LifecycleRow>()
}

function replayedResult(row: LifecycleRow): LifecycleReplayedResult {
  return {
    outcome: 'replayed',
    articleId: row.article_id,
    postRef: row.post_ref,
    version: row.version,
    operationId: row.operation_id,
    existing: true,
    direction: row.direction,
    lifecycle: row.lifecycle_after,
    publicUrl: row.public_url,
    projectionFailures: [],
  }
}

function appliedResult(row: LifecycleRow): LifecycleAppliedResult {
  return {
    outcome: 'applied',
    articleId: row.article_id,
    postRef: row.post_ref,
    version: row.version,
    operationId: row.operation_id,
    existing: false,
    direction: row.direction,
    lifecycle: row.lifecycle_after,
    publicUrl: row.public_url,
    projectionFailures: [],
  }
}

/* ------------------------------------------------------------------ */
/* unpublish — 取消发布                                                 */
/* ------------------------------------------------------------------ */

/**
 * Take a live, formally published article offline. Status precondition: the
 * post must currently be `published` and not soft-deleted, and the formal
 * lifecycle must be `published`. The transition is recorded immutably; no
 * version, revision, restore point or history is created or destroyed.
 */
export async function unpublish(db: Database, input: UnpublishInput): Promise<UnpublishResult> {
  const { articleId, expectedVersion, operationId, actor = 'admin', now = unixNow() } = input
  if (!articleId || !operationId || operationId.trim() === '') {
    throw new Error('unpublish: articleId and operationId are required')
  }

  const article = await findArticleById(db, articleId)
  if (!article) return { outcome: 'not-found', articleId, reason: `article ${articleId} not found` }
  const postRef = article.post_ref

  // Idempotent replay — the same operation id returns the original result.
  const existing = await findLifecycleByOperation(db, operationId)
  if (existing) return replayedResult(existing)

  const serverVersion = await latestVersion(db, articleId)
  if (serverVersion !== expectedVersion) {
    return { outcome: 'conflict', articleId, postRef, expectedVersion, serverVersion, reason: 'version-moved' }
  }

  const formal = await findFormalByArticle(db, articleId)
  const post = await findPostById(db, postRef)
  if (!formal) {
    return { outcome: 'blocked', articleId, reason: 'article has no formal publication; use first-publish to go live', failures: ['formal-missing'] }
  }
  if (!post) return { outcome: 'not-found', articleId, reason: 'post missing' }
  if (post.deleted_at !== null) {
    return { outcome: 'blocked', articleId, reason: 'soft-deleted article must be restored before lifecycle change', failures: ['deleted'] }
  }
  // Status precondition: must currently be live.
  if (post.status !== 'published' || formal.lifecycle !== 'published') {
    return {
      outcome: 'status-conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion,
      currentStatus: post.status,
      lifecycle: formal.lifecycle,
    }
  }

  const payload = JSON.stringify({
    format: 'blogman-lifecycle/v1',
    operationId,
    direction: 'unpublish',
    articleId,
    version: serverVersion,
    lifecycle: 'unpublished',
    slug: formal.slug,
    publicUrl: formal.public_url,
    actor,
    createdAt: now,
  })
  const evidenceSha256 = evidenceDigest(payload)

  const batch = [
    db
      .prepare(
        `UPDATE posts SET status = 'draft', updated_at = ?
         WHERE id = ? AND status = 'published' AND deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ?)
           AND NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)`,
      )
      .bind(now, postRef, articleId, expectedVersion, operationId),
    db
      .prepare(
        `UPDATE formal_publications SET lifecycle = 'unpublished'
         WHERE article_id = ? AND lifecycle = 'published'
           AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'draft')
           AND NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)`,
      )
      .bind(articleId, postRef, operationId),
    db
      .prepare(
        `INSERT INTO article_lifecycles
           (operation_id, article_id, post_ref, version, direction,
            lifecycle_before, lifecycle_after, source_version, public_url,
            evidence_sha256, payload, actor, created_at)
         SELECT ?, ?, ?, ?, 'unpublish', 'published', 'unpublished', ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)
           AND (SELECT status FROM posts WHERE id = ?) = 'draft'
           AND (SELECT lifecycle FROM formal_publications WHERE article_id = ?) = 'unpublished'`,
      )
      .bind(
        operationId,
        articleId,
        postRef,
        serverVersion,
        serverVersion,
        formal.public_url,
        evidenceSha256,
        payload,
        actor,
        now,
        operationId,
        postRef,
        articleId,
      ),
  ]

  await db.batch(batch)

  const row = await findLifecycleByOperation(db, operationId)
  const postAfter = (await findPostById(db, postRef)) ?? post
  const formalAfter = (await findFormalByArticle(db, articleId)) ?? formal
  if (!row || postAfter.status !== 'draft' || formalAfter.lifecycle !== 'unpublished') {
    // A guard no-op'd — report the real live state (fail-closed).
    return {
      outcome: 'status-conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: (await latestVersion(db, articleId)) ?? serverVersion,
      currentStatus: postAfter.status,
      lifecycle: formalAfter.lifecycle,
    }
  }

  const result = appliedResult(row)
  if (input.afterCommit) {
    try {
      await input.afterCommit()
    } catch {
      // Best-effort external I/O (cache invalidation) — the fact is durable.
    }
  }
  return result
}

/* ------------------------------------------------------------------ */
/* relive — 重新上线                                                    */
/* ------------------------------------------------------------------ */

/**
 * Bring an offline article back onto the public surface. Status precondition:
 * the post must currently NOT be published and the formal lifecycle must be
 * `unpublished` (an article that was previously live). Two sources:
 *   - `formal`   (default): re-list the LAST OFFICIAL version — no new version.
 *   - `revision`: raise the CURRENT pending revision (new formal version) then
 *     flip lifecycle back to published.
 */
export async function relive(db: Database, input: ReliveInput): Promise<ReliveResult> {
  const {
    articleId,
    expectedVersion,
    operationId,
    content = 'formal',
    actor = 'admin',
    siteUrl = FIRST_PUBLISH_DEFAULT_SITE_URL,
    now = unixNow(),
  } = input
  if (!articleId || !operationId || operationId.trim() === '') {
    throw new Error('relive: articleId and operationId are required')
  }
  if (content !== 'formal' && content !== 'revision') {
    return { outcome: 'blocked', articleId, reason: `relive: invalid content '${content}'`, failures: ['invalid-content'] }
  }

  const article = await findArticleById(db, articleId)
  if (!article) return { outcome: 'not-found', articleId, reason: `article ${articleId} not found` }
  const postRef = article.post_ref

  // Idempotent replay.
  const existing = await findLifecycleByOperation(db, operationId)
  if (existing) return replayedResult(existing)

  const serverVersion = await latestVersion(db, articleId)
  if (serverVersion !== expectedVersion) {
    return { outcome: 'conflict', articleId, postRef, expectedVersion, serverVersion, reason: 'version-moved' }
  }

  const formal = await findFormalByArticle(db, articleId)
  const post = await findPostById(db, postRef)
  if (!formal) {
    return { outcome: 'blocked', articleId, reason: 'article has no formal publication; use first-publish to go live', failures: ['formal-missing'] }
  }
  if (!post) return { outcome: 'not-found', articleId, reason: 'post missing' }
  if (post.deleted_at !== null) {
    return { outcome: 'blocked', articleId, reason: 'soft-deleted article must be restored first', failures: ['deleted'] }
  }
  // Status precondition: must currently be offline (unpublished).
  if (post.status === 'published' && formal.lifecycle === 'published') {
    return {
      outcome: 'status-conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion,
      currentStatus: post.status,
      lifecycle: formal.lifecycle,
    }
  }

  /* ------------------------- revision relive ------------------------ */
  if (content === 'revision') {
    const active = await findActiveRevision(db, articleId)
    if (!active) {
      return { outcome: 'blocked', articleId, reason: 'no active pending revision to relive', failures: ['no-active-revision'] }
    }
    const promoted = await promoteRevision(db, {
      revisionId: active.revision_id,
      actor,
      siteUrl: siteUrl.replace(/\/+$/, ''),
      now,
    })
    let promotedVersion = serverVersion
    let publicUrl: string | null = formal.public_url
    if (promoted.outcome !== 'promoted' && promoted.outcome !== 'replayed') {
      if (promoted.outcome === 'conflict' || promoted.outcome === 'blocked' || promoted.outcome === 'not-found' || promoted.outcome === 'invalid') {
        return {
          outcome: 'blocked',
          articleId,
          reason: promoted.reason ?? 'revision relive failed',
          failures: promoted.outcome === 'blocked' ? promoted.failures : [promoted.outcome],
        }
      }
      return { outcome: 'blocked', articleId, reason: 'revision relive failed', failures: [] }
    }
    promotedVersion = promoted.promotedVersion
    publicUrl = promoted.publicUrl

    const payload = JSON.stringify({
      format: 'blogman-lifecycle/v1',
      operationId,
      direction: 'relive-revision',
      articleId,
      version: promotedVersion,
      lifecycle: 'published',
      sourceVersion: promoted.baseVersion,
      publicUrl,
      actor,
      createdAt: now,
    })
    const evidenceSha256 = evidenceDigest(payload)

    await db.batch([
      db
        .prepare(
          `UPDATE formal_publications SET lifecycle = 'published'
           WHERE article_id = ? AND lifecycle = 'unpublished'
             AND NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)`,
        )
        .bind(articleId, operationId),
      db
        .prepare(
          `INSERT INTO article_lifecycles
             (operation_id, article_id, post_ref, version, direction,
              lifecycle_before, lifecycle_after, source_version, public_url,
              evidence_sha256, payload, actor, created_at)
           SELECT ?, ?, ?, ?, 'relive-revision', 'unpublished', 'published', ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)
             AND (SELECT lifecycle FROM formal_publications WHERE article_id = ?) = 'published'`,
        )
        .bind(
          operationId,
          articleId,
          postRef,
          promotedVersion,
          promoted.baseVersion,
          publicUrl,
          evidenceSha256,
          payload,
          actor,
          now,
          operationId,
          articleId,
        ),
    ])

    const row = await findLifecycleByOperation(db, operationId)
    const formalAfter = (await findFormalByArticle(db, articleId)) ?? formal
    if (!row || formalAfter.lifecycle !== 'published') {
      return {
        outcome: 'status-conflict',
        articleId,
        postRef,
        expectedVersion,
        serverVersion: (await latestVersion(db, articleId)) ?? serverVersion,
        currentStatus: (await findPostById(db, postRef))?.status ?? null,
        lifecycle: formalAfter.lifecycle,
      }
    }
    const result = appliedResult(row)
    if (input.afterCommit) {
      try {
        await input.afterCommit()
      } catch {
        // Best-effort external I/O — the fact is durable.
      }
    }
    return result
  }

  /* ------------------------ formal (last official) relive ------------- */
  const payload = JSON.stringify({
    format: 'blogman-lifecycle/v1',
    operationId,
    direction: 'relive-formal',
    articleId,
    version: serverVersion,
    lifecycle: 'published',
    slug: formal.slug,
    publicUrl: formal.public_url,
    actor,
    createdAt: now,
  })
  const evidenceSha256 = evidenceDigest(payload)

  const batch = [
    db
      .prepare(
        `UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
         WHERE id = ? AND status = 'draft' AND deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ?)
           AND NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)`,
      )
      .bind(now, now, postRef, articleId, expectedVersion, operationId),
    db
      .prepare(
        `UPDATE formal_publications SET lifecycle = 'published'
         WHERE article_id = ? AND lifecycle = 'unpublished'
           AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'published')
           AND NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)`,
      )
      .bind(articleId, postRef, operationId),
    db
      .prepare(
        `INSERT INTO article_lifecycles
           (operation_id, article_id, post_ref, version, direction,
            lifecycle_before, lifecycle_after, source_version, public_url,
            evidence_sha256, payload, actor, created_at)
         SELECT ?, ?, ?, ?, 'relive-formal', 'unpublished', 'published', ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM article_lifecycles WHERE operation_id = ?)
           AND (SELECT status FROM posts WHERE id = ?) = 'published'
           AND (SELECT lifecycle FROM formal_publications WHERE article_id = ?) = 'published'`,
      )
      .bind(
        operationId,
        articleId,
        postRef,
        serverVersion,
        serverVersion,
        formal.public_url,
        evidenceSha256,
        payload,
        actor,
        now,
        operationId,
        postRef,
        articleId,
      ),
  ]

  await db.batch(batch)

  const row = await findLifecycleByOperation(db, operationId)
  const postAfter = (await findPostById(db, postRef)) ?? post
  const formalAfter = (await findFormalByArticle(db, articleId)) ?? formal
  if (!row || postAfter.status !== 'published' || formalAfter.lifecycle !== 'published') {
    return {
      outcome: 'status-conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: (await latestVersion(db, articleId)) ?? serverVersion,
      currentStatus: postAfter.status,
      lifecycle: formalAfter.lifecycle,
    }
  }

  const result = appliedResult(row)
  if (input.afterCommit) {
    try {
      await input.afterCommit()
    } catch {
      // Best-effort external I/O — the fact is durable.
    }
  }
  return result
}

/** Full lifecycle-history read for an article (immutable ledger, newest first). */
export async function listLifecycleHistory(db: Database, articleId: number): Promise<LifecycleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LIFECYCLE_ROW_COLUMNS} FROM article_lifecycles
       WHERE article_id = ? ORDER BY id DESC`,
    )
    .bind(articleId)
    .all<LifecycleRow>()
  return results ?? []
}
