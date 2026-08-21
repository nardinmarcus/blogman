/**
 * B3-06 — version-bound publish suggestion command kernel (issue #38).
 *
 * The deterministic, author-controlled surface over a per-article analysis
 * result. The background AI records SUGGESTIONS bound to the exact version it
 * anchored to — it never writes a live fact here. The author previews,
 * applies, revokes or ignores each suggestion; only an explicit APPLY goes
 * through the shared article write kernel (`lib/article-commands` `save`, which
 * routes a formally-published article into its revision surface), and the first
 * apply of a result builds exactly ONE restore point (reused by later applies
 * in the same preparation).
 *
 * Staleness (none of these silently write, and a late result never overwrites a
 * newer version):
 *   - bound version != current version → `stale` (迟到的版本)
 *   - content basis hash != current body hash → `stale` (内容已变)
 *   - the target field has diverged from its analysis-time baseline → `stale`
 *     (字段变化使相关建议过期)
 *   - the suggestion sat unapplied past {@link SUGGESTION_TTL} → `stale`
 *     (超时)
 *
 * AI failures never block publishing and never change the publish blockers:
 * suggestion recording is best-effort in the background job, and suggestions
 * are never consulted by the promote kernel.
 */

import type { Database } from '@/lib/repositories/schema'
import { findLiveStateByPostRef, type CanonicalLiveState } from '@/lib/canonical-live'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'
import { save } from '@/lib/article-commands'
import { findActiveRevision, snapshotContentHash } from '@/lib/publish-revision'
import { buildInitialSnapshot, snapshotJson } from '@/lib/article-identity'
import { parsePostTags } from '@/lib/repositories/post-mappers'
import type {
  ApplySuggestionInput,
  ApplySuggestionResult,
  IgnoreSuggestionInput,
  IgnoreSuggestionResult,
  PreparationRow,
  PreparationRead,
  RecordPreparedSuggestionsInput,
  RecordPreparedSuggestionsResult,
  RevokeSuggestionInput,
  RevokeSuggestionResult,
  SuggestionField,
  SuggestionRead,
  SuggestionRow,
  SuggestionState,
} from './types'

/** A pending suggestion older than this many seconds can no longer be applied. */
export const SUGGESTION_TTL = 7 * 24 * 60 * 60

/** The deterministic metadata gap-fill fields the resolver produces (≤ 3). */
export const DEFAULT_SUGGESTION_FIELDS: SuggestionField[] = ['category', 'tags', 'description']

/** JSON value normalised for comparison / application. */
type FieldValue = string | string[] | null

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* low-level reads                                                     */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface PostRow extends CanonicalLiveState {
  id: number
  content: string | null
  html: string | null
}

async function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<ArticleRow>()
}

const POST_COLUMNS = `id, slug, title, content, html, description, category, tags, status,
  password, is_pinned, is_hidden, cover_image, deleted_at, published_at, updated_at`

async function findPostById(db: Database, postRef: number): Promise<PostRow | null> {
  const live = await findLiveStateByPostRef(db, postRef)
  if (!live) return null
  const bodies = await db
    .prepare(
      `SELECT json_extract(v.snapshot_json, '$.original_content') AS content, json_extract(v.snapshot_json, '$.original_html') AS html FROM articles a
       JOIN article_versions v ON v.article_id = a.id
        AND v.version = (SELECT MAX(version) FROM article_versions WHERE article_id = a.id)
       WHERE a.post_ref = ?`,
    )
    .bind(postRef)
    .first<{ content: string | null; html: string | null }>()
  return { id: postRef, ...live, content: bodies?.content ?? '', html: bodies?.html ?? '' }
}

async function latestVersion(db: Database, articleId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
    .bind(articleId)
    .first<{ version: number }>()
  return row?.version ?? 0
}

const PREPARATION_COLUMNS = `id, preparation_id, article_id, post_ref, bound_version,
  bound_revision, source, status, restore_point_id, created_at, applied_at, updated_at`

async function findPreparationBySource(db: Database, articleId: number, source: string): Promise<PreparationRow | null> {
  return db
    .prepare(`SELECT ${PREPARATION_COLUMNS} FROM publish_preparations WHERE article_id = ? AND source = ?`)
    .bind(articleId, source)
    .first<PreparationRow>()
}

