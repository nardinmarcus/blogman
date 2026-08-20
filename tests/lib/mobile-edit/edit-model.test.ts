/**
 * B8-02 — mobile small-edit read model tests (issue #61).
 *
 * Verification for the mobile editing rules, run in plain node (no browser):
 *
 *   - 小修保存确认: status labels only claim "已保存" for the server-confirmed state
 *   - 复杂块只读: paragraphs/headings are editable; tables/code/media/lists nest contexts are not
 *   - 断网/冲突 protocol is inherited from B2-04 coordinator (already covered) — here we
 *     mirror the pieces the mobile surface adds: draft namespace isolation + handoff identity.
 *   - 交接桌面: the handoff URL carries only identity/location (slug), never content.
 */

import { describe, expect, it } from 'vitest'
import {
  MOBILE_EDITABLE_NODE_TYPES,
  desktopHandoffUrl,
  hasComplexBlock,
  isComplexBlockType,
  isEditableContext,
  mobileSaveStatusLabel,
} from '@/lib/mobile-edit/edit-model'
import { isMobileUserAgent, wantsDesktop } from '@/lib/mobile-edit/is-mobile'

describe('mobile-edit model — editable surfaces', () => {
  it('treats paragraph/heading as editable and rich blocks as complex', () => {
    expect(isComplexBlockType('paragraph')).toBe(false)
    expect(isComplexBlockType('heading')).toBe(false)
    expect(isComplexBlockType('table')).toBe(true)
    expect(isComplexBlockType('tableCell')).toBe(true)
    expect(isComplexBlockType('codeBlock')).toBe(true)
    expect(isComplexBlockType('image')).toBe(true)
    expect(isComplexBlockType('video')).toBe(true)
    expect(isComplexBlockType('math')).toBe(true)
  })

  it('isEditableContext allows plain paragraphs/headings', () => {
    expect(isEditableContext(['doc', 'paragraph', 'text'])).toBe(true)
    expect(isEditableContext(['doc', 'heading', 'text'])).toBe(true)
    expect(isEditableContext(['doc', 'bulletList', 'listItem', 'paragraph', 'text'])).toBe(true)
  })

  it('isEditableContext rejects any complex ancestor (complex blocks are read-only)', () => {
    expect(isEditableContext(['doc', 'table', 'tableRow', 'tableCell', 'paragraph', 'text'])).toBe(false)
    expect(isEditableContext(['doc', 'codeBlock', 'text'])).toBe(false)
    expect(isEditableContext(['doc', 'paragraph', 'text', 'image'])).toBe(false)
    // an empty / doc-only context is editable
    expect(isEditableContext(MOBILE_EDITABLE_NODE_TYPES)).toBe(true)
  })

  it('hasComplexBlock detects a complex block anywhere in the document', () => {
    expect(
      hasComplexBlock({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })
    ).toBe(false)
    expect(hasComplexBlock({ type: 'doc', content: [{ type: 'table' }] })).toBe(true)
    expect(
      hasComplexBlock({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ok' }] }, { type: 'video' }] })
    ).toBe(true)
    expect(hasComplexBlock(null)).toBe(false)
  })
})

describe('mobile-edit model — save confirmation label', () => {
  it('only claims 已保存 for the server-confirmed status', () => {
    expect(mobileSaveStatusLabel('saved')).toBe('已保存')
    expect(mobileSaveStatusLabel('dirty')).toBe('未保存')
    expect(mobileSaveStatusLabel('saving')).toBe('保存中…')
    expect(mobileSaveStatusLabel('error')).toBe('保存失败')
    expect(mobileSaveStatusLabel('conflict')).toBe('版本冲突')
  })
})

describe('mobile-edit model — desktop handoff carries only identity/location', () => {
  it('builds an editor deep-link from the slug only (no content)', () => {
    expect(desktopHandoffUrl('hello-world')).toBe('/editor?edit=hello-world&desktop=1')
    expect(desktopHandoffUrl('带空格 slug')).toBe('/editor?edit=%E5%B8%A6%E7%A9%BA%E6%A0%BC%20slug&desktop=1')
    expect(desktopHandoffUrl('')).toBe('/editor')
    expect(desktopHandoffUrl(undefined)).toBe('/editor')
  })
})

describe('mobile-edit model — user agent + desktop hint', () => {
  it('identifies common mobile user agents and truthy desktop hint', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7)')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')).toBe(false)
    expect(isMobileUserAgent(null)).toBe(false)
    expect(wantsDesktop('1')).toBe(true)
    expect(wantsDesktop('true')).toBe(true)
    expect(wantsDesktop(undefined)).toBe(false)
    expect(wantsDesktop('0')).toBe(false)
  })
})
