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
 */

import { createHash } from 'node:crypto'
import type { Database } from '@/lib/repositories/schema'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import { projectWechatDraft } from './projection'
import { sanitizeWechatProviderError } from './provider'
import type {
  DeriveWechatDraftInput,
  DeriveWechatDraftResult,
  ReadWechatDraftTaskResult,
  WechatDraftProjection,
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
  created_at, updated_at`

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

  // One live target per account: a NEWER version may replace an older one, but
  // an older version can never be re-derivable as a second live draft once a
  // newer version is already live — the current live target is the newer one.
  const newerLive = await db
    .prepare(
      `SELECT 1 FROM wechat_draft_tasks
       WHERE article_id = ? AND account_id = ? AND version > ? AND status IN ('draft', 'submitted')
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

  const current = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM wechat_draft_tasks WHERE article_id = ? AND version = ? AND account_id = ?`)
    .bind(input.articleId, input.version, accountId)
    .first<WechatDraftTaskRow>()
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
  // (idempotent replay) is never re-submitted to the WeChat draft box.
  if (created && input.provider) {
    const payload = buildSubmitPayload(current, projection)
    try {
      const providerResult = await input.provider.createDraft(payload)
      if (providerResult.accepted) {
        await db
          .prepare(
            `UPDATE wechat_draft_tasks SET status = 'submitted', remote_draft_id = ?, provider_error = NULL, updated_at = ?
             WHERE task_id = ?`,
          )
          .bind(providerResult.remoteDraftId ?? null, now, taskId)
          .run()
        current.status = 'submitted'
        current.remote_draft_id = providerResult.remoteDraftId ?? null
        current.provider_error = null
        current.updated_at = now
        return {
          outcome: 'submitted',
          articleId: input.articleId,
          version: input.version,
          accountId,
          taskId,
          task: { ...current },
          created: true,
          projection,
        }
      }
      await db
        .prepare(
          `UPDATE wechat_draft_tasks SET status = 'failed', provider_error = ?, updated_at = ? WHERE task_id = ?`,
        )
        .bind(sanitizeWechatProviderError(providerResult.error || 'provider rejected the draft'), now, taskId)
        .run()
      current.status = 'failed'
      current.provider_error = providerResult.error || 'provider rejected the draft'
      current.updated_at = now
      return {
        outcome: 'failed',
        articleId: input.articleId,
        version: input.version,
        accountId,
        taskId,
        task: { ...current },
        created: true,
        projection,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db
        .prepare(
          `UPDATE wechat_draft_tasks SET status = 'failed', provider_error = ?, updated_at = ? WHERE task_id = ?`,
        )
        .bind(sanitizeWechatProviderError(message), now, taskId)
        .run()
      current.status = 'failed'
      current.provider_error = sanitizeWechatProviderError(message)
      current.updated_at = now
      return {
        outcome: 'failed',
        articleId: input.articleId,
        version: input.version,
        accountId,
        taskId,
        task: { ...current },
        created: true,
        projection,
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
  }
}