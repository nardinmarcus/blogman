/**
 * B5-01 — WeChat draft derivation kernel (issue #46).
 *
 * Public entry point: derive a WeChat public-account DRAFT from the EXACT
 * frozen formal version of a formally published article — never from
 * "latest". The derivation binds an article identity + exact version + ONE
 * account target, projects that version's frozen snapshot into the WeChat
 * body (HTML / plaintext / cover / digest), and writes ONE deterministic
 * task row (operation id). 不直接发布, 只建草稿:
 *
 *   - production passes no provider ⇒ the in-DB draft task is created and
 *     NOTHING external happens (零生产, 不真调微信 API),
 *   - a provider adapter (mock in tests, real API in a later batch) is only
 *     invoked when the task row is FRESHLY created, so re-deriving the same
 *     version for the same account never re-submits to the WeChat draft box,
 *   - deriving an OLDER version after a promotion supersedes the previous
 *     version's task (same 事件目标不重复登记) while the frozen row history
 *     stays intact,
 *   - the UNIQUE (article_id, version, account_id) key is the hard idempotency
 *     enforcer — a duplicate derivation lands in the SAME row and returns the
 *     same task id.
 *
 * B5-02 (issue #47) — provider failure / retry / result-unknown state machine.
 *
 * Every provider execution (the derivation hand-off, the executor's
 * submission, a reconcile query) records ONE immutable attempt row with a
 * SANITIZED classification. The task row carries the retry lifecycle in
 * additive columns (the B5-01 status CHECK keeps its four values):
 *
 *   - 'ok'            → remote draft accepted; `remote_draft_id` (the WeChat
 *                       media_id) is PERMANENTLY stored and never overwritten,
 *   - 'retryable'     → transient failure; re-armed with next_attempt_at under
 *                       a cap + exponential backoff via `runWechatDraftExecutor`
 *                       (retries share the task's stable id / operation id and
 *                       are lease-guarded — duplicates converge on one winner),
 *   - 'needs-author'  → permanent / configuration / unclassified rejection;
 *                       author todo (needs_author=1), never auto-retried,
 *   - 'unknown'       → response lost; the request MAY have landed. Blind
 *                       retry is FORBIDDEN — the task freezes as an author
 *                       todo until `reconcileWechatDraft` queries the remote
 *                       and resolves found / not-found / still-unknown.
 *
 * The executor is kill-switchable (`WECHAT_DRAFT_EXECUTOR_DISABLED`) and
 * never touches blog facts — a WeChat failure can never roll back a blog
 * result.
 */

import { createHash } from 'node:crypto'
import type { Database } from '@/lib/repositories/schema'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import { projectWechatDraft } from './projection'
import { normalizeWechatClassification, sanitizeWechatProviderError, WechatProviderError } from './provider'
import type {
  DeriveWechatDraftInput,
  DeriveWechatDraftResult,
  ReadWechatDraftTaskResult,
  WechatDraftAttemptClassification,
  WechatDraftAttemptRow,
  WechatDraftExecutorInput,
  WechatDraftExecutorResult,
  WechatDraftProjection,
  WechatDraftProvider,
  WechatDraftProviderResult,
  WechatDraftReconcileInput,
  WechatDraftReconcileResult,
  WechatDraftSubmitPayload,
  WechatDraftTaskRow,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** Normalise + validate an account target key. */
export function normalizeWechatAccountId(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 120) return null
  if (!ACCOUNT_ID_PATTERN.test(trimmed)) return null
  return trimmed
}

/** Deterministic operation id — repeating the derivation returns this task. */
export function wechatDraftTaskIdFor(articleId: number, version: number, accountId: string): string {
  return `wechat-draft:${articleId}:v${version}:${accountId}`
}

/** Canonical projection digest (tamper-evident body identity for the task row). */
export function projectionDigest(projection: WechatDraftProjection, contentSha256: string): string {
  const canonical = JSON.stringify({
    task: {
      title: projection.title,
      html: projection.html,
      plaintext: projection.plaintext,
      coverImageUrl: projection.coverImageUrl,
      digest: projection.digest,
      sourceUrl: projection.sourceUrl,
    },
    contentSha256,
  })
  return sha256Hex(canonical)
}

export function buildSubmitPayload(
  task: Pick<WechatDraftTaskRow, 'task_id' | 'article_id' | 'version' | 'account_id' | 'content_sha256'>,
  projection: WechatDraftProjection,
): WechatDraftSubmitPayload {
  return {
    taskId: task.task_id,
    articleId: task.article_id,
    version: task.version,
    accountId: task.account_id,
    contentSha256: task.content_sha256,
    title: projection.title,
    html: projection.html,
    plaintext: projection.plaintext,
    coverImageUrl: projection.coverImageUrl,
    digest: projection.digest,
    sourceUrl: projection.sourceUrl,
  }
}

/* ------------------------------------------------------------------ */
/* B5-02 — retry policy, lease, kill-switch, classification           */
/* ------------------------------------------------------------------ */

