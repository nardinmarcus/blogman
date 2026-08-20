/**
 * B8-01 — mobile bottom-bar navigation model tests (issue #60).
 *
 * The bottom bar is a pure navigation surface: it must route to exactly
 * 今天/文章/新建, compute one active state from the current pathname, and never
 * expose command actions (no direct publish/lifecycle execution from cards).
 */

import { describe, expect, it } from 'vitest'
import { MOBILE_NAV_ITEMS, getActiveMobileNavKey } from '@/lib/mobile-nav/model'

describe('mobile bottom-bar nav items (底栏路由)', () => {
  it('exposes exactly today / posts / new with the correct hrefs', () => {
    expect(MOBILE_NAV_ITEMS.map((i) => i.key)).toEqual(['today', 'posts', 'new'])
    expect(MOBILE_NAV_ITEMS.map((i) => i.href)).toEqual([
      '/admin/today',
      '/admin/posts',
      '/editor',
    ])
    expect(MOBILE_NAV_ITEMS.map((i) => i.label)).toEqual(['今天', '文章', '新建'])
  })

  it('is purely navigational — no item carries a command shape', () => {
    // Cards / nav entries must only navigate; they must not describe an action
    // that a client could dispatch (无命令执行副作用).
    for (const item of MOBILE_NAV_ITEMS) {
      expect(Object.keys(item)).toEqual(['key', 'label', 'href', 'activePrefixes'])
      expect(item.href.startsWith('/')).toBe(true)
    }
  })
})

describe('getActiveMobileNavKey (路由高亮)', () => {
  it('marks today active on the today workbench', () => {
    expect(getActiveMobileNavKey('/admin/today')).toBe('today')
  })

  it('marks posts active on the articles list', () => {
    expect(getActiveMobileNavKey('/admin/posts')).toBe('posts')
  })

  it('never marks the new/editor tab active (it is a task surface, not a tab)', () => {
    expect(getActiveMobileNavKey('/editor')).toBeNull()
  })

  it('is null for unrelated admin paths', () => {
    expect(getActiveMobileNavKey('/admin/settings')).toBeNull()
    expect(getActiveMobileNavKey('/admin/categories')).toBeNull()
  })
})
