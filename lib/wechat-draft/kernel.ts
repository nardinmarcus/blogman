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
 *
 * B5-03 (issue #48) — 交付前设置调整、替代草稿与历史.
 *
 * The derivation kernel now applies the per-(article, account) settings
 * (账号/设置修订) to the projection: a pre-delivery row is re-projected in place
 * with the same task id / version / generation (沿用代次), and a DELIVERED row
 * is never re-projected. `saveWechatDraftSettings` maps the first save to
 * settings revision 1 (不猜历史) and never touches the body version.
 * `replaceWechatDraft` is the ONLY post-delivery way to create a new draft: it
 * registers the next monotonic generation (task 代次) in the
 * `wechat_draft_generations` ledger, references the prior generation
 * (replaces_task_id), preserves the old row + media_id as superseded (旧
 * media_id/代次不可删除或假装覆盖), and delivers the replacement to the WeChat
 * DRAFT BOX only. The executor and reconcile now process BOTH base tasks and
 * replacements through one lifecycle-target-aware state machine, and the
 * admin WRITE commands (settings save + replace) are kill-switchable
 * (`WECHAT_DRAFT_ADMIN_WRITES_DISABLED`) while every read surface stays live.
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
  ReplaceWechatDraftInput,
  ReplaceWechatDraftResult,
  SaveWechatDraftSettingsInput,
  SaveWechatDraftSettingsResult,
  WechatDeliveryView,
  WechatDraftAttemptClassification,
  WechatDraftAttemptRow,
  WechatDraftExecutorInput,
  WechatDraftExecutorResult,
  WechatDraftGenerationRow,
  WechatDraftProjection,
  WechatDraftProvider,
  WechatDraftProviderResult,
  WechatDraftReconcileInput,
  WechatDraftReconcileResult,
  WechatDraftReplacementRow,
  WechatDraftSettingsRow,
  WechatDraftSubmitPayload,
  WechatDraftTaskRow,
  WechatLifecycleRowView,
} from './types'
import type { WechatProjectionSettings } from './projection'

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
export const WECHAT_DRAFT_ADMIN_WRITES_DISABLED_ENV = 'WECHAT_DRAFT_ADMIN_WRITES_DISABLED'
export const WECHAT_DRAFT_ERROR_LIMIT = 500

/**
 * B5-03 kill-switch — closes the ADMIN WRITE commands (settings save + explicit
 * replacement) so an anomaly can freeze new delivery facts while every existing
 * group / generation / identity / reminder stays readable. Mirrors the
 * executor kill-switch pattern: empty/0/false means enabled.
 */