export const WECHAT_DRAFT_DEFAULT_MAX_ATTEMPTS = 5
export const WECHAT_DRAFT_DEFAULT_LEASE_SECONDS = 600
export const WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_SECONDS = 60
export const WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_FACTOR = 2
export const WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_MAX_SECONDS = 3600
export const WECHAT_DRAFT_EXECUTOR_DISABLED_ENV = 'WECHAT_DRAFT_EXECUTOR_DISABLED'
export const WECHAT_DRAFT_ERROR_LIMIT = 500

/**
 * Deterministic submission-attempt key — ONE execution, ONE immutable row.
 * The task's stable id + running attempt number make a repeated command
 * idempotent: re-claiming the same attempt writes the same key and can only
 * ever produce one immutable attempt row.
 */
export function wechatDraftAttemptKey(taskId: string, attemptNo: number): string {
  return `wechat-attempt:${taskId}:submit:${attemptNo}`
}

/** Deterministic reconcile-attempt key (separate namespace from submissions). */
export function wechatDraftReconcileKey(taskId: string, seq: number): string {
  return `wechat-attempt:${taskId}:reconcile:${seq}`
}

/**
 * Exponential backoff for retry attempt `attemptNo` (1-based): the first
 * retry waits `base` seconds, each subsequent retry multiplies by `factor`,
 * capped at `maxSeconds`. Mirrors the B4-03 scheduled-publish policy so the
 * two durable-delivery channels behave identically.
 */
export function wechatRetryBackoffSeconds(
  attemptNo: number,
  base: number = WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_SECONDS,
  factor: number = WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_FACTOR,
  maxSeconds: number = WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_MAX_SECONDS,
): number {
  if (attemptNo <= 1) return Math.min(Math.max(1, Math.round(base)), maxSeconds)
  const growth = base * Math.pow(factor, attemptNo - 1)
  return Math.min(Math.max(1, Math.round(growth)), maxSeconds)
}

/** Kill-switch: when set, the channel executor is OFF but tasks/attempts stay. */
export function isWechatDraftExecutorDisabled(): boolean {
  const value = process.env[WECHAT_DRAFT_EXECUTOR_DISABLED_ENV]
  return value != null && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

export type WechatExecutionVerdict =
  | { kind: 'accepted'; remoteDraftId: string | null }
  | { kind: 'rejected'; classification: Exclude<WechatDraftAttemptClassification, 'ok'>; error: string }

/**
 * Classify a provider execution into the retry state machine. Rules:
 *   - accepted → 'ok'-style accepted with the remote identity (media_id),
 *   - a rejection with an explicit classification → that classification,
 *   - a rejection WITHOUT a classification → 'needs-author' (an untyped
 *     rejection is author-actionable, never blindly retried),
 *   - a thrown `WechatProviderError` → its classification,
 *   - any other thrown error → 'retryable' (a transport-level exception is
 *     transient by default).
 */
export function classifyWechatExecution(result: WechatDraftProviderResult | Error): WechatExecutionVerdict {
  if (result instanceof Error) {
    const classification =
      result instanceof WechatProviderError ? normalizeWechatClassification(result.classification) : null
    return {
      kind: 'rejected',
      classification: classification ?? 'retryable',
      error: result.message,
    }
  }
  if (result.accepted) {
    return { kind: 'accepted', remoteDraftId: result.remoteDraftId ?? null }
  }
  return {
    kind: 'rejected',
    classification: normalizeWechatClassification(result.classification) ?? 'needs-author',
    error: result.error || 'provider rejected the draft',
  }
}

/* ------------------------------------------------------------------ */
/* reads                                                              */
/* ------------------------------------------------------------------ */

interface FormalPublicationRow {
  article_id: number
  version: number
  slug: string
  lifecycle: string
  public_url: string
}

interface VersionRow {
  article_id: number
  version: number
  snapshot_json: string
  content_snapshot_sha256: string
}

const TASK_COLUMNS = `id, task_id, article_id, post_ref, version, account_id, status,
  title, html_projection, plaintext_projection, cover_image_url, digest,
  content_sha256, projection_sha256, source_url, remote_draft_id, provider_error,
  created_at, updated_at, revision, attempt_count, classification, needs_author,
  next_attempt_at, last_error, claimed_at, lease_token, lease_expires_at`

async function findFormalPublication(db: Database, articleId: number): Promise<FormalPublicationRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, slug, lifecycle, public_url
       FROM formal_publications WHERE article_id = ?`,
    )
    .bind(articleId)
    .first<FormalPublicationRow>()
}

async function findVersionRow(db: Database, articleId: number, version: number): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, snapshot_json, content_snapshot_sha256
       FROM article_versions WHERE article_id = ? AND version = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(articleId, version)
    .first<VersionRow>()
}

async function findTaskRow(db: Database, taskId: string): Promise<WechatDraftTaskRow | null> {
  return db
    .prepare(`SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<WechatDraftTaskRow>()
}

