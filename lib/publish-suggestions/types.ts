/**
 * B3-06 — version-bound publish suggestion shared types (issue #38).
 *
 * The author-facing surface for a deterministic per-article analysis result.
 * The background AI no longer writes metadata straight into a revision / draft
 * — it records VERSION-BOUND SUGGESTIONS the author previews, applies, revokes
 * or ignores per item. Every fact here is bound to the exact version the AI
 * anchored to (revision number when the article is under a formal active
 * revision, else the article_versions version), so a late result or a field
 * the author has since moved never silently lands on the post.
 */

/** The suggestion surfaces the resolver can produce (metadata gap-fill + content). */
export type SuggestionField = 'category' | 'tags' | 'description' | 'title' | 'content'

/** Lifecycle of one per-item suggestion. */
export type SuggestionStatus = 'pending' | 'applied' | 'ignored' | 'revoked' | 'stale' | 'abandoned'

/**
 * Lifecycle of one analysis RESULT (the per-article current preparation).
 * A result carries ≤ 3 pending suggestions (the 3 metadata gap-fill fields).
 */
export type PreparationStatus = 'recorded' | 'applied' | 'abandoned'

/** One recorded analysis result (the "current preparation result" per article). */
export interface PreparationRow {
  id: number
  preparation_id: string
  article_id: number
  post_ref: number
  /** The version/revision number the analysis was bound to. */
  bound_version: number
  /** The active-revision id when bound to a formal revision, else null. */
  bound_revision: string | null
  /** The AI run / operation id that produced this preparation. */
  source: string
  status: PreparationStatus
  /**
   * The pre-apply restore point for this result. Created ONCE on the first
   * apply of any suggestion in this preparation and reused for the rest —
   * "同一结果首次应用只建一个恢复点".
   */
  restore_point_id: string | null
  created_at: number
  applied_at: number | null
  updated_at: number
}

/** One per-item suggestion row. */
export interface SuggestionRow {
  id: number
  suggestion_id: string
  preparation_id: string
  article_id: number
  field: SuggestionField
  /** JSON-encoded suggested value (`"技术"` / `["a","b"]` / `"文本"`). */
  value: string
  /**
   * JSON-encoded value of this field at analysis time (the gap baseline). A
   * suggestion whose field has diverged from this baseline is field-stale.
   */
  field_before: string | null
  /** Canonical content hash the analysis was anchored to (staleness basis). */
  basis_sha256: string
  bound_version: number
  status: SuggestionStatus
  applied_operation_id: string | null
  created_at: number
  decided_at: number | null
  updated_at: number
}

/* ------------------------------------------------------------------ */
/* record — the background AI writes NO live facts, only suggestions   */
/* ------------------------------------------------------------------ */

/** One gap-fill suggestion the deterministic resolver proposes. */
export interface PreparedSuggestion {
  field: SuggestionField
  /** JSON-encoded suggested value. */
  value: string
  /** JSON-encoded field value at analysis time (the gap baseline). */
  fieldBefore: string
}

export interface RecordPreparedSuggestionsInput {
  articleId: number
  postRef: number
  /** Revision number (active revision) or article_versions version. */
  boundVersion: number
  /** The active-revision id when bound to a formal revision, else null. */
  boundRevision?: string | null
  /** The AI run / operation id (idempotency key for this preparation). */
  source: string
  /** Canonical content hash the analysis was anchored to. */
  basisSha256: string
  suggestions: PreparedSuggestion[]
  now?: number
}

export type RecordPreparedSuggestionsResult =
  | {
      outcome: 'recorded'
      articleId: number
      preparationId: string
      boundVersion: number
      suggestions: number
      /** Suggestions abandoned to keep the per-article pending cap (≤ 3). */
      superseded: number
    }
  | { outcome: 'replayed'; articleId: number; preparationId: string }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* author actions — preview / apply / revoke / ignore                  */
/* ------------------------------------------------------------------ */

export interface ApplySuggestionInput {
  suggestionId: string
  actor: string
  /** Idempotency key for the kernel save that carries the field change. */
  operationId: string
  now?: number
  projections?: import('@/lib/article-commands/types').ArticleCommandProjections
}

export type ApplySuggestionResult =
  | {
      outcome: 'applied'
      suggestionId: string
      articleId: number
      preparationId: string
      field: SuggestionField
      version: number
      operationId: string
      restorePointId: string | null
      revisionId: string | null
    }
  | { outcome: 'replayed'; suggestionId: string; articleId: number; version: number }
  | { outcome: 'stale'; suggestionId: string; articleId: number; reason: string }
  | { outcome: 'conflict'; suggestionId: string; articleId: number; reason: string; operationId: string }
  | { outcome: 'ignored'; suggestionId: string; articleId: number; reason: 'already-ignored' | string }
  | { outcome: 'revoked'; suggestionId: string; articleId: number; reason: 'already-revoked' | string }
  | { outcome: 'not-found'; reason: string }
  | { outcome: 'invalid'; reason: string }

export interface RevokeSuggestionInput {
  suggestionId: string
  actor: string
  operationId: string
  now?: number
  projections?: import('@/lib/article-commands/types').ArticleCommandProjections
}

export type RevokeSuggestionResult =
  | {
      outcome: 'revoked'
      suggestionId: string
      articleId: number
      field: SuggestionField
      version: number
      operationId: string
    }
  | { outcome: 'replayed'; suggestionId: string; articleId: number }
  | { outcome: 'conflict'; suggestionId: string; articleId: number; reason: string; operationId: string }
  | { outcome: 'not-found'; reason: string }
  | { outcome: 'invalid'; reason: string }

export interface IgnoreSuggestionInput {
  suggestionId: string
  actor: string
  now?: number
}

export type IgnoreSuggestionResult =
  | { outcome: 'ignored'; suggestionId: string; articleId: number }
  | { outcome: 'replayed'; suggestionId: string; articleId: number }
  | { outcome: 'conflict'; suggestionId: string; articleId: number; reason: string }
  | { outcome: 'not-found'; reason: string }
  | { outcome: 'invalid'; reason: string }

/* ------------------------------------------------------------------ */
/* read / preview                                                      */
/* ------------------------------------------------------------------ */

export interface SuggestionRead {
  suggestionId: string
  field: SuggestionField
  /** Parsed suggested value (mirrors the snapshot field type). */
  value: string | string[] | null
  status: SuggestionStatus
  boundVersion: number
  basisSha256: string
  createdAt: number
  decidedAt: number | null
}

export interface PreparationRead {
  preparationId: string
  source: string
  boundVersion: number
  status: PreparationStatus
  restorePointId: string | null
  createdAt: number
  appliedAt: number | null
  suggestions: SuggestionRead[]
}

export interface SuggestionState {
  articleId: number
  postRef: number
  /** The current version suggestions are compared against. */
  currentVersion: number
  activeRevision: { revisionId: string; revisionNumber: number } | null
  preparations: PreparationRead[]
}
