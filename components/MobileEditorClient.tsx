'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowLeft, Bold, Check, Italic, Monitor, Sparkles, Strikethrough, Underline, Heading2, Heading3 } from 'lucide-react'
import { EditorContent, EditorInstance, EditorRoot, JSONContent } from 'novel'
import {
  createMobileEditorExtensions,
  buildMobileEditorProps,
} from '@/lib/mobile-edit/editor'
import {
  EditorSaveCoordinator,
  type CoordinatorState,
  type EditorSnapshot,
  type EditorSnapshotContent,
} from '@/lib/editor-save-coordinator'
import { createCommandTransport, createLocalDraftStore } from '@/lib/editor-command-transport'
import { normalizePostSlug } from '@/lib/post-utils'
import {
  desktopHandoffUrl,
  hasComplexBlock,
  mobileSaveStatusLabel,
} from '@/lib/mobile-edit/edit-model'
import {
  suggestionActions,
  suggestionStatusLabel,
} from '@/lib/mobile-ai-suggestion/ui-model'
import type {
  MobileAiSuggestionState,
  MobileAiSuggestionRead,
} from '@/lib/mobile-ai-suggestion/types'

/**
 * B8-02 — mobile small-edit editor (issue #61).
 *
 * A 标题 + 普通段落 + 基础行内格式 editing surface that reuses B2-04's
 * `EditorSaveCoordinator` + shared command transport verbatim. Because it uses
 * the exact same save protocol (expected version + operation id), the local
 * unconfirmed draft store (default namespace — one per article per device,
 * shared with desktop), and the rendered complex blocks (same node schema,
 * read-only via `editable` prop), the confirm-on-current-input, offline
 * recovery, and three-way conflict behaviours are identical to desktop.
 *
 * Complex blocks are read-only; the desktop handoff carries only identity +
 * location (slug) and never an in-memory draft.
 */

const AUTOSAVE_DEBOUNCE_MS = 1500
const AUTOSAVE_MAX_RETRY_DELAY_MS = 10000
const NEW_SESSION_KEY = 'blogman:editor-new-session'

function newCreationId(): string {
  if (typeof window === 'undefined') return 'mobile-' + crypto.randomUUID()
  const stored = window.localStorage.getItem(NEW_SESSION_KEY)
  if (stored) return stored
  const id = 'mobile-' + crypto.randomUUID()
  window.localStorage.setItem(NEW_SESSION_KEY, id)
  return id
}

const EMPTY_DOCUMENT = { type: 'doc', content: [{ type: 'paragraph' }] } satisfies JSONContent

export interface MobileEditorInitialData {
  slug: string
  title: string
  html: string
  category?: string
  status?: 'draft' | 'published' | 'deleted'
  tags?: string[]
  description?: string | null
  cover_image?: string | null
  articleId?: number | null
  version?: number | null
}

interface MobileEditorProps {
  initialData?: MobileEditorInitialData
  skipDraftRestore?: boolean
}

type SaveFeedback = { type: 'success' | 'error'; message: string } | null

