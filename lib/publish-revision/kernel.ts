/**
 * B3-02 — formal-article pending revision command kernel (issue #34).
 *
 * The safe go-live loop for edits to a formally published article. Editing
 * NEVER changes the live version:
 *
 *   - the first content change creates the unique ACTIVE revision for the
 *     article (base_version = current formal version), and every subsequent
 *     writer (in-site editor autosave, AI background enrichment, external
 *     versioned writers) writes into that SAME row through the shared
 *     `save` choke point — the partial unique index on the active revision is
 *     the hard enforcement of "at most one active revision per article",
 *   - no revision is ever fabricated: a save whose content is byte-identical
 *     to the live formal body replays without creating a row, and a stale
 *     writer anchored to the base content (while a divergent revision already
 *     exists) conflicts instead of silently overwriting,
 *   - promotion first writes the RESTORE POINT (the pre-promotion formal
 *     snapshot), then promotes the revision and writes the promotion EVENT in
 *     ONE D1 transaction (guard no-op on a failed precondition; a hard
 *     constraint failure rolls everything back so the old formal version stays
 *     online and the revision stays intact),
 *   - after promotion the revision row is marked `promoted` (immutable
 *     history) so the next edit forms a brand-new active revision,
 *   - public reads keep reading the formal projection (`posts` /
 *     `formal_publications`) until the promotion transaction commits.
 *
 * The save router uses the same outcome vocabulary as the B2-03 kernel so the
 * editor coordinator and external-write adapters keep their versioned protocol
 * unchanged: `version` in a routed result IS the revision number (the client
 * version token), and `expectedVersion` must equal the current revision number
 * once a revision is active.
 */

import { createHash } from 'node:crypto'
import type { Database } from '@/lib/repositories/schema'
import { contentSnapshotHash, parse } from '@/lib/content-envelope'
import { buildInitialSnapshot, snapshotJson, type PostAuthorityRow } from '@/lib/article-identity'
import { FIRST_PUBLISH_DEFAULT_SITE_URL } from '@/lib/first-publish'
import type {
  DiscardResult,
  FormalAnchor,
  PromoteInput,
  PromotionFacts,
  PromotionRow,
  PromoteResult,
  RestorePointRow,
  RevisionRow,
  RevisionSnapshotInput,
  RevisionState,
  SaveRevisionInput,
  SaveRevisionResult,
} from './types'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

function sha256OfEmpty(): string {
  return createHash('sha256').update('', 'utf8').digest('hex')
}

/** Deterministic ids — idempotency keys for the whole loop. */
export function revisionIdFor(articleId: number, baseVersion: number): string {
  return `revision:${articleId}:v${baseVersion}`
}

export function promotionIdFor(revisionId: string): string {
  return `promote:${revisionId}`
}

export function restorePointIdFor(promotionId: string): string {
  return `restore:${promotionId}`
}

/** Canonical evidence digest over the promotion payload. */
export function evidenceDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ */
/* low-level reads                                                     */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface FormalRow {
  article_id: number
  version: number
  slug: string
  lifecycle: string
  first_published_at: number
  public_url: string
}

interface PostRow {
  id: number
  slug: string
  title: string
  content: string
  html: string
  description: string | null
  category: string | null
  tags: string | null
  status: string
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null
  deleted_at: number | null
  published_at: number | null
  updated_at: number | null
}

async function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<ArticleRow>()
}

async function findFormalByArticle(db: Database, articleId: number): Promise<FormalRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, slug, lifecycle, first_published_at, public_url
       FROM formal_publications WHERE article_id = ?`,
    )
    .bind(articleId)
    .first<FormalRow>()
}

async function findPostById(db: Database, postRef: number): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT id, slug, title, content, html, description, category, tags, status,
              password, is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at
       FROM posts WHERE id = ?`,
    )
    .bind(postRef)
    .first<PostRow>()
}

