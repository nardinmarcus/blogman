'use client'

import { ChevronRight, ListTree } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ArticleOutlineItem } from '@/lib/article-outline'

interface ArticleOutlineProps {
  items: ArticleOutlineItem[]
}

function flattenItems(items: ArticleOutlineItem[]): ArticleOutlineItem[] {
  return items.flatMap((item) => [item, ...flattenItems(item.children)])
}

function collectExpandableIds(items: ArticleOutlineItem[]) {
  const ids = new Set<string>()

  for (const item of items) {
    if (item.children.length > 0) ids.add(item.id)
    for (const childId of collectExpandableIds(item.children)) {
      ids.add(childId)
    }
  }

  return ids
}

function OutlineBranch({
  activeId,
  expandedIds,
  item,
  onToggle,
}: {
  activeId: string | null
  expandedIds: Set<string>
  item: ArticleOutlineItem
  onToggle: (id: string) => void
}) {
  const hasChildren = item.children.length > 0
  const expanded = expandedIds.has(item.id)
  const active = activeId === item.id

  return (
    <li>
      <div className="article-outline-row" data-level={item.level} data-active={active ? 'true' : undefined}>
        {hasChildren ? (
          <button
            type="button"
            className="article-outline-toggle"
            aria-label={expanded ? 'Collapse outline branch' : 'Expand outline branch'}
            aria-expanded={expanded}
            onClick={() => onToggle(item.id)}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : (
          <span className="article-outline-toggle-placeholder" aria-hidden />
        )}
        <a href={`#${encodeURIComponent(item.id)}`} className="article-outline-link">
          {item.title}
        </a>
      </div>

      {hasChildren && expanded ? (
        <ol className="article-outline-children">
          {item.children.map((child) => (
            <OutlineBranch
              key={child.id}
              activeId={activeId}
              expandedIds={expandedIds}
              item={child}
              onToggle={onToggle}
            />
          ))}
        </ol>
      ) : null}
    </li>
  )
}

export function ArticleOutline({ items }: ArticleOutlineProps) {
  const allItems = useMemo(() => flattenItems(items), [items])
  const [activeId, setActiveId] = useState<string | null>(allItems[0]?.id ?? null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => collectExpandableIds(items))

  useEffect(() => {
    setExpandedIds(collectExpandableIds(items))
    setActiveId(allItems[0]?.id ?? null)
  }, [allItems, items])

  useEffect(() => {
    if (allItems.length === 0) return

    const visibleHeadings = new Map<string, IntersectionObserverEntry>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleHeadings.set(entry.target.id, entry)
          } else {
            visibleHeadings.delete(entry.target.id)
          }
        }

        const nextActive = Array.from(visibleHeadings.values())
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]?.target.id

        if (nextActive) setActiveId(nextActive)
      },
      {
        rootMargin: '-18% 0px -70% 0px',
        threshold: [0, 1],
      },
    )

    for (const item of allItems) {
      const heading = document.getElementById(item.id)
      if (heading) observer.observe(heading)
    }

    return () => observer.disconnect()
  }, [allItems])

  if (items.length === 0) return null

  return (
    <nav className="article-outline" aria-label="Article outline">
      <details className="article-outline-mobile" open>
        <summary>
          <ListTree className="h-4 w-4" aria-hidden />
          <span>Contents</span>
        </summary>
        <ol className="article-outline-list">
          {items.map((item) => (
            <OutlineBranch
              key={item.id}
              activeId={activeId}
              expandedIds={expandedIds}
              item={item}
              onToggle={(id) => {
                setExpandedIds((current) => {
                  const next = new Set(current)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }}
            />
          ))}
        </ol>
      </details>
    </nav>
  )
}
