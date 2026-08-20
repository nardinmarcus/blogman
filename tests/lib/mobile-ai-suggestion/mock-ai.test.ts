/**
 * B8-03 — mobile local-AI mock generator tests (issue #62).
 *
 * Component-level (pure, no DB): the mock "AI" must be deterministic, produce a
 * real but local rewrite of ONLY the selected text, never touch the rest of the
 * body, and never auto-apply. This is the unit that makes the mobile affordance
 * reviewable without arming a model.
 */

import { describe, expect, it } from 'vitest'
import { buildContentSuggestion, normalizeSuggestionText } from '@/lib/mobile-ai-suggestion'

describe('mobile local-AI mock — normalizeSuggestionText', () => {
  it('collapses whitespace runs and trims the selected text', () => {
    expect(normalizeSuggestionText('  一  段  分隔  文本  ')).toBe('一 段 分隔 文本')
    expect(normalizeSuggestionText('多行\n\n文本\r\n段')).toBe('多行 文本 段')
    expect(normalizeSuggestionText('  干净')).toBe('干净')
  })

  it('is deterministic (same input → same output)', () => {
    expect(normalizeSuggestionText('a  b  c')).toBe(normalizeSuggestionText('a  b  c'))
  })
})

describe('mobile local-AI mock — buildContentSuggestion', () => {
  const body = '# 标题\n\n第一段  这里  有  空格。\n\n第二段。'
  const sel = '这里  有  空格'

  it('rewrites ONLY the selected text and keeps the rest of the body intact', () => {
    const s = buildContentSuggestion(body, sel)
    expect(s).not.toBeNull()
    if (!s) return
    expect(s.value).toBe('# 标题\n\n第一段  这里 有 空格。\n\n第二段。')
    expect(s.value).not.toBe(body) // a real change (local)
    expect(s.before).toBe(body) // anchored on the exact current body
    // The surrounding body is untouched — only the selection span changed.
    expect(s.value.startsWith('# 标题\n\n第一段 ')).toBe(true)
    expect(s.value.endsWith('。\n\n第二段。')).toBe(true)
  })

  it('returns null when the selection is empty', () => {
    expect(buildContentSuggestion(body, '')).toBeNull()
    expect(buildContentSuggestion(body, '   ')).toBeNull()
  })

  it('returns null when the selection is not present in the body', () => {
    expect(buildContentSuggestion(body, '不存在的文本')).toBeNull()
  })

  it('returns null when the selection already matches the rewrite (nothing to suggest)', () => {
    const clean = '# 标题\n\n第一段 干净 无 空格。'
    expect(buildContentSuggestion(clean, '干净 无 空格')).toBeNull()
  })
})
