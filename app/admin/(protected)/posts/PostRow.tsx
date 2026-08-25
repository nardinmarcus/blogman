'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Eye, Link2, Edit, Pin, PinOff, EyeOff, Eye as EyeIcon, Lock, Unlock, Check, FileText, Trash2, MoreHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/Toast'
import { Modal } from '@/components/Modal'
import { PasswordModal } from '@/components/PasswordModal'
import { Dropdown } from '@/components/Dropdown'
import { getSiteUrl } from '@/lib/site-config'
import type { AdminListPost } from './page'

interface PostRowProps {
  post: AdminListPost
  categories: string[]
  preferMenuUp?: boolean
  selected?: boolean
  onSelectChange?: () => void
}

/** Client-side operation id — stable per user action, replayed server-side. */
function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

function formatDate(ts: number) {
  const date = new Date(ts * 1000)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays}天前`

  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  })
}

export function PostRow({ post, categories, preferMenuUp = false, selected = false, onSelectChange }: PostRowProps) {
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showPinModal, setShowPinModal] = useState(false)
  const [showHiddenModal, setShowHiddenModal] = useState(false)
  const [showStatusModal, setShowStatusModal] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [loading, setLoading] = useState(false)

  const router = useRouter()
  const toast = useToast()

  // B2-06 — under versioned authority every list write goes through the explicit
  // /api/article-commands protocol carrying expected version + operation id. On a
  // ledger-only DB (no identity tables ⇒ articleId/version are null) the same
  // action falls back to the legacy direct PUT so existing CRUD never 503s.
  const hasAuthority = typeof post.articleId === 'number' && typeof post.version === 'number'
  const command = async (action: string, value: Record<string, unknown>): Promise<Response> => {
    if (!hasAuthority) {
      const legacyBody: Record<string, unknown> =
        action === 'setPinned' ? { is_pinned: value.is_pinned }
          : action === 'setHidden' ? { is_hidden: value.is_hidden }
            : action === 'setPassword' ? { password: value.password }
              : action === 'setCategory' ? { category: value.category }
                : action === 'softDelete' ? { status: 'deleted' }
                  : action === 'restore' ? { status: 'draft' }
                    : action === 'publishTemp' ? { status: value.status }
                      : {}
      return fetch(`/api/admin/posts/${post.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyBody),
      })
    }
    return fetch('/api/article-commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        slug: post.slug,
        articleId: post.articleId,
        expectedVersion: post.version,
        operationId: operationId(),
        ...value,
      }),
    })
  }

  /**
   * Execute one explicit list command. A server-side `conflict` outcome (HTTP
   * 200 with `outcome: conflict`) surfaces explicitly — the stale action is
   * never applied and never reported as a success.
   */
  const run = async (action: string, value: Record<string, unknown>, successMsg: string): Promise<boolean> => {
    setLoading(true)
    try {
      const res = await command(action, value)
      let data: { outcome?: string; error?: string } | null = null
      try {
        data = (await res.json()) as { outcome?: string; error?: string }
      } catch {
        data = null
      }
      const outcome = data?.outcome
      if (res.ok && (outcome === undefined || outcome === 'applied' || outcome === 'replayed' || outcome === 'legacy-applied')) {
        toast.success(successMsg)
        return true
      }
      if (outcome === 'conflict') {
        toast.error('版本冲突：这篇文章已被他人修改，未应用改动，请刷新后重试')
      } else {
        toast.error(data?.error || '操作失败，请重试')
      }
      router.refresh()
      return false
    } catch {
      toast.error('网络错误，请重试')
      return false
    } finally {
      setLoading(false)
    }
  }

  const siteUrl = getSiteUrl()
  const baseArticleUrl = `${siteUrl}/${post.slug}`
  const articleUrl = post.password
    ? `${baseArticleUrl}?pwd=${post.password}`
    : baseArticleUrl

  const isDeleted = post.status === 'deleted'
  const statusLabel = isDeleted ? '已删除' : post.status === 'published' ? '已发布' : '草稿'
  const statusChipClass = isDeleted
    ? 'border-gray-200 bg-gray-100 text-gray-500'
    : post.status === 'published'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-amber-200 bg-amber-50 text-amber-700'
  const menuButtonClass =
    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-[var(--editor-ink)] transition-colors hover:bg-[var(--editor-soft)] disabled:cursor-not-allowed disabled:opacity-50'
  const menuVerticalClass = preferMenuUp ? 'bottom-full mb-2' : 'top-full mt-2'
  const desktopMenuClass = `absolute right-0 z-30 w-48 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-1 shadow-xl ${menuVerticalClass}`
  const mobileMenuClass = `absolute left-0 z-30 w-48 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-1 shadow-xl ${menuVerticalClass}`

  const handleMoreAction = (action: () => void) => {
    setShowMoreMenu(false)
    action()
  }

  // 分类选项
  const categoryOptions = [
    { value: '', label: '未分类' },
    ...categories.map((cat) => ({ value: cat, label: cat })),
  ]

  // B3 分流文案：从未正式发布 → 首次上线；曾正式发布 → 重新上线；ledger-only → 旧「发布文章」
  const canFirstPublish = hasAuthority && post.formalPublished !== true
  const publishLabel =
    post.status === 'published'
      ? '转为草稿'
      : canFirstPublish
        ? '发布（首次上线）'
        : hasAuthority
          ? '重新上线'
          : '发布文章'

  // 查看文章
  const handleView = () => {
    window.open(articleUrl, '_blank')
  }

  // 复制链接
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(articleUrl)
      toast.success(post.password ? '已复制带密码的链接' : '已复制链接')
    } catch {
      toast.error('复制失败')
    }
  }

  // 更新分类
  const handleCategoryChange = async (newCategory: string) => {
    const ok = await run('setCategory', { category: newCategory || null }, '分类已更新')
    if (ok) router.refresh()
  }

  // 置顶切换
  const handlePinToggle = async () => {
    const newPinned = post.is_pinned === 1 ? 0 : 1
    const ok = await run('setPinned', { is_pinned: newPinned }, newPinned === 1 ? '已置顶' : '已取消置顶')
    if (ok) {
      setShowPinModal(false)
      router.refresh()
    }
    return ok
  }

  // 隐藏切换
  const handleHiddenToggle = async () => {
    const newHidden = post.is_hidden === 1 ? 0 : 1
    const ok = await run('setHidden', { is_hidden: newHidden }, newHidden === 1 ? '已隐藏' : '已取消隐藏')
    if (ok) {
      setShowHiddenModal(false)
      router.refresh()
    }
    return ok
  }

  // 状态切换（发布/取消发布）—— B3 canonical 分流：
  //   · 从未正式发布（无 formal_publication）→ 打开首次发布确认流（prepare →
  //     四阻塞项与精确版本 → confirm → publicUrl 回执），绝不走临时命令；
  //   · 曾正式发布 → relive / unpublish 生命周期命令；
  //   · ledger-only 库（无身份表）→ 保留旧直写回退。
  const handleStatusToggle = async () => {
    if (hasAuthority && post.formalPublished !== true) {
      // 首次上线：交给共享 #33/#34 发布确认页（服务端 prepare/confirm + 回执）。
      router.push(`/admin/publish/${post.articleId}`)
      setShowStatusModal(false)
      return true
    }
    if (hasAuthority) {
      // 曾正式发布：生命周期命令，不使用 publishTemp。
      const action = post.status === 'published' ? 'unpublish' : 'relive'
      const ok = await run(action, { content: 'formal' }, action === 'unpublish' ? '已取消发布' : '已重新上线')
      if (ok) {
        setShowStatusModal(false)
        router.refresh()
      }
      return ok
    }
    const newStatus = post.status === 'published' ? 'draft' : 'published'
    const ok = await run(
      'publishTemp',
      { currentStatus: post.status === 'published' ? 'published' : 'draft', status: newStatus },
      newStatus === 'published' ? '已发布' : '已转为草稿',
    )
    if (ok) {
      setShowStatusModal(false)
      router.refresh()
    }
    return ok
  }

  // 软删除
  const handleSoftDelete = async () => {
    const ok = await run('softDelete', {}, '已删除（可恢复）')
    if (ok) {
      setShowDeleteModal(false)
      router.refresh()
    }
    return ok
  }

  // 恢复
  const handleRestore = async () => {
    const ok = await run('restore', {}, '已恢复为草稿')
    if (ok) router.refresh()
  }

  return (
    <>
      {/* 桌面端 */}
      <div className="hidden md:grid grid-cols-[32px_50px_1fr_120px_90px_150px] gap-3 px-5 py-3 hover:bg-[var(--editor-panel)] transition-colors items-center">
        {/* 选择列 */}
        <span className="flex items-center">
          {onSelectChange && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onSelectChange()}
              className="accent-[var(--editor-accent)]"
              aria-label={`选择 ${post.title}`}
            />
          )}
        </span>
        {/* 状态列 */}
        <div className="flex flex-col items-center gap-1.5">
          {/* 状态圆点 */}
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              post.status === 'published'
                ? 'bg-emerald-500'
                : post.status === 'deleted'
                ? 'bg-gray-400'
                : 'bg-amber-500'
            }`}
            title={post.status === 'published' ? '已发布' : post.status === 'deleted' ? '已删除' : '草稿'}
          />
          {/* 图标行 */}
          <div className="flex items-center gap-1">
            {post.is_pinned === 1 && (
              <Pin className="w-3 h-3 text-[var(--editor-accent)]" />
            )}
            {post.password && (
              <Lock className="w-3 h-3 text-[var(--stone-gray)]" />
            )}
            {post.is_hidden === 1 && (
              <EyeOff className="w-3 h-3 text-[var(--stone-gray)]" />
            )}
          </div>
        </div>

        {/* 标题列 */}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href={`/editor?edit=${post.slug}`}
              className="block min-w-0 truncate font-medium text-[var(--editor-ink)] transition-colors hover:text-[var(--editor-accent)]"
            >
              {post.title}
            </Link>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusChipClass}`}>
              {statusLabel}
            </span>
          </div>
          {(post.is_pinned === 1 || post.password || post.is_hidden === 1) && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {post.is_pinned === 1 && (
                <span className="rounded-full bg-[var(--editor-accent)]/8 px-2 py-0.5 text-[10px] font-medium text-[var(--editor-accent)]">
                  置顶
                </span>
              )}
              {post.password && (
                <span className="rounded-full bg-[var(--editor-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--editor-muted)]">
                  加密
                </span>
              )}
              {post.is_hidden === 1 && (
                <span className="rounded-full bg-[var(--editor-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--editor-muted)]">
                  链接访问
                </span>
              )}
            </div>
          )}
          {post.description && (
            <p className="text-xs text-[var(--editor-muted)] line-clamp-1 leading-relaxed mt-0.5">
              {post.description}
            </p>
          )}
        </div>

        {/* 分类列 */}
        <div className="flex items-center">
          <Dropdown
            options={categoryOptions}
            value={post.category || ''}
            onChange={handleCategoryChange}
            placeholder="未分类"
            className="w-full"
            disabled={loading || isDeleted}
          />
        </div>

        {/* 阅读/日期列 */}
        <div className="flex flex-col items-center justify-center text-xs">
          <span className="text-[var(--editor-ink)] font-medium tabular-nums">
            {post.view_count.toLocaleString()}
          </span>
          <span className="text-[var(--stone-gray)] text-[11px]">
            {formatDate(post.published_at)}
          </span>
        </div>

        {/* 操作列 */}
        <div className="flex items-center justify-end gap-1">
          {isDeleted ? (
            <button
              type="button"
              onClick={handleRestore}
              disabled={loading}
              className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors disabled:opacity-50"
              title="恢复"
            >
              <Check className="w-4 h-4 text-emerald-600" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleView}
                className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors"
                title="查看文章"
              >
                <Eye className="w-4 h-4 text-[var(--stone-gray)]" />
              </button>
              <button
                type="button"
                onClick={handleCopyLink}
                className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors"
                title="复制链接"
              >
                <Link2 className="w-4 h-4 text-[var(--stone-gray)]" />
              </button>
              <Link
                href={`/editor?edit=${post.slug}`}
                className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors"
                title="编辑"
              >
                <Edit className="w-4 h-4 text-[var(--stone-gray)]" />
              </Link>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowMoreMenu((value) => !value)}
                  disabled={loading}
                  aria-expanded={showMoreMenu}
                  aria-label="更多操作"
                  className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors disabled:opacity-50"
                  title="更多操作"
                >
                  <MoreHorizontal className="w-4 h-4 text-[var(--stone-gray)]" />
                </button>
                {showMoreMenu && (
                  <div className={desktopMenuClass}>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowPinModal(true))}
                      disabled={loading}
                      className={menuButtonClass}
                    >
                      {post.is_pinned === 1 ? (
                        <PinOff className="w-4 h-4 text-[var(--editor-accent)]" />
                      ) : (
                        <Pin className="w-4 h-4 text-[var(--stone-gray)]" />
                      )}
                      <span>{post.is_pinned === 1 ? '取消置顶' : '置顶文章'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowHiddenModal(true))}
                      disabled={loading}
                      className={menuButtonClass}
                    >
                      {post.is_hidden === 1 ? (
                        <EyeOff className="w-4 h-4 text-[var(--stone-gray)]" />
                      ) : (
                        <EyeIcon className="w-4 h-4 text-[var(--stone-gray)]" />
                      )}
                      <span>{post.is_hidden === 1 ? '取消隐藏' : '隐藏文章'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowPasswordModal(true))}
                      className={menuButtonClass}
                    >
                      {post.password ? (
                        <Lock className="w-4 h-4 text-[var(--editor-accent)]" />
                      ) : (
                        <Unlock className="w-4 h-4 text-[var(--stone-gray)]" />
                      )}
                      <span>{post.password ? '管理密码' : '设置密码'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowStatusModal(true))}
                      disabled={loading}
                      className={menuButtonClass}
                    >
                      {post.status === 'published' ? (
                        <FileText className="w-4 h-4 text-amber-500" />
                      ) : (
                        <Check className="w-4 h-4 text-emerald-600" />
                      )}
                      <span>{publishLabel}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowDeleteModal(true))}
                      disabled={loading}
                      className={`${menuButtonClass} text-rose-600 hover:bg-rose-50`}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>删除文章</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 移动端 */}
      <div className="md:hidden p-4 hover:bg-[var(--editor-panel)] transition-colors">
        <div className="flex items-start gap-3 mb-2">
          {onSelectChange && (
            <span className="flex-shrink-0 pt-0.5">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onSelectChange()}
                className="accent-[var(--editor-accent)]"
                aria-label={`选择 ${post.title}`}
              />
            </span>
          )}
          {/* 状态列 */}
          <div className="flex flex-col items-center gap-1 flex-shrink-0">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                post.status === 'published'
                  ? 'bg-emerald-500'
                  : post.status === 'deleted'
                  ? 'bg-gray-400'
                  : 'bg-amber-500'
              }`}
            />
            <div className="flex flex-col gap-0.5">
              {post.is_pinned === 1 && <Pin className="w-3 h-3 text-[var(--editor-accent)]" />}
              {post.password && <Lock className="w-3 h-3 text-[var(--stone-gray)]" />}
              {post.is_hidden === 1 && <EyeOff className="w-3 h-3 text-[var(--stone-gray)]" />}
            </div>
          </div>

          {/* 标题 */}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href={`/editor?edit=${post.slug}`}
                className="min-w-0 flex-1 line-clamp-2 font-medium text-[var(--editor-ink)] transition-colors hover:text-[var(--editor-accent)]"
              >
                {post.title}
              </Link>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusChipClass}`}>
                {statusLabel}
              </span>
            </div>
            {(post.is_pinned === 1 || post.password || post.is_hidden === 1) && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {post.is_pinned === 1 && (
                  <span className="rounded-full bg-[var(--editor-accent)]/8 px-2 py-0.5 text-[10px] font-medium text-[var(--editor-accent)]">
                    置顶
                  </span>
                )}
                {post.password && (
                  <span className="rounded-full bg-[var(--editor-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--editor-muted)]">
                    加密
                  </span>
                )}
                {post.is_hidden === 1 && (
                  <span className="rounded-full bg-[var(--editor-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--editor-muted)]">
                    链接访问
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {post.description && (
          <p className="text-xs text-[var(--editor-muted)] line-clamp-2 leading-relaxed mb-3 ml-9">
            {post.description}
          </p>
        )}

        <div className="flex items-center gap-2 text-xs text-[var(--stone-gray)] mb-3 ml-9">
          <div className="w-24">
            <Dropdown
              options={categoryOptions}
              value={post.category || ''}
              onChange={handleCategoryChange}
              placeholder="未分类"
              className="w-full"
              disabled={loading || isDeleted}
            />
          </div>
          <span>·</span>
          <span className="tabular-nums">{post.view_count.toLocaleString()} 次</span>
          <span>·</span>
          <span>{formatDate(post.published_at)}</span>
        </div>

        <div className="flex items-center gap-2 ml-9 flex-wrap">
          {isDeleted ? (
            <button
              type="button"
              onClick={handleRestore}
              disabled={loading}
              className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors disabled:opacity-50"
              title="恢复"
            >
              <Check className="w-4 h-4 text-emerald-600" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleView}
                className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors"
                aria-label="查看文章"
              >
                <Eye className="w-4 h-4 text-[var(--stone-gray)]" />
              </button>
              <button
                type="button"
                onClick={handleCopyLink}
                className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors"
                aria-label="复制链接"
              >
                <Link2 className="w-4 h-4 text-[var(--stone-gray)]" />
              </button>
              <Link
                href={`/editor?edit=${post.slug}`}
                className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors"
                aria-label="编辑"
              >
                <Edit className="w-4 h-4 text-[var(--stone-gray)]" />
              </Link>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowMoreMenu((value) => !value)}
                  disabled={loading}
                  aria-expanded={showMoreMenu}
                  aria-label="更多操作"
                  className="p-1.5 rounded hover:bg-[var(--editor-soft)] transition-colors disabled:opacity-50"
                >
                  <MoreHorizontal className="w-4 h-4 text-[var(--stone-gray)]" />
                </button>
                {showMoreMenu && (
                  <div className={mobileMenuClass}>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowPinModal(true))}
                      disabled={loading}
                      className={menuButtonClass}
                    >
                      {post.is_pinned === 1 ? (
                        <PinOff className="w-4 h-4 text-[var(--editor-accent)]" />
                      ) : (
                        <Pin className="w-4 h-4 text-[var(--stone-gray)]" />
                      )}
                      <span>{post.is_pinned === 1 ? '取消置顶' : '置顶文章'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowHiddenModal(true))}
                      disabled={loading}
                      className={menuButtonClass}
                    >
                      {post.is_hidden === 1 ? (
                        <EyeOff className="w-4 h-4 text-[var(--stone-gray)]" />
                      ) : (
                        <EyeIcon className="w-4 h-4 text-[var(--stone-gray)]" />
                      )}
                      <span>{post.is_hidden === 1 ? '取消隐藏' : '隐藏文章'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowPasswordModal(true))}
                      className={menuButtonClass}
                    >
                      {post.password ? (
                        <Lock className="w-4 h-4 text-[var(--editor-accent)]" />
                      ) : (
                        <Unlock className="w-4 h-4 text-[var(--stone-gray)]" />
                      )}
                      <span>{post.password ? '管理密码' : '设置密码'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowStatusModal(true))}
                      disabled={loading}
                      className={menuButtonClass}
                    >
                      {post.status === 'published' ? (
                        <FileText className="w-4 h-4 text-amber-500" />
                      ) : (
                        <Check className="w-4 h-4 text-emerald-600" />
                      )}
                      <span>{publishLabel}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoreAction(() => setShowDeleteModal(true))}
                      disabled={loading}
                      className={`${menuButtonClass} text-rose-600 hover:bg-rose-50`}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>删除文章</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      <PasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        slug={post.slug}
        articleId={hasAuthority ? post.articleId : null}
        version={hasAuthority ? post.version : null}
        currentPassword={post.password}
        articleUrl={baseArticleUrl}
        onSuccess={() => {
          window.location.reload()
        }}
      />

      <Modal
        isOpen={showPinModal}
        onClose={() => setShowPinModal(false)}
        onConfirm={handlePinToggle}
        title={post.is_pinned === 1 ? '取消置顶' : '置顶文章'}
        description={post.is_pinned === 1 ? '确定要取消置顶吗？' : '置顶后文章将显示在列表顶部。'}
        confirmText="确认"
        type="info"
      />

      <Modal
        isOpen={showHiddenModal}
        onClose={() => setShowHiddenModal(false)}
        onConfirm={handleHiddenToggle}
        title={post.is_hidden === 1 ? '取消隐藏' : '隐藏文章'}
        description={
          post.is_hidden === 1
            ? '取消隐藏后，文章将重新出现在首页、RSS 和搜索结果中。'
            : '隐藏后，文章不会在首页、RSS 和搜索中显示，但可以通过直接链接访问。'
        }
        confirmText="确认"
        type="info"
      />

      <Modal
        isOpen={showStatusModal}
        onClose={() => setShowStatusModal(false)}
        onConfirm={handleStatusToggle}
        title={post.status === 'published' ? '转为草稿' : publishLabel}
        description={
          post.status === 'published'
            ? '转为草稿后，文章将不再公开显示。'
            : canFirstPublish
              ? '将进入首次发布确认：展示精确版本与四项阻塞检查，确认后创建正式发布并生成公开地址。'
              : hasAuthority
                ? '将基于正式版本重新上线，文章将在首页和 RSS 中显示。'
                : '发布后，文章将在首页和 RSS 中显示。'
        }
        confirmText="确认"
        type="info"
      />

      <Modal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleSoftDelete}
        title="删除文章"
        description={`确定要删除「${post.title}」吗？删除后可以在已删除列表中恢复。`}
        confirmText="删除"
        type="warning"
      />
    </>
  )
}