export function isWechatDraftAdminWritesDisabled(): boolean {
  const value = process.env[WECHAT_DRAFT_ADMIN_WRITES_DISABLED_ENV]
  return value != null && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

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
  next_attempt_at, last_error, claimed_at, lease_token, lease_expires_at,
  generation, settings_revision`

/** B5-03 — replacement rows share the SAME lifecycle column names as tasks. */
const REPLACEMENT_COLUMNS = `id, replacement_key, article_id, version, account_id,
  replaces_task_id, status, title, html_projection, plaintext_projection,
  cover_image_url, digest, content_sha256, projection_sha256, source_url,
  remote_draft_id, provider_error, settings_revision, created_at, updated_at,
  revision, attempt_count, classification, needs_author, next_attempt_at,
  last_error, claimed_at, lease_token, lease_expires_at, generation`

const GENERATION_COLUMNS = `id, article_id, account_id, generation, version, task_id,
  replaces_task_id, status, settings_revision, created_at, updated_at`

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

/* ------------------------------------------------------------------ */
/* B5-03 — lifecycle view (tasks + replacements normalized)            */
/* ------------------------------------------------------------------ */

async function findReplacementRow(db: Database, key: string): Promise<WechatDraftReplacementRow | null> {
  return db
    .prepare(`SELECT ${REPLACEMENT_COLUMNS} FROM wechat_draft_replacements WHERE replacement_key = ?`)
    .bind(key)
    .first<WechatDraftReplacementRow>()
}

function taskToLifecycle(row: WechatDraftTaskRow): WechatLifecycleRowView {
  return {
    kind: 'task',
    key: row.task_id,
    articleId: row.article_id,
    version: row.version,
    accountId: row.account_id,
    status: row.status,
    title: row.title,
    htmlProjection: row.html_projection,
    plaintextProjection: row.plaintext_projection,
    coverImageUrl: row.cover_image_url,
    digest: row.digest,
    contentSha256: row.content_sha256,
    projectionSha256: row.projection_sha256,
    sourceUrl: row.source_url,
    remoteDraftId: row.remote_draft_id,
    providerError: row.provider_error,
    settingsRevision: row.settings_revision,
    generation: row.generation,
    replacesTaskId: null,
    revision: row.revision,
    attemptCount: row.attempt_count,
    classification: row.classification,
    needsAuthor: row.needs_author,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    claimedAt: row.claimed_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  }
}

function replacementToLifecycle(row: WechatDraftReplacementRow): WechatLifecycleRowView {
  return {
    kind: 'replacement',
    key: row.replacement_key,
    articleId: row.article_id,
    version: row.version,
    accountId: row.account_id,
    status: row.status,
    title: row.title,
    htmlProjection: row.html_projection,
    plaintextProjection: row.plaintext_projection,
    coverImageUrl: row.cover_image_url,
    digest: row.digest,
    contentSha256: row.content_sha256,
    projectionSha256: row.projection_sha256,
    sourceUrl: row.source_url,
    remoteDraftId: row.remote_draft_id,
    providerError: row.provider_error,
    settingsRevision: row.settings_revision,
    generation: row.generation,
    replacesTaskId: row.replaces_task_id,
    revision: row.revision,
    attemptCount: row.attempt_count,
    classification: row.classification,
    needsAuthor: row.needs_author,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    claimedAt: row.claimed_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  }
}

/** Resolve ANY lifecycle row (base task or replacement) by its key. */
async function findLifecycleRow(db: Database, key: string): Promise<WechatLifecycleRowView | null> {
  if (!key) return null
  const task = await findTaskRow(db, key)
  if (task) return taskToLifecycle(task)
  const replacement = await findReplacementRow(db, key)
  if (replacement) return replacementToLifecycle(replacement)
  return null
}

/**
 * The CURRENT live delivery of a (article, account) group: the highest
 * generation that is NOT superseded. Returns the lifecycle view for it.
 */
async function findCurrentLiveDelivery(
  db: Database,
  articleId: number,
  accountId: string,
): Promise<WechatLifecycleRowView | null> {
  const { results: gens } = await db
    .prepare(
      `SELECT ${GENERATION_COLUMNS} FROM wechat_draft_generations
       WHERE article_id = ? AND account_id = ? AND status != 'superseded'
       ORDER BY generation DESC LIMIT 1`,
    )
    .bind(articleId, accountId)
    .all<WechatDraftGenerationRow>()
  const gen = gens?.[0]
  if (!gen) return null
  return findLifecycleRow(db, gen.task_id)
}

/** The projection shape for a lifecycle view (read API parity). */
export function projectionFromView(view: Pick<WechatLifecycleRowView, 'title' | 'htmlProjection' | 'plaintextProjection' | 'coverImageUrl' | 'digest' | 'sourceUrl'>): WechatDraftProjection {
  return {
    title: view.title,
    html: view.htmlProjection,
    plaintext: view.plaintextProjection,
    coverImageUrl: view.coverImageUrl ?? '',
    digest: view.digest ?? '',
    sourceUrl: view.sourceUrl,
  }
}

/**
 * B5-03 — human-readable delivery view: a delivered draft NEVER claims to be
 * published. `submitted` maps to 待微信确认; every other state is 未交付.
 */
export function wechatDeliveryView(row: WechatLifecycleRowView): WechatDeliveryView {
  const awaiting = row.status === 'submitted'
  const humanLabel = awaiting
    ? '待微信确认'
    : row.status === 'superseded'
      ? '历史代次（已交付）'
      : '未交付'
  return {
    kind: row.kind,
    key: row.key,
    articleId: row.articleId,
    version: row.version,
    accountId: row.accountId,
    generation: row.generation,
    replacesTaskId: row.replacesTaskId,
    status: row.status,
    awaitingWechatConfirmation: awaiting,
    humanLabel,
    remoteDraftId: row.remoteDraftId,
    settingsRevision: row.settingsRevision,
    title: row.title,
  }
}

/* ------------------------------------------------------------------ */
/* B5-03 — 交付前设置修订 (账号/设置修订, 与正文版本/代次分离)          */
/* ------------------------------------------------------------------ */

async function findSettingsRow(db: Database, articleId: number, accountId: string): Promise<WechatDraftSettingsRow | null> {
  return db
    .prepare(
      `SELECT id, article_id, account_id, settings_revision, title_override,
              digest_override, cover_image_override, created_at, updated_at
       FROM wechat_draft_settings WHERE article_id = ? AND account_id = ?`,
    )
    .bind(articleId, accountId)
    .first<WechatDraftSettingsRow>()
}

/** Projection settings from a settings row (empty overrides → no override). */
function settingsToProjection(settings: WechatDraftSettingsRow | null): WechatProjectionSettings | undefined {
  if (!settings) return undefined
  const out: WechatProjectionSettings = {}
  if ((settings.title_override ?? '').trim()) out.title = settings.title_override!.trim()
  if ((settings.digest_override ?? '').trim()) out.digest = settings.digest_override!.trim()
  if ((settings.cover_image_override ?? '').trim()) out.coverImageUrl = settings.cover_image_override!.trim()
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * B5-03 — save (or update) the deliverable settings for (article, account).
 *
 * The FIRST save maps to settings revision 1 (初始配置映射初始修订, 不猜历史);
 * every later save bumps the revision. Adjusting settings NEVER changes the
 * article body version and NEVER advances the delivery generation — the
 * pre-delivery derivation re-applies them to the SAME task (沿用代次). After
 * delivery the settings only feed an EXPLICIT replacement draft.
 */
export async function saveWechatDraftSettings(
  db: Database,
  input: SaveWechatDraftSettingsInput,
): Promise<SaveWechatDraftSettingsResult> {
  if (isWechatDraftAdminWritesDisabled()) {
    return { outcome: 'disabled', reason: 'wechat admin writes are disabled by WECHAT_DRAFT_ADMIN_WRITES_DISABLED' }
  }
  if (!Number.isInteger(input.articleId) || input.articleId <= 0) {
    return { outcome: 'invalid', reason: 'saveWechatDraftSettings: articleId is required' }
  }
  const accountId = normalizeWechatAccountId(input.accountId ?? '')
  if (!accountId) {
    return { outcome: 'invalid', reason: 'saveWechatDraftSettings: accountId is required (letters/digits/-/_)' }
  }
  const now = input.now ?? unixNow()
  const existing = await findSettingsRow(db, input.articleId, accountId)
  const title = (input.title ?? '').trim()
  const digest = (input.digest ?? '').trim()
  const coverImageUrl = (input.coverImageUrl ?? '').trim()
  if (!existing) {
    const { meta } = (await db
      .prepare(
        `INSERT INTO wechat_draft_settings
           (article_id, account_id, settings_revision, title_override, digest_override,
            cover_image_override, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(article_id, account_id) DO NOTHING`,
      )
      .bind(
        input.articleId,
        accountId,
        title || null,
        digest || null,
        coverImageUrl || null,
        now,
        now,
      )
      .run()) as { meta: { changes?: number } }
    const settings = await findSettingsRow(db, input.articleId, accountId)
    return {
      outcome: 'saved',
      created: (meta.changes ?? 0) > 0,
      settingsRevision: settings?.settings_revision ?? 1,
      settings: settings ?? {
        id: 0,
        article_id: input.articleId,
        account_id: accountId,
        settings_revision: 1,
        title_override: title || null,
        digest_override: digest || null,
        cover_image_override: coverImageUrl || null,
        created_at: now,
        updated_at: now,
      },
    }
  }

  await db
    .prepare(
      `UPDATE wechat_draft_settings
       SET settings_revision = settings_revision + 1,
           title_override = ?, digest_override = ?, cover_image_override = ?,
           updated_at = ?
       WHERE article_id = ? AND account_id = ?`,
    )
    .bind(title || null, digest || null, coverImageUrl || null, now, input.articleId, accountId)
    .run()
  const settings = await findSettingsRow(db, input.articleId, accountId)
  return {
    outcome: 'saved',
    created: false,
    settingsRevision: settings?.settings_revision ?? existing.settings_revision + 1,
    settings: settings ?? existing,
  }
}

export async function readWechatDraftSettings(
  db: Database,
  articleId: number,
  accountId: string,
): Promise<WechatDraftSettingsRow | null> {
  return findSettingsRow(db, articleId, normalizeWechatAccountId(accountId) ?? '')
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

/** Next monotonic generation number for the (article, account) delivery group. */
async function nextWechatGeneration(db: Database, articleId: number, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(generation), 0) + 1 AS next
       FROM wechat_draft_generations WHERE article_id = ? AND account_id = ?`,
    )
    .bind(articleId, accountId)
    .first<{ next: number }>()
  return row?.next ?? 1
}

