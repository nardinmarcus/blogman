'use client'

import { Link2 } from 'lucide-react'
import { useToast } from '@/components/Toast'

interface CopyArticleLinkProps {
  url: string
}

export function CopyArticleLink({ url }: CopyArticleLinkProps) {
  const toast = useToast()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('已复制文章链接')
    } catch {
      toast.error('复制链接失败')
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--editor-line)] bg-[var(--editor-panel)] px-3 py-1.5 text-xs font-medium text-[var(--editor-ink)] transition hover:border-[var(--editor-accent)]/35 hover:bg-[var(--editor-soft)]"
    >
      <Link2 className="h-3.5 w-3.5" />
      复制链接
    </button>
  )
}
