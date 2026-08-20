/**
 * B8-03 — mobile local-AI suggestion module index (issue #62).
 *
 * The mobile "局部 AI" surface is a thin wrapper over the SHARED #38 suggestion
 * protocol. It exposes the local (mock-AI) request kernel plus, VERBATIM, the
 * #38 author commands the mobile suggestion list reuses — preview
 * (`readSuggestionState`), apply (`applySuggestion`), undo (`revokeSuggestion`)
 * and ignore (`ignoreSuggestion`). No mobile-specific version or suggestion
 * state is added; the mobile feature is a transport over the same facts.
 */

export * from './types'
export * from './mock-ai'
export * from './kernel'
export * from './ui-model'

// The shared #38 commands — reused verbatim so the mobile list has byte-for-byte
// DB behaviour (staleness, expected-version applies, restore-point-once).
export {
  applySuggestion,
  revokeSuggestion,
  ignoreSuggestion,
  readSuggestionState,
  SUGGESTION_TTL,
} from '@/lib/publish-suggestions'

export type {
  ApplySuggestionInput,
  ApplySuggestionResult,
  RevokeSuggestionInput,
  RevokeSuggestionResult,
  IgnoreSuggestionInput,
  IgnoreSuggestionResult,
} from '@/lib/publish-suggestions'
