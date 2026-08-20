'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarHeart, LayoutGrid, PenLine } from 'lucide-react'
import { MOBILE_NAV_ITEMS, getActiveMobileNavKey, type MobileNavItem } from '@/lib/mobile-nav/model'

/**
 * B8-01 — mobile bottom navigation bar (issue #60).
 *
 * Mobile-only (`md:hidden`) fixed bottom bar with 今天/文章/新建. It only
 * NAVIGATES between the three entry points — it never renders command buttons
 * and never carries stale state. 新建 is a prominent action surface that opens
 * the editor (a "short task"); the editor itself returns the user to 今天.
 */
export function MobileAdminNav() {
  const pathname = usePathname()
  const activeKey = getActiveMobileNavKey(pathname)

  return (
    <nav
      aria-label="移动端主导航"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-[var(--editor-line)] bg-[var(--editor-panel)]/95 backdrop-blur"
    >
      <div className="grid grid-cols-3 h-16 max-w-md mx-auto">
        {MOBILE_NAV_ITEMS.map((item) => (
          <MobileNavLink key={item.key} item={item} active={activeKey === item.key} />
        ))}
      </div>
    </nav>
  )
}

function MobileNavLink({ item, active }: { item: MobileNavItem; active: boolean }) {
  const Icon = item.key === 'today' ? CalendarHeart : item.key === 'posts' ? LayoutGrid : PenLine
  const isAction = item.key === 'new'

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
        isAction
          ? 'text-[var(--editor-accent)]'
          : active
            ? 'text-[var(--editor-accent)]'
            : 'text-[var(--editor-muted)]'
      }`}
    >
      <span
        className={`grid h-9 w-14 place-items-center rounded-xl ${
          active && !isAction ? 'bg-[var(--editor-accent)]/10' : ''
        }`}
      >
        <Icon className="w-5 h-5" />
      </span>
      <span>{item.label}</span>
    </Link>
  )
}
