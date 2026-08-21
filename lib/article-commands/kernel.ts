/**
 * B2-03 — versioned article write command kernel (issue #26).
 *
 * The isolated D1 application command layer. Three commands:
 *
 *   - `create`: idempotent creation keyed by a client creation id; a blank
 *     session (no title AND no body) never creates an article; writes the
 *     article identity + version 1 + the legacy `posts` compat projection in
 *     one D1 transaction.
 *   - `save`: writes the next monotonic version only when the expected
 *     version matches the server's latest; the same operation id replays the
 *     original result; a conflict returns the current server version plus
 *     comparison facts with zero partial writes.
 *   - `publishTemp`: temporary publish / status change with version + status
 *     preconditions and an idempotency key; it does NOT build batch-3 facts
 *     (no publish intent / events / Outbox).
 *
 * Atomicity model: version facts lead, the posts projection follows — both
 * guarded by the same preconditions inside one transaction. The posts UPDATE
 * is guarded by `EXISTS(operation_id)` (the version row this command just
 * inserted), so the two statements always move together. The kernel resolves
 * outcomes by re-reading after the batch (the wrangler CLI does not surface
 * `changes`/`last_row_id`, so result resolution never depends on statement
 * meta) — identical behaviour on production D1 and in the CLI-backed tests.
 *
 * KV / FTS / related-content / vector indexes are out-of-transaction
 * rebuildable projections: failures are recorded, never rolled back.
 */

import type { Database } from '@/lib/repositories/schema'
import {
  buildInitialSnapshot,
  postFieldDigest,
  snapshotJson,
  type ArticleIdentitySnapshot,
  type ArticleSnapshotFields,
  type PostAuthorityRow,
} from '@/lib/article-identity'
import type {
  AppliedVersionResult,
  ArticleCommandProjections,
  ArticleCommandSnapshot,
  ArticleLevelInput,
  ArticleLevelResult,
  BatchSetCategoryInput,
  BatchSetCategoryItem,
  BatchSetCategoryItemResult,
  BatchSetCategoryResult,
  CreateArticleInput,
  CreateResult,
  PublishTempInput,
  PublishTempResult,
  SaveArticleInput,
  SaveResult,
  SetCategoryInput,
  SetHiddenInput,
  SetPasswordInput,
  SetPinnedInput,
  RestoreInput,
  SoftDeleteInput,
  VersionComparisonFacts,
} from './types'
import { resolveFormalAnchor, revisionSnapshotFromSave, saveRevision } from '@/lib/publish-revision'
import type { FormalAnchor } from '@/lib/publish-revision/types'
import {
  linkSourceToArticle,
  liveLinkForUrl,
  sourceFactsFor,
  type SourceFacts,
} from '@/lib/source-identity'
import { normalizeSourceUrl } from '@/lib/source-identity/url'

/** Monotonic version facts for one article (article_versions row surface). */
interface VersionRow {
  id: number
  article_id: number
  version: number
  operation_id: string
  snapshot_json: string
  content_snapshot_sha256: string | null
  published_at: number | null
}

interface ArticleRow {
  id: number
  post_ref: number
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/** Stable operation id derived from the creation id for the version-1 fact. */
export function createOperationId(creationId: string): string {
  return `create:${creationId}`
}

function snapshotRow(
  snapshot: ArticleCommandSnapshot,
  postRef: number,
  now: number,
): PostAuthorityRow {
  return {
    id: postRef,
    slug: snapshot.slug,
    title: snapshot.title,
    content: snapshot.content,
    html: snapshot.html,
    description: snapshot.description,
    category: snapshot.category,
    tags: snapshot.tags ? JSON.stringify(snapshot.tags) : null,
    status: snapshot.status,
    password: snapshot.password,
    is_pinned: snapshot.is_pinned,
    is_hidden: snapshot.is_hidden,
    cover_image: snapshot.cover_image,
    deleted_at: snapshot.deleted_at,
    published_at: snapshot.published_at,
    updated_at: snapshot.updated_at ?? now,
  }
}

/** Canonical version record (same shape as the B2-02 identity snapshots). */
function buildVersionRecord(row: PostAuthorityRow, version: number): ArticleIdentitySnapshot {
  // The B2-02 identity snapshot types version 1 as a literal; command writes
  // stamp the actual monotonic version on top.
  return { ...buildInitialSnapshot(row), version } as ArticleIdentitySnapshot
}

/** Envelope columns for the legacy posts compat projection. */
function envelopeColumns(record: ArticleIdentitySnapshot): {
  content_envelope: string | null
  content_snapshot_sha256: string | null
  source_sync_sha256: string | null
} {
  return {
    content_envelope: record.envelope ? JSON.stringify(record.envelope) : null,
    content_snapshot_sha256: record.content_snapshot_sha256,
    source_sync_sha256: record.source_sync_sha256,
  }
}

function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<ArticleRow>()
}

