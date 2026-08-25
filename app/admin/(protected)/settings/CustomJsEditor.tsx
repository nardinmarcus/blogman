'use client'

import { useEffect, useRef, useState } from 'react'
import type { AutosaveOptions } from './NavLinksEditor'

interface Props {
  initialValue: string
  onSave: (value: string, opts: AutosaveOptions) => Promise<void>
}

export function CustomJsEditor({ initialValue, onSave }: Props) {
  const [code, setCode] = useState(initialValue)
  const persistedRef = useRef(initialValue)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const commit = (next: string) => {
    const undoValue = persistedRef.current
    if (next === undoValue) return
    void onSave(next, {
      undoValue,
      onUndo: () => {
        if (timerRef.current) clearTimeout(timerRef.current)
        persistedRef.current = undoValue
        setCode(undoValue)
      },
    })
      .then(() => {
        persistedRef.current = next
      })
      .catch(() => {
        // 失败 toast 由父级 save 负责
      })
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    setCode(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => commit(next), 1000)
  }

  return (
    <div className="space-y-3">
      <textarea
        value={code}
        onChange={handleChange}
        rows={8}
        aria-label="自定义 head 代码"
        spellCheck={false}
        className="w-full rounded-lg border border-[var(--editor-line)] bg-[var(--background)] p-3 font-mono text-sm text-[var(--editor-ink)] placeholder:text-[var(--editor-muted)] outline-none focus:border-[var(--editor-accent)] transition-colors resize-y"
        placeholder={'<script>\n  // 在此粘贴统计代码\n</script>'}
      />
      <p className="text-xs text-[var(--editor-muted)]">输入停止后自动保存。</p>
    </div>
  )
}
