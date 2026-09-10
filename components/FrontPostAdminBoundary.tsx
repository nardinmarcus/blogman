'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Pencil } from 'lucide-react'
import { InlineArticleEditorClient } from '@/components/InlineArticleEditorClient'
import { useAdminSession } from '@/lib/admin-session-client'

const ArticleEditContext = createContext<{
  enterEditing: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
} | null>(null)

/** Explicit, admin-only entry placed in the server-rendered article actions. */
export function FrontPostEditButton() {
  const entry = useContext(ArticleEditContext)
  if (!entry) return null

  return (
    <button
      ref={entry.buttonRef}
      type="button"
      onClick={entry.enterEditing}
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--editor-line)] bg-[var(--editor-panel)] px-3 py-1.5 text-xs font-medium text-[var(--editor-ink)] transition hover:border-[var(--editor-accent)]/35 hover:bg-[var(--editor-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--editor-accent)]"
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      编辑本文
    </button>
  )
}

interface FrontPostAdminBoundaryProps {
  slug: string
  title: string
  html: string
  category?: string | null
  coverImage?: string | null
  password?: string | null
  publishedAt?: number
  viewCount?: number
  content?: string
  children: ReactNode
  /** B2-05 versioned-authority identity + latest server version. */
  articleId?: number | null
  version?: number | null
  status?: 'draft' | 'published'
  description?: string | null
  tags?: string[] | null
  isHidden?: number
}

export function FrontPostAdminBoundary({
  slug,
  title,
  html,
  category,
  coverImage,
  password,
  publishedAt,
  viewCount,
  content,
  children,
  articleId,
  version,
  status,
  description,
  tags,
  isHidden,
}: FrontPostAdminBoundaryProps) {
  const { authenticated } = useAdminSession()
  const [editing, setEditing] = useState(false)

  const buttonRef = useRef<HTMLButtonElement>(null)
  const readingPosition = useRef<{ left: number; top: number } | null>(null)
  const restoreReading = useRef(false)

  const enterEditing = useCallback(() => {
    if (!authenticated) return
    readingPosition.current = { left: window.scrollX, top: window.scrollY }
    setEditing(true)
  }, [authenticated])

  const exitEditing = useCallback(() => {
    restoreReading.current = true
    setEditing(false)
  }, [])

  // Restore only after the reading DOM has remounted, before it is painted.
  // Explicit instant scrolling overrides the site's smooth-scroll CSS.
  useLayoutEffect(() => {
    if (editing || !restoreReading.current) return
    restoreReading.current = false
    buttonRef.current?.focus({ preventScroll: true })
    if (readingPosition.current) {
      window.scrollTo({ ...readingPosition.current, behavior: 'instant' })
    }
  }, [editing])

  if (authenticated && editing) {
    return (
      <section>
        <InlineArticleEditorClient
          slug={slug}
          title={title}
          html={html}
          category={category}
          coverImage={coverImage}
          password={password}
          publishedAt={publishedAt}
          viewCount={viewCount}
          content={content}
          onExitReading={exitEditing}
          articleId={articleId}
          version={version}
          status={status}
          description={description}
          tags={tags}
          isHidden={isHidden}
        />
      </section>
    )
  }

  return (
    <ArticleEditContext.Provider value={authenticated ? { enterEditing, buttonRef } : null}>
      <div>{children}</div>
    </ArticleEditContext.Provider>
  )
}