function findArticleByCreationId(db: Database, creationId: string): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE draft_ref = ?')
    .bind(creationId)
    .first<ArticleRow>()
}

function findVersionByOperationId(db: Database, operationId: string): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT id, article_id, version, operation_id, snapshot_json,
              content_snapshot_sha256, published_at
       FROM article_versions WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<VersionRow>()
}

function findLatestVersion(db: Database, articleId: number): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT id, article_id, version, operation_id, snapshot_json,
              content_snapshot_sha256, published_at
       FROM article_versions WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<VersionRow>()
}

/**
 * Slug exclusivity through the permanent address registry (ADR 0009): the slug
 * is taken when ANY kind row exists for a DIFFERENT article. Own historical /
 * candidate rows never block (revert / re-reserve).
 */
function slugOwnedByOther(db: Database, slug: string, articleId: number): Promise<boolean> {
  return db
    .prepare('SELECT article_id FROM article_slug_addresses WHERE slug = ?')
    .bind(slug)
    .first<{ article_id: number }>()
    .then((row) => row !== null && row.article_id !== articleId)
}

function slugTaken(db: Database, slug: string): Promise<boolean> {
  return db
    .prepare('SELECT article_id FROM article_slug_addresses WHERE slug = ?')
    .bind(slug)
    .first<{ article_id: number }>()
    .then((row) => row !== null)
}