async function findPreparationById(db: Database, preparationId: string): Promise<PreparationRow | null> {
  return db
    .prepare(`SELECT ${PREPARATION_COLUMNS} FROM publish_preparations WHERE preparation_id = ?`)
    .bind(preparationId)
    .first<PreparationRow>()
}

const SUGGESTION_COLUMNS = `id, suggestion_id, preparation_id, article_id, field, value,
  field_before, basis_sha256, bound_version, status, applied_operation_id, created_at,
  decided_at, updated_at`

async function findSuggestionById(db: Database, suggestionId: string): Promise<SuggestionRow | null> {
  return db
    .prepare(`SELECT ${SUGGESTION_COLUMNS} FROM publish_suggestions WHERE suggestion_id = ?`)
    .bind(suggestionId)
    .first<SuggestionRow>()
}

/* ------------------------------------------------------------------ */
/* field encoding / comparison                                         */
/* ------------------------------------------------------------------ */

function decodeField(field: SuggestionField, json: string | null): FieldValue {
  if (field === 'tags') {
    if (!json) return []
    try {
      const parsed = JSON.parse(json)
      return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
    } catch {
      return []
    }
  }
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

function readSnapshotField(field: SuggestionField, snapshot: ArticleCommandSnapshot): FieldValue {
  if (field === 'category') return snapshot.category ?? null
  if (field === 'tags') return snapshot.tags ?? []
  if (field === 'description') return snapshot.description ?? null
  if (field === 'title') return snapshot.title ?? null
  return snapshot.content ?? null
}

function fieldEqual(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? [...a] : []
    const right = Array.isArray(b) ? [...b] : []
    return left.length === right.length && left.every((v, i) => v === right[i])
  }
  return (a ?? null) === (b ?? null)
}

function applyField(field: SuggestionField, snapshot: ArticleCommandSnapshot, value: FieldValue): ArticleCommandSnapshot {
  if (field === 'category') return { ...snapshot, category: typeof value === 'string' ? value : null }
  if (field === 'tags') return { ...snapshot, tags: Array.isArray(value) ? (value.length > 0 ? value : null) : null }
  if (field === 'description') return { ...snapshot, description: typeof value === 'string' ? value : null }
  if (field === 'title') return { ...snapshot, title: typeof value === 'string' ? value : (snapshot.title ?? '') }
  return { ...snapshot, content: typeof value === 'string' ? value : (snapshot.content ?? '') }
}

/* ------------------------------------------------------------------ */
/* current snapshot resolution (active revision / draft version)       */
/* ------------------------------------------------------------------ */

interface CurrentState {
  version: number
  snapshot: ArticleCommandSnapshot
  contentHash: string
  activeRevision: { revisionId: string; revisionNumber: number } | null
}

function snapshotFromActiveRevision(rev: {
  slug: string
  title: string
  content: string
  html: string
  description: string | null
  category: string | null
  tags: string | null
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null
}): ArticleCommandSnapshot {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(rev.tags ?? '[]')
    tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    tags = []
  }
  return {
    slug: rev.slug,
    title: rev.title,
    content: rev.content,
    html: rev.html,
    description: rev.description,
    category: rev.category,
    tags: tags.length > 0 ? tags : null,
    status: 'published',
    password: rev.password,
    is_pinned: rev.is_pinned,
    is_hidden: rev.is_hidden,
    cover_image: rev.cover_image,
    deleted_at: null,
    published_at: null,
    updated_at: null,
  }
}

