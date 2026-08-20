'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Clock,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  X,
} from 'lucide-react'
import { createLocalDraftStore } from '@/lib/editor-command-transport'
import {
  availableScheduleActions,
  BLOCKER_LABELS,
  formatScheduleTime,
  parseScheduleDatetime,
  scheduleActionLabel,
  scheduleBlocker,
  SCHEDULE_DISPLAY_TIMEZONE,
  scheduleStatusLabel,
  terminalReason,
  toDatetimeLocalValue,
  type MobileScheduleAction,
} from '@/lib/mobile-schedule/model'
import type { MobileScheduleView } from '@/lib/mobile-schedule/view'

/**
 * B8-04 — mobile schedule manager (issue #63).
 *
 * A mobile-first surface for acting on a scheduled-publish intent. All four
 * actions (改期 / 取消 / 立即发布 / 对暂停或待办重新确认) reuse the SHARED #41
 * command kernel through the thin `/api/mobile/schedule` route — the server
 * re-reads D1, computes the deterministic operation id, and re-reads again, so
 * the UI never trusts client-optimistic state. Schedule times here are ALWAYS
 * rendered in Asia/Shanghai.
 *
 * Blocking: an unconfirmed device draft (本机稿 / 未保存) and article version
 * drift (版本漂移) disable unsafe actions on this device. Results are refreshed
 * from D1 after every action; in-flight state disables the buttons to prevent
 * duplicate taps, and the shared kernel's operation ledger makes repeats
 * replay instead of double-applying.
 */

type Feedback = { type: 'success' | 'error' | 'info'; message: string } | null

function draftKeyFor(articleId: number): string {
  return `editor-draft:${articleId}`
}