/** Comparison facts extracted from the latest server-side version snapshot. */
function comparisonFacts(latest: VersionRow | null): VersionComparisonFacts {
  if (!latest) {
    return {
      version: 0,
      title: null,
      slug: null,
      status: null,
      published_at: null,
      updated_at: null,
      content_snapshot_sha256: null,
      source_sync_sha256: null,
      post_field_sha256: null,
      fidelity: null,
    }
  }
  let parsed: ArticleIdentitySnapshot | null = null
  try {
    parsed = JSON.parse(latest.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    parsed = null
  }
  return {
    version: latest.version,
    title: parsed?.fields.title ?? null,
    slug: parsed?.fields.slug ?? null,
    status: parsed?.fields.status ?? null,
    published_at: parsed?.published_at ?? null,
    updated_at: parsed?.fields.updated_at ?? null,
    content_snapshot_sha256: latest.content_snapshot_sha256,
    source_sync_sha256: parsed?.source_sync_sha256 ?? null,
    post_field_sha256: parsed?.post_field_sha256 ?? null,
    fidelity: parsed?.fidelity ?? null,
  }
}

async function runProjections(
  projections: ArticleCommandProjections | undefined,
  result: AppliedVersionResult,
): Promise<string[]> {
  const failures: string[] = []
  if (!projections?.afterCommit) return failures
  try {
    await projections.afterCommit(result)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  return failures
}

/**
 * B6-01 — ensure the 待确认 (pending) source link exists for a created/replayed
 * article and return the facts. Idempotent by the stable `source:<creationId>`
 * operation id: a present link replays (zero new rows), a MISSING link is
 * converged so a failed write-back never leaves a hidden orphan — the pending
 * link stays visible until the author confirms or cancels it.
 */
async function ensureSourceFacts(
  db: Database,
  url: string,
  articleId: number,
  creationId: string,
  role: 'primary' | 'clip' = 'primary',
): Promise<SourceFacts | null> {
  if (!url) return null
  const linkResult = await linkSourceToArticle(db, {
    operationId: `source:${creationId}`,
    url,
    articleId,
    role,
  })
  if (linkResult.outcome === 'applied' || linkResult.outcome === 'replayed') {
    return sourceFactsFor(db, url, articleId)
  }
  if (linkResult.outcome === 'collision') {
    // A concurrent clip claimed the URL — report the owner facts, no duplicate link.
    return { sourceIdentity: linkResult.sourceIdentity, link: null }
  }
  return null
}

async function existingResult(
  db: Database,
  article: ArticleRow,
  operationId: string,
  sourceUrl: string | null,
  creationId: string,
  sourceRole: 'primary' | 'clip' = 'primary',
): Promise<CreateResult> {
  const sourceFacts =
    sourceUrl != null
      ? await ensureSourceFacts(db, sourceUrl, article.id, creationId, sourceRole).catch(() => null)
      : null
  return {
    outcome: 'existing' as const,
    articleId: article.id,
    postRef: article.post_ref,
    version: 1,
    operationId,
    existing: true,
    projectionFailures: [],
    ...(sourceFacts ? { source: sourceFacts } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* create                                                              */
/* ------------------------------------------------------------------ */

export async function create(
  db: Database,
  input: CreateArticleInput,
): Promise<CreateResult> {
  const { creationId, snapshot, source } = input
  if (!creationId || creationId.trim() === '') {
    throw new Error('create: creationId is required')
  }
  if (!snapshot.slug || snapshot.slug.trim() === '') {
    throw new Error('create: snapshot.slug is required')
  }
  if (snapshot.title.trim() === '' && snapshot.content.trim() === '') {
    return { outcome: 'skipped', reason: 'blank-session' }
  }

  // B6-01 — optional writable-primary-source URL driving the identity + pending link.
  const sourceUrl = source?.url?.trim() || null
  const sourceRole = source?.role ?? 'primary'

  const operationId = createOperationId(creationId)

  // B6-01 — a URL that cannot become a source identity (unparseable / not http)
  // is refused up-front: we never guess a source out of an invalid URL.
  if (sourceUrl && !normalizeSourceUrl(sourceUrl)) {
    return { outcome: 'invalid-source', url: sourceUrl }
  }

  // Fast idempotent return: same creation id -> same article.
  const existing = await findArticleByCreationId(db, creationId)
  if (existing) {
    return existingResult(db, existing, operationId, sourceUrl, creationId, sourceRole)
  }

  // B6-01 — repeated clip / duplicate source: the normalized URL already owns a
  // live (pending | confirmed) link to an EXISTING article, so we converge on
  // that article's identity + version instead of creating a duplicate.
  if (sourceUrl) {
    const owned = await liveLinkForUrl(db, sourceUrl).catch(() => null)
    if (owned) {
      const owner = await findArticleById(db, owned.articleId)
      if (owner) {
        const ownerVersion = (await findLatestVersion(db, owned.articleId))?.version ?? 0
        const sourceFacts = await sourceFactsFor(db, sourceUrl, owned.articleId)
        return {
          outcome: 'source-linked' as const,
          articleId: owned.articleId,
          postRef: owner.post_ref,
          version: ownerVersion,
          operationId,
          existing: true,
          // A live link exists, so the source facts are always resolvable here.
          source: sourceFacts!,
        }
      }
    }
  }

  // Fast slug-conflict return.
  if (await slugTaken(db, snapshot.slug)) {
    return { outcome: 'slug-conflict', slug: snapshot.slug }
  }

  const now = unixNow()
  const publishedAt =
    snapshot.status === 'published' ? (snapshot.published_at ?? now) : snapshot.published_at
  const row = snapshotRow({ ...snapshot, published_at: publishedAt }, 0, now)
  const record = buildVersionRecord(row, 1)
  // post_ref is patched into the stored JSON inside the transaction (json_set).
  const recordJson = snapshotJson({ ...record, post_ref: 0 })
  const { content_snapshot_sha256 } = envelopeColumns(record)

  const batch = [
    // (1) The article identity — post_ref is synthesized as MAX(post_ref)+1
    // (ADR 0008): a legacy numeric identifier whose only job is uniqueness;
    // it is no longer derived from (or mirrored into) the posts projection.
    db
      .prepare(
        `INSERT INTO articles (post_ref, slug, draft_ref)
         SELECT COALESCE((SELECT MAX(post_ref) FROM articles), 0) + 1, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM articles WHERE draft_ref = ?)`,
      )
      .bind(row.slug, creationId, creationId),
    db
      .prepare(
        `INSERT INTO article_versions
           (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
         SELECT a.id, 1, ?, json_set(?, '$.post_ref', a.post_ref), ?, ?
         FROM articles a WHERE a.draft_ref = ?
           AND NOT EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)`,
      )
      .bind(
        operationId,
        recordJson,
        content_snapshot_sha256,
        record.published_at,
        creationId,
        operationId,
      ),
    // (3) Reserve the draft slug in the address registry (ADR 0009). No
    // guard against a RIVAL's row: the registry's slug UNIQUE is the hard
    // enforcement — a concurrent registration aborts the whole batch.
    db
      .prepare(
        `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
         SELECT ?, a.id, 'candidate', ?, ?
         FROM articles a WHERE a.draft_ref = ?
           AND NOT EXISTS (
             SELECT 1 FROM article_slug_addresses s WHERE s.slug = ? AND s.article_id = a.id
           )`,
      )
      .bind(row.slug, now, now, creationId, row.slug),
  ]

  try {
    await db.batch(batch)
  } catch {
    // Batch aborted atomically (e.g. slug UNIQUE or operation_id UNIQUE from a
    // concurrent identical create). Resolve the real state and report it.
    const byCreation = await findArticleByCreationId(db, creationId)
    if (byCreation) {
      return existingResult(db, byCreation, operationId, sourceUrl, creationId, sourceRole)
    }
    if (await slugTaken(db, row.slug)) {
      return { outcome: 'slug-conflict', slug: row.slug }
    }
    throw new Error(
      `create: unexpected batch failure for creationId '${creationId}' (slug '${row.slug}')`,
    )
  }

  const article = await findArticleByCreationId(db, creationId)
  if (!article) {
    throw new Error(`create: article for creationId '${creationId}' not found after batch`)
  }
  const version = await findVersionByOperationId(db, operationId)
  if (!version) {
    throw new Error(
      `create: version for creationId '${creationId}' not found after batch (operation '${operationId}')`,
    )
  }

  const result: AppliedVersionResult = {
    outcome: 'created',
    articleId: article.id,
    postRef: article.post_ref,
    version: version.version,
    operationId,
    existing: false,
    projectionFailures: [],
  }

  // B6-01 — record the 待确认 (pending, not auto-effective) source link AFTER
  // the article + version commit. A failed/retried write-back never leaves a
  // hidden orphan: replaying the same creation id re-converges the pending link,
  // which stays visible until the author confirms or cancels it.
  if (sourceUrl) {
    result.source = await ensureSourceFacts(db, sourceUrl, article.id, creationId, sourceRole)
  }

  result.projectionFailures = await runProjections(input.projections, result)
  return result
}

/* ------------------------------------------------------------------ */
/* save                                                                */
/* ------------------------------------------------------------------ */

export async function save(db: Database, input: SaveArticleInput): Promise<SaveResult> {
  const { articleId, expectedVersion, operationId, snapshot } = input
  if (!articleId || !operationId || operationId.trim() === '') {
    throw new Error('save: articleId and operationId are required')
  }
  if (!snapshot.slug || snapshot.slug.trim() === '') {
    throw new Error('save: snapshot.slug is required')
  }

  const article = await findArticleById(db, articleId)
  if (!article) throw new Error(`save: article ${articleId} not found`)
  const postRef = article.post_ref

  // Idempotent replay: the same operation id returns the original result.
  const replayed = await findVersionByOperationId(db, operationId)
  if (replayed) {
    if (replayed.article_id !== articleId) {
      throw new Error(
        `save: operation '${operationId}' already used by article ${replayed.article_id}`,
      )
    }
    return {
      outcome: 'replayed',
      articleId,
      postRef,
      version: replayed.version,
      operationId,
      existing: true,
      projectionFailures: [],
    }
  }

  // B3-02 (issue #34): a formally published article edits NEVER change the
  // live version. The save is routed into the shared revision surface — every
  // writer (editor autosave, AI enrichment, external versioned writers) lands
  // in the SAME active revision; the formal projection stays online until
  // promotion. A draft article (no formal publication) keeps the normal
  // monotonic version path below. When the formal_publications surface is
  // absent (pre-B3-01 / ledger-only DB) there is no formal anchor to route to
  // and the normal version path is preserved.
  let formalAnchor: FormalAnchor | null = null
  try {
    formalAnchor = await resolveFormalAnchor(db, articleId)
  } catch {
    formalAnchor = null
  }
  if (formalAnchor) {
    const routed = await saveRevision(db, {
      articleId,
      postRef,
      expectedVersion,
      operationId,
      snapshot: revisionSnapshotFromSave(snapshot),
      formal: formalAnchor,
    })
    if (routed.outcome === 'applied' || routed.outcome === 'replayed') {
      const result = routed as AppliedVersionResult
      result.projectionFailures = await runProjections(input.projections, result)
      return result as SaveResult
    }
    return routed as unknown as SaveResult
  }

  const serverVersion = (await findLatestVersion(db, articleId))?.version ?? 0
  if (serverVersion !== expectedVersion) {
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion,
      facts: comparisonFacts(await findLatestVersion(db, articleId)),
    }
  }

  // Slug precondition through the address registry (ADR 0009); the batch's
  // registry UNIQUE constraint is the suspenders.
  if (await slugOwnedByOther(db, snapshot.slug, articleId)) {
    return { outcome: 'slug-conflict', slug: snapshot.slug }
  }

  const now = unixNow()
  const publishedAt =
    snapshot.status === 'published' ? (snapshot.published_at ?? now) : snapshot.published_at
  const row = snapshotRow({ ...snapshot, published_at: publishedAt }, postRef, now)
  const record = buildVersionRecord(row, expectedVersion + 1)
  const recordJson = snapshotJson(record)
  const { content_snapshot_sha256 } = envelopeColumns(record)

  const batch = [
    db
      .prepare(
        `INSERT INTO article_versions
           (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
         SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
         FROM article_versions
         WHERE article_id = ?
         GROUP BY article_id
         HAVING COALESCE(MAX(version), 0) = ?
           AND NOT EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)`,
      )
      .bind(
        articleId,
        operationId,
        recordJson,
        content_snapshot_sha256,
        record.published_at,
        articleId,
        expectedVersion,
        operationId,
      ),
    // Reserve the saved slug as this article's candidate. Own rows (from
    // create or a prior save) skip via the NOT EXISTS; a RIVAL's row trips
    // the registry slug UNIQUE and aborts the whole batch.
    db
      .prepare(
        `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
         SELECT ?, ?, 'candidate', ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM article_slug_addresses WHERE slug = ? AND article_id = ?
         )`,
      )
      .bind(row.slug, articleId, now, now, row.slug, articleId),
  ]

  try {
    await db.batch(batch)
  } catch (error) {
    // Atomic abort — most likely a registry slug UNIQUE race.
    const byOperation = await findVersionByOperationId(db, operationId)
    if (byOperation) {
      return {
        outcome: 'replayed',
        articleId,
        postRef,
        version: byOperation.version,
        operationId,
        existing: true,
        projectionFailures: [],
      }
    }
    if (await slugOwnedByOther(db, snapshot.slug, articleId)) {
      return { outcome: 'slug-conflict', slug: snapshot.slug }
    }
    throw new Error(
      `save: unexpected batch failure for article ${articleId} operation '${operationId}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const version = await findVersionByOperationId(db, operationId)
  if (!version) {
    // Guards no-op'd: the expected version lost a race between pre-read and
    // batch. Nothing was written — report the real server state.
    const latest = await findLatestVersion(db, articleId)
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: latest?.version ?? 0,
      facts: comparisonFacts(latest),
    }
  }

  const result = {
    outcome: 'applied' as const,
    articleId,
    postRef,
    version: version.version,
    operationId,
    existing: false,
    projectionFailures: [] as string[],
  }
  result.projectionFailures = await runProjections(input.projections, result)
  return result
}

/* ------------------------------------------------------------------ */
/* publishTemp                                                         */
/* ------------------------------------------------------------------ */

export async function publishTemp(
  db: Database,
  input: PublishTempInput,
): Promise<PublishTempResult> {
  const { articleId, expectedVersion, currentStatus, operationId, status } = input
  if (!articleId || !operationId || operationId.trim() === '') {
    throw new Error('publishTemp: articleId and operationId are required')
  }
  if (status !== 'draft' && status !== 'published') {
    throw new Error(`publishTemp: invalid status '${status}'`)
  }

  const article = await findArticleById(db, articleId)
  if (!article) throw new Error(`publishTemp: article ${articleId} not found`)
  const postRef = article.post_ref

  // Idempotent replay.
  const replayed = await findVersionByOperationId(db, operationId)
  if (replayed) {
    if (replayed.article_id !== articleId) {
      throw new Error(
        `publishTemp: operation '${operationId}' already used by article ${replayed.article_id}`,
      )
    }
    return {
      outcome: 'replayed',
      articleId,
      postRef,
      version: replayed.version,
      operationId,
      existing: true,
      projectionFailures: [],
    }
  }

  const latest = await findLatestVersion(db, articleId)
  const serverVersion = latest?.version ?? 0
  if (serverVersion !== expectedVersion) {
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion,
      facts: comparisonFacts(latest),
    }
  }

  // Status precondition anchored on the latest version snapshot — the
  // canonical lifecycle fact (the legacy posts projection is retired).
  const current = JSON.parse(latest!.snapshot_json) as ArticleIdentitySnapshot
  const liveStatus = current.fields.status ?? null
  if (liveStatus !== currentStatus) {
    return {
      outcome: 'status-conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion,
      currentStatus: liveStatus,
    }
  }

  // Legacy-compatible published_at: keep on unpublish, first-now on publish.
  const now = unixNow()
  const nextPublishedAt =
    status === 'published' ? (latest!.published_at ?? now) : latest!.published_at
  const nextRow: PostAuthorityRow = {
    id: postRef,
    slug: current.fields.slug,
    title: current.fields.title,
    content: current.original_content ?? '',
    html: current.original_html ?? '',
    description: current.fields.description,
    category: current.fields.category,
    tags: current.fields.tags,
    status,
    password: current.fields.password,
    is_pinned: current.fields.is_pinned ?? 0,
    is_hidden: current.fields.is_hidden ?? 0,
    cover_image: current.fields.cover_image,
    deleted_at: current.fields.deleted_at,
    published_at: nextPublishedAt,
    updated_at: now,
  }
  const record = buildVersionRecord(nextRow, expectedVersion + 1)
  const recordJson = snapshotJson(record)

  const batch = [
    db
      .prepare(
        `INSERT INTO article_versions
           (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
         SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
         FROM article_versions
         WHERE article_id = ?
         GROUP BY article_id
         HAVING COALESCE(MAX(version), 0) = ?
           AND NOT EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)
           AND COALESCE(json_extract((SELECT snapshot_json FROM article_versions
                 WHERE article_id = ? ORDER BY version DESC LIMIT 1), '$.fields.status'), '') = ?`,
      )
      .bind(
        articleId,
        operationId,
        recordJson,
        record.content_snapshot_sha256 ?? '',
        record.published_at,
        articleId,
        expectedVersion,
        operationId,
        articleId,
        currentStatus,
      ),
  ]

  try {
    await db.batch(batch)
  } catch (error) {
    const byOperation = await findVersionByOperationId(db, operationId)
    if (byOperation) {
      return {
        outcome: 'replayed',
        articleId,
        postRef,
        version: byOperation.version,
        operationId,
        existing: true,
        projectionFailures: [],
      }
    }
    throw new Error(
      `publishTemp: unexpected batch failure for article ${articleId} operation '${operationId}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const version = await findVersionByOperationId(db, operationId)
  if (!version) {
    const server = await findLatestVersion(db, articleId)
    return {
      outcome: 'conflict',
      articleId,
      postRef,
      expectedVersion,
      serverVersion: server?.version ?? 0,
      facts: comparisonFacts(server),
    }
  }

  const result = {
    outcome: 'applied' as const,
    articleId,
    postRef,
    version: version.version,
    operationId,
    existing: false,
    projectionFailures: [] as string[],
  }
  result.projectionFailures = await runProjections(input.projections, result)
  return result
}

/* ------------------------------------------------------------------ */
/* article-level (non-body) commands — #234 Phase A                    */
/*                                                                    */
/* These commands are the admin list's explicit write protocol. Each   */
/* command appends ONE immutable version snapshot (ADR 0007): the new  */
/* snapshot carries the latest state with only the target field moved, */
/* so the canonical public read (latest version) reflects pin / hide / */
/* password / category / soft-delete / restore immediately — no admin  */
/* vs public divergence. The body version therefore ADVANCES on every  */
/* applied article-level action; a long-open editor's next save gets   */
/* an expectedVersion conflict and replays after refresh (expected).   */
/*                                                                    */
/* Idempotency:                                                        */
/*   - a repeated operation_id finds its version fact and replays it   */
/*     (existing: true) without writing;                               */
/*   - a different operation whose target value is already live in the */
/*     latest snapshot also returns `replayed` without writing.        */
/* The insert is guarded inside the batch (HAVING MAX(version) =       */
/* expected AND NOT EXISTS operation_id), so a racing save/publish     */
/* between pre-read and write aborts atomically with zero partial      */
/* writes. categories.post_count bookkeeping statements carry the      */
/* same EXISTS(operation_id) guard so they can never fire without the  */
/* version fact landing in the same transaction.                       */
/* ------------------------------------------------------------------ */

interface ArticleLevelSpec {
  input: ArticleLevelInput
  label: string
  /** Current value of the target field, read from the latest snapshot's fields. */
  readCurrent: (fields: ArticleSnapshotFields) => unknown
  /** True when the target value is already live (idempotent replay, no write). */
  isUnchanged: (current: unknown) => boolean
  /** Mutates the cloned fields into the target state; reports a category move for count bookkeeping. */
  applyFields: (
    fields: ArticleSnapshotFields,
    now: number,
  ) => { from: string | null; to: string | null } | null
}

/** Rebuild the authoritative row surface from a stored snapshot for digest recomputation. */
function authorityRowFromSnapshot(
  parsed: ArticleIdentitySnapshot,
  postRef: number,
  fields: ArticleSnapshotFields,
): PostAuthorityRow {
  return {
    id: postRef,
    slug: fields.slug,
    title: fields.title,
    content: parsed.original_content ?? '',
    html: parsed.original_html ?? '',
    description: fields.description,
    category: fields.category,
    tags: fields.tags,
    status: fields.status,
    password: fields.password,
    is_pinned: fields.is_pinned,
    is_hidden: fields.is_hidden,
    cover_image: fields.cover_image,
    deleted_at: fields.deleted_at,
    published_at: fields.published_at,
    updated_at: fields.updated_at,
  }
}

/** Rebuild a full authority row from the latest frozen snapshot + a field patch. */
function nextAuthorityRow(
  postRef: number,
  current: ArticleIdentitySnapshot,
  patch: Partial<ArticleSnapshotFields>,
  now: number,
): PostAuthorityRow {
  const fields = { ...current.fields, ...patch }
  return {
    id: postRef,
    slug: fields.slug,
    title: fields.title,
    content: current.original_content ?? '',
    html: current.original_html ?? '',
    description: fields.description,
    category: fields.category,
    tags: fields.tags,
    status: fields.status,
    password: fields.password,
    is_pinned: fields.is_pinned ?? 0,
    is_hidden: fields.is_hidden ?? 0,
    cover_image: fields.cover_image,
    deleted_at: fields.deleted_at,
    published_at: fields.published_at,
    updated_at: now,
  }
}

async function runArticleLevelCommand(
  db: Database,
  spec: ArticleLevelSpec,
): Promise<ArticleLevelResult> {
  const { input, label } = spec
  if (!input.articleId || !input.operationId || input.operationId.trim() === '') {
    throw new Error(`${label}: articleId and operationId are required`)
  }

  const article = await findArticleById(db, input.articleId)
  if (!article) throw new Error(`${label}: article ${input.articleId} not found`)
  const postRef = article.post_ref

  // Idempotent replay: this exact operation already committed a version fact.
  const byOperation = await findVersionByOperationId(db, input.operationId)
  if (byOperation && byOperation.article_id === input.articleId) {
    return {
      outcome: 'replayed',
      articleId: input.articleId,
      postRef,
      version: byOperation.version,
      operationId: input.operationId,
      existing: true,
      projectionFailures: [],
    }
  }

  const latest = await findLatestVersion(db, input.articleId)
  const serverVersion = latest?.version ?? 0
  if (serverVersion !== input.expectedVersion) {
    return {
      outcome: 'conflict',
      articleId: input.articleId,
      postRef,
      expectedVersion: input.expectedVersion,
      serverVersion,
      facts: comparisonFacts(latest),
    }
  }

  let parsed: ArticleIdentitySnapshot | null = null
  try {
    parsed = latest ? (JSON.parse(latest.snapshot_json) as ArticleIdentitySnapshot) : null
  } catch {
    parsed = null
  }
  if (!parsed) {
    // No canonical snapshot to anchor on — refuse without writing.
    return {
      outcome: 'conflict',
      articleId: input.articleId,
      postRef,
      expectedVersion: input.expectedVersion,
      serverVersion,
      facts: comparisonFacts(latest),
    }
  }

  // Target value already live → replay signal, zero writes.
  if (spec.isUnchanged(spec.readCurrent(parsed.fields))) {
    return {
      outcome: 'replayed',
      articleId: input.articleId,
      postRef,
      version: serverVersion,
      operationId: input.operationId,
      existing: true,
      projectionFailures: [],
    }
  }

  const now = unixNow()
  const nextFields: ArticleSnapshotFields = { ...parsed.fields }
  const categoryMove = spec.applyFields(nextFields, now)
  nextFields.updated_at = now

  // Immutable next snapshot: only the target field moved; content hashes are
  // inherited (the body did not change) and the field digest is recomputed.
  // The identity snapshot types version as the literal INITIAL_VERSION; command
  // writes stamp the actual monotonic version on top (same as buildVersionRecord).
  const next = {
    ...parsed,
    version: serverVersion + 1,
    post_ref: postRef,
    fields: nextFields,
    post_field_sha256: postFieldDigest(authorityRowFromSnapshot(parsed, postRef, nextFields)),
    published_at:
      nextFields.status === 'published' ? (nextFields.published_at ?? null) : null,
  } as ArticleIdentitySnapshot
  const recordJson = snapshotJson(next)

  const batch = [
    db
      .prepare(
        `INSERT INTO article_versions
           (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at)
         SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
         FROM article_versions
         WHERE article_id = ?
         GROUP BY article_id
         HAVING COALESCE(MAX(version), 0) = ?
           AND NOT EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)`,
      )
      .bind(
        input.articleId,
        input.operationId,
        recordJson,
        next.content_snapshot_sha256,
        next.published_at,
        input.articleId,
        input.expectedVersion,
        input.operationId,
      ),
  ]
  if (categoryMove && categoryMove.from !== categoryMove.to) {
    // Count bookkeeping is guarded by the version fact so a no-op'd insert
    // (lost race) can never move a counter inside the aborted transaction.
    if (categoryMove.from) {
      batch.push(
        db
          .prepare(
            'UPDATE categories SET post_count = post_count - 1 WHERE name = ? AND EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)',
          )
          .bind(categoryMove.from, input.operationId),
      )
    }
    if (categoryMove.to) {
      batch.push(
        db
          .prepare(
            'UPDATE categories SET post_count = post_count + 1 WHERE name = ? AND EXISTS (SELECT 1 FROM article_versions WHERE operation_id = ?)',
          )
          .bind(categoryMove.to, input.operationId),
      )
    }
  }

  try {
    await db.batch(batch)
  } catch (error) {
    const raced = await findVersionByOperationId(db, input.operationId)
    if (raced && raced.article_id === input.articleId) {
      return {
        outcome: 'replayed',
        articleId: input.articleId,
        postRef,
        version: raced.version,
        operationId: input.operationId,
        existing: true,
        projectionFailures: [],
      }
    }
    throw new Error(
      `${label}: unexpected batch failure for article ${input.articleId} operation '${input.operationId}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const version = await findVersionByOperationId(db, input.operationId)
  if (!version || version.article_id !== input.articleId) {
    // Guards no-op'd: the expected version lost a race between pre-read and
    // batch. Nothing was written — report the real server state.
    const fresh = await findLatestVersion(db, input.articleId)
    return {
      outcome: 'conflict',
      articleId: input.articleId,
      postRef,
      expectedVersion: input.expectedVersion,
      serverVersion: fresh?.version ?? 0,
      facts: comparisonFacts(fresh),
    }
  }

  return {
    outcome: 'applied',
    articleId: input.articleId,
    postRef,
    version: version.version,
    operationId: input.operationId,
    existing: false,
    projectionFailures: [],
  }
}

/** Pin / unpin — appends one immutable version snapshot. */
export async function setPinned(db: Database, input: SetPinnedInput): Promise<ArticleLevelResult> {
  const is_pinned = input.is_pinned === 1 ? 1 : 0
  return runArticleLevelCommand(db, {
    input,
    label: 'setPinned',
    readCurrent: (fields) => fields.is_pinned,
    isUnchanged: (current) => current === is_pinned,
    applyFields: (fields) => {
      fields.is_pinned = is_pinned
      return null
    },
  })
}

/** Visibility (unlisted/link-only) — appends one immutable version snapshot. */
export async function setHidden(db: Database, input: SetHiddenInput): Promise<ArticleLevelResult> {
  const is_hidden = input.is_hidden === 1 ? 1 : 0
  return runArticleLevelCommand(db, {
    input,
    label: 'setHidden',
    readCurrent: (fields) => fields.is_hidden,
    isUnchanged: (current) => current === is_hidden,
    applyFields: (fields) => {
      fields.is_hidden = is_hidden
      return null
    },
  })
}

/** Access password — appends one immutable version snapshot; NULL and '' are the same "no password" state. */
export async function setPassword(db: Database, input: SetPasswordInput): Promise<ArticleLevelResult> {
  const password = typeof input.password === 'string' && input.password.trim() ? input.password.trim() : null
  return runArticleLevelCommand(db, {
    input,
    label: 'setPassword',
    readCurrent: (fields) => fields.password,
    isUnchanged: (current) => (current ?? null) === password,
    applyFields: (fields) => {
      fields.password = password
      return null
    },
  })
}

/** Category rename/move — appends one immutable version snapshot; keeps `categories.post_count` deltas. */
export async function setCategory(db: Database, input: SetCategoryInput): Promise<ArticleLevelResult> {
  const category = typeof input.category === 'string' && input.category.trim() ? input.category.trim() : null
  return runArticleLevelCommand(db, {
    input,
    label: 'setCategory',
    readCurrent: (fields) => fields.category,
    isUnchanged: (current) => (current ?? null) === category,
    applyFields: (fields) => {
      const from = fields.category ?? null
      fields.category = category
      return { from, to: category }
    },
  })
}

/** Soft delete — appends one immutable version snapshot; keeps the first deletion timestamp and the status. */
export async function softDelete(db: Database, input: SoftDeleteInput): Promise<ArticleLevelResult> {
  return runArticleLevelCommand(db, {
    input,
    label: 'softDelete',
    readCurrent: (fields) => fields.deleted_at,
    isUnchanged: (current) => current !== null && current !== undefined,
    applyFields: (fields, now) => {
      fields.deleted_at = fields.deleted_at ?? now
      return null
    },
  })
}

/** Restore — appends one immutable version snapshot; returns a soft-deleted article to draft with NO deletion timestamp. */
export async function restore(db: Database, input: RestoreInput): Promise<ArticleLevelResult> {
  return runArticleLevelCommand(db, {
    input,
    label: 'restore',
    readCurrent: (fields) => fields.deleted_at === null && fields.status === 'draft',
    isUnchanged: (current) => current === true,
    applyFields: (fields) => {
      fields.status = 'draft'
      fields.deleted_at = null
      return null
    },
  })
}

/** One batch item; a missing article is reported, never silently skipped. */
async function applyBatchCategoryItem(
  db: Database,
  item: BatchSetCategoryItem,
): Promise<BatchSetCategoryItemResult> {
  let article: ArticleRow | null = null
  try {
    article = await findArticleById(db, item.articleId)
  } catch {
    article = null
  }
  if (!article) {
    return { outcome: 'not-found', articleId: item.articleId, expectedVersion: item.expectedVersion }
  }
  return setCategory(db, {
    articleId: item.articleId,
    expectedVersion: item.expectedVersion,
    operationId: item.operationId,
    category: item.category,
  })
}

/**
 * Batch classification — every article keeps its own version precondition and
 * operation id; each item reports applied / replayed / conflict / not-found.
 * A conflicting article is NEVER silently overwritten and never blocks the
 * other items in the batch.
 */
export async function batchSetCategory(db: Database, input: BatchSetCategoryInput): Promise<BatchSetCategoryResult> {
  const items = Array.isArray(input.items) ? input.items : []
  const results = await Promise.all(items.map((item) => applyBatchCategoryItem(db, item)))
  return { items: results }
}

