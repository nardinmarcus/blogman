'use client'

import { useState, ReactNode } from 'react'

interface Tab {
  id: string
  label: string
  group?: string
  content: ReactNode
}

interface TabsProps {
  tabs: Tab[]
  defaultTab?: string
}

export function Tabs({ tabs, defaultTab }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id)

  const activeContent = tabs.find(t => t.id === activeTab)?.content
  const groupedTabs = tabs.reduce<Array<{ group: string; tabs: Tab[] }>>((groups, tab) => {
    const group = tab.group || ''
    const current = groups.find((item) => item.group === group)
    if (current) {
      current.tabs.push(tab)
      return groups
    }
    return [...groups, { group, tabs: [tab] }]
  }, [])

  return (
    <div>
      {/* Tab 导航 */}
      <div className="mb-6 rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          {groupedTabs.map(({ group, tabs: items }) => (
            <div key={group || 'default'} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center">
              {group && (
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--stone-gray)] sm:w-16 sm:px-0">
                  {group}
                </div>
              )}
              <div className="flex min-w-0 gap-1 overflow-x-auto">
                {items.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`shrink-0 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                      activeTab === tab.id
                        ? 'bg-[var(--editor-accent)] text-[var(--editor-accent-ink)] shadow-sm'
                        : 'text-[var(--editor-muted)] hover:bg-[var(--editor-soft)] hover:text-[var(--editor-ink)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab 内容 */}
      <div>{activeContent}</div>
    </div>
  )
}
