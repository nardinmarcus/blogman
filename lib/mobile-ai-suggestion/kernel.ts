/**
 * B8-03 — mobile local-AI suggestion kernel (issue #62).
 *
 * A thin, deterministic surface over the SHARED #38 suggestion protocol. The
 * author selects text on mobile and requests a LOCAL suggestion; the mock AI
 * rewrites exactly that selection (never the whole article, never auto-applied)
 * and the result is RECORDED as a version-bound `content` suggestion into the
 * same `publish_preparations` / `publish_suggestions` tables — so the mobile
 * feature adds NO mobile-specific version / suggestion state.
 *
 * Every author action on the suggestion list — preview, apply, undo (revoke),
 * ignore — is the #38 kernel verbatim (`readSuggestionState` / `applySuggestion`
 * / `revokeSuggestion` / `ignoreSuggestion`), so staleness, version binding,
 * restore-point-once, expected-version applies and "AI failure never blocks
 * save/publish" all hold unchanged.
 *
 *   - 正文变化使建议过期  the suggestion binds the analysed body hash + body
 *     baseline; once the body diverges the suggestion is `stale` and never
 *     applies silently.
 *   - 冲突不静默重试       `applySuggestion` returns `conflict` when the expected
 *     version moved; the mobile UI surfaces it instead of retrying.
 *   - AI 失败不阻止保存发布 request failure leaves the editor + publish save path
 *     untouched (suggestion recording is best-effort).
 */

import type { Database } from '@/lib/repositories/schema'
import { findActiveRevision, snapshotContentHash } from '@/lib/publish-revision'
import { recordPreparedSuggestions } from '@/lib/publish-suggestions'
import { buildContentSuggestion } from './mock-ai'
import type {
  RequestMobileSuggestionInput,
  RequestMobileSuggestionResult,
} from './types'

/** Source prefix marking a mobile local-AI preparation. */
export const MOBILE_AI_SOURCE_PREFIX = 'mobile-ai'

export const MANUAL_REWRITE_HINT = '请保存正文后再请求局部 AI 建议'

/** The current body + version + canonical hash the suggestion must anchor to. */
export interface MobileSuggestionBasis {
  content: string
  contentHash: string
  version: number
  postRef: number
}

/**
 * Resolve the author's current editing basis: the active revision surface when a
 * formal article is under revision, else the latest draft article_version. This
 * mirrors the #38 `resolveCurrent` so the recorded suggestion shares the exact
 * staleness basis the shared kernel compares against.
 */
export async function resolveMobileSuggestionBasis(
  db: Database,
  articleId: number,
): Promise<MobileSuggestionBasis | null> {
  const article = await db
    .prepare('SELECT post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<{ post_ref: number }>()
  if (!article) return null
  const postRef = article.post_ref

  let active: Awaited<ReturnType<typeof findActiveRevision>> = null
  try {
    active = await findActiveRevision(db, articleId)
  } catch {
    active = null
  }
  if (active) {
    return {
      content: active.content,
      contentHash: active.content_sha256,
      version: active.revision_number,
      postRef,
    }
  }

  const versionRow = await db
    .prepare(
      `SELECT version, snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<{ version: number; snapshot_json: string; content_snapshot_sha256: string | null }>()
  if (!versionRow) return null

  let originalContent = ''
  try {
    const record: { original_content?: string | null } = JSON.parse(versionRow.snapshot_json)
    originalContent = record.original_content ?? ''
  } catch {
    originalContent = ''
  }
  if (!originalContent) return null

  return {
    content: originalContent,
    contentHash: versionRow.content_snapshot_sha256 ?? snapshotContentHash({ content: originalContent }),
    version: versionRow.version,
    postRef,
  }
}

/**
 * Request a LOCAL AI suggestion for the selected text and record it as a
 * version-bound `content` suggestion. Best-effort: any failure returns an error
 * outcome and never touches the author's article, save or publish state.
 */
export async function requestMobileSuggestion(
  db: Database,
  input: RequestMobileSuggestionInput,
): Promise<RequestMobileSuggestionResult> {
  const articleId = input.articleId
  const selectedText = (input.selectedText ?? '').trim()
  const operationId = (input.operationId ?? '').trim()
  const actor = (input.actor ?? '').trim()

  if (!articleId) return { outcome: 'invalid', articleId, reason: 'requestMobileSuggestion: articleId is required' }
  if (!selectedText) return { outcome: 'invalid', articleId, reason: 'requestMobileSuggestion: selectedText is required' }
  if (!operationId) return { outcome: 'invalid', articleId, reason: 'requestMobileSuggestion: operationId is required' }
  if (!actor) return { outcome: 'invalid', articleId, reason: 'requestMobileSuggestion: actor is required' }

  const basis = await resolveMobileSuggestionBasis(db, articleId)
  if (!basis) {
    return { outcome: 'no-current-state', articleId, reason: 'requestMobileSuggestion: no resolvable current version' }
  }

  const suggestion = buildContentSuggestion(basis.content, selectedText)
  if (!suggestion) {
    // The selection is absent from the current server body — the author has
    // unconfirmed edits (or selected something not yet saved). Never fabricate:
    // ask them to save the body first so the suggestion is bound to a real version.
    if (basis.content.indexOf(selectedText) < 0) {
      return { outcome: 'not-found', articleId, reason: MANUAL_REWRITE_HINT }
    }
    return { outcome: 'no-change', articleId, reason: 'selection already matches the suggested rewrite' }
  }

  // Record via the SHARED #38 protocol (same tables, same version binding,
  // same staleness). The mobile layer stops here — it never writes a post fact.
  const source = `${MOBILE_AI_SOURCE_PREFIX}:${operationId}`
  const recorded = await recordPreparedSuggestions(db, {
    articleId,
    postRef: basis.postRef,
    boundVersion: basis.version,
    boundRevision: null,
    source,
    basisSha256: basis.contentHash,
    suggestions: [
      {
        field: 'content',
        value: JSON.stringify(suggestion.value),
        fieldBefore: JSON.stringify(suggestion.before),
      },
    ],
  })

  if (recorded.outcome === 'replayed') {
    const existing = await findRecordedSuggestion(db, articleId, source)
    if (existing) {
      return {
        outcome: 'recorded',
        articleId,
        preparationId: existing.preparation_id,
        suggestionId: existing.suggestion_id,
        field: 'content',
        value: suggestion.value,
        before: suggestion.before,
        boundVersion: basis.version,
      }
    }
    return { outcome: 'invalid', articleId, reason: 'requestMobileSuggestion: replayed without a record' }
  }
  if (recorded.outcome !== 'recorded') {
    return { outcome: 'invalid', articleId, reason: recorded.reason }
  }

  const suggestionId = `suggest:${articleId}:content:${source}`
  return {
    outcome: 'recorded',
    articleId,
    preparationId: recorded.preparationId,
    suggestionId,
    field: 'content',
    value: suggestion.value,
    before: suggestion.before,
    boundVersion: recorded.boundVersion,
  }
}

async function findRecordedSuggestion(
  db: Database,
  articleId: number,
  source: string,
): Promise<{ preparation_id: string; suggestion_id: string } | null> {
  return db
    .prepare(
      `SELECT p.preparation_id, s.suggestion_id
       FROM publish_preparations p
       JOIN publish_suggestions s ON s.preparation_id = p.preparation_id
       WHERE p.article_id = ? AND p.source = ? AND s.field = 'content' LIMIT 1`,
    )
    .bind(articleId, source)
    .first<{ preparation_id: string; suggestion_id: string }>()
}