export async function findActiveRevision(db: Database, articleId: number): Promise<RevisionRow | null> {
  return db
    .prepare(
      `SELECT id, revision_id, article_id, base_version, revision_number, status,
              slug, title, content, html, description, category, tags, password,
              is_pinned, is_hidden, cover_image, content_sha256, created_at, updated_at
       FROM publish_revisions WHERE article_id = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<RevisionRow>()
}

export async function findRevisionById(db: Database, revisionId: string): Promise<RevisionRow | null> {
  return db
    .prepare(
      `SELECT id, revision_id, article_id, base_version, revision_number, status,
              slug, title, content, html, description, category, tags, password,
              is_pinned, is_hidden, cover_image, content_sha256, created_at, updated_at
       FROM publish_revisions WHERE revision_id = ?`,
    )
    .bind(revisionId)
    .first<RevisionRow>()
}

async function findPromotion(db: Database, promotionId: string): Promise<PromotionRow | null> {
  return db
    .prepare(
      `SELECT id, promotion_id, article_id, revision_id, base_version, promoted_version,
              slug, public_url, content_sha256, evidence_sha256, payload, actor, created_at
       FROM publish_promotions WHERE promotion_id = ?`,
    )
    .bind(promotionId)
    .first<PromotionRow>()
}

async function latestVersion(db: Database, articleId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
    .bind(articleId)
    .first<{ version: number }>()
  return row?.version ?? 0
}

async function formalContentHash(db: Database, articleId: number, version: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(articleId, version)
    .first<{ content_snapshot_sha256: string | null }>()
  return row?.content_snapshot_sha256 ?? null
}

/** Resolve the formal anchor an incoming save must be checked against. */
export async function resolveFormalAnchor(db: Database, articleId: number): Promise<FormalAnchor | null> {
  const formal = await findFormalByArticle(db, articleId)
  if (!formal) return null
  const contentHash = await formalContentHash(db, articleId, formal.version)
  return { version: formal.version, slug: formal.slug, contentHash }
}

/** Canonical content hash for an incoming authoring snapshot (pure). */
export function snapshotContentHash(snapshot: Pick<RevisionSnapshotInput, 'content'>): string {
  const envelope = parse({ markdown: (snapshot.content ?? '').trim() })
  return contentSnapshotHash(envelope)
}

function tagJson(tags: string[] | null): string | null {
  if (!tags || tags.length === 0) return null
  return JSON.stringify(tags)
}

/** Full-snapshot equality — a replay only when EVERY field matches. */
function snapshotsEqual(a: RevisionSnapshotInput, b: RevisionSnapshotInput): boolean {
  return (
    a.slug === b.slug &&
    a.title === b.title &&
    (a.content ?? '') === (b.content ?? '') &&
    (a.html ?? '') === (b.html ?? '') &&
    (a.description ?? null) === (b.description ?? null) &&
    (a.category ?? null) === (b.category ?? null) &&
    JSON.stringify(a.tags ?? null) === JSON.stringify(b.tags ?? null) &&
    (a.password ?? null) === (b.password ?? null) &&
    (a.is_pinned ?? 0) === (b.is_pinned ?? 0) &&
    (a.is_hidden ?? 0) === (b.is_hidden ?? 0) &&
    (a.cover_image ?? null) === (b.cover_image ?? null)
  )
}

function snapshotFromPost(post: PostRow): RevisionSnapshotInput {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(post.tags ?? '[]')
    tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    tags = []
  }
  return {
    slug: post.slug,
    title: post.title,
    content: post.content ?? '',
    html: post.html ?? '',
    description: post.description,
    category: post.category,
    tags: tags.length > 0 ? tags : null,
    password: post.password,
    is_pinned: post.is_pinned ?? 0,
    is_hidden: post.is_hidden ?? 0,
    cover_image: post.cover_image,
  }
}

function snapshotFromRevision(revision: RevisionRow): RevisionSnapshotInput {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(revision.tags ?? '[]')
    tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    tags = []
  }
  return {
    slug: revision.slug,
    title: revision.title,
    content: revision.content,
    html: revision.html,
    description: revision.description,
    category: revision.category,
    tags: tags.length > 0 ? tags : null,
    password: revision.password,
    is_pinned: revision.is_pinned,
    is_hidden: revision.is_hidden,
    cover_image: revision.cover_image,
  }
}

/* ------------------------------------------------------------------ */
/* save routing — the shared writer choke point for formal articles    */
/* ------------------------------------------------------------------ */

/**
 * Route a save whose article is under a formal publication into the revision
 * surface. Called by the B2-03 `save` kernel before it touches the live
 * version/post row — the ONLY branch point every writer (editor autosave, AI,
 * external versioned writers) must pass through.
 *
 * Conflict semantics:
 *
 *   - no active revision: expectedVersion must equal the formal version; an
 *     identical body replays WITHOUT creating a revision (never fabricated),
 *     a different body creates the unique active revision (revision_number 1).
 *   - active revision: expectedVersion must equal the current revision_number;
 *     a writer still anchored to the base content (whose body hash equals the
 *     formal base) is STALE and conflicts instead of overwriting the in-flight
 *     revision; a byte-identical body replays; otherwise the same row advances
 *     to revision_number + 1.
 */
export async function saveRevision(
  db: Database,
  input: SaveRevisionInput,
): Promise<SaveRevisionResult> {
  const { articleId, postRef, expectedVersion, operationId, snapshot, formal } = input
  if (!articleId || !operationId || operationId.trim() === '') {
    return { outcome: 'invalid', reason: 'saveRevision: articleId and operationId are required' }
  }
  if (!snapshot.slug || snapshot.slug.trim() === '') {
    return { outcome: 'invalid', reason: 'saveRevision: snapshot.slug is required' }
  }
  if (formal.version < 1) {
    return { outcome: 'invalid', reason: 'saveRevision: no formal version to anchor to' }
  }

  const incomingHash = snapshotContentHash(snapshot)
  const baseHash = formal.contentHash ?? ''
  const live = await findPostById(db, postRef)
  const formalSnapshot = live ? snapshotFromPost(live) : null

  const active = await findActiveRevision(db, articleId)

  // No active revision — the first change creates the unique active revision.
  if (!active) {
    if (expectedVersion !== formal.version) {
      return {
        outcome: 'conflict',
        articleId,
        postRef,
        expectedVersion,
        serverVersion: formal.version,
        revision: true,
        revisionId: null,
        reason: 'stale-formal-version',
      }
    }
    // Identical to the live formal snapshot → replay WITHOUT fabricating a
    // revision. "Identical" means every field (a metadata-only save that
    // changes tags/description/category is a real change: it must form a
    // revision like any other edit).
    if (formalSnapshot && snapshotsEqual(snapshot, formalSnapshot)) {
      return {
        outcome: 'replayed',
        articleId,
        postRef,
        version: formal.version,
        operationId,
        existing: true,
        projectionFailures: [],
        revision: true,
        revisionId: revisionIdFor(articleId, formal.version),
        baseVersion: formal.version,
      }
    }

    const revisionId = revisionIdFor(articleId, formal.version)
    const now = unixNow()
    try {
      await db
        .prepare(
          `INSERT INTO publish_revisions
             (revision_id, article_id, base_version, revision_number, status,
              slug, title, content, html, description, category, tags, password,
              is_pinned, is_hidden, cover_image, content_sha256, created_at, updated_at)
           SELECT ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM publish_revisions WHERE article_id = ? AND status = 'active')
             AND (SELECT version FROM formal_publications WHERE article_id = ?) = ?
             AND (SELECT COALESCE(MAX(version), 0) FROM article_versions WHERE article_id = ?) = ?
             AND (SELECT id FROM posts WHERE id = ?) IS NOT NULL`,
        )
        .bind(
          revisionId,
          articleId,
          formal.version,
          snapshot.slug,
          snapshot.title,
          snapshot.content,
          snapshot.html,
          snapshot.description,
          snapshot.category,
          tagJson(snapshot.tags),
          snapshot.password,
          snapshot.is_pinned,
          snapshot.is_hidden,
          snapshot.cover_image,
          incomingHash,
          now,
          now,
          articleId,
          articleId,
          formal.version,
          articleId,
          formal.version,
          postRef,
        )
        .run()
    } catch (error) {
      // Atomic abort — most likely a racing writer created the active revision
      // between our pre-read and the guarded insert. Resolve the real state.
      const raced = await findActiveRevision(db, articleId)
      if (raced) {
        return {
          outcome: 'conflict',
          articleId,
          postRef,
          expectedVersion,
          serverVersion: raced.revision_number,
          revision: true,
          revisionId: raced.revision_id,
          reason: 'revision-created-by-other-writer',
        }
      }
      throw new Error(
        `saveRevision: insert failure for article ${articleId} operation '${operationId}': ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const created = await findActiveRevision(db, articleId)
    if (!created) {
      // A guard no-op'd: the formal version moved between pre-read and batch.
      const serverVersion = await latestVersion(db, articleId)
      return {
        outcome: 'conflict',
        articleId,
        postRef,
        expectedVersion,
        serverVersion,
        revision: true,
        revisionId: null,
        reason: 'formal-version-moved',
      }
    }
    return {
      outcome: 'applied',
      articleId,
      postRef,
      version: created.revision_number,
      operationId,
      existing: false,
      projectionFailures: [],
      revision: true,
      revisionId: created.revision_id,
      baseVersion: created.base_version,
    }
  }

  // Active revision exists — ALL writers land in this row.
  if (expectedVersion !== active.revision_number) {
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: active.revision_number,
      revision: true,
      revisionId: active.revision_id,
      reason: 'revision-version-mismatch',
    }
  }
  // A writer anchored to the FORMAL base (not the revision) is stale.
  if (incomingHash === baseHash && baseHash !== '' && baseHash !== sha256OfEmpty() && active.content_sha256 !== baseHash) {
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: active.revision_number,
      revision: true,
      revisionId: active.revision_id,
      reason: 'stale-base-content',
    }
  }
  // Full-snapshot equality → replay; a metadata-only change still advances the
  // revision (the AI writer enriches category/tags/description with the same
  // body — that is a real change and must land in the shared revision row).
  if (snapshotsEqual(snapshot, snapshotFromRevision(active))) {
    return {
      outcome: 'replayed',
      articleId,
      postRef,
      version: active.revision_number,
      operationId,
      existing: true,
      projectionFailures: [],
      revision: true,
      revisionId: active.revision_id,
      baseVersion: active.base_version,
    }
  }

  const nextNumber = active.revision_number + 1
  const now = unixNow()
  try {
    await db
      .prepare(
        `UPDATE publish_revisions SET
           revision_number = revision_number + 1,
           slug = ?, title = ?, content = ?, html = ?, description = ?, category = ?,
           tags = ?, password = ?, is_pinned = ?, is_hidden = ?, cover_image = ?,
           content_sha256 = ?, updated_at = ?
         WHERE article_id = ? AND revision_id = ? AND status = 'active' AND revision_number = ?`,
      )
      .bind(
        snapshot.slug,
        snapshot.title,
        snapshot.content,
        snapshot.html,
        snapshot.description,
        snapshot.category,
        tagJson(snapshot.tags),
        snapshot.password,
        snapshot.is_pinned,
        snapshot.is_hidden,
        snapshot.cover_image,
        incomingHash,
        now,
        articleId,
        active.revision_id,
        expectedVersion,
      )
      .run()
  } catch (error) {
    throw new Error(
      `saveRevision: update failure for article ${articleId} operation '${operationId}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const updated = await findActiveRevision(db, articleId)
  if (!updated || updated.revision_number !== nextNumber) {
    // Guard refused the write — a racing writer advanced the revision first.
    const server = await findActiveRevision(db, articleId)
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: server?.revision_number ?? active.revision_number,
      revision: true,
      revisionId: server?.revision_id ?? active.revision_id,
      reason: 'revision-version-moved',
    }
  }
  return {
    outcome: 'applied',
    articleId,
    postRef,
    version: updated.revision_number,
    operationId,
    existing: false,
    projectionFailures: [],
    revision: true,
    revisionId: updated.revision_id,
    baseVersion: updated.base_version,
  }
}

/* ------------------------------------------------------------------ */
/* promote — restore point + raise + event in ONE transaction          */
/* ------------------------------------------------------------------ */

function revisionToPostRow(revision: RevisionRow, postRef: number, now: number): PostAuthorityRow {
  return {
    id: postRef,
    slug: revision.slug,
    title: revision.title,
    content: revision.content,
    html: revision.html,
    description: revision.description,
    category: revision.category,
    tags: revision.tags,
    status: 'published',
    password: revision.password,
    is_pinned: revision.is_pinned,
    is_hidden: revision.is_hidden,
    cover_image: revision.cover_image,
    deleted_at: null,
    published_at: now,
    updated_at: now,
  }
}

async function promoteById(
  db: Database,
  input: { revision: RevisionRow; articleId: number; postRef: number; formal: FormalRow; actor: string; siteUrl: string; now: number; afterCommit?: PromoteInput['afterCommit'] },
): Promise<PromoteResult> {
  const { revision, articleId, postRef, formal, actor, siteUrl, now, afterCommit } = input
  const promotedVersion = revision.base_version + 1
  const promotionId = promotionIdFor(revision.revision_id)
  const publicUrl = `${siteUrl.replace(/\/+$/, '')}/${revision.slug}`

  const payload = JSON.stringify({
    format: 'blogman-publish-promotion/v1',
    promotionId,
    revisionId: revision.revision_id,
    articleId,
    baseVersion: revision.base_version,
    promotedVersion,
    slug: revision.slug,
    publicUrl,
    contentSha256: revision.content_sha256,
    actor,
    createdAt: now,
  })
  const evidenceSha256 = evidenceDigest(payload)

  // The exact live snapshot being replaced (the restore point material).
  const live = await findPostById(db, postRef)
  const restoreSnapshot = live
    ? snapshotJson(
        buildInitialSnapshot({
          id: postRef,
          slug: live.slug,
          title: live.title,
          content: live.content ?? '',
          html: live.html ?? '',
          description: live.description,
          category: live.category,
          tags: live.tags,
          status: live.status,
          password: live.password,
          is_pinned: live.is_pinned,
          is_hidden: live.is_hidden,
          cover_image: live.cover_image,
          deleted_at: live.deleted_at,
          published_at: live.published_at,
          updated_at: live.updated_at,
        }),
      )
    : '{}'
  const liveContentHash = live
    ? snapshotContentHash({ content: live.content ?? '' })
    : sha256OfEmpty()

  const promotedRow = revisionToPostRow(revision, postRef, now)
  const record = buildInitialSnapshot(promotedRow)
  const recordJson = snapshotJson({
    ...record,
    version: promotedVersion as 1,
  })
  const restoredId = restorePointIdFor(promotionId)
  const promoteOperationId = `promote:${revision.revision_id}`

  const batch: D1PreparedStatement[] = [
    // (1) Restore point FIRST — the pre-promotion formal snapshot. Guarded so
    // it only lands when this promotion can actually proceed (no prior
    // promotion, the promoted version slot is free); under a failed guard the
    // whole batch no-ops and no partial fact survives.
    db
      .prepare(
        `INSERT INTO publish_restore_points
           (restore_point_id, article_id, formal_version, promoted_version, snapshot_json, content_sha256, reason, created_at)
         SELECT ?, ?, ?, ?, ?, ?, 'promote:' || ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM publish_promotions WHERE promotion_id = ?)
           AND NOT EXISTS (SELECT 1 FROM publish_restore_points WHERE restore_point_id = ?)
           AND NOT EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ?)`,
      )
      .bind(
        restoredId,
        articleId,
        formal.version,
        promotedVersion,
        restoreSnapshot,
        liveContentHash,
        revision.revision_id,
        now,
        promotionId,
        restoredId,
        articleId,
        promotedVersion,
      ),
    // (2) The promoted version fact — guarded by the exact formal base + the
    //     still-active revision (a racing writer aborting the whole batch).
    db
      .prepare(
        `INSERT INTO article_versions
           (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (SELECT version FROM formal_publications WHERE article_id = ?) = ?
           AND (SELECT status FROM publish_revisions WHERE revision_id = ?) = 'active'
           AND NOT EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ?)`,
      )
      .bind(
        articleId,
        promotedVersion,
        promoteOperationId,
        recordJson,
        record.content_snapshot_sha256 ?? '',
        now,
        articleId,
        revision.base_version,
        revision.revision_id,
        articleId,
        promotedVersion,
      ),
    // (3) The formal version + public address move to the promoted revision —
    //     guarded by OUR OWN version fact (never a dirty foreign row).
    db
      .prepare(
        `UPDATE formal_publications SET
           version = ?, slug = ?, published_at = ?, public_url = ?, event_id = ?
         WHERE article_id = ?
           AND version = ?
           AND EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ? AND operation_id = ?)`,
      )
      .bind(
        promotedVersion,
        revision.slug,
        now,
        publicUrl,
        promotionId,
        articleId,
        revision.base_version,
        articleId,
        promotedVersion,
        promoteOperationId,
      ),
    // (4) The posts projection follows the formal fact — content replaced, the
    //     first-published time is preserved (only published_at moves).
    db
      .prepare(
        `UPDATE posts SET
           slug = ?, title = ?, content = ?, html = ?, description = ?, category = ?,
           tags = ?, status = 'published', password = ?, is_pinned = ?, is_hidden = ?,
           cover_image = ?, deleted_at = NULL, published_at = ?, updated_at = ?,
           content_envelope = ?, content_snapshot_sha256 = ?, source_sync_sha256 = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ? AND operation_id = ?)`,
      )
      .bind(
        revision.slug,
        revision.title,
        revision.content,
        revision.html,
        revision.description,
        revision.category,
        revision.tags,
        revision.password,
        revision.is_pinned,
        revision.is_hidden,
        revision.cover_image,
        now,
        now,
        record.envelope ? JSON.stringify(record.envelope) : null,
        record.content_snapshot_sha256,
        record.source_sync_sha256,
        postRef,
        articleId,
        promotedVersion,
        promoteOperationId,
      ),
    // (5) The revision leaves the active surface (immutable history).
    db
      .prepare(
        `UPDATE publish_revisions SET status = 'promoted', updated_at = ?
         WHERE revision_id = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM formal_publications WHERE article_id = ? AND version = ?)
           AND EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ? AND operation_id = ?)`,
      )
      .bind(now, revision.revision_id, articleId, promotedVersion, articleId, promotedVersion, promoteOperationId),
    // (6) The immutable promotion event — requires the restore point written
    // in THIS batch (the rollback material) and the promoted version fact; the
    // hard UNIQUE constraint is the enforcement of at-most-one event.
    db
      .prepare(
        `INSERT INTO publish_promotions
           (promotion_id, article_id, revision_id, base_version, promoted_version,
            slug, public_url, content_sha256, evidence_sha256, payload, actor, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM publish_restore_points WHERE restore_point_id = ?)
           AND EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version = ? AND operation_id = ?)
           AND NOT EXISTS (SELECT 1 FROM publish_promotions WHERE promotion_id = ?)`,
      )
      .bind(
        promotionId,
        articleId,
        revision.revision_id,
        revision.base_version,
        promotedVersion,
        revision.slug,
        publicUrl,
        revision.content_sha256,
        evidenceSha256,
        payload,
        actor,
        now,
        restoredId,
        articleId,
        promotedVersion,
        promoteOperationId,
        promotionId,
      ),
  ]

  try {
    await db.batch(batch)
  } catch (error) {
    // Atomic abort — a hard constraint fired (e.g. a dirty partial promotion
    // row). Zero partial online state: the old formal version stays online and
    // the active revision stays intact.
    const raced = await findPromotion(db, promotionId)
    if (raced) {
      return promotionFactsResult(db, raced, true)
    }
    return {
      outcome: 'conflict',
      articleId,
      reason: `transaction interrupted (no partial promotion written): ${error instanceof Error ? error.message : String(error)}`,
      revision: { revisionId: revision.revision_id, revisionNumber: revision.revision_number, status: 'active' },
    }
  }

  const promotion = await findPromotion(db, promotionId)
  if (!promotion) {
    // A guard no-op'd — determine which precondition failed (fail-closed).
    const liveFormal = await findFormalByArticle(db, articleId)
    if (!liveFormal || liveFormal.version !== promotedVersion) {
      return {
        outcome: 'conflict',
        articleId,
        reason: 'promotion-guard-aborted',
        revision: { revisionId: revision.revision_id, revisionNumber: revision.revision_number, status: 'active' },
      }
    }
    const stillActive = await findActiveRevision(db, articleId)
    return {
      outcome: 'conflict',
      articleId,
      reason: stillActive ? 'promotion-guard-aborted' : 'revision-no-longer-active',
      revision: stillActive
        ? { revisionId: stillActive.revision_id, revisionNumber: stillActive.revision_number, status: stillActive.status }
        : { revisionId: revision.revision_id, revisionNumber: revision.revision_number, status: 'promoted' },
    }
  }

  // External I/O runs ONLY after the transaction committed.
  if (afterCommit) {
    try {
      await afterCommit(promotion)
    } catch {
      // Best-effort external I/O (cache invalidation) — the promotion fact is
      // already durable and never rolled back by a transport failure.
    }
  }

  return promotionFactsResult(db, promotion, false)
}

async function promotionFactsResult(db: Database, promotion: PromotionRow, existing: boolean): Promise<PromoteResult> {
  const facts: PromotionFacts = {
    articleId: promotion.article_id,
    revisionId: promotion.revision_id,
    baseVersion: promotion.base_version,
    promotedVersion: promotion.promoted_version,
    slug: promotion.slug,
    publicUrl: promotion.public_url,
    contentSha256: promotion.content_sha256,
    evidenceSha256: promotion.evidence_sha256,
    actor: promotion.actor,
  }
  if (existing) {
    return { outcome: 'replayed' as const, ...facts, promotionId: promotion.promotion_id, existing: true }
  }
  return { outcome: 'promoted' as const, ...facts, promotionId: promotion.promotion_id, existing: false }
}

export async function promoteRevision(db: Database, input: PromoteInput): Promise<PromoteResult> {
  const { actor, siteUrl = FIRST_PUBLISH_DEFAULT_SITE_URL, now = unixNow(), afterCommit } = input
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'promoteRevision: actor is required' }

  let articleId = input.articleId
  let revision: RevisionRow | null = null
  if (input.revisionId && input.revisionId.trim() !== '') {
    revision = await findRevisionById(db, input.revisionId.trim())
    if (!revision) return { outcome: 'not-found', reason: `revision '${input.revisionId}' not found` }
    articleId = revision.article_id
  } else if (Number.isInteger(articleId) && (articleId as number) > 0) {
    revision = await findActiveRevision(db, articleId as number)
    if (!revision) return { outcome: 'not-found', articleId: articleId as number, reason: 'no active revision for article' }
  } else {
    return { outcome: 'invalid', reason: 'promoteRevision: revisionId or articleId is required' }
  }
  if (!revision || !articleId) {
    return { outcome: 'invalid', reason: 'promoteRevision: could not resolve the active revision' }
  }

  const article = await findArticleById(db, articleId)
  if (!article) return { outcome: 'not-found', articleId, reason: `article ${articleId} not found` }

  // Idempotent replay: this revision was already promoted.
  const promotionId = promotionIdFor(revision.revision_id)
  const existingPromotion = await findPromotion(db, promotionId)
  if (existingPromotion) {
    return promotionFactsResult(db, existingPromotion, true)
  }

  const formal = await findFormalByArticle(db, articleId)
  if (!formal) return { outcome: 'blocked', articleId, reason: 'article has no formal publication', failures: ['formal-missing'] }
  if (revision.base_version !== formal.version) {
    return { outcome: 'conflict', articleId, reason: `revision base v${revision.base_version} != formal v${formal.version}`, revision: { revisionId: revision.revision_id, revisionNumber: revision.revision_number, status: revision.status } }
  }
  if (revision.status !== 'active') {
    return { outcome: 'conflict', articleId, reason: `revision is not active (status='${revision.status}')`, revision: { revisionId: revision.revision_id, revisionNumber: revision.revision_number, status: revision.status } }
  }

  // Content gate: the promoted body must be publishable (same spirit as the
  // first-publish B4 blocker — the public page needs a title and a body).
  const failures: string[] = []
  if (revision.title.trim().length === 0) failures.push('title-blank')
  if (revision.content.trim().length === 0 && revision.html.trim().length === 0) failures.push('content-blank')
  if (revision.password !== null && revision.password !== '') failures.push('password-protected')
  // Slug uniqueness against other formal articles / published posts.
  const rivalFormal = await db
    .prepare('SELECT article_id FROM formal_publications WHERE slug = ? AND article_id != ?')
    .bind(revision.slug, articleId)
    .first<{ article_id: number }>()
  const rivalPublished = await db
    .prepare("SELECT id FROM posts WHERE slug = ? AND id != ? AND status = 'published'")
    .bind(revision.slug, article.post_ref)
    .first<{ id: number }>()
  if (rivalFormal || rivalPublished) failures.push('slug-conflict')
  if (failures.length > 0) return { outcome: 'blocked', articleId, reason: 'promotion blockers failed', failures }

  return promoteById(db, {
    revision,
    articleId,
    postRef: article.post_ref,
    formal,
    actor,
    siteUrl,
    now,
    afterCommit,
  })
}

/* ------------------------------------------------------------------ */
/* discard — drop the active revision with zero live change            */
/* ------------------------------------------------------------------ */

export async function discardRevision(
  db: Database,
  input: { revisionId?: string; articleId?: number; actor: string },
): Promise<DiscardResult> {
  const { actor } = input
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'discardRevision: actor is required' }

  let revision: RevisionRow | null = null
  if (input.revisionId && input.revisionId.trim() !== '') {
    revision = await findRevisionById(db, input.revisionId.trim())
  } else if (Number.isInteger(input.articleId) && (input.articleId as number) > 0) {
    revision = await findActiveRevision(db, input.articleId as number)
  }
  if (!revision) return { outcome: 'not-found', reason: 'no active revision to discard' }
  if (revision.status !== 'active') {
    return { outcome: 'replayed', articleId: revision.article_id, revisionId: revision.revision_id }
  }

  const now = unixNow()
  await db
    .prepare(
      `UPDATE publish_revisions SET status = 'discarded', updated_at = ?
       WHERE revision_id = ? AND status = 'active'`,
    )
    .bind(now, revision.revision_id)
    .run()
  return { outcome: 'discarded', articleId: revision.article_id, revisionId: revision.revision_id }
}

/* ------------------------------------------------------------------ */
/* read model                                                          */
/* ------------------------------------------------------------------ */

/** The full revision-loop read surface for the editor / workbench. */
export async function readRevisionState(db: Database, articleId: number): Promise<RevisionState> {
  const article = await findArticleById(db, articleId)
  if (!article) {
    return { articleId, formal: null, active: null, promotions: [], latestRestorePoint: null }
  }
  const formal = await findFormalByArticle(db, articleId)
  const formalAnchor: FormalAnchor & { slug: string } | null = formal
    ? {
        version: formal.version,
        slug: formal.slug,
        contentHash: await formalContentHash(db, articleId, formal.version),
      }
    : null
  const active = await findActiveRevision(db, articleId)
  const { results: promotions } = await db
    .prepare(
      `SELECT id, promotion_id, article_id, revision_id, base_version, promoted_version,
              slug, public_url, content_sha256, evidence_sha256, payload, actor, created_at
       FROM publish_promotions WHERE article_id = ? ORDER BY created_at DESC`,
    )
    .bind(articleId)
    .all<PromotionRow>()
  const latestRestorePoint = await db
    .prepare(
      `SELECT id, restore_point_id, article_id, formal_version, promoted_version,
              snapshot_json, content_sha256, reason, created_at
       FROM publish_restore_points WHERE article_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<RestorePointRow>()
  return { articleId, formal: formalAnchor, active, promotions: promotions ?? [], latestRestorePoint }
}

/** @internal — reuse the first-publish snapshot hashing for the record builder. */
export function buildPromotedVersionRecord(row: PostAuthorityRow): ReturnType<typeof buildInitialSnapshot> {
  return buildInitialSnapshot(row)
}

/** Coerce a kernel save snapshot into the revision snapshot shape. */
export function revisionSnapshotFromSave(snapshot: ArticleCommandSnapshot): RevisionSnapshotInput {
  return {
    slug: snapshot.slug,
    title: snapshot.title,
    content: snapshot.content,
    html: snapshot.html,
    description: snapshot.description,
    category: snapshot.category,
    tags: snapshot.tags,
    password: snapshot.password,
    is_pinned: snapshot.is_pinned,
    is_hidden: snapshot.is_hidden,
    cover_image: snapshot.cover_image,
  }
}