export async function readWechatDraftTask(
  db: Database,
  articleId: number,
  version: number,
  accountId: string,
): Promise<ReadWechatDraftTaskResult> {
  const row = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks WHERE article_id = ? AND version = ? AND account_id = ?`)
    .bind(articleId, version, accountId)
    .first<WechatDraftTaskRow>()
  if (!row) return { task: null }
  return { task: row, projection: projectionFromRow(row) }
}

export async function listWechatDraftTasks(
  db: Database,
  articleId: number,
  accountId?: string,
): Promise<WechatDraftTaskRow[]> {
  const rows = accountId
    ? await db
        .prepare(`SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks WHERE article_id = ? AND account_id = ? ORDER BY version`)
        .bind(articleId, accountId)
        .all<WechatDraftTaskRow>()
    : await db
        .prepare(`SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks WHERE article_id = ? ORDER BY version`)
        .bind(articleId)
        .all<WechatDraftTaskRow>()
  return rows.results ?? []
}

/** Rebuild the projection shape from a stored task row (for read API parity). */
export function projectionFromRow(row: WechatDraftTaskRow): WechatDraftProjection {
  return {
    title: row.title,
    html: row.html_projection,
    plaintext: row.plaintext_projection,
    coverImageUrl: row.cover_image_url ?? '',
    digest: row.digest ?? '',
    sourceUrl: row.source_url,
  }
}

/** Immutable execution evidence for one task (newest first). */
export async function listWechatDraftAttempts(db: Database, taskId: string): Promise<WechatDraftAttemptRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM wechat_draft_attempts WHERE task_id = ? ORDER BY id DESC`,
    )
    .bind(taskId)
    .all<WechatDraftAttemptRow>()
  return rows.results ?? []
}

/* ------------------------------------------------------------------ */
/* derivation command                                                 */
/* ------------------------------------------------------------------ */

