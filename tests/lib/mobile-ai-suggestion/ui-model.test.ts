/**
 * B8-03 — mobile local-AI suggestion UI-model tests (issue #62).
 *
 * The mobile tray action surface over the shared suggestion lifecycle: pending
 * can be applied or ignored; applied can only be undone; decided/drifted/
 * superseded states are inert. Plus the "局部 AI" affordance gating on a real
 * selection.
 */

import { describe, expect, it } from 'vitest'
import {
  canRequestLocalAi,
  suggestionActions,
  suggestionStatusLabel,
} from '@/lib/mobile-ai-suggestion'

describe('mobile local-AI tray — per-status actions (preview/apply/undo/ignore)', () => {
  it('pending → apply or ignore', () => {
    expect(suggestionActions('pending')).toEqual({ canApply: true, canRevoke: false, canIgnore: true })
  })

  it('applied → undo only (revoke), never re-apply', () => {
    expect(suggestionActions('applied')).toEqual({ canApply: false, canRevoke: true, canIgnore: false })
  })

  it('decided / stale / abandoned → inert (no silent action)', () => {
    for (const status of ['ignored', 'revoked', 'stale', 'abandoned'] as const) {
      expect(suggestionActions(status)).toEqual({ canApply: false, canRevoke: false, canIgnore: false })
    }
  })
})

describe('mobile local-AI tray — status labels', () => {
  it('labels every lifecycle status', () => {
    expect(suggestionStatusLabel('pending')).toBe('待应用')
    expect(suggestionStatusLabel('applied')).toBe('已应用')
    expect(suggestionStatusLabel('ignored')).toBe('已忽略')
    expect(suggestionStatusLabel('revoked')).toBe('已撤销')
    expect(suggestionStatusLabel('stale')).toBe('已过期（正文已变）')
    expect(suggestionStatusLabel('abandoned')).toBe('已作废')
  })
})

describe('mobile local-AI affordance — gating on a selection', () => {
  it('only offers the request when the author selected non-empty text', () => {
    expect(canRequestLocalAi('选中文字')).toBe(true)
    expect(canRequestLocalAi('   ')).toBe(false)
    expect(canRequestLocalAi('')).toBe(false)
    expect(canRequestLocalAi(null)).toBe(false)
    expect(canRequestLocalAi(undefined)).toBe(false)
  })
})
