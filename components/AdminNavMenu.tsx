'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { Menu as MenuIcon, Settings, ExternalLink, LayoutGrid, LogOut } from 'lucide-react'

/**
 * B8-01 — mobile admin menu (issue #60).
 *
 * Mobile-only (`md:hidden`) overflow menu that moves 设置 / 查看博客 / 退出 out
 * of the cramped inline header into a single tap target, keeping the primary
 * 今天/文章/新建 actions on the bottom bar. Desktop keeps its inline nav.
 * Purely navigational (logout is the only action and it just clears the session
 * and returns to login).
 */
export function AdminNavMenu() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  const logout = async () => {
    setOpen(false)
    await fetch('/api/admin/logout', { method: 'POST' })
    router.push('/admin/login')
    router.refresh()
  }

  const itemClass =
    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-[var(--editor-ink)] transition-colors hover:bg-[var(--editor-soft)]'

  return (
    <div className="relative md:hidden" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="更多菜单"
        className="p-2 rounded-lg text-[var(--editor-muted)] hover:text-[var(--editor-ink)] hover:bg-[var(--editor-soft)] transition-colors"
      >
        <MenuIcon className="w-5 h-5" />
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-48 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-1 shadow-xl">
          <Link href="/admin/categories" className={itemClass}>
            <LayoutGrid className="w-4 h-4 text-[var(--stone-gray)]" />
            <span>分类</span>
          </Link>
          <Link href="/admin/settings" className={itemClass}>
            <Settings className="w-4 h-4 text-[var(--stone-gray)]" />
            <span>设置</span>
          </Link>
          <Link
            href="/"
            className={itemClass}
            title="查看博客"
          >
            <ExternalLink className="w-4 h-4 text-[var(--stone-gray)]" />
            <span>查看博客</span>
          </Link>
          <div className="my-1 h-px bg-[var(--editor-line)]" />
          <button type="button" onClick={logout} className={`${itemClass} text-rose-600 hover:bg-rose-50`}>
            <LogOut className="w-4 h-4" />
            <span>退出登录</span>
          </button>
        </div>
      )}
    </div>
  )
}
