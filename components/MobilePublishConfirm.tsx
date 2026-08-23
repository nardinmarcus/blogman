'use client'

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, CircleAlert, Clock, Globe, Send } from 'lucide-react'
import { CONFIRM_BLOCKER_LABELS, formatPublishTime } from '@/lib/mobile-publish/model'
import type { MobilePublishConfirmation } from '@/lib/mobile-publish/view'
import type { MobileConfirmResult } from '@/lib/mobile-publish/kernel'
import type { ReceiptSurface } from '@/lib/mobile-publish/model'

/**
 * B8-05 — mobile full-page publish confirmation + receipt (issue #64).
 *
 * A standalone full page (390px-first single column) that shows the EXACT
 * version content, the existing public address / access / time / channel facts,
 * and the blocker status. A SINGLE result-type primary button drives the SHARED
 * #33/#34 publish kernel through the thin `/api/mobile/publish` route — there
 * is NO second confirmation modal and the button disables on first click
 * (duplicate-tap protection + server idempotency via event/outbox uniqueness).
 *
 * - version drift during confirmation → the server returns conflict; the page
 *   aborts the attempt and returns to the prepare state with a refresh;
 * - success → a combined receipt distinguishing 博客 / 排期 / 渠道 progress,
 *   read fresh from D1.
 *
 * No `node:crypto` is imported anywhere on the client — the kernel computes
 * deterministic ids server-side, keeping this component browser-safe.
 */

type Feedback = { type: 'success' | 'error' | 'info'; message: string } | null

