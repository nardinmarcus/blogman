'use client'

import dynamic from 'next/dynamic'

const InlineArticleEditor = dynamic(
  () => import('@/components/InlineArticleEditor').then(m => ({ default: m.InlineArticleEditor })),
  {
    ssr: false,
    loading: () => <div className="prose prose-lg max-w-none" />,
  }
)

export function InlineArticleEditorClient(props: {
  slug: string
  title: string
  html: string
  category?: string | null
  coverImage?: string | null
  password?: string | null
  publishedAt?: number
  viewCount?: number
  content?: string
  onExitReading?: () => void
  articleId?: number | null
  version?: number | null
  status?: 'draft' | 'published'
  description?: string | null
  tags?: string[] | null
  isHidden?: number
}) {
  return <InlineArticleEditor {...props} />
}