function snapshotFromVersionRow(version: number, snapshotJsonStr: string): ArticleCommandSnapshot | null {
  let record: {
    fields: {
      slug: string
      title: string
      description: string | null
      category: string | null
      tags: string | null
      status: string
      password: string | null
      is_pinned?: number | null
      is_hidden?: number | null
      cover_image: string | null
      deleted_at?: number | null
      published_at?: number | null
      updated_at?: number | null
    }
    original_content?: string | null
    original_html?: string | null
  }
  try {
    record = JSON.parse(snapshotJsonStr)
  } catch {
    return null
  }
  const fields = record.fields ?? ({} as typeof record.fields)
  const tags = fields.tags ? parsePostTags(fields.tags) : null
  return {
    slug: fields.slug ?? '',
    title: fields.title ?? '',
    content: record.original_content ?? '',
    html: record.original_html ?? '',
    description: fields.description ?? null,
    category: fields.category ?? null,
    tags: tags && tags.length > 0 ? tags : null,
    status: fields.status === 'published' ? 'published' : 'draft',
    password: fields.password ?? null,
    is_pinned: fields.is_pinned ?? 0,
    is_hidden: fields.is_hidden ?? 0,
    cover_image: fields.cover_image ?? null,
    deleted_at: fields.deleted_at ?? null,
    published_at: fields.published_at ?? null,
    updated_at: fields.updated_at ?? null,
  }
}

async function resolveCurrent(db: Database, articleId: number): Promise<CurrentState | null> {
  let active: Awaited<ReturnType<typeof findActiveRevision>> = null
  try {
    active = await findActiveRevision(db, articleId)
  } catch {
    active = null
  }
  if (active) {
    return {
      version: active.revision_number,
      snapshot: snapshotFromActiveRevision(active),
      contentHash: active.content_sha256,
      activeRevision: { revisionId: active.revision_id, revisionNumber: active.revision_number },
    }
  }
  const version = await latestVersion(db, articleId)
  if (version < 1) return null
  const row = await db
    .prepare(
      `SELECT version, snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = ? LIMIT 1`,
    )
    .bind(articleId, version)
    .first<{ version: number; snapshot_json: string; content_snapshot_sha256: string | null }>()
  if (!row) return null
  const snapshot = snapshotFromVersionRow(row.version, row.snapshot_json)
  if (!snapshot) return null
  return {
    version: row.version,
    snapshot,
    contentHash: row.content_snapshot_sha256 ?? snapshotContentHash(snapshot),
    activeRevision: null,
  }
}

/* ------------------------------------------------------------------ */
/* record — the background AI records suggestions (never writes posts) */
/* ------------------------------------------------------------------ */

function suggestionIdFor(articleId: number, field: SuggestionField, preparationId: string): string {
  return `suggest:${articleId}:${field}:${preparationId}`
}

/** Abandon an older pending result + its pending suggestions (keeps ≤ 3). */
async function supersedePending(db: Database, articleId: number, now: number): Promise<number> {
  // How many pending suggestions will be abandoned (≈ the old pending set size).
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM publish_suggestions
       WHERE article_id = ? AND status = 'pending'
         AND preparation_id IN (SELECT preparation_id FROM publish_preparations
                                WHERE article_id = ? AND status = 'recorded')`,
    )
    .bind(articleId, articleId)
    .first<{ n: number }>()
  // The old recorded preparation becomes abandoned; its pending suggestions too.
  await db
    .prepare(
      `UPDATE publish_preparations SET status = 'abandoned', updated_at = ?
       WHERE article_id = ? AND status = 'recorded'`,
    )
    .bind(now, articleId)
    .run()
  // Also abandon any stray pending suggestions in those older preparations.
  await db
    .prepare(
      `UPDATE publish_suggestions SET status = 'abandoned', updated_at = ?
       WHERE article_id = ? AND status = 'pending'
         AND preparation_id IN (SELECT preparation_id FROM publish_preparations WHERE status = 'abandoned')`,
    )
    .bind(now, articleId)
    .run()
  return pending?.n ?? 0
}

/**
 * Record the analysis result as version-bound suggestions. Never writes any
 * live post fact — the AI write path stops here. Idempotent by `source` (the
 * AI operation id): a queue retry replays instead of re-recording.
 */
export async function recordPreparedSuggestions(
  db: Database,
  input: RecordPreparedSuggestionsInput,
): Promise<RecordPreparedSuggestionsResult> {
  const { articleId, postRef, boundVersion, source, basisSha256, suggestions } = input
  const now = input.now ?? unixNow()
  if (!articleId || !postRef || boundVersion < 1 || !source || source.trim() === '') {
    return { outcome: 'invalid', reason: 'recordPreparedSuggestions: articleId/postRef/boundVersion/source are required' }
  }
  if (!/^[0-9a-f]{64}$/.test(basisSha256 ?? '')) {
    return { outcome: 'invalid', reason: 'recordPreparedSuggestions: basisSha256 must be a 64-char hash' }
  }
  if (suggestions.length === 0) {
    return { outcome: 'invalid', reason: 'recordPreparedSuggestions: no suggestions to record' }
  }

  const preparationId = source
  const existing = await findPreparationBySource(db, articleId, source)
  if (existing) {
    return { outcome: 'replayed', articleId, preparationId: existing.preparation_id }
  }

  // Cap the pending set: only this newest result may stay pending (≤ 3 items).
  const superseded = await supersedePending(db, articleId, now)

  try {
    await db
      .prepare(
        `INSERT INTO publish_preparations
           (preparation_id, article_id, post_ref, bound_version, bound_revision,
            source, status, restore_point_id, created_at, applied_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'recorded', NULL, ?, NULL, ?)`,
      )
      .bind(
        preparationId,
        articleId,
        postRef,
        boundVersion,
        input.boundRevision ?? null,
        source,
        now,
        now,
      )
      .run()

    for (const suggestion of suggestions.slice(0, 3)) {
      await db
        .prepare(
          `INSERT INTO publish_suggestions
             (suggestion_id, preparation_id, article_id, field, value, field_before,
              basis_sha256, bound_version, status, applied_operation_id, created_at, decided_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
           ON CONFLICT(suggestion_id) DO NOTHING`,
        )
        .bind(
          suggestionIdFor(articleId, suggestion.field, preparationId),
          preparationId,
          articleId,
          suggestion.field,
          suggestion.value,
          suggestion.fieldBefore,
          basisSha256,
          boundVersion,
          now,
          now,
        )
        .run()
    }
  } catch (error) {
    throw new Error(
      `recordPreparedSuggestions: insert failure for article ${articleId} source '${source}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    outcome: 'recorded',
    articleId,
    preparationId,
    boundVersion,
    suggestions: Math.min(suggestions.length, 3),
    superseded,
  }
}

