/**
 * Article Command Client — pure wire adapter (CONTEXT.md).
 *
 * Factory-injected fetch + operation-id keep the /api/article-commands
 * contract testable without React or a server: tests assert the exact
 * request bodies and the normalization of every outcome the wire emits
 * (issue #19 / PR #239 was exactly a caller drifting off this contract).
 *
 * The legacy direct-write bypass for ledger-only rows (null identity
 * facts → PUT /api/admin/posts/[slug]) is part of this interface on
 * purpose: callers must not decide which wire to use. When that bypass
 * retires, it dies here alone.
 */

import type {
  ArticleCommandOutcome,
  ArticleCommandRequest,
  ArticleCommandTarget,
  BatchCategoryItem,
  BatchCategoryOutcome,
  FetchLike,
} from './types'

const COMMAND_URL = '/api/article-commands'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function defaultOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * Legacy direct-write body per action, byte-compatible with the mapping
 * table PostRow used to inline. `unpublish` / `relive` never legitimately
 * reach the legacy wire (callers only send them under versioned
 * authority); they map to an empty body as the old code did.
 */
function legacyBody(request: ArticleCommandRequest): Record<string, unknown> {
  switch (request.action) {
    case 'setPinned':
      return { is_pinned: request.is_pinned }
    case 'setHidden':
      return { is_hidden: request.is_hidden }
    case 'setPassword':
      return { password: request.password }
    case 'setCategory':
      return { category: request.category }
    case 'softDelete':
      return { status: 'deleted' }
    case 'restore':
      return { status: 'draft' }
    case 'publishTemp':
      return { status: request.status }
    default:
      return {}
  }
}

export interface ArticleCommandClient {
  /** Execute one command for one target row on the single wire. */
  execute(target: ArticleCommandTarget, request: ArticleCommandRequest): Promise<ArticleCommandOutcome>
  /** Batch classification; every item reports into the aggregated counts. */
  runBatchCategory(items: BatchCategoryItem[]): Promise<BatchCategoryOutcome>
}

export function createArticleCommandClient(
  options: { fetchImpl?: FetchLike; newOperationId?: () => string } = {},
): ArticleCommandClient {
  const doFetch: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init as unknown as RequestInit) as Promise<Pick<Response, 'ok' | 'json'>>)
  const newOperationId = options.newOperationId ?? defaultOperationId

  async function interpret(res: Pick<Response, 'ok' | 'json'>): Promise<ArticleCommandOutcome> {
    const data = (await res.json().catch(() => ({}))) as {
      outcome?: string
      error?: unknown
      serverVersion?: unknown
    }
    if (
      res.ok &&
      (data.outcome === undefined || data.outcome === 'applied' || data.outcome === 'replayed' || data.outcome === 'legacy-applied')
    ) {
      return { kind: 'ok', ok: true, replayed: data.outcome === 'replayed' }
    }
    if (data.outcome === 'conflict') {
      return {
        kind: 'conflict',
        ok: false,
        serverVersion: typeof data.serverVersion === 'number' ? data.serverVersion : undefined,
      }
    }
    return { kind: 'error', ok: false, message: typeof data.error === 'string' && data.error ? data.error : '操作失败，请重试' }
  }

  return {
    async execute(target, request) {
      const hasAuthority = typeof target.articleId === 'number' && typeof target.expectedVersion === 'number'
      try {
        let res: Pick<Response, 'ok' | 'json'>
        if (hasAuthority) {
          const { action, ...payload } = request
          res = await doFetch(COMMAND_URL, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
              action,
              slug: target.slug,
              articleId: target.articleId,
              expectedVersion: target.expectedVersion,
              operationId: newOperationId(),
              ...payload,
            }),
          })
        } else {
          res = await doFetch(`/api/admin/posts/${encodeURIComponent(target.slug)}`, {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify(legacyBody(request)),
          })
        }
        return await interpret(res)
      } catch {
        return { kind: 'error', ok: false, message: '网络错误，请重试' }
      }
    },

    async runBatchCategory(items) {
      const wireItems = items.map(({ slug, articleId, expectedVersion, category }) => ({
        slug,
        articleId,
        expectedVersion,
        operationId: newOperationId(),
        category,
      }))
      try {
        const res = await doFetch(COMMAND_URL, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ action: 'batchSetCategory', items: wireItems }),
        })
        const data = (await res.json().catch(() => ({}))) as { items?: Array<{ outcome?: string }>; error?: unknown }
        if (!res.ok) {
          return { ok: false, message: typeof data.error === 'string' && data.error ? data.error : '批量分类失败' }
        }
        const results = Array.isArray(data.items) ? data.items : []
        const applied = results.filter((r) => r.outcome === 'applied' || r.outcome === 'legacy-applied').length
        const conflicts = results.filter((r) => r.outcome === 'conflict').length
        const skipped = results.filter((r) => r.outcome === 'invalid' || r.outcome === 'not-found' || r.outcome === 'error').length
        return { ok: true, applied, conflicts, skipped }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '批量分类失败' }
      }
    },
  }
}