export function MobileEditorClient({ initialData, skipDraftRestore = false }: MobileEditorProps = {}) {
  const [title, setTitle] = useState(initialData?.title ?? '')
  const latestTitleRef = useRef(initialData?.title ?? '')
  const editSlugRef = useRef<string | null>(initialData?.slug ?? null)
  // Metadata is NOT edited on mobile — preserved from the server snapshot.
  const metaRef = useRef({
    slug: initialData?.slug ?? '',
    category: initialData?.category || '未分类',
    tags: initialData?.tags ?? [],
    description: initialData?.description ?? '',
    coverImage: initialData?.cover_image ?? '',
  })

  const editorRef = useRef<EditorInstance | null>(null)
  const [draftReady, setDraftReady] = useState(false)
  const [initialContent, setInitialContent] = useState<JSONContent>(EMPTY_DOCUMENT)
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error' | 'conflict'>('saved')
  const [feedback, setFeedback] = useState<SaveFeedback>(null)
  const [saving, setSaving] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [coordinatorUI, setCoordinatorUI] = useState<CoordinatorState | null>(null)
  const [complexContent, setComplexContent] = useState(false)

  // B8-03 — mobile local-AI suggestion tray (shares the #38 suggestion state).
  const boardRef = useRef<number | null>(initialData?.articleId ?? null)
  const [suggestionState, setSuggestionState] = useState<MobileAiSuggestionState | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)

  const coordinatorRef = useRef<EditorSaveCoordinator | null>(null)
  const coordinatorInitRef = useRef(false)
  const skipNextEditorUpdateRef = useRef(Boolean(initialData?.html))

  const buildCoordinatorContent = useCallback((): EditorSnapshotContent => {
    const editor = editorRef.current
    const html = editor?.getHTML() ?? initialData?.html ?? ''
    let content = ''
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content = (editor?.storage as any)?.markdown?.getMarkdown?.() ?? ''
    } catch {
      content = ''
    }
    if (!content && editor) content = editor.getText({ blockSeparator: '\n\n' })
    return {
      slug: normalizePostSlug(metaRef.current.slug),
      title: latestTitleRef.current.trim(),
      html,
      content: content.trim(),
      description: metaRef.current.description,
      category: metaRef.current.category,
      tags: metaRef.current.tags,
      coverImage: metaRef.current.coverImage,
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCoordinatorChange = useCallback((s: CoordinatorState) => {
    setCoordinatorUI(s)
    setSaveState(s.status)
    if (s.status === 'conflict') setConflictOpen(true)
    else if (s.conflict === null) setConflictOpen(false)
    if (s.status === 'error' && s.errorMessage) {
      setFeedback({ type: 'error', message: s.errorMessage })
    }
  }, [])

  // Init once: create the coordinator + restore server baseline.
  useEffect(() => {
    setInitialContent(EMPTY_DOCUMENT)
    setDraftReady(true)
    if (!coordinatorInitRef.current) {
      coordinatorInitRef.current = true
      coordinatorRef.current = new EditorSaveCoordinator({
        articleId: initialData?.articleId ?? null,
        version: initialData?.version ?? null,
        creationId: initialData?.articleId ? '' : newCreationId(),
        getContent: buildCoordinatorContent,
        transport: createCommandTransport(),
        draftStore: createLocalDraftStore(), // default namespace — one draft per article per device, shared with desktop
        onStateChange: handleCoordinatorChange,
        debounceMs: AUTOSAVE_DEBOUNCE_MS,
        maxRetryDelayMs: AUTOSAVE_MAX_RETRY_DELAY_MS,
        onAppliedSlug: (slug) => {
          editSlugRef.current = slug
          metaRef.current = { ...metaRef.current, slug }
        },
      })
      coordinatorRef.current.setAppliedState({
        status: initialData?.status === 'draft' ? 'draft' : 'published',
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the unconfirmed draft on unload; dispose coordinator timers.
  useEffect(() => {
    const onUnload = () => coordinatorRef.current?.persistLocalDraft()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      coordinatorRef.current?.dispose()
    }
  }, [])

  // Apply a snapshot (refresh recovery / conflict "server version" choice).
  const applySnapshot = useCallback((snap: EditorSnapshot) => {
    latestTitleRef.current = snap.title
    setTitle(snap.title)
    metaRef.current = {
      slug: snap.slug || metaRef.current.slug,
      category: snap.category || '未分类',
      tags: snap.tags ?? [],
      description: snap.description ?? '',
      coverImage: snap.coverImage ?? '',
    }
    if (snap.slug) editSlugRef.current = snap.slug
    if (editorRef.current && snap.html !== undefined) {
      skipNextEditorUpdateRef.current = false
      editorRef.current.commands.setContent(snap.html || '')
    }
  }, [])

  const handleAdoptServer = useCallback(async () => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    const snap = await coordinator.adoptServerVersion()
    if (snap) {
      applySnapshot(snap)
      coordinator.setInitialConfirmed()
    }
    setConflictOpen(false)
  }, [applySnapshot])

  const handleResubmitLocal = useCallback(async () => {
    await coordinatorRef.current?.resubmitLocal()
    setConflictOpen(false)
  }, [])

  const handleSaveAsNew = useCallback(async () => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    const res = await coordinator.saveAsNewDraft()
    setConflictOpen(false)
    if (res.ok && res.slug) {
      editSlugRef.current = res.slug
      metaRef.current = { ...metaRef.current, slug: res.slug }
      setFeedback({ type: 'success', message: '已另存为新草稿' })
    }
  }, [])

  const scheduleDraftSave = useCallback(() => coordinatorRef.current?.schedule(), [])

  // B8-03 — load the shared version-bound suggestion list for this article.
  const loadSuggestions = useCallback(async () => {
    const id = boardRef.current
    if (!id) {
      setSuggestionState(null)
      return
    }
    try {
      const res = await fetch(`/api/mobile-ai-suggestion?articleId=${id}`)
      if (res.ok) {
        const data = (await res.json()) as { state?: MobileAiSuggestionState }
        setSuggestionState(data.state ?? null)
      }
    } catch {
      // Best-effort read — never blocks editing/saving.
    }
  }, [])

  // B8-03 — request a LOCAL (mock-AI) suggestion for the selected text.
  const handleRequestLocalAi = useCallback(async () => {
    const editor = editorRef.current
    const id = boardRef.current
    if (!editor) return
    const { from, to } = editor.state.selection
    const selectedText = editor.state.doc.textBetween(from, to, ' ').trim()
    if (!id) {
      setAiError('还没有文章身份，请先保存一次草稿')
      return
    }
    if (!selectedText) {
      setAiError('请先选中要改写的一段文字')
      return
    }
    setAiBusy(true)
    setAiError(null)
    try {
      const res = await fetch('/api/mobile-ai-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          articleId: id,
          selectedText,
          operationId: typeof crypto !== 'undefined' ? crypto.randomUUID() : `mobile-ai-${Date.now()}`,
        }),
      })
      const data = (await res.json()) as { outcome?: string; reason?: string }
      if (res.ok && data?.outcome === 'recorded') {
        await loadSuggestions()
      } else {
        setAiError(data?.reason && data.reason !== 'unknown' ? data.reason : '无法生成建议')
      }
    } catch {
      setAiError('建议请求失败，不影响保存')
    } finally {
      setAiBusy(false)
    }
  }, [loadSuggestions])

  // B8-03 — apply / undo / ignore a suggestion through the shared #38 commands.
  const handleSuggestionAction = useCallback(
    async (action: 'apply' | 'revoke' | 'ignore', suggestionId: string) => {
      const id = boardRef.current
      if (!id) return
      setAiError(null)
      try {
        const res = await fetch('/api/mobile-ai-suggestion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            suggestionId,
            ...(action !== 'ignore' ? { operationId: crypto.randomUUID() } : {}),
          }),
        })
        if (!res.ok) {
          const data = (await res.json()) as { error?: string }
          setAiError(data?.error ?? '操作失败')
        }
        await loadSuggestions()
      } catch {
        setAiError('操作失败')
      }
    },
    [loadSuggestions],
  )

  // Refresh the tray when the article identity is established.
  useEffect(() => {
    boardRef.current = initialData?.articleId ?? null
    void loadSuggestions()
  }, [initialData?.articleId, loadSuggestions])

  const handleSave = async (target: 'draft' | 'published') => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    const editor = editorRef.current
    if (!latestTitleRef.current.trim()) {
      setFeedback({ type: 'error', message: '先把文章标题写上。' })
      return
    }
    if (editor) {
      const content = editor.getText({ blockSeparator: '\n\n' }).trim()
      const hasContent = content || /<(img|video|audio|iframe)\s/.test(editor.getHTML())
      if (!hasContent) {
        setFeedback({ type: 'error', message: '正文还是空的。' })
        return
      }
    }
    setSaving(true)
    setFeedback(null)
    try {
      let res
      if (editSlugRef.current) {
        res = await coordinator.saveAndPublish({ status: target })
      } else {
        res = await coordinator.createNew({ status: target })
        if (res.ok && res.slug) editSlugRef.current = res.slug
      }
      if (res.ok) {
        setFeedback({ type: 'success', message: target === 'published' ? '已发布' : '草稿已保存' })
      } else if (res.error === 'conflict') {
        // conflict modal shown via coordinator state
      } else if (res.error === 'status-conflict') {
        setFeedback({ type: 'error', message: '文章状态已被其他设备修改，请刷新后重试' })
      } else {
        setFeedback({ type: 'error', message: '保存失败，请检查网络后重试' })
      }
    } catch (error) {
      setSaveState('error')
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--editor-app-bg)] flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 h-14 border-b border-[var(--editor-line)] bg-[color-mix(in_srgb,var(--background)_90%,transparent)] backdrop-blur-lg">
        <div className="flex h-full items-center gap-2 px-3">
          <Link href="/admin/today" className="flex items-center gap-1 shrink-0 text-sm text-[var(--editor-muted)] hover:text-[var(--editor-ink)]">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className={`flex items-center gap-1.5 text-xs min-w-0 flex-1 ${
            saveState === 'saved' ? 'text-emerald-600' :
            saveState === 'conflict' ? 'text-amber-600' :
            saveState === 'error' ? 'text-orange-500' : 'text-[var(--stone-gray)]'
          }`}>
            <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${
              saveState === 'saved' ? 'bg-emerald-500' :
              saveState === 'conflict' ? 'bg-amber-500' :
              saveState === 'dirty' ? 'bg-gray-300' :
              saveState === 'saving' ? 'bg-gray-400 animate-pulse' : 'bg-orange-500'
            }`} />
            <span className="truncate font-medium">{mobileSaveStatusLabel(saveState)}</span>
          </div>
          <button
            type="button"
            onClick={() => void handleSave('draft')}
            disabled={saving}
            className="shrink-0 rounded-lg border border-[var(--editor-line)] px-3 py-1.5 text-sm text-[var(--editor-ink)] hover:bg-[var(--editor-soft)] disabled:opacity-50"
          >
            {saving ? '保存中…' : '草稿'}
          </button>
          <button
            type="button"
            onClick={() => void handleSave('published')}
            disabled={saving}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-[var(--editor-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:brightness-105 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {editSlugRef.current ? '更新' : '发布'}
          </button>
        </div>
        {feedback && (
          <div className={`border-t border-[var(--editor-line)] px-3 py-2 text-sm ${feedback.type === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
            <div className="flex items-center gap-2">
              <span className="truncate">{feedback.message}</span>
              <button type="button" onClick={() => setFeedback(null)} className="ml-auto shrink-0">✕</button>
            </div>
          </div>
        )}
      </header>

      {/* Complex-block handoff hint */}
      <div className="px-4 pt-3">
        <div className="mx-auto max-w-2xl">
          <HandoffHint slug={editSlugRef.current} complex={complexContent} />
        </div>
      </div>

      {/* Editor body */}
      <main className="flex-1">
        <div className="mx-auto max-w-2xl px-4 pt-4 pb-24 w-full">
          <textarea
            value={title}
            placeholder="无标题"
            rows={1}
            onChange={(e) => {
              const v = e.target.value
              setTitle(v)
              latestTitleRef.current = v
              scheduleDraftSave()
              if (feedback?.type === 'error') setFeedback(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                editorRef.current?.chain().focus().run()
              }
            }}
            className="editor-title-textarea block w-full appearance-none bg-transparent p-0 m-0 resize-none overflow-hidden border-0 outline-none ring-0 text-3xl font-bold leading-tight tracking-tight text-[var(--editor-ink)] placeholder:text-[var(--stone-gray)]"
            style={{ minHeight: '44px' }}
          />

          {!draftReady ? (
            <div className="editor-surface" />
          ) : (
            <EditorRoot>
              <div>
                <MobileFormatBar editorRef={editorRef} onRequestAi={handleRequestLocalAi} aiBusy={aiBusy} />
                <MobileSuggestionPanel
                  open={aiPanelOpen}
                  onToggle={() => setAiPanelOpen((v) => !v)}
                  state={suggestionState}
                  error={aiError}
                  onAction={handleSuggestionAction}
                />
                <EditorContent
                  initialContent={initialContent}
                  extensions={createMobileEditorExtensions() as never}
                  className="editor-surface"
                  immediatelyRender={false}
                  editorProps={buildMobileEditorProps()}
                  onCreate={({ editor }) => {
                    editorRef.current = editor
                    setComplexContent(hasComplexBlock((editor.getJSON() as Parameters<typeof hasComplexBlock>[0]) ?? null))
                    if (initialData?.html) {
                      skipNextEditorUpdateRef.current = true
                      editor.commands.setContent(initialData.html)
                    } else {
                      skipNextEditorUpdateRef.current = false
                    }
                    if (initialData?.slug && !skipDraftRestore) {
                      coordinatorRef.current?.setInitialConfirmed()
                      const draft = coordinatorRef.current?.restoreLocalDraft()
                      if (draft) {
                        skipNextEditorUpdateRef.current = false
                        applySnapshot(draft)
                      }
                    } else {
                      coordinatorRef.current?.setInitialConfirmed()
                    }
                  }}
                  onUpdate={({ editor }) => {
                    editorRef.current = editor
                    setComplexContent(hasComplexBlock((editor.getJSON() as Parameters<typeof hasComplexBlock>[0]) ?? null))
                    if (skipNextEditorUpdateRef.current) {
                      skipNextEditorUpdateRef.current = false
                      return
                    }
                    scheduleDraftSave()
                  }}
                />
              </div>
            </EditorRoot>
          )}
        </div>
      </main>

      {/* Mobile bottom action bar (fixed) */}
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-[var(--editor-line)] bg-[var(--editor-panel)]/95 backdrop-blur">
        <div className="mx-auto max-w-2xl px-4 py-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSave('draft')}
            disabled={saving}
            className="flex-1 rounded-lg border border-[var(--editor-line)] py-2.5 text-sm text-[var(--editor-ink)] hover:bg-[var(--editor-soft)] disabled:opacity-50"
          >
            保存草稿
          </button>
          <button
            type="button"
            onClick={() => void handleSave('published')}
            disabled={saving}
            className="flex-1 rounded-lg bg-[var(--editor-accent)] py-2.5 text-sm font-semibold text-white hover:brightness-105 disabled:opacity-50"
          >
            {saving ? '保存中…' : editSlugRef.current ? '更新文章' : '发布文章'}
          </button>
        </div>
      </div>

      {/* B2-04 three-way conflict modal (reused protocol). */}
      {conflictOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-6 shadow-2xl">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
              <h3 className="text-base font-semibold text-[var(--editor-ink)]">保存冲突</h3>
            </div>
            <p className="mt-3 text-sm text-[var(--editor-muted)]">
              这篇文章已在其他设备上被更新（服务器版本{' '}
              <span className="font-semibold text-[var(--editor-ink)] tabular-nums">
                {coordinatorUI?.conflict?.serverVersion ?? '?'}
              </span>
              ）。自动保存已暂停，请选择如何处理：
            </p>
            <div className="mt-5 space-y-2">
              <button type="button" onClick={() => void handleAdoptServer()} className="w-full rounded-lg border border-[var(--editor-line)] bg-[var(--editor-soft)] px-4 py-3 text-left text-sm text-[var(--editor-ink)] hover:border-[var(--editor-accent)]/40 transition">
                <span className="font-semibold">采用服务器版本</span>
                <span className="mt-0.5 block text-xs text-[var(--editor-muted)]">放弃本机的未确认修改，加载最新服务器内容</span>
              </button>
              <button type="button" onClick={() => void handleResubmitLocal()} className="w-full rounded-lg border border-[var(--editor-line)] bg-[var(--editor-soft)] px-4 py-3 text-left text-sm text-[var(--editor-ink)] hover:border-[var(--editor-accent)]/40 transition">
                <span className="font-semibold">用本机版本重新提报</span>
                <span className="mt-0.5 block text-xs text-[var(--editor-muted)]">以当前服务端版本为基础安全覆盖</span>
              </button>
              <button type="button" onClick={() => void handleSaveAsNew()} className="w-full rounded-lg border border-[var(--editor-line)] bg-[var(--editor-soft)] px-4 py-3 text-left text-sm text-[var(--editor-ink)] hover:border-[var(--editor-accent)]/40 transition">
                <span className="font-semibold">另存为新草稿</span>
                <span className="mt-0.5 block text-xs text-[var(--editor-muted)]">不碰服务器版本，把本机内容保存为独立新文章</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MobileSuggestionPanel({
  open,
  onToggle,
  state,
  error,
  onAction,
}: {
  open: boolean
  onToggle: () => void
  state: MobileAiSuggestionState | null
  error: string | null
  onAction: (action: 'apply' | 'revoke' | 'ignore', suggestionId: string) => void
}) {
  const preparations = state?.preparations ?? []
  const actions = preparations.length > 0 ? preparations[0].suggestions : []
  const pendingCount = actions.filter((s) => s.status === 'pending').length

  return (
    <div className="mb-3 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm"
      >
        <Sparkles className="h-4 w-4 text-[var(--editor-accent)]" />
        <span className="font-medium text-[var(--editor-ink)]">局部 AI 建议</span>
        {pendingCount > 0 && (
          <span className="ml-auto rounded-full bg-[var(--editor-accent)]/15 px-2 py-0.5 text-xs font-semibold text-[var(--editor-accent)]">
            {pendingCount} 条待处理
          </span>
        )}
        <span className="text-[var(--editor-muted)]">{open ? '收起' : '展开'}</span>
      </button>

      {(open || error) && (
        <div className="border-t border-[var(--editor-line)] px-3 py-2.5 space-y-2">
          {error && (
            <p className="text-xs text-rose-600">{error}</p>
          )}
          {actions.length === 0 && !error && (
            <p className="text-xs text-[var(--editor-muted)]">
              选中一段文字，点上方「AI 建议」生成版本绑定的局部建议。
            </p>
          )}
          {actions.map((s) => (
            <MobileSuggestionRow key={s.suggestionId} suggestion={s} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  )
}

function MobileSuggestionRow({
  suggestion,
  onAction,
}: {
  suggestion: MobileAiSuggestionRead
  onAction: (action: 'apply' | 'revoke' | 'ignore', suggestionId: string) => void
}) {
  const acts = suggestionActions(suggestion.status)
  const value = Array.isArray(suggestion.value)
    ? suggestion.value.join(', ')
    : (suggestion.value ?? '')
  return (
    <div className="rounded-lg border border-[var(--editor-line)] bg-[var(--background)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-[var(--editor-accent)]/10 px-1.5 py-0.5 text-[11px] font-medium text-[var(--editor-accent)]">
          {suggestion.field === 'content' ? '正文' : suggestion.field}
        </span>
        <span className={`text-[11px] ${suggestion.status === 'stale' ? 'text-amber-600' : 'text-[var(--editor-muted)]'}`}>
          {suggestionStatusLabel(suggestion.status)} · v{suggestion.boundVersion}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--editor-ink)]">{value}</p>
      {(acts.canApply || acts.canRevoke || acts.canIgnore) && (
        <div className="mt-2 flex gap-2">
          {acts.canApply && (
            <button
              type="button"
              onClick={() => onAction('apply', suggestion.suggestionId)}
              className="rounded-md bg-[var(--editor-accent)] px-2.5 py-1 text-xs font-medium text-white"
            >
              应用
            </button>
          )}
          {acts.canRevoke && (
            <button
              type="button"
              onClick={() => onAction('revoke', suggestion.suggestionId)}
              className="rounded-md border border-[var(--editor-line)] px-2.5 py-1 text-xs text-[var(--editor-ink)]"
            >
              撤销
            </button>
          )}
          {acts.canIgnore && (
            <button
              type="button"
              onClick={() => onAction('ignore', suggestion.suggestionId)}
              className="rounded-md border border-[var(--editor-line)] px-2.5 py-1 text-xs text-[var(--editor-muted)]"
            >
              忽略
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function HandoffHint({ slug, complex }: { slug: string | null; complex: boolean }) {
  const href = desktopHandoffUrl(slug)
  if (!slug) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--editor-line)] px-3 py-2 text-xs text-[var(--stone-gray)]">
        移动端支持标题 / 段落 / 基础行内格式小修
      </div>
    )
  }
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${complex ? 'border-[var(--editor-accent)]/30 bg-[var(--editor-accent)]/5 text-[var(--editor-ink)]' : 'border-[var(--editor-line)] text-[var(--editor-muted)]'}`}>
      <Monitor className="h-4 w-4 shrink-0 text-[var(--editor-accent)]" />
      <span className="flex-1">
        {complex ? '正文含需在电脑上处理的复杂内容块' : '复杂内容块请在电脑上继续'}
      </span>
      <Link href={href} className="shrink-0 font-medium text-[var(--editor-accent)] hover:underline">
        在电脑上继续
      </Link>
    </div>
  )
}

function MobileFormatBar({
  editorRef,
  onRequestAi,
  aiBusy,
}: {
  editorRef: React.RefObject<EditorInstance | null>
  onRequestAi?: () => void
  aiBusy?: boolean
}) {
  const [open, setOpen] = useState(false)
  const run = (fn: (editor: EditorInstance) => void) => {
    const editor = editorRef.current
    if (!editor) return
    fn(editor)
    editor.chain().focus().run()
  }
  const buttons: Array<{ label: string; icon: React.ReactNode; test: (e: EditorInstance) => boolean; run: (e: EditorInstance) => void }> = [
    { label: '粗体', icon: <Bold className="h-4 w-4" />, test: (e) => e.isActive('bold'), run: (e) => e.chain().toggleBold().run() },
    { label: '斜体', icon: <Italic className="h-4 w-4" />, test: (e) => e.isActive('italic'), run: (e) => e.chain().toggleItalic().run() },
    { label: '下划线', icon: <Underline className="h-4 w-4" />, test: (e) => e.isActive('underline'), run: (e) => e.chain().toggleUnderline().run() },
    { label: '删除线', icon: <Strikethrough className="h-4 w-4" />, test: (e) => e.isActive('strike'), run: (e) => e.chain().toggleStrike().run() },
    { label: '标题2', icon: <Heading2 className="h-4 w-4" />, test: (e) => e.isActive('heading', { level: 2 }), run: (e) => e.chain().toggleHeading({ level: 2 }).run() },
    { label: '标题3', icon: <Heading3 className="h-4 w-4" />, test: (e) => e.isActive('heading', { level: 3 }), run: (e) => e.chain().toggleHeading({ level: 3 }).run() },
  ]

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] px-2 py-1.5">
      {buttons.slice(0, open ? 6 : 4).map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          title={b.label}
          onClick={() => run(b.run)}
          className={`grid h-8 w-8 place-items-center rounded-lg transition ${editorRef.current && b.test(editorRef.current) ? 'bg-[var(--editor-accent)]/10 text-[var(--editor-accent)]' : 'text-[var(--editor-muted)] hover:bg-[var(--editor-soft)]'}`}
        >
          {b.icon}
        </button>
      ))}
      {onRequestAi && (
        <button
          type="button"
          onClick={onRequestAi}
          disabled={aiBusy}
          title="选中文字后请求局部 AI 建议"
          className="grid h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--editor-accent)] hover:bg-[var(--editor-soft)] disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {aiBusy ? '…' : 'AI建议'}
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-[var(--editor-muted)] hover:bg-[var(--editor-soft)]"
        title={open ? '收起' : '更多格式'}
      >
        <span className="text-sm font-semibold">{open ? '收起' : '更多'}</span>
      </button>
    </div>
  )
}
