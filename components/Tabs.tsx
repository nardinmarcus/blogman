'use client'

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

interface Tab {
  id: string
  label: string
  content: ReactNode
}

interface TabsProps {
  tabs: Tab[]
  defaultTab?: string
  ariaLabel?: string
}

export function Tabs({ tabs, defaultTab, ariaLabel = '设置分类' }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id)
  // 用 ref 持有最新 tabs，避免全局快捷键监听随渲染反复解绑
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const activate = useCallback((id: string, focus = false) => {
    setActiveTab(id)
    history.replaceState(null, '', `#${id}`)
    if (focus) {
      document.getElementById(`settings-tab-${id}`)?.focus()
    }
  }, [])

  // 挂载时从 location.hash 恢复激活 tab
  useEffect(() => {
    const fromHash = window.location.hash.slice(1)
    if (fromHash && tabsRef.current.some((t) => t.id === fromHash)) {
      setActiveTab(fromHash)
    }
  }, [])

  // ⌘/Ctrl + 1..N 全局切换（输入框内 ⌘数字 无默认行为，直接全局监听）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > tabsRef.current.length) return
      const tab = tabsRef.current[n - 1]
      if (!tab) return
      e.preventDefault()
      activate(tab.id)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [activate])

  // 方向键 ←/→ 循环、Home/End，Roving tabindex
  const onTabListKeyDown = (e: React.KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === activeTab)
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next === null) return
    e.preventDefault()
    activate(tabs[next].id, true)
  }

  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0]

  return (
    <div>
      <div
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onTabListKeyDown}
        className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active?.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => activate(tab.id)}
              className={`shrink-0 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-colors duration-150 ${
                selected
                  ? 'bg-[var(--editor-accent-strong)] text-[var(--editor-accent-ink)] shadow-sm'
                  : 'text-[var(--editor-muted)] hover:bg-[var(--editor-soft)] hover:text-[var(--editor-ink)]'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
        <span
          aria-hidden="true"
          className="ml-auto hidden self-center whitespace-nowrap px-3 text-xs text-[var(--editor-muted)] sm:inline"
        >
          ⌘1–{tabs.length} 切换
        </span>
      </div>

      {active && (
        <div
          key={active.id}
          role="tabpanel"
          id={`settings-panel-${active.id}`}
          aria-labelledby={`settings-tab-${active.id}`}
          className="tab-panel-fade"
        >
          {active.content}
        </div>
      )}
    </div>
  )
}
