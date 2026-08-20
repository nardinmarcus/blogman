/**
 * B8-03 — mobile local-AI suggestion UI model (issue #62).
 *
 * Pure, framework-free rules for the mobile "局部 AI" tray over the SHARED #38
 * read model. It decides which author actions are offered per suggestion and
 * labels each status in the mobile surface — kept out of React so it unit-tests
 * in plain node, mirroring B8-02's edit-model.
 */

import type { SuggestionStatus } from '@/lib/publish-suggestions/types'

/** Actions the mobile tray offers for one suggestion state. */
export interface SuggestionActions {
  canApply: boolean
  canRevoke: boolean
  canIgnore: boolean
}

export function suggestionActions(status: SuggestionStatus): SuggestionActions {
  switch (status) {
    case 'pending':
      // A fresh, still-bound suggestion: preview → apply, or ignore.
      return { canApply: true, canRevoke: false, canIgnore: true }
    case 'applied':
      // Already applied: offer undo (back to the anchored body) — no re-apply.
      return { canApply: false, canRevoke: true, canIgnore: false }
    case 'ignored':
    case 'revoked':
    case 'stale':
    case 'abandoned':
      // Decided / drifted / superseded — no further action.
      return { canApply: false, canRevoke: false, canIgnore: false }
    default:
      return { canApply: false, canRevoke: false, canIgnore: false }
  }
}

export function suggestionStatusLabel(status: SuggestionStatus): string {
  switch (status) {
    case 'pending':
      return '待应用'
    case 'applied':
      return '已应用'
    case 'ignored':
      return '已忽略'
    case 'revoked':
      return '已撤销'
    case 'stale':
      return '已过期（正文已变）'
    case 'abandoned':
      return '已作废'
    default:
      return status
  }
}

/** Whether the mobile "局部 AI" affordance can be offered at all. */
export function canRequestLocalAi(selectedText: string | null | undefined): boolean {
  return Boolean(selectedText && selectedText.trim())
}
