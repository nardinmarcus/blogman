'use client'

import { useState } from 'react'
import { SettingsSection } from './SettingsSection'
import { AiActionsManager } from './AiActionsManager'
import { AiImageActionsManager } from './AiImageActionsManager'
import { AiPostGeneratorsManager } from './AiPostGeneratorsManager'

type PromptFilter = 'all' | 'text' | 'image' | 'post'

const FILTERS: Array<{ id: PromptFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'text', label: '文本' },
  { id: 'image', label: '图片' },
  { id: 'post', label: '文章生成' },
]

export function PromptsSettings() {
  const [filter, setFilter] = useState<PromptFilter>('all')
  const [query, setQuery] = useState('')

  const showText = filter === 'all' || filter === 'text'
  const showImage = filter === 'all' || filter === 'image'
  const showPost = filter === 'all' || filter === 'post'

  const resetFilter = () => {
    setQuery('')
    setFilter('all')
  }

  return (
    <SettingsSection
      title="提示词"
      description="编辑器内 AI 操作的提示词模板：文本操作、图片生成、整篇文章生成。"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div
          role="group"
          aria-label="按类型筛选"
          className="flex gap-0.5 rounded-lg border border-[var(--editor-line)] bg-[var(--editor-soft)]/60 p-0.5"
        >
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                filter === item.id
                  ? 'bg-[var(--editor-panel)] font-medium text-[var(--editor-ink)] shadow-sm'
                  : 'text-[var(--editor-muted)] hover:text-[var(--editor-ink)]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索提示词…"
          aria-label="搜索提示词"
          className="w-full min-w-[140px] rounded-lg border border-[var(--editor-line)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--editor-ink)] outline-none focus:border-[var(--editor-accent)] sm:ml-auto sm:w-auto sm:max-w-[260px]"
        />
      </div>

      {/* 三个 manager 保持挂载，用 hidden 切换显隐，避免反复 fetch */}
      <div className="space-y-6">
        <div hidden={!showText}>
          <AiActionsManager
            heading={filter === 'all' ? '文本提示' : undefined}
            searchQuery={query}
            onResetFilter={resetFilter}
          />
        </div>
        <div hidden={!showImage}>
          <AiImageActionsManager
            heading={filter === 'all' ? '图片提示' : undefined}
            searchQuery={query}
            onResetFilter={resetFilter}
          />
        </div>
        <div hidden={!showPost}>
          {filter === 'all' ? (
            <h3 className="mb-2 text-sm font-semibold text-[var(--editor-ink)]">文章生成</h3>
          ) : null}
          <AiPostGeneratorsManager />
        </div>
      </div>
    </SettingsSection>
  )
}
