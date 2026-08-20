import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { getMobileScheduleView } from '@/lib/mobile-schedule'
import { MobileScheduleManager } from '@/components/MobileScheduleManager'

export const metadata = { title: '排期管理' }

export default async function MobileSchedulePage({
  params,
}: {
  params: Promise<{ scheduleId: string }>
}) {
  const { scheduleId } = await params
  const env = await getAppCloudflareEnv()

  let initial: Awaited<ReturnType<typeof getMobileScheduleView>> | null = null
  let error: string | null = null
  if (env?.DB) {
    try {
      initial = await getMobileScheduleView(env.DB, scheduleId)
      if (!initial) error = '排期不存在或已删除'
    } catch (e) {
      rethrowIfDatabaseMigrationRequired(e)
      error = '读取排期失败'
    }
  } else {
    error = '数据库不可用'
  }

  if (error || !initial) {
    return (
      <div className="text-sm text-[var(--editor-muted)] border border-dashed border-[var(--editor-line)] rounded-xl p-8 text-center">
        {error ?? '排期不存在'}
      </div>
    )
  }

  return <MobileScheduleManager initial={initial} scheduleId={scheduleId} />
}
