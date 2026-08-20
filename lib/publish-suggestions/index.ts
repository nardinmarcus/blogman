/**
 * B3-06 — version-bound publish suggestions (issue #38).
 *
 * Public entry: the author preview/apply/revoke/ignore surface for a
 * deterministic per-article analysis result. The background AI records
 * VERSION-BOUND SUGGESTIONS (no live write); an explicit author APPLY goes
 * through the shared article write kernel and creates at most ONE restore point
 * per result. Staleness (late version, changed body, changed field, TTL expiry)
 * is enforced at apply time so a result is never silently written.
 */

export {
  applySuggestion,
  ignoreSuggestion,
  readSuggestionState,
  recordPreparedSuggestions,
  revokeSuggestion,
  SUGGESTION_TTL,
  DEFAULT_SUGGESTION_FIELDS,
} from './kernel'
export { PUBLISH_SUGGESTIONS_DDL_STATEMENTS, ensurePublishSuggestionsTables } from './ddl'
export type {
  ApplySuggestionInput,
  ApplySuggestionResult,
  IgnoreSuggestionInput,
  IgnoreSuggestionResult,
  PreparationRead,
  PreparationRow,
  PreparationStatus,
  PreparedSuggestion,
  RecordPreparedSuggestionsInput,
  RecordPreparedSuggestionsResult,
  RevokeSuggestionInput,
  RevokeSuggestionResult,
  SuggestionField,
  SuggestionRead,
  SuggestionRow,
  SuggestionState,
  SuggestionStatus,
} from './types'
