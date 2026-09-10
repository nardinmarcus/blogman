/**
 * #244 — accessible article navigation loading feedback.
 *
 * A lightweight skeleton (existing design tokens only) shown while the
 * article route streams. Announced politely to assistive tech via a real
 * status region with visible text — never color/animation alone.
 */

export function ArticleLoading() {
  return (
    <div role="status" aria-live="polite" className="page-main mx-auto w-full max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <span className="sr-only">正在加载文章…</span>
      <div aria-hidden className="animate-pulse space-y-6">
        <div className="h-9 w-3/4 rounded-xl bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
        <div className="flex gap-2">
          <div className="h-4 w-24 rounded-full bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
          <div className="h-4 w-16 rounded-full bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
        </div>
        <div className="space-y-3">
          <div className="h-4 w-full rounded bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
          <div className="h-4 w-11/12 rounded bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
          <div className="h-4 w-4/5 rounded bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
          <div className="h-4 w-2/3 rounded bg-[var(--editor-panel)] border border-[var(--editor-line)]" />
        </div>
      </div>
    </div>
  )
}
