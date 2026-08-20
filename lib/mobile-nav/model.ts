/**
 * B8-01 — mobile bottom-bar navigation model (issue #60).
 *
 * Pure, framework-free read model for the mobile 今天/文章/新建 bottom bar.
 * Kept separate from the React component so the routing rules are unit-testable
 * without a rendering environment: the bottom bar only ever NAVIGATES between
 * these three entry points, and the descriptors below are the single source of
 * truth for hrefs, labels, and active-state matching.
 */

export type MobileNavKey = 'today' | 'posts' | 'new'

export interface MobileNavItem {
  key: MobileNavKey
  label: string
  href: string
  /**
   * Pathname prefixes that mark this item as active (today & posts). The
   * "新建" entry is intentionally never active — the editor is a task surface,
   * not a tab.
   */
  activePrefixes: string[]
}

export const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  {
    key: 'today',
    label: '今天',
    href: '/admin/today',
    activePrefixes: ['/admin/today'],
  },
  {
    key: 'posts',
    label: '文章',
    href: '/admin/posts',
    activePrefixes: ['/admin/posts'],
  },
  {
    key: 'new',
    label: '新建',
    href: '/editor',
    activePrefixes: [],
  },
]

/**
 * Map a current pathname to the active mobile-nav key, or null when none of the
 * bottom-bar tabs is active (e.g. on the editor — it is not a tab).
 */
export function getActiveMobileNavKey(pathname: string): MobileNavKey | null {
  for (const item of MOBILE_NAV_ITEMS) {
    for (const prefix of item.activePrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return item.key
    }
  }
  return null
}
