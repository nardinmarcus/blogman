'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/Toast'
import { Dropdown } from '@/components/Dropdown'
import { PostRow } from './PostRow'
import type { AdminListPost } from './page'

/** Client-side operation id — stable per user action, replayed server-side. */
function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * B2-06 — the admin posts list client. Owns row selection for batch
 * classification (each article carries its own expected version + operation
 * id; the server returns per-article applied/conflict and never silently
 * overwrites a conflicting article).
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
  const [applying, setApplying] = useState(false)
  const router = useRouter()
  const toast = useToast()

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
        operationId: operationId(),
        category: batchCategory || null,
      }))
    if (items.length === 0) return
    setApplying(true)
    try {
      const res = await fetch('/api/article-commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'batchSetCategory', items }),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '批量分类失败')
      const results = Array.isArray(data.items) ? (data.items as Array<{ outcome?: string }>) : []
      const applied = results.filter((r) => r.outcome === 'applied' || r.outcome === 'legacy-applied').length
      const conflicts = results.filter((r) => r.outcome === 'conflict').length
      const skipped = results.filter((r) => r.outcome === 'invalid' || r.outcome === 'not-found' || r.outcome === 'error').length
      if (conflicts > 0 || skipped > 0) {
        toast.error(`部分文章冲突或失败：成功 ${applied}，冲突 ${conflicts}，其他 ${skipped}。冲突的文章未被覆盖，请刷新后重试。`)
      } else {
        toast.success(`已批量更新 ${applied} 篇文章的分类`)
      }
      setSelected(new Set())
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量分类失败')
    } finally {
      setApplying(false)
    }
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