/* ------------------------------------------------------------------ */
/* restore point (ONCE per preparation, reused for the rest)           */
/* ------------------------------------------------------------------ */

async function ensureSuggestionRestorePoint(
  db: Database,
  preparation: PreparationRow,
  articleId: number,
  postRef: number,
  now: number,
): Promise<string | null> {
  if (preparation.restore_point_id) return preparation.restore_point_id
  // Restore points are the pre-promotion FORMAL rollback material. A draft
  // (no formal publication) is fully rollback-able via its own version history
  // (article_versions), so no restore point is fabricated here.
  const formal = await db
    .prepare('SELECT version FROM formal_publications WHERE article_id = ?')
    .bind(articleId)
    .first<{ version: number }>()
  if (!formal || !formal.version || formal.version < 1) return null
  const live = await findPostById(db, postRef)
  if (!live) return null
  const id = `restore:suggest:${preparation.preparation_id}`
  const restoreSnapshot = snapshotJson(
    buildInitialSnapshot({
      id: live.id,
      slug: live.slug,
      title: live.title,
      content: live.content ?? '',
      html: live.html ?? '',
      description: live.description,
      category: live.category,
      tags: live.tags,
      status: live.status ?? 'draft',
      password: live.password,
      is_pinned: live.is_pinned,
      is_hidden: live.is_hidden,
      cover_image: live.cover_image,
      deleted_at: live.deleted_at,
      published_at: live.published_at,
      updated_at: live.updated_at,
    }),
  )
  const contentHash = snapshotContentHash({ content: live.content ?? '' })
  try {
    await db
      .prepare(
        `INSERT INTO publish_restore_points
           (restore_point_id, article_id, formal_version, promoted_version, snapshot_json,
            content_sha256, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'suggest-apply:', ?)
         ON CONFLICT(restore_point_id) DO NOTHING`,
      )
      .bind(id, articleId, formal.version, formal.version, restoreSnapshot, contentHash, now)
      .run()
  } catch (error) {
    throw new Error(
      `ensureSuggestionRestorePoint: insert failure article ${articleId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const row = await db
    .prepare('SELECT restore_point_id FROM publish_restore_points WHERE restore_point_id = ?')
    .bind(id)
    .first<{ restore_point_id: string }>()
  if (row) {
    await db
      .prepare(
        `UPDATE publish_preparations SET restore_point_id = ?, updated_at = ?
         WHERE preparation_id = ?`,
      )
      .bind(id, now, preparation.preparation_id)
      .run()
    return id
  }
  return null
}

/* ------------------------------------------------------------------ */
/* staleness                                                           */
/* ------------------------------------------------------------------ */

function stalenessReason(suggestion: SuggestionRow, current: CurrentState, now: number): string | null {
  // The body the analysis described must still be the live body. This is the
  // "迟到 / 版本移动" guard: once the content diverges from the basis the
  // suggestion was anchored to, it can never be silently applied.
  if (suggestion.basis_sha256 !== current.contentHash) return 'stale-content'
  // The target field must still be the gap the analysis saw (字段变化使相关
  // 建议过期) — an author who set their own value invalidates that suggestion.
  const before = decodeField(suggestion.field, suggestion.field_before)
  if (!fieldEqual(readSnapshotField(suggestion.field, current.snapshot), before)) return 'field-changed'
  // A suggestion left unapplied past its TTL expires (超时).
  if (now - suggestion.created_at > SUGGESTION_TTL) return 'expired'
  return null
}

async function markStale(db: Database, suggestion: SuggestionRow, now: number): Promise<void> {
  if (suggestion.status === 'pending') {
    await db
      .prepare(`UPDATE publish_suggestions SET status = 'stale', updated_at = ? WHERE suggestion_id = ?`)
      .bind(now, suggestion.suggestion_id)
      .run()
  }
}

/* ------------------------------------------------------------------ */
/* apply — author explicitly applies ONE suggestion via the write kernel */
/* ------------------------------------------------------------------ */

export async function applySuggestion(
  db: Database,
  input: ApplySuggestionInput,
): Promise<ApplySuggestionResult> {
  const { actor, operationId, now = unixNow() } = input
  const suggestionId = input.suggestionId.trim()
  if (!suggestionId) return { outcome: 'invalid', reason: 'applySuggestion: suggestionId is required' }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'applySuggestion: actor is required' }
  if (!operationId || operationId.trim() === '') return { outcome: 'invalid', reason: 'applySuggestion: operationId is required' }

  const suggestion = await findSuggestionById(db, suggestionId)
  if (!suggestion) return { outcome: 'not-found', reason: `suggestion '${suggestionId}' not found` }

  // Replay an already-applied / already-decided suggestion.
  if (suggestion.status === 'applied') {
    return { outcome: 'replayed', suggestionId, articleId: suggestion.article_id, version: suggestion.bound_version }
  }
  if (suggestion.status === 'ignored') {
    return { outcome: 'ignored', suggestionId, articleId: suggestion.article_id, reason: 'already-ignored' }
  }
  if (suggestion.status === 'revoked') {
    return { outcome: 'revoked', suggestionId, articleId: suggestion.article_id, reason: 'already-revoked' }
  }
  if (suggestion.status === 'abandoned') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: 'abandoned', operationId }
  }
  if (suggestion.status !== 'pending') {
    return { outcome: 'stale', suggestionId, articleId: suggestion.article_id, reason: `status='${suggestion.status}'` }
  }

  const article = await findArticleById(db, suggestion.article_id)
  if (!article) return { outcome: 'not-found', reason: `article ${suggestion.article_id} not found` }
  const current = await resolveCurrent(db, suggestion.article_id)
  if (!current) return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: 'no-current-state', operationId }

  const stale = stalenessReason(suggestion, current, now)
  if (stale) {
    await markStale(db, suggestion, now)
    return { outcome: 'stale', suggestionId, articleId: suggestion.article_id, reason: stale }
  }

  const preparation = await findPreparationById(db, suggestion.preparation_id)
  const restorePointId = preparation
    ? await ensureSuggestionRestorePoint(db, preparation, suggestion.article_id, article.post_ref, now)
    : null

  const value = decodeField(suggestion.field, suggestion.value)
  const appliedSnapshot = applyField(suggestion.field, current.snapshot, value)

  const result = await save(db, {
    articleId: suggestion.article_id,
    expectedVersion: current.version,
    operationId,
    snapshot: appliedSnapshot,
    projections: input.projections,
  })

  if (result.outcome === 'conflict') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: result.outcome, operationId }
  }
  if (result.outcome !== 'applied' && result.outcome !== 'replayed') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: result.outcome, operationId }
  }

  await db
    .prepare(
      `UPDATE publish_suggestions SET status = 'applied', applied_operation_id = ?, decided_at = ?, updated_at = ?
       WHERE suggestion_id = ? AND status = 'pending'`,
    )
    .bind(operationId, now, now, suggestion.suggestion_id)
    .run()

  // Reflect the new version on the preparation so later staleness compares
  // against the value actually produced by this apply.
  if (preparation) {
    await db
      .prepare(
        `UPDATE publish_preparations SET applied_at = COALESCE(applied_at, ?), updated_at = ?
         WHERE preparation_id = ?`,
      )
      .bind(now, now, preparation.preparation_id)
      .run()
  }

  return {
    outcome: 'applied',
    suggestionId,
    articleId: suggestion.article_id,
    preparationId: suggestion.preparation_id,
    field: suggestion.field,
    version: result.version,
    operationId,
    restorePointId,
    revisionId: current.activeRevision?.revisionId ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* revoke — the author undoes an APPLIED suggestion                    */
/* ------------------------------------------------------------------ */

export async function revokeSuggestion(
  db: Database,
  input: RevokeSuggestionInput,
): Promise<RevokeSuggestionResult> {
  const { actor, operationId, now = unixNow() } = input
  const suggestionId = input.suggestionId.trim()
  if (!suggestionId) return { outcome: 'invalid', reason: 'revokeSuggestion: suggestionId is required' }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'revokeSuggestion: actor is required' }
  if (!operationId || operationId.trim() === '') return { outcome: 'invalid', reason: 'revokeSuggestion: operationId is required' }

  const suggestion = await findSuggestionById(db, suggestionId)
  if (!suggestion) return { outcome: 'not-found', reason: `suggestion '${suggestionId}' not found` }
  if (suggestion.status === 'revoked') {
    return { outcome: 'replayed', suggestionId, articleId: suggestion.article_id }
  }
  if (suggestion.status !== 'applied') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: `cannot-revoke-status='${suggestion.status}'`, operationId }
  }

  const article = await findArticleById(db, suggestion.article_id)
  if (!article) return { outcome: 'not-found', reason: `article ${suggestion.article_id} not found` }
  const current = await resolveCurrent(db, suggestion.article_id)
  if (!current) return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: 'no-current-state', operationId }

  // Only revocable while the applied value is still in place — never clobber a
  // newer author edit in the same field.
  const appliedValue = decodeField(suggestion.field, suggestion.value)
  if (!fieldEqual(readSnapshotField(suggestion.field, current.snapshot), appliedValue)) {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: 'field-diverged-after-apply', operationId }
  }

  const revertSnapshot = applyField(suggestion.field, current.snapshot, decodeField(suggestion.field, suggestion.field_before))
  const result = await save(db, {
    articleId: suggestion.article_id,
    expectedVersion: current.version,
    operationId,
    snapshot: revertSnapshot,
    projections: input.projections,
  })
  if (result.outcome === 'conflict') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: result.outcome, operationId }
  }
  if (result.outcome !== 'applied' && result.outcome !== 'replayed') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: result.outcome, operationId }
  }

  await db
    .prepare(
      `UPDATE publish_suggestions SET status = 'revoked', decided_at = ?, updated_at = ?
       WHERE suggestion_id = ? AND status = 'applied'`,
    )
    .bind(now, now, suggestion.suggestion_id)
    .run()

  return {
    outcome: 'revoked',
    suggestionId,
    articleId: suggestion.article_id,
    field: suggestion.field,
    version: result.version,
    operationId,
  }
}

/* ------------------------------------------------------------------ */
/* ignore — the author dismisses a pending suggestion                  */
/* ------------------------------------------------------------------ */

export async function ignoreSuggestion(
  db: Database,
  input: IgnoreSuggestionInput,
): Promise<IgnoreSuggestionResult> {
  const { actor, now = unixNow() } = input
  const suggestionId = input.suggestionId.trim()
  if (!suggestionId) return { outcome: 'invalid', reason: 'ignoreSuggestion: suggestionId is required' }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'ignoreSuggestion: actor is required' }

  const suggestion = await findSuggestionById(db, suggestionId)
  if (!suggestion) return { outcome: 'not-found', reason: `suggestion '${suggestionId}' not found` }
  if (suggestion.status === 'ignored') return { outcome: 'replayed', suggestionId, articleId: suggestion.article_id }
  if (suggestion.status !== 'pending') {
    return { outcome: 'conflict', suggestionId, articleId: suggestion.article_id, reason: `cannot-ignore-status='${suggestion.status}'` }
  }

  await db
    .prepare(
      `UPDATE publish_suggestions SET status = 'ignored', decided_at = ?, updated_at = ?
       WHERE suggestion_id = ? AND status = 'pending'`,
    )
    .bind(now, now, suggestion.suggestion_id)
    .run()

  return { outcome: 'ignored', suggestionId, articleId: suggestion.article_id }
}

/* ------------------------------------------------------------------ */
/* read / preview — the author previews every suggestion per article   */
/* ------------------------------------------------------------------ */

function parseSuggestionValue(field: SuggestionField, json: string): string | string[] | null {
  return decodeField(field, json)
}

async function loadPreparations(db: Database, articleId: number): Promise<PreparationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PREPARATION_COLUMNS} FROM publish_preparations
       WHERE article_id = ? ORDER BY id DESC`,
    )
    .bind(articleId)
    .all<PreparationRow>()
  return results ?? []
}

async function loadSuggestionsForPreparations(db: Database, preparationIds: string[]): Promise<SuggestionRow[]> {
  if (preparationIds.length === 0) return []
  const placeholders = preparationIds.map(() => '?').join(',')
  const { results } = await db
    .prepare(
      `SELECT ${SUGGESTION_COLUMNS} FROM publish_suggestions
       WHERE preparation_id IN (${placeholders}) ORDER BY id ASC`,
    )
    .bind(...preparationIds)
    .all<SuggestionRow>()
  return results ?? []
}

/**
 * Read the per-article preview: the current preparation result + every
 * suggestion with its live status. Pending suggestions whose bound version /
 * content basis / field baseline no longer match the current state are reported
 * `stale` (without persisting — reality is re-verified at apply time).
 */
export async function readSuggestionState(db: Database, articleId: number): Promise<SuggestionState> {
  const article = await findArticleById(db, articleId)
  if (!article) return { articleId, postRef: 0, currentVersion: 0, activeRevision: null, preparations: [] }

  const current = await resolveCurrent(db, articleId)
  const now = unixNow()

  const rawPreps = await loadPreparations(db, articleId)
  const suggestsByPrep = groupSuggestionsById(
    await loadSuggestionsForPreparations(db, rawPreps.map((p) => p.preparation_id)),
  )

  const preparations: PreparationRead[] = rawPreps.map((prep) => {
    const suggestions: SuggestionRead[] = (suggestsByPrep.get(prep.preparation_id) ?? []).map((s) => {
      let status = s.status
      if (status === 'pending' && current) {
        const reason = stalenessReason(s, current, now)
        if (reason) status = 'stale'
      }
      return {
        suggestionId: s.suggestion_id,
        field: s.field,
        value: parseSuggestionValue(s.field, s.value),
        status,
        boundVersion: s.bound_version,
        basisSha256: s.basis_sha256,
        createdAt: s.created_at,
        decidedAt: s.decided_at,
      }
    })
    return {
      preparationId: prep.preparation_id,
      source: prep.source,
      boundVersion: prep.bound_version,
      status: prep.status,
      restorePointId: prep.restore_point_id,
      createdAt: prep.created_at,
      appliedAt: prep.applied_at,
      suggestions,
    }
  })

  return {
    articleId,
    postRef: article.post_ref,
    currentVersion: current?.version ?? 0,
    activeRevision: current?.activeRevision ?? null,
    preparations,
  }
}

function groupSuggestionsById(rows: SuggestionRow[]): Map<string, SuggestionRow[]> {
  const map = new Map<string, SuggestionRow[]>()
  for (const row of rows) {
    const list = map.get(row.preparation_id) ?? []
    list.push(row)
    map.set(row.preparation_id, list)
  }
  return map
}
