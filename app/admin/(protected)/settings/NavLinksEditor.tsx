'use client'

import { useEffect, useRef, useState } from 'react'
import { Modal } from '@/components/Modal'

interface NavLink {
  label: string
  url: string
  openInNewTab: boolean
}

export interface AutosaveOptions {
  /** 本次保存前已持久化的值，用于撤销回滚 */
  undoValue: string
  /** 撤销时恢复组件本地状态 */
  onUndo: () => void
}

interface Props {
  initialValue: string
  onSave: (value: string, opts: AutosaveOptions) => Promise<void>
}

const defaultLinks: NavLink[] = [
  { label: 'GitHub', url: 'https://github.com/nardinmarcus/', openInNewTab: true },
  { label: 'Twitter', url: 'https://x.com/nardinmarcus/', openInNewTab: true },
  { label: 'About', url: '/about', openInNewTab: false },
  { label: 'RSS', url: '/feed.xml', openInNewTab: false },
]

function parseLinks(value: string): NavLink[] {
  if (!value) return defaultLinks
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : defaultLinks
  } catch {
    return defaultLinks
  }
}

export function NavLinksEditor({ initialValue, onSave }: Props) {
  const [initialLinks] = useState(() => parseLinks(initialValue))
  const [links, setLinks] = useState<NavLink[]>(initialLinks)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  // 最近一次成功持久化的序列化值；撤销以此为准
  const persistedRef = useRef(JSON.stringify(initialLinks))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const commit = (next: NavLink[]) => {
    const value = JSON.stringify(next)
    const undoValue = persistedRef.current
    if (value === undoValue) return
    void onSave(value, {
      undoValue,
      onUndo: () => {
        if (timerRef.current) clearTimeout(timerRef.current)
        persistedRef.current = undoValue
        setLinks(parseLinks(undoValue))
      },
    })
      .then(() => {
        persistedRef.current = value
      })
      .catch(() => {
        // 失败 toast 由父级 save 负责；persistedRef 不变，后续编辑会基于旧基线重试
      })
  }

  /** 文本输入：防抖 1 秒自动保存 */
  const scheduleCommit = (next: NavLink[]) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => commit(next), 1000)
  }

  /** 添加/删除/上下移：立即保存 */
  const commitNow = (next: NavLink[]) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    commit(next)
  }

  const update = (idx: number, field: keyof NavLink, value: string | boolean, immediate = false) => {
    const next = links.map((l, i) => (i === idx ? { ...l, [field]: value } : l))
    setLinks(next)
    if (immediate) commitNow(next)
    else scheduleCommit(next)
  }

  const add = () => {
    const next = [...links, { label: '', url: '', openInNewTab: false }]
    setLinks(next)
    commitNow(next)
  }

  const confirmRemove = () => {
    if (deleteIndex === null) return false
    const next = links.filter((_, i) => i !== deleteIndex)
    setLinks(next)
    commitNow(next)
    setDeleteIndex(null)
    return true
  }

  const moveUp = (idx: number) => {
    if (idx <= 0) return
    const next = [...links]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    setLinks(next)
    commitNow(next)
  }

  const moveDown = (idx: number) => {
    if (idx >= links.length - 1) return
    const next = [...links]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    setLinks(next)
    commitNow(next)
  }

  const inputCls = 'h-9 rounded-lg border border-[var(--editor-line)] bg-[var(--background)] px-3 text-sm text-[var(--editor-ink)] placeholder:text-[var(--editor-muted)] outline-none focus:border-[var(--editor-accent)] transition-colors'
  const btnCls = 'h-9 px-3 rounded-lg text-sm font-medium transition-colors'

  return (
    <div className="space-y-3">
      {links.map((link, idx) => (
        <div key={idx} className="flex items-center gap-2 flex-wrap">
          <input
            className={`${inputCls} w-24`}
            placeholder="名称"
            aria-label="链接名称"
            value={link.label}
            onChange={(e) => update(idx, 'label', e.target.value)}
          />
          <input
            className={`${inputCls} flex-1 min-w-[180px]`}
            placeholder="URL"
            aria-label="链接地址"
            value={link.url}
            onChange={(e) => update(idx, 'url', e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs text-[var(--editor-muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={link.openInNewTab}
              onChange={(e) => update(idx, 'openInNewTab', e.target.checked, true)}
              className="accent-[var(--editor-accent)]"
            />
            新窗口
          </label>
          <button onClick={() => moveUp(idx)} disabled={idx === 0} aria-label="上移" className={`${btnCls} bg-[var(--editor-soft)] text-[var(--editor-muted)] hover:text-[var(--editor-ink)] disabled:opacity-30`}>↑</button>
          <button onClick={() => moveDown(idx)} disabled={idx === links.length - 1} aria-label="下移" className={`${btnCls} bg-[var(--editor-soft)] text-[var(--editor-muted)] hover:text-[var(--editor-ink)] disabled:opacity-30`}>↓</button>
          <button onClick={() => setDeleteIndex(idx)} className={`${btnCls} text-red-500 hover:bg-rose-500/10`}>删除</button>
        </div>
      ))}

      <div className="flex items-center gap-3 pt-2">
        <button onClick={add} className={`${btnCls} bg-[var(--editor-soft)] text-[var(--editor-ink)] hover:bg-[var(--border-warm)]`}>
          + 添加链接
        </button>
      </div>

      <Modal
        isOpen={deleteIndex !== null}
        onClose={() => setDeleteIndex(null)}
        onConfirm={confirmRemove}
        title="删除导航链接"
        description={`确定删除导航链接「${deleteIndex !== null ? links[deleteIndex]?.label || '未命名' : ''}」吗？`}
        confirmText="删除"
        type="danger"
      />
    </div>
  )
}