export function MobileScheduleManager({
  initial,
  scheduleId,
}: {
  initial: MobileScheduleView
  scheduleId: string
}) {
  const router = useRouter()
  const [view, setView] = useState<MobileScheduleView>(initial)
  const [hasUnsavedLocalDraft, setHasUnsavedLocalDraft] = useState(false)
  const [inFlight, setInFlight] = useState<MobileScheduleAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [rescheduleValue, setRescheduleValue] = useState(() =>
    toDatetimeLocalValue(initial.scheduledAt),
  )

  // Detect an unconfirmed device draft for this article (本机稿 / 未保存).
  useEffect(() => {
    let disposed = false
    const drafts = createLocalDraftStore()
    const check = () => {
      if (disposed) return
      const record = drafts.load(draftKeyFor(view.articleId))
      setHasUnsavedLocalDraft(Boolean(record))
    }
    check()
    // Re-check when the tab regains focus (author may have returned and saved).
    window.addEventListener('focus', check)
    return () => {
      disposed = true
      window.removeEventListener('focus', check)
    }
  }, [view.articleId])

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/mobile/schedule?scheduleId=${encodeURIComponent(scheduleId)}`)
    if (!res.ok) {
      setFeedback({ type: 'error', message: '刷新排期失败' })
      return
    }
    const data = (await res.json()) as { schedule: MobileScheduleView }
    setView(data.schedule)
  }, [scheduleId])

  const actions = useMemo(() => availableScheduleActions(view.status), [view.status])
  const terminal = terminalReason(view.status)

  const blockedFor = useCallback(
    (action: MobileScheduleAction): string | null => {
      const key = scheduleBlocker(
        {
          scheduleStatus: view.status,
          hasUnsavedLocalDraft,
          latestVersion: view.latestVersion,
          scheduleVersion: view.version,
        },
        action,
      )
      return key ? BLOCKER_LABELS[key] : null
    },
    [view, hasUnsavedLocalDraft],
  )

  const run = async (action: MobileScheduleAction, extra: Record<string, unknown> = {}) => {
    if (inFlight) return // 重复点击保护
    const blockReason = blockedFor(action)
    if (blockReason) {
      setFeedback({ type: 'error', message: blockReason })
      return
    }
    // B8-05 (#64): 卡片不直接执行 —— 立即发布必须先在完整发布确认页确认。
    // A card never force-fires a scheduled intent; it routes to the full-page
    // confirm so the PUBLISH goes through the SHARED #33/#34 kernel with a
    // single exact event + receipt, never a raw schedule-control force-fire.
    if (action === 'publish_now') {
      router.push(`/admin/publish/${view.articleId}`)
      return
    }
    const rescheduleChecked =
      action === 'reschedule'
        ? parseScheduleDatetime(String(extra.newScheduledAt ?? ''))
        : undefined
    if (action === 'reschedule' && rescheduleChecked === null) {
      setFeedback({ type: 'error', message: '请选择有效的改期时间' })
      return
    }
    setInFlight(action)
    setFeedback(null)
    try {
      const res = await fetch('/api/mobile/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduleId,
          action,
          newScheduledAt: rescheduleChecked,
          timezone: SCHEDULE_DISPLAY_TIMEZONE,
          newVersion: extra.newVersion,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        result?: { outcome?: string; reason?: string }
        schedule?: MobileScheduleView
      }
      if (!res.ok) {
        setFeedback({ type: 'error', message: (data.result?.reason) || '操作失败' })
        return
      }
      // Authority is D1 — apply the re-read schedule, never a local guess.
      if (data.schedule) setView(data.schedule)
      const outcome = data.result?.outcome
      const okMessage =
        action === 'reschedule' ? '已改期'
          : action === 'cancel' ? '已取消排期'
            : action === 'reconfirm' ? '已重新确认'
              : '已暂停'
      setFeedback({
        type: outcome === 'conflict' || outcome === 'invalid' ? 'error' : 'success',
        message: outcome === 'conflict' || outcome === 'invalid' ? (data.result?.reason ?? '操作被拒绝') : okMessage,
      })
      if (action === 'reschedule') setRescheduleOpen(false)
      router.refresh()
    } catch {
      setFeedback({ type: 'error', message: '网络错误，请重试' })
    } finally {
      setInFlight(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center gap-2">
        <Link
          href="/admin/today"
          className="inline-flex items-center gap-1 text-sm text-[var(--editor-muted)] hover:text-[var(--editor-ink)]"
        >
          <ArrowLeft className="h-4 w-4" /> 返回
        </Link>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${
          view.status === 'pending' ? 'bg-emerald-500/10 text-emerald-700' :
          view.status === 'paused' || view.status === 'stale' ? 'bg-amber-500/10 text-amber-700' :
          view.status === 'claimed' ? 'bg-sky-500/10 text-sky-700' : 'bg-[var(--editor-soft)] text-[var(--editor-muted)]'
        }`}>
          {scheduleStatusLabel(view.status)}
        </span>
      </div>

      {feedback && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          feedback.type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' :
          feedback.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' :
          'border-[var(--editor-line)] bg-[var(--editor-soft)] text-[var(--editor-muted)]'
        }`}>
          <div className="flex items-center gap-2">
            <span className="truncate">{feedback.message}</span>
            <button type="button" onClick={() => setFeedback(null)} className="ml-auto shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* schedule facts */}
      <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-600">
            <CalendarClock className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="min-w-0 max-w-full truncate text-lg font-semibold text-[var(--editor-ink)]">
              {view.title || '(无标题)'}
            </h1>
            <p className="text-xs text-[var(--editor-muted)] font-mono truncate">
              #{view.scheduleId}
            </p>
          </div>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          <FactRow label="发布时间" icon={<Clock className="h-4 w-4" />}>
            <span className="font-medium text-[var(--editor-ink)] tabular-nums">
              {formatScheduleTime(view.scheduledAt)}
            </span>
            <span className="ml-2 rounded bg-[var(--editor-soft)] px-1.5 py-0.5 text-[11px] text-[var(--editor-muted)]">
              {SCHEDULE_DISPLAY_TIMEZONE}
            </span>
          </FactRow>
          <FactRow label="绑定版本">
            <span className="font-mono tabular-nums text-[var(--editor-ink)]">v{view.version}</span>
            {view.latestVersion !== null && view.latestVersion !== view.version && (
              <span className="ml-2 text-xs text-amber-600">最新 v{view.latestVersion}（版本已变化）</span>
            )}
          </FactRow>
          {view.staleReason && <FactRow label="原因"><span className="text-amber-600">{view.staleReason}</span></FactRow>}
          {view.lastError && <FactRow label="错误"><span className="text-rose-600 font-mono text-xs">{view.lastError}</span></FactRow>}
        </dl>
      </section>

      {/* blockers */}
      {hasUnsavedLocalDraft && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {BLOCKER_LABELS['unsaved-local-draft']}
          <Link href={`/editor?edit=${encodeURIComponent(view.slug)}`} className="ml-2 inline-flex items-center gap-1 font-medium text-amber-700 underline">
            <Pencil className="h-3.5 w-3.5" /> 去编辑
          </Link>
        </div>
      )}

      {/* actions */}
      {terminal ? (
        <div className="rounded-xl border border-dashed border-[var(--editor-line)] px-4 py-4 text-sm text-[var(--editor-muted)]">
          {terminal}
        </div>
      ) : (
        <section className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const blockLabel = blockedFor(action)
            const disabled = Boolean(blockLabel) || inFlight !== null
            return (
              <ActionButton
                key={action}
                action={action}
                disabled={disabled}
                loading={inFlight === action}
                onClick={() => void run(action, { newVersion: view.latestVersion ?? view.version })}
              />
            )
          })}
          {actions.length === 0 && (
            <div className="col-span-2 text-sm text-[var(--editor-muted)] border border-dashed border-[var(--editor-line)] rounded-xl px-4 py-4 text-center">
              当前状态无可执行的操作。
            </div>
          )}
        </section>
      )}

      {blockedFor('publish_now') && view.status !== 'pending' && (
        <p className="text-xs text-[var(--editor-muted)]">{BLOCKER_LABELS['version-drift']}</p>
      )}

      {/* reschedule inline input */}
      {rescheduleOpen && (
        <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-4 space-y-3">
          <label className="text-sm text-[var(--editor-ink)]">改期到（{SCHEDULE_DISPLAY_TIMEZONE}）</label>
          <input
            type="datetime-local"
            value={rescheduleValue}
            onChange={(e) => setRescheduleValue(e.target.value)}
            className="w-full rounded-lg border border-[var(--editor-line)] bg-[var(--editor-soft)] px-3 py-2.5 text-sm text-[var(--editor-ink)] outline-none focus:border-[var(--editor-accent)]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRescheduleOpen(false)}
              className="flex-1 rounded-lg border border-[var(--editor-line)] py-2.5 text-sm text-[var(--editor-muted)]"
              disabled={inFlight !== null}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void run('reschedule', { newScheduledAt: rescheduleValue })}
              disabled={inFlight !== null}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--editor-accent)] py-2.5 text-sm font-semibold text-white hover:brightness-105 disabled:opacity-50"
            >
              {inFlight === 'reschedule' ? '提交中…' : '确认改期'}
            </button>
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => void refresh()}
        disabled={inFlight !== null}
        className="inline-flex items-center gap-1 text-xs text-[var(--editor-muted)] hover:text-[var(--editor-ink)] disabled:opacity-50"
      >
        <RefreshCw className="h-3.5 w-3.5" /> 从服务器刷新
      </button>
    </div>
  )
}

function FactRow({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="w-20 shrink-0 text-xs text-[var(--editor-muted)]">{label}</dt>
      <dd className="flex min-w-0 items-center text-[var(--editor-ink)]">
        {icon && <span className="mr-1.5 text-[var(--editor-muted)]">{icon}</span>}
        {children}
      </dd>
    </div>
  )
}

function ActionButton({
  action,
  disabled,
  loading,
  onClick,
}: {
  action: MobileScheduleAction
  disabled: boolean
  loading: boolean
  onClick: () => void
}) {
  const Icon =
    action === 'reschedule' ? <RotateCcw className="h-4 w-4" />
      : action === 'publish_now' ? <Send className="h-4 w-4" />
        : action === 'reconfirm' ? <Check className="h-4 w-4" />
          : action === 'pause' ? <Clock className="h-4 w-4" />
            : <X className="h-4 w-4" />
  const tone =
    action === 'publish_now'
      ? 'text-white bg-[var(--editor-accent)] hover:brightness-105'
      : action === 'cancel'
        ? 'border border-rose-200 text-rose-600 hover:bg-rose-50'
        : 'border border-[var(--editor-line)] text-[var(--editor-ink)] hover:bg-[var(--editor-soft)]'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium disabled:opacity-40 ${tone}`}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : Icon}
      {loading ? '处理中…' : scheduleActionLabel(action)}
    </button>
  )
}
