import Link from 'next/link'
import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { buildTodayWorkbench } from '@/lib/workbench'
import { listNotifications } from '@/lib/notifications'
import { resolveDeepLink } from '@/lib/deep-link'
import type { TodayWorkbench, WorkbenchGroupView } from '@/lib/workbench'
import {
  CalendarClock,
  FileText,
  Bell,
  CircleDot,
  ArrowRight,
  User,
  Cpu,
} from 'lucide-react'

export const metadata = { title: '今天工作台' }

const GROUP_META: Record<string, { icon: typeof FileText; accent: string }> = {
  drafts: { icon: FileText, accent: 'bg-sky-500/10 text-sky-600' },
  schedules: { icon: CalendarClock, accent: 'bg-violet-500/10 text-violet-600' },
  'system-in-progress': { icon: Cpu, accent: 'bg-amber-500/10 text-amber-600' },
  'author-todos': { icon: Bell, accent: 'bg-rose-500/10 text-rose-600' },
}

export default async function TodayWorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>
}) {
  const { focus } = await searchParams
  const env = await getAppCloudflareEnv()
  let workbench: TodayWorkbench | null = null
  let notifications: Awaited<ReturnType<typeof listNotifications>> = []

  if (env?.DB) {
    try {
      workbench = await buildTodayWorkbench(env.DB)
      notifications = await listNotifications(env.DB)
    } catch (error) {
      rethrowIfDatabaseMigrationRequired(error)
      console.error('workbench fetch error:', error)
    }
  }

  // Deep-link focus: re-read current state for the focused entry, never a stale param.
  let focusResolution: Awaited<ReturnType<typeof resolveDeepLink>> | null = null
  if (env?.DB && focus) {
    const [groupSource, sourceType, sourceId] = focus.split(':')
    if (groupSource && sourceType && sourceId) {
      try {
        focusResolution = await resolveDeepLink(env.DB, {
          sourceType: sourceType as 'article' | 'schedule',
          sourceId,
        })
      } catch {
        focusResolution = null
      }
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--editor-ink)]">今天工作台</h1>
          <p className="text-sm text-[var(--editor-muted)] mt-1">按责任方分组的可追溯读模型 —— 由权威事实重建，非恢复源</p>
        </div>
        {workbench && (
          <span className="text-xs px-2.5 py-1 rounded-full bg-[var(--editor-soft)] text-[var(--editor-muted)]">
            {workbench.projectionEnabled ? '投影开启' : '投影已关闭'}
          </span>
        )}
      </div>

      {focusResolution && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-soft)] px-4 py-3">
          {focusResolution.fallback && (
            <span className="text-[11px] px-2 py-0.5 rounded bg-rose-500/10 text-rose-600">过期深链 · 落到当前实况</span>
          )}
          <span className="text-sm text-[var(--editor-ink)]">{focusResolution.liveTitle}</span>
          <span className="text-xs text-[var(--editor-muted)]">{focusResolution.outcome}</span>
          <Link
            href={focusResolution.navigation.href}
            className="ml-auto inline-flex items-center gap-1 text-sm text-[var(--editor-accent)] hover:underline"
          >
            前往 <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {!workbench || !workbench.projectionEnabled ? (
        <div className="text-sm text-[var(--editor-muted)] border border-dashed border-[var(--editor-line)] rounded-xl p-8 text-center">
          今天工作台投影已关闭。来源草稿、排期与发布事实不受影响。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {workbench.groups.map((group) => <GroupCard key={group.group} group={group} />)}
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-[var(--editor-muted)]">
        <Bell className="w-4 h-4" /> 活动通知（D1 为源）
        <span className="text-xs ml-auto">{notifications.filter((n) => n.status === 'open').length} 条待处理</span>
      </div>
      <div className="space-y-2">
        {notifications.length === 0 && (
          <div className="text-sm text-[var(--editor-muted)] border border-dashed border-[var(--editor-line)] rounded-xl p-6 text-center">
            暂无活动通知
          </div>
        )}
        {notifications.map((n) => (
          <NotificationRow key={n.id} sourceType={n.source_type} sourceId={n.source_id} title={n.title} detail={n.detail} status={n.status} acknowledged={n.acknowledged === 1} />
        ))}
      </div>
    </div>
  )
}

function GroupCard({ group }: { group: WorkbenchGroupView }) {
  const meta = GROUP_META[group.group] ?? { icon: CircleDot, accent: 'bg-[var(--editor-soft)] text-[var(--editor-muted)]' }
  const Icon = meta.icon
  return (
    <section className="rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-[var(--editor-line)]">
        <span className={`w-7 h-7 rounded-lg grid place-items-center ${meta.accent}`}>
          <Icon className="w-4 h-4" />
        </span>
        <h2 className="font-medium text-[var(--editor-ink)]">{group.label}</h2>
        <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[var(--editor-soft)] text-[var(--editor-muted)]">
          {group.responsible === 'system' ? <Cpu className="w-3 h-3" /> : <User className="w-3 h-3" />}
          {group.responsible === 'system' ? '系统' : '作者'}
        </span>
        <span className="ml-auto text-xs text-[var(--editor-muted)]">{group.items.length} 项</span>
      </header>
      <ul className="divide-y divide-[var(--editor-line)]">
        {group.items.length === 0 && (
          <li className="px-4 py-4 text-sm text-[var(--editor-muted)]">暂无</li>
        )}
        {group.items.map((item) => (
          <li key={item.key} className="px-4 py-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--editor-ink)] truncate">{item.title || '(无标题)'}</p>
              <p className="text-xs text-[var(--editor-muted)] font-mono truncate mt-0.5">
                {item.sourceType} · {item.sourceId}
              </p>
            </div>
            {item.sourceType === 'schedule' && (
              <Link
                href={`/admin/schedule/${encodeURIComponent(item.sourceId)}`}
                className="inline-flex items-center gap-1 text-xs text-[var(--editor-accent)] hover:underline shrink-0"
              >
                管理排期 <ArrowRight className="w-3 h-3" />
              </Link>
            )}
            <Link
              href={`/admin/today?focus=${item.key}`}
              className="inline-flex items-center gap-1 text-xs text-[var(--editor-accent)] hover:underline shrink-0"
            >
              深链 <ArrowRight className="w-3 h-3" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NotificationRow({
  sourceType,
  sourceId,
  title,
  detail,
  status,
  acknowledged,
}: {
  sourceType: string
  sourceId: string
  title: string
  detail: string | null
  status: string
  acknowledged: boolean
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] px-4 py-3">
      <span
        className={`mt-1 w-2 h-2 rounded-full shrink-0 ${status === 'open' ? 'bg-rose-500' : 'bg-emerald-500'}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--editor-ink)]">{title}</p>
        {detail && <p className="text-xs text-[var(--editor-muted)] mt-0.5 truncate">{detail}</p>}
        <p className="text-[11px] text-[var(--editor-muted)] font-mono mt-1">
          {status} · ack:{acknowledged ? 'yes' : 'no'} · {sourceType}:{sourceId}
        </p>
      </div>
    </div>
  )
}