export async function deriveWechatDraft(
  db: Database,
  input: DeriveWechatDraftInput,
): Promise<DeriveWechatDraftResult> {
  const accountId = normalizeWechatAccountId(input.accountId ?? '')
  if (!Number.isInteger(input.articleId) || input.articleId <= 0) {
    return { outcome: 'invalid', reason: 'deriveWechatDraft: articleId is required' }
  }
  if (!Number.isInteger(input.version) || input.version <= 0) {
    return { outcome: 'invalid', reason: 'deriveWechatDraft: version is required' }
  }
  if (!accountId) {
    return { outcome: 'invalid', reason: 'deriveWechatDraft: accountId is required (letters/digits/-/_)' }
  }

  const formal = await findFormalPublication(db, input.articleId)
  if (!formal || formal.lifecycle !== 'published') {
    return {
      outcome: 'not-found',
      reason: 'article is not a formally published article',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }
  // The requested version must be a FROZEN version this formal article reached
  // (the current or an earlier published version) — never a future version.
  if (input.version > formal.version) {
    return {
      outcome: 'not-found',
      reason: 'version has not been formally published',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }

  const versionRow = await findVersionRow(db, input.articleId, input.version)
  if (!versionRow) {
    return {
      outcome: 'not-found',
      reason: 'version snapshot is missing from the article version stream',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }

  let snapshot: ArticleIdentitySnapshot
  try {
    snapshot = JSON.parse(versionRow.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    return {
      outcome: 'not-found',
      reason: 'version snapshot is not valid JSON',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.fields) {
    return {
      outcome: 'not-found',
      reason: 'version snapshot is malformed',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }

  const contentSha256 = snapshot.content_snapshot_sha256 ?? versionRow.content_snapshot_sha256 ?? ''
  const projection = projectWechatDraft(snapshot, {
    sourceUrl: formal.public_url,
    siteUrl: input.siteUrl,
  })
  const digest = projectionDigest(projection, contentSha256)
  const taskId = wechatDraftTaskIdFor(input.articleId, input.version, accountId)
  const now = input.now ?? unixNow()
  const maxAttempts = input.maxAttempts ?? WECHAT_DRAFT_DEFAULT_MAX_ATTEMPTS

  // One live target per account: a NEWER version may replace an older one, but
  // an older version can never be re-derivable as a second live draft once a
  // newer version is already live — the current live target is the newer one.
  // B5-02: a newer task that is still failing / unknown / re-arming is just as
  // live as a submitted one (its frozen facts are preserved and being converged).
  const newerLive = await db
    .prepare(
      `SELECT 1 FROM wechat_draft_tasks
       WHERE article_id = ? AND account_id = ? AND version > ? AND status IN ('draft', 'submitted', 'failed')
       LIMIT 1`,
    )
    .bind(input.articleId, accountId, input.version)
    .first()
  if (newerLive) {
    return {
      outcome: 'not-found',
      reason: 'a newer version is already derived and live for this account',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }

  // D1 mirrors SQLite `changes()`: an `ON CONFLICT DO NOTHING` skip reports 0,
  // a real insert reports 1 — the truthful created flag that gates the
  // provider hand-off below (a duplicate derivation must never re-submit).
  const insert = (await db
    .prepare(
      `INSERT INTO wechat_draft_tasks
         (task_id, article_id, post_ref, version, account_id, status,
          title, html_projection, plaintext_projection, cover_image_url, digest,
          content_sha256, projection_sha256, source_url, created_at, updated_at)
       VALUES (?, ?, (SELECT COALESCE((SELECT post_ref FROM articles WHERE id = ?), 0)), ?, ?, 'draft',
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(article_id, version, account_id) DO NOTHING`,
    )
    .bind(
      taskId,
      input.articleId,
      input.articleId,
      input.version,
      accountId,
      projection.title,
      projection.html,
      projection.plaintext,
      projection.coverImageUrl || null,
      projection.digest,
      contentSha256,
      digest,
      projection.sourceUrl,
      now,
      now,
    )
    .run()) as { meta: { last_row_id: number; changes?: number } }

  const created = (insert.meta?.changes ?? 0) > 0

  if (created) {
    // An older derived task for the same (article, account) is superseded —
    // one live target per account, history retained.
    await db
      .prepare(
        `UPDATE wechat_draft_tasks SET status = 'superseded', updated_at = ?
         WHERE article_id = ? AND account_id = ? AND version < ? AND status != 'superseded'`,
      )
      .bind(now, input.articleId, accountId, input.version)
      .run()
  }

  const current = await findTaskRow(db, taskId)
  if (!current) {
    return {
      outcome: 'not-found',
      reason: 'task row vanished after insert',
      articleId: input.articleId,
      version: input.version,
      accountId,
    }
  }

  // Provider invocation happens ONLY on a fresh derivation — an existing row
  // (idempotent replay) is never re-submitted to the WeChat draft box. The
  // hand-off is B5-02-classified: it records the first immutable attempt row
  // and arms the retry lifecycle (retryable → rearmed, needs-author/unknown →
  // author todo / reconcile) exactly like the executor would.
  if (created && input.provider) {
    const payload = buildSubmitPayload(current, projection)
    let verdict: WechatExecutionVerdict
    try {
      verdict = classifyWechatExecution(await input.provider.createDraft(payload))
    } catch (error) {
      verdict = classifyWechatExecution(error instanceof Error ? error : new Error(String(error)))
    }

    if (verdict.kind === 'accepted') {
      await db.batch([
        insertAttemptRow(
          db,
          taskId,
          1,
          'ok',
          'submitted',
          now,
          now,
          verdict.remoteDraftId,
          null,
        ),
        db
          .prepare(
            `UPDATE wechat_draft_tasks
             SET status = 'submitted', remote_draft_id = ?, provider_error = NULL,
                 classification = 'ok', needs_author = 0, next_attempt_at = NULL,
                 last_error = NULL, attempt_count = attempt_count + 1, revision = revision + 1,
                 updated_at = ?
             WHERE task_id = ?`,
          )
          .bind(verdict.remoteDraftId, now, taskId),
      ])
      const task = (await findTaskRow(db, taskId)) ?? { ...current }
      return {
        outcome: 'submitted',
        articleId: input.articleId,
        version: input.version,
        accountId,
        taskId,
        task,
        created: true,
        projection,
        classification: 'ok',
      }
    }

    await recordFailedHandoff(db, taskId, { verdict, now, attemptNo: 1, maxAttempts })
    const task = (await findTaskRow(db, taskId)) ?? { ...current }
    return {
      outcome: verdict.classification === 'unknown' ? 'unknown' : 'failed',
      articleId: input.articleId,
      version: input.version,
      accountId,
      taskId,
      task,
      created: true,
      projection,
      classification: verdict.classification,
    }
  }

  return {
    outcome: created ? 'created' : 'existing',
    articleId: input.articleId,
    version: input.version,
    accountId,
    taskId,
    task: { ...current },
    created,
    projection,
  }
}

/* ------------------------------------------------------------------ */
/* B5-02 — immutable attempt helpers                                  */
/* ------------------------------------------------------------------ */

/**
 * Insert one immutable attempt row in its final state. `attempt_key` is
 * deterministic, so a repeated command (duplicate derivation, duplicate
 * executor claim, duplicate reconcile) lands on the SAME row and the
 * `ON CONFLICT DO NOTHING` makes the replay a no-op — one execution, one
 * durable fact, no duplicates.
 */
function insertAttemptRow(
  db: Database,
  taskId: string,
  attemptNo: number,
  classification: WechatDraftAttemptClassification,
  outcome: WechatDraftAttemptRow['outcome'],
  startedAt: number,
  finishedAt: number,
  remoteDraftId: string | null,
  error: string | null,
  attemptKey = wechatDraftAttemptKey(taskId, attemptNo),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO wechat_draft_attempts
         (attempt_key, task_id, attempt_no, classification, outcome,
          started_at, finished_at, remote_draft_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(attempt_key) DO NOTHING`,
    )
    .bind(
      attemptKey,
      taskId,
      attemptNo,
      classification,
      outcome,
      startedAt,
      finishedAt,
      remoteDraftId,
      error === null ? null : sanitizeWechatProviderError(error),
      startedAt,
      finishedAt,
    )
}

/** Finalize the running attempt row of THIS execution with its true verdict. */
function finalizeRunningAttempt(
  db: Database,
  attemptKey: string,
  classification: WechatDraftAttemptClassification,
  outcome: WechatDraftAttemptRow['outcome'],
  remoteDraftId: string | null,
  error: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE wechat_draft_attempts
       SET finished_at = ?, classification = ?, outcome = ?, remote_draft_id = ?,
           error = ?, updated_at = ?
       WHERE attempt_key = ? AND finished_at IS NULL`,
    )
    .bind(
      now,
      classification,
      outcome,
      remoteDraftId,
      error === null ? null : sanitizeWechatProviderError(error),
      now,
      attemptKey,
    )
}

/** Finalize (or insert-and-finalize) a failed hand-off with classification. */
function transitionFailedTask(
  db: Database,
  taskId: string,
  opts: {
    classification: Exclude<WechatDraftAttemptClassification, 'ok'>
    lastError: string
    needsAuthor: boolean
    nextAttemptAt: number | null
    now: number
  },
) {
  return db
    .prepare(
      `UPDATE wechat_draft_tasks
       SET status = 'failed',
           classification = ?,
           needs_author = ?,
           last_error = ?,
           provider_error = ?,
           next_attempt_at = ?,
           claimed_at = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           revision = revision + 1,
           updated_at = ?
       WHERE task_id = ?`,
    )
    .bind(
      opts.classification,
      opts.needsAuthor ? 1 : 0,
      sanitizeWechatProviderError(opts.lastError, WECHAT_DRAFT_ERROR_LIMIT),
      sanitizeWechatProviderError(opts.lastError),
      opts.nextAttemptAt,
      opts.now,
      taskId,
    )
}

/**
 * Apply a rejected verdict (retryable / needs-author / unknown) to a task and
 * write its immutable attempt row. Used by BOTH the derivation hand-off (no
 * running row → the attempt is inserted already-finalized) and the executor
 * (the claim-time running row is finalized in place) so the two surfaces share
 * one state machine.
 * Returns the fresh task row + the classified outcome for the caller.
 */
async function recordFailedHandoff(
  db: Database,
  taskId: string,
  opts: {
    verdict: Extract<WechatExecutionVerdict, { kind: 'rejected' }>
    now: number
    attemptNo: number
    maxAttempts: number
    /** When set, THIS running row is finalized instead of inserting a new one. */
    runningAttemptKey?: string
    backoffSeconds?: number
    backoffFactor?: number
    backoffMaxSeconds?: number
  },
): Promise<{ task: WechatDraftTaskRow; outcome: 'retried' | 'failed' | 'needs-author' | 'unknown' }> {
  const { verdict, now, attemptNo, maxAttempts } = opts
  const backoffSeconds = opts.backoffSeconds ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_SECONDS
  const backoffFactor = opts.backoffFactor ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_FACTOR
  const backoffMax = opts.backoffMaxSeconds ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_MAX_SECONDS

  const attemptStmt = opts.runningAttemptKey
    ? finalizeRunningAttempt(
        db,
        opts.runningAttemptKey,
        'unknown',
        'unknown',
        null,
        verdict.error,
        now,
      )
    : insertAttemptRow(db, taskId, attemptNo, 'unknown', 'unknown', now, now, null, verdict.error)

  if (verdict.classification === 'unknown') {
    await db.batch([
      attemptStmt,
      transitionFailedTask(db, taskId, {
        classification: 'unknown',
        lastError: verdict.error,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
    ])
    return { task: (await findTaskRow(db, taskId))!, outcome: 'unknown' }
  }

  if (verdict.classification === 'needs-author') {
    await db.batch([
      opts.runningAttemptKey
        ? finalizeRunningAttempt(db, opts.runningAttemptKey, 'needs-author', 'failed', null, verdict.error, now)
        : insertAttemptRow(db, taskId, attemptNo, 'needs-author', 'failed', now, now, null, verdict.error),
      transitionFailedTask(db, taskId, {
        classification: 'needs-author',
        lastError: verdict.error,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
    ])
    return { task: (await findTaskRow(db, taskId))!, outcome: 'needs-author' }
  }

  // retryable: re-arm below the cap, stop (→ author todo) at the cap.
  if (attemptNo >= maxAttempts) {
    await db.batch([
      opts.runningAttemptKey
        ? finalizeRunningAttempt(db, opts.runningAttemptKey, 'retryable', 'failed', null, verdict.error, now)
        : insertAttemptRow(db, taskId, attemptNo, 'retryable', 'failed', now, now, null, verdict.error),
      transitionFailedTask(db, taskId, {
        classification: 'needs-author',
        lastError: `retries-exhausted: ${verdict.error}`,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
    ])
    return { task: (await findTaskRow(db, taskId))!, outcome: 'failed' }
  }

  const nextAttemptAt = now + wechatRetryBackoffSeconds(attemptNo, backoffSeconds, backoffFactor, backoffMax)
  await db.batch([
    opts.runningAttemptKey
      ? finalizeRunningAttempt(db, opts.runningAttemptKey, 'retryable', 'retried', null, verdict.error, now)
      : insertAttemptRow(db, taskId, attemptNo, 'retryable', 'retried', now, now, null, verdict.error),
    transitionFailedTask(db, taskId, {
      classification: 'retryable',
      lastError: verdict.error,
      needsAuthor: false,
      nextAttemptAt,
      now,
    }),
  ])
  return { task: (await findTaskRow(db, taskId))!, outcome: 'retried' }
}

/* ------------------------------------------------------------------ */
/* B5-02 — runWechatDraftExecutor (channel executor/retry loop)       */
/* ------------------------------------------------------------------ */

/**
 * The channel executor: claims every due draft task (a fresh zero-production
 * `draft` row, or a `failed` row re-armed 'retryable'), submits it through the
 * injected provider under a per-claim lease, and records one immutable,
 * classified attempt row per execution. Contracts:
 *
 *   - kill-switch (`WECHAT_DRAFT_EXECUTOR_DISABLED`) or no provider → returns
 *     `disabled` WITHOUT touching any task or attempt (可关闭渠道执行器,
 *     保留任务、尝试和远端身份),
 *   - the D1 conditional claim (lease + next_attempt_at + needs_author guard)
 *     makes overlapping executor runs converge on exactly ONE submission per
 *     task — duplicates can never create a second remote draft,
 *   - a claimed-but-crashed run is reclaimed after lease expiry; its orphaned
 *     attempt is finalized 'abandoned' before the new attempt is recorded,
 *   - the retry policy is cap + exponential backoff: transient failures re-arm
 *     via next_attempt_at; exhausting the cap (or a needs-author / unknown
 *     verdict) freezes the task as an author todo and NEVER auto-retries,
 *   - the executor writes ONLY `wechat_draft_tasks` + `wechat_draft_attempts`
 *     — a WeChat failure can never roll back a blog result.
 */
export async function runWechatDraftExecutor(
  db: Database,
  input: WechatDraftExecutorInput = {},
): Promise<WechatDraftExecutorResult> {
  const result: WechatDraftExecutorResult = {
    disabled: false,
    scanned: 0,
    claimed: 0,
    submitted: 0,
    retried: 0,
    failed: 0,
    needsAuthor: 0,
    unknown: 0,
  }
  if (isWechatDraftExecutorDisabled()) {
    result.disabled = true
    return result
  }
  const { provider } = input
  if (!provider) {
    // Zero production: no adapter bound ⇒ the executor stays inert. Tasks,
    // attempts and remote identities are untouched (只建草稿, 不发布).
    result.disabled = true
    return result
  }

  const now = input.now ?? unixNow()
  const limit = input.limit ?? 20
  const leaseSeconds = input.leaseSeconds ?? WECHAT_DRAFT_DEFAULT_LEASE_SECONDS
  const maxAttempts = input.maxAttempts ?? WECHAT_DRAFT_DEFAULT_MAX_ATTEMPTS
  const backoffSeconds = input.retryBackoffSeconds ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_SECONDS
  const backoffFactor = input.retryBackoffFactor ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_FACTOR
  const backoffMax = input.retryBackoffMaxSeconds ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_MAX_SECONDS

  const { results: candidates } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks
       WHERE needs_author = 0
         AND status IN ('draft', 'failed')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND ((status = 'draft' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'failed' AND classification = 'retryable' AND next_attempt_at <= ?))
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(now, now, now, limit)
    .all<WechatDraftTaskRow>()

  result.scanned = candidates?.length ?? 0

  for (const row of candidates ?? []) {
    const claimed = await claimWechatTask(db, row, { now, leaseSeconds, maxAttempts })
    if (!claimed) continue // another runner already owns or advanced this row

    result.claimed += 1
    // A reclaimed crashed execution leaves its attempt running — finalize it
    // accordingly (immutable row, never deleted) before the new one.
    await abandonOrphanedWechatAttempts(db, row.task_id, now)

    await db
      .prepare(
        `INSERT INTO wechat_draft_attempts
           (attempt_key, task_id, attempt_no, classification, outcome,
            started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'retryable', 'retried', ?, ?, ?)
         ON CONFLICT(attempt_key) DO NOTHING`,
      )
      .bind(
        wechatDraftAttemptKey(row.task_id, claimed.attempt_count),
        row.task_id,
        claimed.attempt_count,
        now,
        now,
        now,
      )
      .run()

    const outcome = await executeWechatSubmission(db, claimed, {
      provider,
      now,
      maxAttempts,
      backoffSeconds,
      backoffFactor,
      backoffMax,
    })

    if (outcome === 'submitted') result.submitted += 1
    else if (outcome === 'retried') result.retried += 1
    else if (outcome === 'failed') result.failed += 1
    else if (outcome === 'needs-author') result.needsAuthor += 1
    else if (outcome === 'unknown') result.unknown += 1
  }

  return result
}

/**
 * Atomically claim a due task for THIS runner. Returns the claimed row
 * (attempt_count already incremented, lease held) only when the runner truly
 * owns the lease; otherwise null (a concurrent runner won or advanced it).
 */
async function claimWechatTask(
  db: Database,
  row: WechatDraftTaskRow,
  opts: { now: number; leaseSeconds: number; maxAttempts: number },
): Promise<WechatDraftTaskRow | null> {
  const { now, leaseSeconds } = opts
  const token = crypto.randomUUID()
  await db
    .prepare(
      `UPDATE wechat_draft_tasks
       SET claimed_at = ?, lease_expires_at = ?, lease_token = ?,
           attempt_count = attempt_count + 1, revision = revision + 1, updated_at = ?
       WHERE task_id = ?
         AND needs_author = 0
         AND status IN ('draft', 'failed')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND ((status = 'draft' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'failed' AND classification = 'retryable' AND next_attempt_at <= ?))`,
    )
    .bind(now, now + leaseSeconds, token, now, row.task_id, now, now, now)
    .run()
  const after = await findTaskRow(db, row.task_id)
  if (!after || after.lease_token !== token) return null // our conditional UPDATE matched nothing
  return after
}

/** A reclaimed crashed run leaves its attempt running — finalize it abandoned. */
async function abandonOrphanedWechatAttempts(db: Database, taskId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE wechat_draft_attempts
       SET finished_at = ?, outcome = 'abandoned', error = ?, updated_at = ?, classification = 'retryable'
       WHERE task_id = ? AND finished_at IS NULL`,
    )
    .bind(now, 'abandoned: lease expired before the run completed (crash?)', now, taskId)
    .run()
}

/**
 * Submit one claimed task through the provider and converge the task row +
 * immutable attempt fact in ONE batch. Returns the classified outcome.
 */
async function executeWechatSubmission(
  db: Database,
  row: WechatDraftTaskRow,
  opts: {
    provider: WechatDraftProvider
    now: number
    maxAttempts: number
    backoffSeconds: number
    backoffFactor: number
    backoffMax: number
  },
): Promise<'submitted' | 'retried' | 'failed' | 'needs-author' | 'unknown'> {
  const { provider, now, maxAttempts, backoffSeconds, backoffFactor, backoffMax } = opts
  const taskId = row.task_id
  const attemptNo = row.attempt_count
  const projection = projectionFromRow(row)
  const payload = buildSubmitPayload(row, projection)

  let verdict: WechatExecutionVerdict
  try {
    verdict = classifyWechatExecution(await provider.createDraft(payload))
  } catch (error) {
    verdict = classifyWechatExecution(error instanceof Error ? error : new Error(String(error)))
  }

  if (verdict.kind === 'accepted') {
    await db.batch([
      finalizeRunningAttempt(
        db,
        wechatDraftAttemptKey(taskId, attemptNo),
        'ok',
        'submitted',
        verdict.remoteDraftId,
        null,
        now,
      ),
      db
        .prepare(
          `UPDATE wechat_draft_tasks
           SET status = 'submitted',
               remote_draft_id = COALESCE(remote_draft_id, ?),
               provider_error = NULL,
               classification = 'ok',
               needs_author = 0,
               next_attempt_at = NULL,
               last_error = NULL,
               claimed_at = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               revision = revision + 1,
               updated_at = ?
           WHERE task_id = ?`,
        )
        .bind(verdict.remoteDraftId, now, taskId),
    ])
    return 'submitted'
  }

  const { outcome } = await recordFailedHandoff(db, taskId, {
    verdict,
    now,
    attemptNo,
    maxAttempts,
    runningAttemptKey: wechatDraftAttemptKey(taskId, attemptNo),
    backoffSeconds,
    backoffFactor,
    backoffMaxSeconds: backoffMax,
  })
  return outcome
}

/* ------------------------------------------------------------------ */
/* B5-02 — reconcileWechatDraft (query first, then act)               */
/* ------------------------------------------------------------------ */

/**
 * Resolve a result-unknown task by QUERYING the remote BEFORE any further
 * submission — a possibly-non-idempotent call is never blindly retried
 * (非幂等不确定结果停止自动重试). Outcomes:
 *
 *   - found:true   → the earlier submission DID land; the task is recorded
 *                    'submitted' and the remote identity (media_id) is saved —
 *                    an existing media_id is NEVER overwritten (不丢失覆盖),
 *   - found:false  → the draft was provably NEVER created; the task is
 *                    re-armed as a fresh 'draft' so the executor may safely
 *                    re-submit exactly once under the retry policy,
 *   - unknown:true / thrown query → the query itself lost its response; the
 *                    task STAYS frozen as an author todo (no blind conclusion).
 *
 * Reconcile is idempotent: once the task leaves the unknown state, a repeated
 * reconcile is a `replayed` no-op that writes nothing; concurrent reconciles
 * share one deterministic attempt key (`ON CONFLICT DO NOTHING`).
 */
export async function reconcileWechatDraft(
  db: Database,
  input: WechatDraftReconcileInput,
): Promise<WechatDraftReconcileResult> {
  const { taskId, now = unixNow() } = input
  if (!taskId || taskId.trim() === '') return { outcome: 'invalid', reason: 'taskId is required' }

  const task = await findTaskRow(db, taskId)
  if (!task) return { outcome: 'not-found', taskId }

  // Already delivered — a late result of a previously accepted call (or a
  // reconcile that already resolved): nothing to do, nothing overwritten.
  if (task.status === 'submitted') {
    return { outcome: 'replayed', taskId, task: { ...task } }
  }
  // Only result-unknown tasks are reconcilable; anything else is a replay.
  if (task.status !== 'failed' || task.classification !== 'unknown' || task.needs_author !== 1) {
    return { outcome: 'not-unknown', taskId, task: { ...task } }
  }

  const provider = input.provider
  if (!provider) {
    return { outcome: 'no-provider', taskId, task: { ...task } }
  }

  // Deterministic reconcile sequence id: the max existing attempt_no + 1.
  const { results: countRows } = await db
    .prepare(`SELECT COALESCE(MAX(attempt_no), 0) AS n FROM wechat_draft_attempts WHERE task_id = ?`)
    .bind(taskId)
    .all<{ n: number }>()
  const seq = (countRows?.[0]?.n ?? 0) + 1
  const attemptKey = wechatDraftReconcileKey(taskId, seq)

  await db
    .prepare(
      `INSERT INTO wechat_draft_attempts
         (attempt_key, task_id, attempt_no, classification, outcome,
          started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'unknown', 'unknown', ?, ?, ?)
       ON CONFLICT(attempt_key) DO NOTHING`,
    )
    .bind(attemptKey, taskId, seq, now, now, now)
    .run()

  let query
  try {
    query = await provider.queryDraft({
      taskId: task.task_id,
      articleId: task.article_id,
      version: task.version,
      accountId: task.account_id,
      sourceUrl: task.source_url,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.batch([
      finalizeReconcileAttempt(db, attemptKey, 'unknown', 'unknown', null, message, now),
      transitionFailedTask(db, taskId, {
        classification: 'unknown',
        lastError: `reconcile-query-lost: ${message}`,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
    ])
    return { outcome: 'unknown-still', taskId, reason: message, task: (await findTaskRow(db, taskId))! }
  }

  if (query.unknown) {
    const message = query.error ?? 'reconcile query result unknown'
    await db.batch([
      finalizeReconcileAttempt(db, attemptKey, 'unknown', 'unknown', null, message, now),
      transitionFailedTask(db, taskId, {
        classification: 'unknown',
        lastError: `reconcile-query-lost: ${message}`,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
    ])
    return { outcome: 'unknown-still', taskId, reason: message, task: (await findTaskRow(db, taskId))! }
  }

  if (query.found) {
    const remoteId = query.remoteDraftId ?? null
    await db.batch([
      finalizeReconcileAttempt(db, attemptKey, 'ok', 'reconciled', remoteId, null, now),
      db
        .prepare(
          `UPDATE wechat_draft_tasks
           SET status = 'submitted',
               remote_draft_id = COALESCE(remote_draft_id, ?),
               provider_error = NULL,
               classification = 'ok',
               needs_author = 0,
               next_attempt_at = NULL,
               last_error = NULL,
               claimed_at = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               revision = revision + 1,
               updated_at = ?
           WHERE task_id = ? AND status = 'failed'`,
        )
        .bind(remoteId, now, taskId),
    ])
    const taskAfter = (await findTaskRow(db, taskId))!
    return {
      outcome: 'reconciled',
      found: true,
      taskId,
      remoteDraftId: remoteId ?? taskAfter.remote_draft_id,
      task: taskAfter,
    }
  }

  // Found:false — provably never created. Re-arm as a fresh zero-production
  // draft so the executor can re-submit once under the retry policy. No
  // second task row is ever created (the UNIQUE key already prevents it).
  await db.batch([
    finalizeReconcileAttempt(db, attemptKey, 'retryable', 'reconciled', null, 'confirmed-not-created', now),
    db
      .prepare(
        `UPDATE wechat_draft_tasks
         SET status = 'draft',
             classification = NULL,
             needs_author = 0,
             next_attempt_at = NULL,
             last_error = NULL,
             provider_error = NULL,
             claimed_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             revision = revision + 1,
             updated_at = ?
         WHERE task_id = ? AND status = 'failed'`,
      )
      .bind(now, taskId),
  ])
  return {
    outcome: 'reconciled',
    found: false,
    taskId,
    remoteDraftId: null,
    task: (await findTaskRow(db, taskId))!,
  }
}

function finalizeReconcileAttempt(
  db: Database,
  attemptKey: string,
  classification: WechatDraftAttemptClassification,
  outcome: WechatDraftAttemptRow['outcome'],
  remoteDraftId: string | null,
  error: string | null,
  now: number,
) {
  return db
    .prepare(
      `UPDATE wechat_draft_attempts
       SET finished_at = ?, classification = ?, outcome = ?, remote_draft_id = ?,
           error = ?, updated_at = ?
       WHERE attempt_key = ?`,
    )
    .bind(
      now,
      classification,
      outcome,
      remoteDraftId,
      error === null ? null : sanitizeWechatProviderError(error),
      now,
      attemptKey,
    )
}