'use client'

import dynamic from 'next/dynamic'

const MobileEditorClient = dynamic(
  () => import('@/components/MobileEditorClient').then(m => ({ default: m.MobileEditorClient })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen items-center justify-center">
        <div className="text-sm text-gray-500">加载移动编辑器...</div>
      </div>
    ),
  }
)

export function MobileEditorClientEntry({
  initialData,
  skipDraftRestore,
}: {
  initialData?: {
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
  skipDraftRestore?: boolean
}) {
  return <MobileEditorClient initialData={initialData} skipDraftRestore={skipDraftRestore} />
}
