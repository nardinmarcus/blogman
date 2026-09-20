'use client'

interface Props {
  value: string
  onChange: (value: string) => void
}

export function CustomJsEditor({ value, onChange }: Props) {
  return (
    <div className="space-y-3">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
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
