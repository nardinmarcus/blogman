'use client'

import { useState } from 'react'
import { Dropdown } from '@/components/Dropdown'
import { PostRow } from './PostRow'
import { useArticleCommand } from '@/lib/article-command-client'
import type { AdminListPost } from './page'

/**
 * B2-06 — the admin posts list client. Owns row selection for batch
 * classification; every article keeps its own version precondition and the
 * Article Command Client reports per-article applied/conflict (a conflicting
 * article is never silently overwritten).
 */
export function PostListClient({
  posts,
  categories,
}: {
  posts: AdminListPost[]
  categories: string[]
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchCategory, setBatchCategory] = useState('')
  const { runBatch, loading: applying } = useArticleCommand()

  const toggle = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const allVisibleSelected = posts.length > 0 && posts.every((p) => selected.has(p.slug))

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const p of posts) next.delete(p.slug)
      } else {
        for (const p of posts) next.add(p.slug)
      }
      return next
    })
  }

  const categoryOptions = [
    { value: '', label: '未分类' },
    ...categories.map((cat) => ({ value: cat, label: cat })),
  ]

  const applyBatch = async () => {
    const items = posts
      .filter((p) => selected.has(p.slug))
      .map((p) => ({
        slug: p.slug,
        articleId: p.articleId,
        expectedVersion: p.version,
        category: batchCategory || null,
      }))
    if (items.length === 0) return
    const result = await runBatch(items)
    if (result.ok) setSelected(new Set())
  }

  return (
    <div className="overflow-visible rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)]">
      {/* 批量分类操作条 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-t-xl border-b border-[var(--editor-line)] bg-[var(--editor-soft)] px-5 py-3">
          <span className="text-sm font-medium text-[var(--editor-ink)]">已选 {selected.size} 篇</span>
          <div className="min-w-[160px]">
            <Dropdown
              options={categoryOptions}
              value={batchCategory}
              onChange={setBatchCategory}
              placeholder="选择分类"
              className="w-full"
            />
          </div>
          <button
            type="button"
            onClick={applyBatch}
            disabled={applying}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--editor-accent)] px-3 py-2 text-sm font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
          >
            {applying ? '应用中...' : '应用分类'}
          </button>
        </div>
      )}

      {/* 表头 */}
      <div className="hidden rounded-t-xl border-b border-[var(--editor-line)] bg-[var(--editor-soft)] px-5 py-3.5 md:grid md:grid-cols-[32px_50px_1fr_120px_90px_150px] gap-3">
        <span>
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleAll}
            className="accent-[var(--editor-accent)]"
            aria-label="全选"
          />
        </span>
        <span className="text-xs font-semibold text-[var(--editor-muted)] uppercase tracking-wide text-center">状态</span>
        <span className="text-xs font-semibold text-[var(--editor-muted)] uppercase tracking-wide">标题</span>
        <span className="text-xs font-semibold text-[var(--editor-muted)] uppercase tracking-wide">分类</span>
        <span className="text-xs font-semibold text-[var(--editor-muted)] uppercase tracking-wide text-center">阅读</span>
        <span className="text-xs font-semibold text-[var(--editor-muted)] uppercase tracking-wide text-right">操作</span>
      </div>

      {/* 文章列表 */}
      <div className="divide-y divide-[var(--editor-line)]">
        {posts.map((post, index) => (
          <PostRow
            key={post.slug}
            post={post}
            categories={categories}
            preferMenuUp={posts.length > 1 && index >= posts.length - 2}
            selected={selected.has(post.slug)}
            onSelectChange={() => toggle(post.slug)}
          />
        ))}
      </div>
    </div>
  )
}
