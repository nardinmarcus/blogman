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
  // 用 ref 持有最新 tabs，供挂载时 hash 恢复读取
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
      {/* 吸顶：滚动到后台顶栏（sticky top-0 + h-14）下缘时固定住，不再滚出视野。
          外层用页面底色 + 内边距包住圆角面板，避免滚动内容从圆角缝隙透出。 */}
      <div className="sticky top-14 z-30 -mx-1 -mt-2 mb-4 bg-[var(--background)] px-1 pb-2 pt-2">
        <div
          role="tablist"
          aria-label={ariaLabel}
          onKeyDown={onTabListKeyDown}
          className="flex gap-1 overflow-x-auto rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
        </div>
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
