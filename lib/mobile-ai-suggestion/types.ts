/**
 * B8-03 — mobile local-AI suggestion shared types (issue #62).
 *
 * The mobile "局部 AI" affordance: the author selects text and asks for a local
 * suggestion. The suggestion is a `content`-field version-bound suggestion
 * recorded into the shared #38 suggestion tables (same version binding + staleness
 * as desktop publish suggestions); the existing-suggestion list (preview /
 * apply / revoke / ignore) is the SAME #38 model — no mobile-specific state or
 * version is introduced.
 */

/** The existing version-bound suggestion state (shared #38 read model). */
export type MobileAiSuggestionState = import('@/lib/publish-suggestions/types').SuggestionState

export type MobileAiSuggestionRead = import('@/lib/publish-suggestions/types').SuggestionRead
export type MobileAiPreparationRead = import('@/lib/publish-suggestions/types').PreparationRead

export interface RequestMobileSuggestionInput {
  articleId: number
  /** The exact text currently selected in the mobile editor. */
  selectedText: string
  /** Idempotency key / AI run id for the recorded preparation (source). */
  operationId: string
  actor: string
  now?: number
}

export type RequestMobileSuggestionResult =
  | {
      outcome: 'recorded'
      articleId: number
      preparationId: string
      suggestionId: string
      /** 'content' — the mobile local rewrite is a version-bound body suggestion. */
      field: 'content'
      /** The revised body (suggested value) for the author to preview. */
      value: string
      /** The body the suggestion was anchored on. */
      before: string
      boundVersion: number
    }
  | { outcome: 'no-change'; articleId: number; reason: string }
  | { outcome: 'not-found'; articleId: number; reason: string }
  | { outcome: 'invalid'; articleId: number; reason: string }
  | { outcome: 'no-current-state'; articleId: number; reason: string }