/** Register one delivery-generation ledger row (idempotent, 旧代次不删除). */
function registerWechatGeneration(
  db: Database,
  opts: {
    articleId: number
    accountId: string
    generation: number
    version: number
    taskId: string
    replacesTaskId: string | null
    status: WechatDraftTaskRow['status']
    settingsRevision: number
    now: number
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO wechat_draft_generations
         (article_id, account_id, generation, version, task_id, replaces_task_id,
          status, settings_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(article_id, account_id, generation) DO NOTHING`,
    )
    .bind(
      opts.articleId,
      opts.accountId,
      opts.generation,
      opts.version,
      opts.taskId,
      opts.replacesTaskId,
      opts.status,
      opts.settingsRevision,
      opts.now,
      opts.now,
    )
}

/** Keep the generation ledger status in lockstep with the delivery row status. */
function syncGenerationStatus(
  db: Database,
  taskKey: string,
  status: WechatDraftTaskRow['status'],
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE wechat_draft_generations SET status = ?, updated_at = ? WHERE task_id = ?`,
    )
    .bind(status, now, taskKey)
}


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

  const settings = await findSettingsRow(db, input.articleId, accountId)
  const settingsRevision = settings?.settings_revision ?? 0
  const contentSha256 = snapshot.content_snapshot_sha256 ?? versionRow.content_snapshot_sha256 ?? ''
  const projection = projectWechatDraft(snapshot, {
    sourceUrl: formal.public_url,
    siteUrl: input.siteUrl,
    settings: settingsToProjection(settings),
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
  const generation = await nextWechatGeneration(db, input.articleId, accountId)
  const insert = (await db
    .prepare(
      `INSERT INTO wechat_draft_tasks
         (task_id, article_id, post_ref, version, account_id, status,
          title, html_projection, plaintext_projection, cover_image_url, digest,
          content_sha256, projection_sha256, source_url,
          generation, settings_revision, created_at, updated_at)
       VALUES (?, ?, (SELECT COALESCE((SELECT post_ref FROM articles WHERE id = ?), 0)), ?, ?, 'draft',
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      generation,
      settingsRevision,
      now,
      now,
    )
    .run()) as { meta: { last_row_id: number; changes?: number } }

  const created = (insert.meta?.changes ?? 0) > 0

  if (created) {
    // Register the new generation ledger row, then supersede older versions of
    // the same (article, account) — one live target per account, history kept.
    await db.batch([
      registerWechatGeneration(db, {
        articleId: input.articleId,
        accountId,
        generation,
        version: input.version,
        taskId,
        replacesTaskId: null,
        status: 'draft',
        settingsRevision,
        now,
      }),
      db
        .prepare(
          `UPDATE wechat_draft_tasks SET status = 'superseded', updated_at = ?
           WHERE article_id = ? AND account_id = ? AND version < ? AND status != 'superseded'`,
        )
        .bind(now, input.articleId, accountId, input.version),
      db
        .prepare(
          `UPDATE wechat_draft_replacements SET status = 'superseded', updated_at = ?
           WHERE article_id = ? AND account_id = ? AND version < ? AND status IN ('draft', 'submitted', 'failed')`,
        )
        .bind(now, input.articleId, accountId, input.version),
      db
        .prepare(
          `UPDATE wechat_draft_generations SET status = 'superseded', updated_at = ?
           WHERE article_id = ? AND account_id = ? AND version < ? AND status != 'superseded'`,
        )
        .bind(now, input.articleId, accountId, input.version),
    ])
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
        syncGenerationStatus(db, taskId, 'submitted', now),
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
        generation,
        settingsRevision,
        classification: 'ok',
      }
    }

    await recordFailedHandoff(db, TARGET_TASK, taskId, { verdict, now, attemptNo: 1, maxAttempts })
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
      generation,
      settingsRevision,
      classification: verdict.classification,
    }
  }

  // B5-03 — 交付前设置调整沿用代次: a NOT-YET-DELIVERED row (draft/failed) is
  // re-projected in place when the settings revision or projection changed.
  // The task id / version / generation all stay — only the delivery body and
  // settings_revision move. A DELIVERED row is NEVER touched here (the caller
  // must explicitly create a replacement draft instead).
  if (!created && (current.status === 'draft' || current.status === 'failed')) {
    const changed = settingsRevision !== current.settings_revision || digest !== current.projection_sha256
    if (changed) {
      await db
        .prepare(
          `UPDATE wechat_draft_tasks
           SET title = ?, html_projection = ?, plaintext_projection = ?,
               cover_image_url = ?, digest = ?, projection_sha256 = ?,
               settings_revision = ?, updated_at = ?
           WHERE task_id = ? AND status IN ('draft', 'failed')`,
        )
        .bind(
          projection.title,
          projection.html,
          projection.plaintext,
          projection.coverImageUrl || null,
          projection.digest,
          digest,
          settingsRevision,
          now,
          taskId,
        )
        .run()
      const updated = await findTaskRow(db, taskId)
      const latest = updated ?? { ...current }
      return {
        outcome: 'updated',
        articleId: input.articleId,
        version: input.version,
        accountId,
        taskId,
        task: latest,
        created: false,
        projection,
        generation: latest.generation,
        settingsRevision: latest.settings_revision,
      }
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
    generation: current.generation,
    settingsRevision: current.settings_revision,
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

/* B5-03 — one lifecycle target (base task table or replacement table). */
export interface LifecycleTarget {
  table: 'wechat_draft_tasks' | 'wechat_draft_replacements'
  keyColumn: 'task_id' | 'replacement_key'
}

const TARGET_TASK: LifecycleTarget = { table: 'wechat_draft_tasks', keyColumn: 'task_id' }
const TARGET_REPLACEMENT: LifecycleTarget = { table: 'wechat_draft_replacements', keyColumn: 'replacement_key' }

/** Finalize (or insert-and-finalize) a failed hand-off with classification. */
function transitionFailedTask(
  db: Database,
  target: LifecycleTarget,
  key: string,
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
      `UPDATE ${target.table}
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
       WHERE ${target.keyColumn} = ?`,
    )
    .bind(
      opts.classification,
      opts.needsAuthor ? 1 : 0,
      sanitizeWechatProviderError(opts.lastError, WECHAT_DRAFT_ERROR_LIMIT),
      sanitizeWechatProviderError(opts.lastError),
      opts.nextAttemptAt,
      opts.now,
      key,
    )
}

/**
 * Apply a rejected verdict (retryable / needs-author / unknown) to a task or
 * replacement and write its immutable attempt row. Used by the derivation /
 * replacement hand-off (no running row → the attempt is inserted already-
 * finalized) and the executor (the claim-time running row is finalized in
 * place) so the two surfaces share one state machine.
 * Returns the classified outcome for the caller.
 */
async function recordFailedHandoff(
  db: Database,
  target: LifecycleTarget,
  key: string,
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
): Promise<'retried' | 'failed' | 'needs-author' | 'unknown'> {
  const { verdict, now, attemptNo, maxAttempts } = opts
  const backoffSeconds = opts.backoffSeconds ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_SECONDS
  const backoffFactor = opts.backoffFactor ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_FACTOR
  const backoffMax = opts.backoffMaxSeconds ?? WECHAT_DRAFT_DEFAULT_RETRY_BACKOFF_MAX_SECONDS
  const syncFailed = syncGenerationStatus(db, key, 'failed', now)
  // On a fresh hand-off (no running attempt) the row's attempt_count was NOT
  // incremented by a claim — advance it here so the next executor claim uses a
  // fresh attempt number and its own immutable attempt row (one execution,
  // one fact; never a reused/overwritten attempt key).
  const countStmt = opts.runningAttemptKey
    ? null
    : db
        .prepare(
          `UPDATE ${target.table}
           SET attempt_count = attempt_count + 1, revision = revision + 1, updated_at = ?
           WHERE ${target.keyColumn} = ?`,
        )
        .bind(now, key)

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
    : insertAttemptRow(db, key, attemptNo, 'unknown', 'unknown', now, now, null, verdict.error)

  if (verdict.classification === 'unknown') {
    await db.batch([
      attemptStmt,
      transitionFailedTask(db, target, key, {
        classification: 'unknown',
        lastError: verdict.error,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
      syncFailed,
      ...(countStmt ? [countStmt] : []),
    ])
    return 'unknown'
  }

  if (verdict.classification === 'needs-author') {
    await db.batch([
      opts.runningAttemptKey
        ? finalizeRunningAttempt(db, opts.runningAttemptKey, 'needs-author', 'failed', null, verdict.error, now)
        : insertAttemptRow(db, key, attemptNo, 'needs-author', 'failed', now, now, null, verdict.error),
      transitionFailedTask(db, target, key, {
        classification: 'needs-author',
        lastError: verdict.error,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
      syncFailed,
      ...(countStmt ? [countStmt] : []),
    ])
    return 'needs-author'
  }

  // retryable: re-arm below the cap, stop (→ author todo) at the cap.
  if (attemptNo >= maxAttempts) {
    await db.batch([
      opts.runningAttemptKey
        ? finalizeRunningAttempt(db, opts.runningAttemptKey, 'retryable', 'failed', null, verdict.error, now)
        : insertAttemptRow(db, key, attemptNo, 'retryable', 'failed', now, now, null, verdict.error),
      transitionFailedTask(db, target, key, {
        classification: 'needs-author',
        lastError: `retries-exhausted: ${verdict.error}`,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
      syncFailed,
      ...(countStmt ? [countStmt] : []),
    ])
    return 'failed'
  }

  const nextAttemptAt = now + wechatRetryBackoffSeconds(attemptNo, backoffSeconds, backoffFactor, backoffMax)
  await db.batch([
    opts.runningAttemptKey
      ? finalizeRunningAttempt(db, opts.runningAttemptKey, 'retryable', 'retried', null, verdict.error, now)
      : insertAttemptRow(db, key, attemptNo, 'retryable', 'retried', now, now, null, verdict.error),
    transitionFailedTask(db, target, key, {
      classification: 'retryable',
      lastError: verdict.error,
      needsAuthor: false,
      nextAttemptAt,
      now,
    }),
    syncFailed,
    ...(countStmt ? [countStmt] : []),
  ])
  return 'retried'
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

  // Scan BOTH lifecycle surfaces — base tasks AND explicit replacement drafts
  // — under the SAME due/lease/needs-author conditions. A replacement is just
  // another delivery generation awaiting the draft-box hand-off (自动化止于草稿).
  const { results: baseCandidates } = await db
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

  const { results: replacementCandidates } = await db
    .prepare(
      `SELECT ${REPLACEMENT_COLUMNS} FROM wechat_draft_replacements
       WHERE needs_author = 0
         AND status IN ('draft', 'failed')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND ((status = 'draft' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'failed' AND classification = 'retryable' AND next_attempt_at <= ?))
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(now, now, now, limit)
    .all<WechatDraftReplacementRow>()

  result.scanned = (baseCandidates?.length ?? 0) + (replacementCandidates?.length ?? 0)

  const runClaim = async (
    target: LifecycleTarget,
    key: string,
  ): Promise<string | null> => {
    const claimed = await claimLifecycleTask(db, target, key, { now, leaseSeconds, maxAttempts })
    if (!claimed) return null // another runner already owns or advanced this row

    result.claimed += 1
    // A reclaimed crashed execution leaves its attempt running — finalize it
    // accordingly (immutable row, never deleted) before the new one.
    await abandonOrphanedWechatAttempts(db, claimed.key, now)

    await db
      .prepare(
        `INSERT INTO wechat_draft_attempts
           (attempt_key, task_id, attempt_no, classification, outcome,
            started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'retryable', 'retried', ?, ?, ?)
         ON CONFLICT(attempt_key) DO NOTHING`,
      )
      .bind(
        wechatDraftAttemptKey(claimed.key, claimed.attemptCount),
        claimed.key,
        claimed.attemptCount,
        now,
        now,
        now,
      )
      .run()

    return executeWechatSubmission(db, target, claimed, {
      provider,
      now,
      maxAttempts,
      backoffSeconds,
      backoffFactor,
      backoffMax,
    })
  }

  const tally = (outcome: string) => {
    if (outcome === 'submitted') result.submitted += 1
    else if (outcome === 'retried') result.retried += 1
    else if (outcome === 'failed') result.failed += 1
    else if (outcome === 'needs-author') result.needsAuthor += 1
    else if (outcome === 'unknown') result.unknown += 1
  }

  for (const row of baseCandidates ?? []) {
    const outcome = await runClaim(TARGET_TASK, row.task_id)
    if (outcome) tally(outcome)
  }
  for (const row of replacementCandidates ?? []) {
    const outcome = await runClaim(TARGET_REPLACEMENT, row.replacement_key)
    if (outcome) tally(outcome)
  }

  return result
}

/**
 * Atomically claim a due lifecycle row (task or replacement) for THIS runner.
 * Returns the claimed row (attempt_count already incremented, lease held) only
 * when the runner truly owns the lease; otherwise null (a concurrent runner
 * won or advanced it).
 */
async function claimLifecycleTask(
  db: Database,
  target: LifecycleTarget,
  key: string,
  opts: { now: number; leaseSeconds: number; maxAttempts: number },
): Promise<WechatLifecycleRowView | null> {
  const { now, leaseSeconds } = opts
  const token = crypto.randomUUID()
  await db
    .prepare(
      `UPDATE ${target.table}
       SET claimed_at = ?, lease_expires_at = ?, lease_token = ?,
           attempt_count = attempt_count + 1, revision = revision + 1, updated_at = ?
       WHERE ${target.keyColumn} = ?
         AND needs_author = 0
         AND status IN ('draft', 'failed')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND ((status = 'draft' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'failed' AND classification = 'retryable' AND next_attempt_at <= ?))`,
    )
    .bind(now, now + leaseSeconds, token, now, key, now, now, now)
    .run()
  const after = await findLifecycleRow(db, key)
  if (!after || after.leaseToken !== token) return null // our conditional UPDATE matched nothing
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
 * Submit one claimed lifecycle row through the provider and converge the row +
 * immutable attempt fact in ONE batch. Returns the classified outcome.
 */
async function executeWechatSubmission(
  db: Database,
  target: LifecycleTarget,
  row: WechatLifecycleRowView,
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
  const taskId = row.key
  const attemptNo = row.attemptCount
  const projection = projectionFromView(row)
  const payload = buildSubmitPayload(
    {
      task_id: taskId,
      article_id: row.articleId,
      version: row.version,
      account_id: row.accountId,
      content_sha256: row.contentSha256,
    },
    projection,
  )

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
          `UPDATE ${target.table}
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
           WHERE ${target.keyColumn} = ?`,
        )
        .bind(verdict.remoteDraftId, now, taskId),
      syncGenerationStatus(db, taskId, 'submitted', now),
    ])
    return 'submitted'
  }

  return recordFailedHandoff(db, target, taskId, {
    verdict,
    now,
    attemptNo,
    maxAttempts,
    runningAttemptKey: wechatDraftAttemptKey(taskId, attemptNo),
    backoffSeconds,
    backoffFactor,
    backoffMaxSeconds: backoffMax,
  })
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

  const row = await findLifecycleRow(db, taskId)
  if (!row) return { outcome: 'not-found', taskId }
  const target: LifecycleTarget = row.kind === 'task' ? TARGET_TASK : TARGET_REPLACEMENT

  // Already delivered — a late result of a previously accepted call (or a
  // reconcile that already resolved): nothing to do, nothing overwritten.
  if (row.status === 'submitted') {
    return { outcome: 'replayed', taskId, ...(await withRawRefs(db, row, { delivery: row })) }
  }
  // Only result-unknown rows are reconcilable; anything else is a replay.
  if (row.status !== 'failed' || row.classification !== 'unknown' || row.needsAuthor !== 1) {
    return { outcome: 'not-unknown', taskId, ...(await withRawRefs(db, row, { delivery: row })) }
  }

  const provider = input.provider
  if (!provider) {
    return { outcome: 'no-provider', taskId, ...(await withRawRefs(db, row, { delivery: row })) }
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
      taskId: row.key,
      articleId: row.articleId,
      version: row.version,
      accountId: row.accountId,
      sourceUrl: row.sourceUrl,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.batch([
      finalizeReconcileAttempt(db, attemptKey, 'unknown', 'unknown', null, message, now),
      transitionFailedTask(db, target, taskId, {
        classification: 'unknown',
        lastError: `reconcile-query-lost: ${message}`,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
      syncGenerationStatus(db, taskId, 'failed', now),
    ])
    const after = (await findLifecycleRow(db, taskId))!
    return { outcome: 'unknown-still', taskId, reason: message, ...(await withRawRefs(db, after, { delivery: after })) }
  }

  if (query.unknown) {
    const message = query.error ?? 'reconcile query result unknown'
    await db.batch([
      finalizeReconcileAttempt(db, attemptKey, 'unknown', 'unknown', null, message, now),
      transitionFailedTask(db, target, taskId, {
        classification: 'unknown',
        lastError: `reconcile-query-lost: ${message}`,
        needsAuthor: true,
        nextAttemptAt: null,
        now,
      }),
      syncGenerationStatus(db, taskId, 'failed', now),
    ])
    const after = (await findLifecycleRow(db, taskId))!
    return { outcome: 'unknown-still', taskId, reason: message, ...(await withRawRefs(db, after, { delivery: after })) }
  }

  if (query.found) {
    const remoteId = query.remoteDraftId ?? null
    await db.batch([
      finalizeReconcileAttempt(db, attemptKey, 'ok', 'reconciled', remoteId, null, now),
      db
        .prepare(
          `UPDATE ${target.table}
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
           WHERE ${target.keyColumn} = ? AND status = 'failed'`,
        )
        .bind(remoteId, now, taskId),
      syncGenerationStatus(db, taskId, 'submitted', now),
    ])
    const after = (await findLifecycleRow(db, taskId))!
    return {
      outcome: 'reconciled',
      found: true,
      taskId,
      remoteDraftId: remoteId ?? after.remoteDraftId,
      ...(await withRawRefs(db, after, { delivery: after })),
    }
  }

  // Found:false — provably never created. Re-arm as a fresh zero-production
  // draft so the executor can re-submit once under the retry policy. No
  // second row is ever created (the UNIQUE key already prevents it).
  await db.batch([
    finalizeReconcileAttempt(db, attemptKey, 'retryable', 'reconciled', null, 'confirmed-not-created', now),
    db
      .prepare(
        `UPDATE ${target.table}
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
         WHERE ${target.keyColumn} = ? AND status = 'failed'`,
      )
      .bind(now, taskId),
    syncGenerationStatus(db, taskId, 'draft', now),
  ])
  const after = (await findLifecycleRow(db, taskId))!
  return {
    outcome: 'reconciled',
    found: false,
    taskId,
    remoteDraftId: null,
    ...(await withRawRefs(db, after, { delivery: after })),
  }
}

function rawRowRefs(db: Database, row: WechatLifecycleRowView) {
  if (row.kind === 'task') {
    return findTaskRow(db, row.key)
  }
  return findReplacementRow(db, row.key)
}

/** Async spread helper for the raw back-ref (task or replacement row). */
async function withRawRefs<T extends object>(
  db: Database,
  row: WechatLifecycleRowView,
  extra: T,
): Promise<T & { task?: WechatDraftTaskRow; replacement?: WechatDraftReplacementRow }> {
  const raw = await rawRowRefs(db, row)
  if (!raw) return { ...extra }
  if (row.kind === 'task') return { ...extra, task: raw as WechatDraftTaskRow }
  return { ...extra, replacement: raw as WechatDraftReplacementRow }
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
/* ------------------------------------------------------------------ */
/* B5-03 — 显式替代草稿 (交付后) 与历史读取                           */
/* ------------------------------------------------------------------ */

/**
 * B5-03 — explicitly create a REPLACEMENT draft for an already DELIVERED
 * generation (交付后只能显式建替代草稿, 引用前代并保留历史).
 *
 * Contracts:
 *
 *   - only a DELIVERED live generation ('submitted', 待微信确认) can be
 *     replaced; a pre-delivery row (draft/failed) is adjusted via settings +
 *     re-derivation (沿用代次) instead and is REJECTED here,
 *   - the replacement is the NEXT monotonic generation of the (article,
 *     account) group; its ledger row references the prior generation
 *     (replaces_task_id = 前代键), so the chain is traceable,
 *   - the OLD row is NEVER deleted or overwritten — its status flips to
 *     'superseded' but its media_id / attempts / identity are preserved
 *     (旧 media_id/代次不可删除或假装覆盖),
 *   - the replacement is deterministic per prior live generation
 *     (`wechat-replacement:<priorKey>`): repeating the command for the SAME
 *     live generation returns the SAME replacement ('existing'), never a
 *     duplicate draft,
 *   - a provider hand-off (mock in tests, null in production) delivers the
 *     replacement to the WeChat DRAFT BOX only — automation stops at the
 *     draft (绝不自动群发或声称已发布).
 */
export async function replaceWechatDraft(
  db: Database,
  input: ReplaceWechatDraftInput,
): Promise<ReplaceWechatDraftResult> {
  if (isWechatDraftAdminWritesDisabled()) {
    return { outcome: 'disabled', reason: 'wechat admin writes are disabled by WECHAT_DRAFT_ADMIN_WRITES_DISABLED' }
  }
  const now = input.now ?? unixNow()
  const maxAttempts = input.maxAttempts ?? WECHAT_DRAFT_DEFAULT_MAX_ATTEMPTS

  let current: WechatLifecycleRowView | null = null
  let resolvedAccount: string | null = null
  if (input.taskId) {
    current = await findLifecycleRow(db, input.taskId)
    if (current) resolvedAccount = current.accountId
  } else if (input.articleId != null && input.accountId) {
    resolvedAccount = normalizeWechatAccountId(input.accountId)
    if (!resolvedAccount) {
      return { outcome: 'invalid', reason: 'replaceWechatDraft: accountId is required (letters/digits/-/_)' }
    }
    current = await findCurrentLiveDelivery(db, input.articleId, resolvedAccount)
  } else {
    return { outcome: 'invalid', reason: 'replaceWechatDraft: taskId or articleId+accountId is required' }
  }

  if (!current) {
    return {
      outcome: 'not-found',
      reason: 'no current live delivery exists to replace',
      articleId: input.articleId,
      accountId: resolvedAccount ?? undefined,
    }
  }
  if (current.status !== 'submitted') {
    return {
      outcome: 'not-delivered',
      reason: '只能替代已交付草稿（交付前用设置调整沿用代次，交付后才可显式建替代草稿）',
      current,
    }
  }

  const articleId = current.articleId
  const account = current.accountId
  const formal = await findFormalPublication(db, articleId)
  const versionRow = await findVersionRow(db, articleId, current.version)
  if (!formal || formal.lifecycle !== 'published' || !versionRow) {
    return { outcome: 'not-found', reason: 'frozen version facts are missing for the current delivery' }
  }
  let snapshot: ArticleIdentitySnapshot
  try {
    snapshot = JSON.parse(versionRow.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    return { outcome: 'not-found', reason: 'version snapshot is not valid JSON' }
  }
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.fields) {
    return { outcome: 'not-found', reason: 'version snapshot is malformed' }
  }

  const settings = await findSettingsRow(db, articleId, account)
  const settingsRevision = settings?.settings_revision ?? 0
  const contentSha256 = snapshot.content_snapshot_sha256 ?? versionRow.content_snapshot_sha256 ?? ''
  const projection = projectWechatDraft(snapshot, {
    sourceUrl: formal.public_url,
    siteUrl: input.siteUrl,
    settings: settingsToProjection(settings),
  })
  const digest = projectionDigest(projection, contentSha256)

  // Deterministic key: at most ONE explicit replacement of the same live
  // generation. To create a NEW generation, replace the NEW live generation.
  const replacementKey = `wechat-replacement:${current.key}`
  const existingReplacement = await findReplacementRow(db, replacementKey)
  if (existingReplacement) {
    return {
      outcome: 'existing',
      articleId,
      version: current.version,
      accountId: account,
      generation: existingReplacement.generation,
      replacesTaskId: existingReplacement.replaces_task_id,
      taskId: replacementKey,
      replacement: existingReplacement,
      projection: projectionFromView(replacementToLifecycle(existingReplacement)),
      handout: false,
    }
  }

  const generation = await nextWechatGeneration(db, articleId, account)
  const priorTarget: LifecycleTarget = current.kind === 'task' ? TARGET_TASK : TARGET_REPLACEMENT
  await db.batch([
    db
      .prepare(
        `INSERT INTO wechat_draft_replacements
           (replacement_key, article_id, version, account_id, replaces_task_id,
            generation, status, title, html_projection, plaintext_projection,
            cover_image_url, digest, content_sha256, projection_sha256, source_url,
            settings_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        replacementKey,
        articleId,
        current.version,
        account,
        current.key,
        generation,
        projection.title,
        projection.html,
        projection.plaintext,
        projection.coverImageUrl || null,
        projection.digest,
        contentSha256,
        digest,
        projection.sourceUrl,
        settingsRevision,
        now,
        now,
      ),
    registerWechatGeneration(db, {
      articleId,
      accountId: account,
      generation,
      version: current.version,
      taskId: replacementKey,
      replacesTaskId: current.key,
      status: 'draft',
      settingsRevision,
      now,
    }),
    // The prior live generation is superseded in PLACE — never deleted, its
    // media_id / attempts / identity stay intact (旧代次不假覆盖).
    db
      .prepare(
        `UPDATE ${priorTarget.table}
         SET status = 'superseded', updated_at = ?
         WHERE ${priorTarget.keyColumn} = ? AND status = 'submitted'`,
      )
      .bind(now, current.key),
    syncGenerationStatus(db, current.key, 'superseded', now),
  ])

  const replacement = await findReplacementRow(db, replacementKey)
  if (!replacement) {
    return { outcome: 'not-found', reason: 'replacement row vanished after insert' }
  }

  // Provider hand-off happens ONLY on creation — the replacement is delivered
  // to the WeChat DRAFT BOX (mock) or stays an in-DB draft (zero production).
  if (input.provider) {
    const payload = buildSubmitPayload(
      {
        task_id: replacementKey,
        article_id: articleId,
        version: current.version,
        account_id: account,
        content_sha256: contentSha256,
      },
      projection,
    )
    let verdict: WechatExecutionVerdict
    try {
      verdict = classifyWechatExecution(await input.provider.createDraft(payload))
    } catch (error) {
      verdict = classifyWechatExecution(error instanceof Error ? error : new Error(String(error)))
    }

    if (verdict.kind === 'accepted') {
      await db.batch([
        insertAttemptRow(db, replacementKey, 1, 'ok', 'submitted', now, now, verdict.remoteDraftId, null),
        db
          .prepare(
            `UPDATE wechat_draft_replacements
             SET status = 'submitted', remote_draft_id = ?, provider_error = NULL,
                 classification = 'ok', needs_author = 0, next_attempt_at = NULL,
                 last_error = NULL, attempt_count = attempt_count + 1, revision = revision + 1,
                 updated_at = ?
             WHERE replacement_key = ?`,
          )
          .bind(verdict.remoteDraftId, now, replacementKey),
        syncGenerationStatus(db, replacementKey, 'submitted', now),
      ])
      const delivered = (await findReplacementRow(db, replacementKey)) ?? replacement
      return {
        outcome: 'submitted',
        articleId,
        version: current.version,
        accountId: account,
        generation,
        replacesTaskId: current.key,
        taskId: replacementKey,
        replacement: delivered,
        projection,
        handout: true,
        classification: 'ok',
      }
    }

    await recordFailedHandoff(db, TARGET_REPLACEMENT, replacementKey, {
      verdict,
      now,
      attemptNo: 1,
      maxAttempts,
    })
    const failed = (await findReplacementRow(db, replacementKey)) ?? replacement
    return {
      outcome: verdict.classification === 'unknown' ? 'unknown' : 'failed',
      articleId,
      version: current.version,
      accountId: account,
      generation,
      replacesTaskId: current.key,
      taskId: replacementKey,
      replacement: failed,
      projection,
      handout: true,
      classification: verdict.classification,
    }
  }

  return {
    outcome: 'created',
    articleId,
    version: current.version,
    accountId: account,
    generation,
    replacesTaskId: current.key,
    taskId: replacementKey,
    replacement,
    projection,
    handout: false,
  }
}

/** B5-03 — full delivery history (groups → generations → rows) in generation order. */
export async function listWechatDeliveries(
  db: Database,
  articleId: number,
  accountId: string,
): Promise<Array<{ generation: WechatDraftGenerationRow; delivery: WechatLifecycleRowView; replacesTaskId: string | null }>> {
  const normalized = normalizeWechatAccountId(accountId)
  if (!normalized) return []
  const { results: gens } = await db
    .prepare(
      `SELECT ${GENERATION_COLUMNS} FROM wechat_draft_generations
       WHERE article_id = ? AND account_id = ? ORDER BY generation`,
    )
    .bind(articleId, normalized)
    .all<WechatDraftGenerationRow>()
  const out = []
  for (const gen of gens ?? []) {
    const row = await findLifecycleRow(db, gen.task_id)
    if (!row) continue
    out.push({ generation: gen, delivery: row, replacesTaskId: gen.replaces_task_id })
  }
  return out
}

/** B5-03 — read ONE delivery as a human-facing view (待微信确认, never 已发布). */
export async function readWechatDeliveryView(db: Database, key: string): Promise<WechatDeliveryView | null> {
  if (!key || key.trim() === '') return null
  const row = await findLifecycleRow(db, key)
  return row ? wechatDeliveryView(row) : null
}
