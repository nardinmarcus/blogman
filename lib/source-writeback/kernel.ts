/**
 * B6-03 — 显式写回 Blogman 领先内容到主要源稿 command kernel (issue #52).
 *
 * Three commands own the confirmation-gated write-back of Blogman-leading
 * content back to the primary source:
 *
 *   - `initiateWriteBack` — the author EXPLICITLY begins a write-back ONLY when
 *     the source still equals the confirmed baseline AND Blogman is leading
 *     (article version > baseline). Records an intent bound once to article
 *     version + source identity + operation id. Idempotent by operation id.
 *   - `executeWriteBack`  — pushes the leading content to the source via the
 *     (always-mocked) `SourceWriteProvider`. A success moves the intent to
 *     `written` (awaiting EXTERNAL confirmation) but NEVER advances the
 *     baseline. A version change / source divergence is rejected as `stale`
 *     with no baseline move; a provider/device failure stays `intent` so the
 *     same operation can retry. A lost response is answered by re-reading the
 *     same operation id.
 *   - `confirmWriteBack`  — the EXTERNAL confirmation is the ONLY thing that
 *     advances the baseline. It re-validates the article version is unchanged
 *     (a newer edit marks the intent `stale`, Blogman stays leading) and then
 *     atomically upserts the baseline to the written version+source hash and
 *     marks the intent `confirmed`.
 *
 * Invariants (ticket acceptance):
 *   - 确认前不推进基线          — the baseline only moves in confirmWriteBack.
 *   - 失败或版本变化保持 Blogman 领先 — provider failure / version change move
 *     nothing; Blogman remains leading.
 *   - 设备不可用不阻止发布但不能称已同步 — a source outage never touches the
 *     article lifecycle and never advances the baseline, so publish still
 *     works but the article is never claimed "synced".
 *   - 拒绝 stale baseline/冲突，不自动覆盖 — a diverged source or changed
 *     version is refused; the kernel never overwrites blindly.
 *
 * `operation_id` UNIQUE on `source_write_back_intents` is the idempotency
 * backstop for concurrent/repeated initiates. All reads resolve outcomes by
 * re-reading rows (identical behaviour on production D1 and the CLI-backed
 * tests, matching the B2-03 kernel convention).
 */

