import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { getMobilePublishConfirmation } from '@/lib/mobile-publish'
import { MobilePublishConfirm } from '@/components/MobilePublishConfirm'

export const metadata = { title: '发布确认' }

/** B8-05 — mobile full-page publish confirmation route (issue #64). */
export default async function MobilePublishConfirmPage({
  params,
}: {
  params: Promise<{ articleId: string }>
}) {
  const { articleId } = await params
  const env = await getAppCloudflareEnv()
  const numeric = Number(articleId)

  let initial: Awaited<ReturnType<typeof getMobilePublishConfirmation>> | null = null
  let error: string | null = null
  if (!Number.isInteger(numeric) || numeric <= 0) {
    error = '无效的文章'
  } else if (env?.DB) {
    try {
      initial = await getMobilePublishConfirmation(env.DB, numeric)
      if (!initial) error = '文章不存在'
    } catch (e) {
      rethrowIfDatabaseMigrationRequired(e)
      error = '读取发布确认失败'
    }
  } else {
    error = '数据库不可用'
  }

  if (error || !initial) {
    return (
      <div className="text-sm text-[var(--editor-muted)] border border-dashed border-[var(--editor-line)] rounded-xl p-8 text-center">
        {error ?? '文章不存在'}
      </div>
    )
  }

  return <MobilePublishConfirm initial={initial} articleId={initial.articleId} />
}