export function MobilePublishConfirm({
  initial,
  articleId,
}: {
  initial: MobilePublishConfirmation
  articleId: number
}) {
  const router = useRouter()
  const [conf, setConf] = useState<MobilePublishConfirmation>(initial)
  const [inFlight, setInFlight] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [receipt, setReceipt] = useState<ReceiptSurface[] | null>(null)
  const [receiptFacts, setReceiptFacts] = useState<{ version: number; publicUrl: string; publishedAt: number } | null>(null)
  const [drifted, setDrifted] = useState(false)
  const startedPathRef = useRef(conf.path)

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/mobile/publish?articleId=${encodeURIComponent(String(articleId))}`)
    if (!res.ok) {
      setFeedback({ type: 'error', message: '刷新确认页失败' })
      return
    }
    const data = (await res.json()) as { confirmation: MobilePublishConfirmation | null }
    if (data.confirmation) setConf(data.confirmation)
  }, [articleId])

  // Confirm once; the button disables at the first click (no second modal).
  const confirm = async () => {
    if (inFlight) return
    setInFlight(true)
    setFeedback(null)
    setReceipt(null)
    try {
      const res = await fetch('/api/mobile/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', articleId, path: startedPathRef.current, expectedVersion: conf.exactVersion }),
      })
      const data = (await res.json().catch(() => ({}))) as MobileConfirmResult & { message?: string }
      if (!res.ok) {
        setFeedback({ type: 'error', message: data.message || '发布失败' })
        return
      }
      if (data.outcome === 'conflict') {
        // Acceptance: version changed during confirm → abort and return to prepare.
        setDrifted(true)
        setFeedback({ type: 'info', message: data.reason || '文章版本已变化，已终止并返回准备' })
        await refresh()
        return
      }
      if (data.outcome === 'blocked') {
        setFeedback({ type: 'error', message: data.reason || '发布被阻塞项拦截' })
        await refresh()
        return
      }
      if (data.outcome === 'invalid' || data.outcome === 'aborted' || data.outcome === 'not-found') {
        setFeedback({
          type: 'error',
          message: data.outcome === 'not-found' ? '文章不存在' : (data.reason || '发布失败'),
        })
        return
      }
      // delivered / replayed / already-published → receipt.
      setReceipt(data.receipt ?? null)
      setReceiptFacts({ version: data.version, publicUrl: data.publicUrl, publishedAt: data.publishedAt ?? 0 })
    } catch {
      setFeedback({ type: 'error', message: '网络错误，请重试' })
    } finally {
      setInFlight(false)
    }
  }

  const ready = conf.canConfirm && !drifted
  const blockers = Object.entries(conf.blockers) as Array<[keyof MobilePublishConfirmation['blockers'], boolean]>
  const pathLabel = conf.path === 'revision' ? '修订上线' : conf.path === 'first' ? '首次发布' : '不可发布'

  return (
    <div className="min-h-screen bg-[var(--editor-app-bg)]">
      <div className="mx-auto max-w-[430px] min-h-screen flex flex-col">
        {/* header (390px-first) */}
        <header className="sticky top-0 z-40 h-14 border-b border-[var(--editor-line)] bg-[color-mix(in_srgb,var(--background)_90%,transparent)] backdrop-blur-lg px-3">
          <div className="flex h-full items-center gap-2">
            <Link href="/admin/today" className="flex items-center gap-1 shrink-0 text-sm text-[var(--editor-muted)] hover:text-[var(--editor-ink)]">
              <ArrowLeft className="h-4 w-4" /> 返回
            </Link>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--editor-ink)]">发布确认</p>
            </div>
            <span className={`shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${
              conf.canConfirm ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'
            }`}>
              {pathLabel}
            </span>
          </div>
          {feedback && (
            <div className={`flex items-center gap-2 border-t border-[var(--editor-line)] py-2 text-sm ${
              feedback.type === 'success' ? 'bg-emerald-50 text-emerald-800'
              : feedback.type === 'error' ? 'bg-rose-50 text-rose-800'
              : 'bg-amber-50 text-amber-800'
            }`}>
              <span className="truncate">{feedback.message}</span>
              <button type="button" onClick={() => setFeedback(null)} className="ml-auto shrink-0 px-1">✕</button>
            </div>
          )}
        </header>

        <main className="flex-1 space-y-4 p-4 pb-28">
          {/* exact version — the version this page will publish */}
          <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--editor-ink)] line-clamp-1">{conf.title}</h2>
              <span className="shrink-0 rounded-lg bg-[var(--editor-soft)] px-2 py-1 text-xs font-mono text-[var(--editor-muted)]">
                v{conf.exactVersion}
              </span>
            </div>
            {conf.pendingRevisionNumber !== null && (
              <p className="mt-1 text-xs text-[var(--editor-muted)]">待发布修订 v{conf.pendingRevisionNumber} · 修订编号 {conf.exactVersion}</p>
            )}
            <p className="mt-1 text-xs text-[var(--editor-muted)] font-mono break-all">/{conf.slug}</p>
          </section>

          {/* access / address / time / channel */}
          <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-4 space-y-2.5">
            <div className="flex items-center gap-2 text-sm text-[var(--editor-ink)]">
              <Globe className="h-4 w-4 text-[var(--editor-muted)]" />
              <span className="w-14 shrink-0 text-[var(--editor-muted)]">公开地址</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{conf.publicUrl ?? '首次发布 · 确认后生成'}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-[var(--editor-ink)]">
              <Clock className="h-4 w-4 text-[var(--editor-muted)]" />
              <span className="w-14 shrink-0 text-[var(--editor-muted)]">开放</span>
              <span className="min-w-0 flex-1 truncate">{conf.path === 'revision' ? '公开网页（正式版）' : '首次公开上线'}</span>
            </div>
          </section>

          {/* blocker status — 阻塞项存在时不能确认 */}
          <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--editor-muted)]">发布条件</h3>
            {blockers.map(([key, ok]) => (
              <div key={key} className="flex items-start gap-2 text-sm">
                {ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                )}
                <span className={ok ? 'text-[var(--editor-ink)]' : 'text-rose-600'}>{CONFIRM_BLOCKER_LABELS[key]}</span>
              </div>
            ))}
          </section>

          {/* exact version content preview */}
          <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--editor-muted)]">确认内容</h3>
            {conf.contentHtml ? (
              <div
                className="prose prose-sm max-w-none text-sm text-[var(--editor-ink)] [&>p]:my-1"
                dangerouslySetInnerHTML={{ __html: conf.contentHtml }}
              />
            ) : (
              <p className="text-sm text-[var(--editor-muted)]">正文为空</p>
            )}
          </section>

          {/* receipt — successful publish */}
          {receipt && receiptFacts && (
            <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Check className="h-5 w-5 text-emerald-700" />
                <h3 className="text-base font-semibold text-emerald-800">发布回执</h3>
              </div>
              <dl className="space-y-1.5 text-sm">
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-emerald-700/70">版本</dt>
                  <dd className="font-mono text-emerald-900">v{receiptFacts.version}</dd>
                </div>
                {receiptFacts.publishedAt > 0 && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-emerald-700/70">时间</dt>
                    <dd className="font-mono text-emerald-900">{formatPublishTime(receiptFacts.publishedAt)}</dd>
                  </div>
                )}
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-emerald-700/70">地址</dt>
                  <dd className="break-all font-mono text-xs text-emerald-900">{receiptFacts.publicUrl}</dd>
                </div>
              </dl>
              <div className="space-y-1.5">
                {receipt.map((s) => (
                  <div key={s.key} className="flex items-center gap-2 rounded-xl bg-white/60 px-3 py-2 text-sm">
                    <span className="w-10 shrink-0 font-medium text-emerald-800">{s.label}</span>
                    <span className="min-w-0 flex-1 truncate text-emerald-900">{s.state}</span>
                    {s.url && <span className="max-w-[40%] truncate font-mono text-[11px] text-emerald-600">{s.url}</span>}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => router.push('/admin/today')}
                className="w-full rounded-lg border border-emerald-300 py-2.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
              >
                返回工作台
              </button>
            </section>
          )}
        </main>

        {/* single result-type primary action (no second modal; disables on click); hidden once the receipt shows */}
        {!receipt && (
        <footer className="fixed bottom-0 inset-x-0 z-40 border-t border-[var(--editor-line)] bg-[var(--editor-panel)]/95 backdrop-blur">
          <div className="mx-auto max-w-[430px] px-4 py-3">
            <button
              type="button"
              disabled={inFlight || !ready}
              onClick={() => void confirm()}
              className={`w-full inline-flex items-center justify-center gap-2 rounded-xl py-3.5 text-base font-semibold text-white disabled:opacity-50 ${
                ready ? 'bg-[var(--editor-accent)] hover:brightness-105' : 'bg-[var(--editor-muted)]'
              }`}
            >
              {inFlight ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  发布中…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  {conf.path === 'revision' ? '确认上线修订' : '确认发布'}
                </>
              )}
            </button>
          </div>
        </footer>
        )}
      </div>
    </div>
  )
}