import type { Database } from '@/lib/repositories/schema'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import type {
  ConfirmWriteBackInput,
  ConfirmWriteBackResult,
  ExecuteWriteBackInput,
  ExecuteWriteBackResult,
  InitiateWriteBackInput,
  InitiateWriteBackResult,
  SourceSyncBaseline,
  SourceWriteProvider,
  WriteBackIntent,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

interface BaselineRow {
  id: number
  source_identity_id: number
  article_id: number
  article_version: number
  source_sync_sha256: string
  created_at: number
  updated_at: number
}

function mapBaseline(row: BaselineRow): SourceSyncBaseline {
  return {
    id: row.id,
    sourceIdentityId: row.source_identity_id,
    articleId: row.article_id,
    articleVersion: row.article_version,
    sourceSyncSha256: row.source_sync_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function findBaseline(
  db: Database,
  sourceIdentityId: number,
  articleId: number,
): Promise<SourceSyncBaseline | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, article_id, article_version,
              source_sync_sha256, created_at, updated_at
       FROM source_sync_baselines
       WHERE source_identity_id = ? AND article_id = ?`,
    )
    .bind(sourceIdentityId, articleId)
    .first<BaselineRow>()
  return row ? mapBaseline(row) : null
}

interface IntentRow {
  id: number
  source_identity_id: number
  article_id: number
  article_version: number
  baseline_version: number
  operation_id: string
  status: string
  external_ref: string | null
  source_sync_sha256: string | null
  intent_at: number
  written_at: number | null
  confirmed_at: number | null
}

function mapIntent(row: IntentRow): WriteBackIntent {
  return {
    id: row.id,
    sourceIdentityId: row.source_identity_id,
    articleId: row.article_id,
    articleVersion: row.article_version,
    baselineVersion: row.baseline_version,
    operationId: row.operation_id,
    status: row.status as WriteBackIntent['status'],
    externalRef: row.external_ref,
    sourceSyncSha256: row.source_sync_sha256,
    intentAt: row.intent_at,
    writtenAt: row.written_at,
    confirmedAt: row.confirmed_at,
  }
}

async function findIntentByOperation(db: Database, operationId: string): Promise<WriteBackIntent | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, article_id, article_version, baseline_version,
              operation_id, status, external_ref, source_sync_sha256,
              intent_at, written_at, confirmed_at
       FROM source_write_back_intents WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<IntentRow>()
  return row ? mapIntent(row) : null
}

interface LatestVersionRow {
  version: number
  snapshot_json: string
}

async function findLatestVersion(db: Database, articleId: number): Promise<LatestVersionRow | null> {
  return db
    .prepare(
      `SELECT version, snapshot_json FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<LatestVersionRow>()
}

async function sourceCanonicalUrl(db: Database, sourceIdentityId: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT canonical_url FROM source_identities WHERE id = ?')
    .bind(sourceIdentityId)
    .first<{ canonical_url: string }>()
  return row?.canonical_url ?? null
}

async function liveLinkStatus(
  db: Database,
  sourceIdentityId: number,
  articleId: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT status FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<{ status: string }>()
  return row?.status ?? null
}

/** Latest article-version title + markdown body (the content to write back). */
function latestContent(
  row: LatestVersionRow,
): { version: number; title: string; body: string } {
  let parsed: ArticleIdentitySnapshot | null = null
  try {
    parsed = JSON.parse(row.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    parsed = null
  }
  const title = parsed?.fields?.title ?? ''
  const body = parsed?.original_content ?? ''
  return { version: row.version, title, body }
}

async function markStale(db: Database, operationId: string): Promise<WriteBackIntent | null> {
  await db
    .prepare(`UPDATE source_write_back_intents SET status = 'stale' WHERE operation_id = ?`)
    .bind(operationId)
    .run()
  return findIntentByOperation(db, operationId)
}

/* ------------------------------------------------------------------ */
/* initiateWriteBack — 作者明确发起写回 (仅当源稿==基线 且 Blogman 领先)  */
/* ------------------------------------------------------------------ */

export async function initiateWriteBack(
  db: Database,
  provider: SourceWriteProvider,
  input: InitiateWriteBackInput,
): Promise<InitiateWriteBackResult> {
  const { articleId, sourceIdentityId, operationId } = input
  if (!articleId || !sourceIdentityId || !operationId?.trim()) {
    throw new Error('initiateWriteBack: articleId, sourceIdentityId and operationId are required')
  }

  // Fast idempotent return: same operation id -> same intent.
  const existing = await findIntentByOperation(db, operationId)
  if (existing) return { outcome: 'replayed', intent: existing, existing: true }

  const baseline = await findBaseline(db, sourceIdentityId, articleId)
  if (!baseline) return { outcome: 'no-baseline' }

  const latest = await findLatestVersion(db, articleId)
  if (!latest) return { outcome: 'not-leading' }
  // Blogman 领先: the current article version is ahead of the confirmed baseline.
  if (latest.version <= baseline.articleVersion) return { outcome: 'not-leading' }

  // The write-back is an author action on an owned source — the source
  // association must be author-confirmed (not merely pending).
  const linkStatus = await liveLinkStatus(db, sourceIdentityId, articleId)
  if (linkStatus !== 'confirmed') return { outcome: 'link-not-confirmed' }

  // 源稿仍等于基线: the primary source currently holds the baseline content.
  const canonicalUrl = await sourceCanonicalUrl(db, sourceIdentityId)
  if (!canonicalUrl) return { outcome: 'invalid-source', sourceIdentityId }
  let sourceHash: string
  try {
    sourceHash = await provider.readSourceHash(canonicalUrl)
  } catch {
    // 设备不可用 → cannot confirm the source==baseline precondition; refuse.
    return { outcome: 'source-unavailable' }
  }
  if (sourceHash !== baseline.sourceSyncSha256) return { outcome: 'source-diverged' }

  const now = unixNow()
  try {
    await db
      .prepare(
        `INSERT INTO source_write_back_intents
           (source_identity_id, article_id, article_version, baseline_version,
            operation_id, status, intent_at)
         VALUES (?, ?, ?, ?, ?, 'intent', ?)`,
      )
      .bind(sourceIdentityId, articleId, latest.version, baseline.articleVersion, operationId, now)
      .run()
  } catch {
    // Concurrent identical initiate converged on the operation_id UNIQUE.
    const raced = await findIntentByOperation(db, operationId)
    if (raced) return { outcome: 'replayed', intent: raced, existing: true }
    throw new Error(`initiateWriteBack: unexpected insert failure for operation '${operationId}'`)
  }

  const intent = await findIntentByOperation(db, operationId)
  if (!intent) {
    throw new Error(`initiateWriteBack: intent for operation '${operationId}' not found after insert`)
  }
  return { outcome: 'intent', intent }
}

/* ------------------------------------------------------------------ */
/* executeWriteBack — 推送到外部源稿，等待外部确认 (不推进基线)            */
/* ------------------------------------------------------------------ */

export async function executeWriteBack(
  db: Database,
  provider: SourceWriteProvider,
  input: ExecuteWriteBackInput,
): Promise<ExecuteWriteBackResult> {
  const { operationId } = input
  if (!operationId?.trim()) throw new Error('executeWriteBack: operationId is required')

  const intent = await findIntentByOperation(db, operationId)
  if (!intent) return { outcome: 'not-found' }

  // Idempotent / lost-response replays and terminal outcomes:
  if (intent.status === 'written') return { outcome: 'written', intent }
  if (intent.status === 'confirmed') return { outcome: 'confirmed', intent }
  if (intent.status === 'stale') return { outcome: 'stale', intent }

  // 版本变化 → reject as stale, keep Blogman leading, never auto-overwrite.
  const latest = await findLatestVersion(db, intent.articleId)
  if (!latest || latest.version !== intent.articleVersion) {
    const staled = await markStale(db, operationId)
    return { outcome: 'stale', intent: staled! }
  }

  const canonicalUrl = await sourceCanonicalUrl(db, intent.sourceIdentityId)
  if (!canonicalUrl) return { outcome: 'not-found' }
  const baseline = await findBaseline(db, intent.sourceIdentityId, intent.articleId)
  if (!baseline) {
    const staled = await markStale(db, operationId)
    return { outcome: 'stale', intent: staled! }
  }

  // 源稿仍等于基线 re-checked at execution (it may have diverged since initiate).
  let sourceHash: string
  try {
    sourceHash = await provider.readSourceHash(canonicalUrl)
  } catch {
    // 设备不可用 → not syncable; intent stays 'intent' for a later retry.
    return { outcome: 'provider-error', intent }
  }
  if (sourceHash !== baseline.sourceSyncSha256) return { outcome: 'source-diverged', intent }

  const content = latestContent(latest)
  let push: { externalRef: string; sourceSyncSha256: string }
  try {
    push = await provider.pushWriteBack(canonicalUrl, {
      title: content.title,
      body: content.body,
    })
  } catch {
    // 设备不可用 → push never happened; baseline untouched, Blogman stays leading.
    return { outcome: 'provider-error', intent }
  }

  const now = unixNow()
  await db
    .prepare(
      `UPDATE source_write_back_intents
         SET status = 'written', written_at = ?, external_ref = ?, source_sync_sha256 = ?
       WHERE id = ? AND status = 'intent'`,
    )
    .bind(now, push.externalRef, push.sourceSyncSha256, intent.id)
    .run()

  const updated = await findIntentByOperation(db, operationId)
  if (!updated) throw new Error(`executeWriteBack: intent for operation '${operationId}' lost after update`)
  return { outcome: 'written', intent: updated }
}

/* ------------------------------------------------------------------ */
/* confirmWriteBack — 外部确认后才推进基线 (唯一推进点)                  */
/* ------------------------------------------------------------------ */

export async function confirmWriteBack(
  db: Database,
  input: ConfirmWriteBackInput,
): Promise<ConfirmWriteBackResult> {
  const { operationId } = input
  if (!operationId?.trim()) throw new Error('confirmWriteBack: operationId is required')

  const intent = await findIntentByOperation(db, operationId)
  if (!intent) return { outcome: 'not-found' }

  if (intent.status === 'confirmed') return { outcome: 'replayed', intent, existing: true }
  if (intent.status === 'stale') return { outcome: 'stale', intent }
  if (intent.status !== 'written') return { outcome: 'transition-refused', intent }
  if (!intent.sourceSyncSha256) return { outcome: 'transition-refused', intent }

  // 版本变化 → the written-back version is no longer current; reject and keep
  // Blogman leading (the newer edit is NOT silently claimed as synced).
  const latest = await findLatestVersion(db, intent.articleId)
  if (!latest || latest.version !== intent.articleVersion) {
    const staled = await markStale(db, operationId)
    return { outcome: 'stale', intent: staled! }
  }

  // External confirmation received: advance the baseline to the written
  // version + source hash, and mark the intent confirmed, atomically.
  const now = unixNow()
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO source_sync_baselines
             (source_identity_id, article_id, article_version, source_sync_sha256, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_identity_id, article_id) DO UPDATE SET
             article_version = excluded.article_version,
             source_sync_sha256 = excluded.source_sync_sha256,
             updated_at = excluded.updated_at`,
        )
        .bind(
          intent.sourceIdentityId,
          intent.articleId,
          intent.articleVersion,
          intent.sourceSyncSha256,
          now,
          now,
        ),
      db
        .prepare(
          `UPDATE source_write_back_intents
             SET status = 'confirmed', confirmed_at = ?
           WHERE id = ? AND status = 'written'`,
        )
        .bind(now, intent.id),
    ])
  } catch {
    const fresh = await findIntentByOperation(db, operationId)
    if (fresh?.status === 'confirmed') return { outcome: 'replayed', intent: fresh, existing: true }
    if (fresh?.status === 'stale') return { outcome: 'stale', intent: fresh }
    throw new Error(`confirmWriteBack: unexpected failure confirming operation '${operationId}'`)
  }

  const updated = await findIntentByOperation(db, operationId)
  if (!updated) throw new Error(`confirmWriteBack: intent for operation '${operationId}' lost after confirm`)
  if (updated.status !== 'confirmed') {
    // Guard's status='written' predicate no-op'd (e.g. raced) → report current state.
    return { outcome: 'stale', intent: updated }
  }
  return { outcome: 'confirmed', intent: updated }
}

/* ------------------------------------------------------------------ */
/* Baseline query surface                                              */
/* ------------------------------------------------------------------ */

/** Read the confirmed-sync baseline for a (source identity, article) pair. */
export async function baselineFor(
  db: Database,
  sourceIdentityId: number,
  articleId: number,
): Promise<SourceSyncBaseline | null> {
  return findBaseline(db, sourceIdentityId, articleId)
}

/** Read the current write-back intent by its operation id (响应丢失可 query 同一操作). */
export async function writeBackByOperation(db: Database, operationId: string): Promise<WriteBackIntent | null> {
  return findIntentByOperation(db, operationId)
}
