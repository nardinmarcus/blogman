/**
 * B8-03 — mobile local-AI suggestion generator (issue #62).
 *
 * ZERO-production stand-in for the remote AI. The mobile "局部 AI" affordance
 * asks the author to select text; here a DETERMINISTIC, on-device-local mock
 * rewrites exactly that selection (never auto-applies, never rewrites the whole
 * article). The mock only normalises whitespace of the selected text so the
 * suggestion is a real, visible small change bound to the version the author is
 * editing — while staying trivially testable and obviously not a model.
 *
 * The suggestion it produces is a `content`-field version-bound suggestion in
 * the shared #38 storage: `value` is the current body with ONLY the selected
 * text replaced, and `before` is the unchanged body the author anchored on.
 * The mobile layer never writes a live fact; apply/undo/ignore go through the
 * shared publish-suggestion kernel.
 */

export interface ContentSuggestion {
  /** The full revised body (current body with the selected text replaced). */
  value: string
  /** The full body the suggestion was anchored on (the apply/undo baseline). */
  before: string
}

/**
 * The mock "local AI": normalise the selected text — collapse any run of
 * whitespace (including newlines) to a single space and trim the edges. The
 * output is deterministic and plainly mechanical; it exists to give the mobile
 * suggestion affordance a real, reviewable change without arming a model.
 */
export function normalizeSuggestionText(selectedText: string): string {
  return selectedText.replace(/\s+/gu, ' ').trim()
}

/**
 * Returns a version-bound `content` suggestion whose `value` is the body with
 * the FIRST exact occurrence of `selectedText` replaced by the normalised
 * rewrite. `null` when the selection is empty, is not present in the body, or
 * already matches the rewrite (nothing to suggest).
 */
export function buildContentSuggestion(body: string, selectedText: string): ContentSuggestion | null {
  const sel = selectedText ?? ''
  if (!sel.trim()) return null
  const rewrite = normalizeSuggestionText(sel)
  if (!rewrite) return null

  // Anchor on the exact selected span as found in the body (first occurrence).
  const start = body.indexOf(sel)
  if (start < 0) return null
  const before = body
  const value = before.slice(0, start) + rewrite + before.slice(start + sel.length)
  if (value === before) return null
  return { value, before }
}
