/**
 * B4-04 — "today" workbench read-model kernel (issue #43).
 *
 * A REBUILDABLE, READ ONLY projection grouped by responsible party. It queries
 * the authoritative fact tables fresh on every read and never writes anything
 * to them; rebuilding is just re-querying. The only write surface is the
 * `workbench_controls.enabled` toggle, which switches the projection off/on
 * without affecting any source task (drafts, schedules, publish facts).
 *
 * Grouping (责任方 → 组):
 *   - author · drafts         `posts.status='draft'` (not deleted)
 *   - author · schedules      `publish_schedules.status='pending'` (future intents)
 *   - system · in-progress    `publish_schedules.status='claimed'` (leased/processing)
 *   - author · todos          `publish_schedules.status IN ('stale','paused')`
 *
 * Every entry carries a traceable authoritative source (article id / schedule
 * id) so the UI can深链 by identity and re-read current state — never stale
 * parameters.
 */

import type { Database } from '@/lib/repositories/schema'
import type {
  SetWorkbenchEnabledResult,
  TodayWorkbench,
  WorkbenchBuildInput,
  WorkbenchControlRow,
  WorkbenchEntry,
  WorkbenchGroupView,
} from './types'

const WORKBENCH_CONTROL_KEY = 'workbench' as const

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

async function isWorkbenchEnabled(db: Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT id, key, enabled, updated_at FROM workbench_controls WHERE key = ?')
    .bind(WORKBENCH_CONTROL_KEY)
    .first<WorkbenchControlRow>()
  // Default enabled when no control row exists yet.
  return row === null || row.enabled === 1
}

/** Flip the projection on/off. Never touches a source fact. */
export async function setWorkbenchEnabled(
  db: Database,
  enabled: boolean,
  now = unixNow(),
): Promise<SetWorkbenchEnabledResult> {
  await db
    .prepare(
      `INSERT INTO workbench_controls (key, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(WORKBENCH_CONTROL_KEY, enabled ? 1 : 0, now)
    .run()
  const outcome: SetWorkbenchEnabledResult = enabled
    ? { outcome: 'enabled', key: WORKBENCH_CONTROL_KEY, enabled: true, updatedAt: now }
    : { outcome: 'disabled', key: WORKBENCH_CONTROL_KEY, enabled: false, updatedAt: now }
  return outcome
}

/* ------------------------------------------------------------------ */
/* authoritative fact reads                                            */
/* ------------------------------------------------------------------ */

interface DraftRow {
  id: number
  slug: string
  title: string
  updated_at: number
}

interface ScheduleRow {
  schedule_id: string
  article_id: number
  version: number
  scheduled_at: number
  status: string
  stale_reason: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

/** Author drafts — authoritative `posts` rows that are drafts and not deleted. */
async function listAuthorDrafts(db: Database): Promise<DraftRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug, title, updated_at FROM posts
       WHERE status = 'draft' AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 100`,
    )
    .all<DraftRow>()
  return results ?? []
}

/** Map schedule rows to titled entries by joining the article title. */
async function listSchedulesByStatus(
  db: Database,
  statuses: string[],
): Promise<{ row: ScheduleRow; title: string }[]> {
  if (statuses.length === 0) return []
  const placeholders = statuses.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT s.schedule_id, s.article_id, s.version, s.scheduled_at, s.status,
              s.stale_reason, s.last_error, s.created_at, s.updated_at,
              COALESCE(p.title, '') AS title
       FROM publish_schedules s
       LEFT JOIN articles a ON a.id = s.article_id
       LEFT JOIN posts p ON p.id = a.post_ref
       WHERE s.status IN (${placeholders})
       ORDER BY s.updated_at DESC LIMIT 100`,
    )
    .bind(...statuses)
    .all<ScheduleRow & { title: string }>()
  return (results ?? []).map((r) => ({ row: r, title: r.title }))
}

/* ------------------------------------------------------------------ */
/* workbench build                                                     */
/* ------------------------------------------------------------------ */

export async function buildTodayWorkbench(
  db: Database,
  input: WorkbenchBuildInput = {},
): Promise<TodayWorkbench> {
  const now = input.now ?? unixNow()
  const projectionEnabled = await isWorkbenchEnabled(db)

  const groups: WorkbenchGroupView[] = []

  if (!projectionEnabled) {
    return { projectionEnabled: false, generatedAt: now, groups, _facts: { articles: 0, schedules: 0 } }
  }

  // author · drafts
  const drafts = await listAuthorDrafts(db)
  groups.push({
    group: 'drafts',
    responsible: 'author',
    label: '草稿',
    items: drafts.map<WorkbenchEntry>((d) => ({
      key: `drafts:article:${d.id}`,
      group: 'drafts',
      responsible: 'author',
      sourceType: 'article',
      sourceId: String(d.id),
      title: d.title,
      meta: { slug: d.slug, status: 'draft' },
      updatedAt: d.updated_at,
    })),
  })

  // author · schedules (pending)
  const pending = await listSchedulesByStatus(db, ['pending'])
  groups.push({
    group: 'schedules',
    responsible: 'author',
    label: '排期',
    items: pending.map<WorkbenchEntry>(({ row, title }) => ({
      key: `schedules:schedule:${row.schedule_id}`,
      group: 'schedules',
      responsible: 'author',
      sourceType: 'schedule',
      sourceId: row.schedule_id,
      title,
      meta: {
        articleId: row.article_id,
        version: row.version,
        scheduledAt: row.scheduled_at,
      },
      updatedAt: row.updated_at,
    })),
  })

  // system · in-progress (claimed)
  const claimed = await listSchedulesByStatus(db, ['claimed'])
  groups.push({
    group: 'system-in-progress',
    responsible: 'system',
    label: '系统处理中',
    items: claimed.map<WorkbenchEntry>(({ row, title }) => ({
      key: `system-in-progress:schedule:${row.schedule_id}`,
      group: 'system-in-progress',
      responsible: 'system',
      sourceType: 'schedule',
      sourceId: row.schedule_id,
      title,
      meta: { articleId: row.article_id, version: row.version, status: row.status },
      updatedAt: row.updated_at,
    })),
  })

  // author · todos (stale / paused)
  const todos = await listSchedulesByStatus(db, ['stale', 'paused'])
  groups.push({
    group: 'author-todos',
    responsible: 'author',
    label: '作者待办',
    items: todos.map<WorkbenchEntry>(({ row, title }) => ({
      key: `author-todos:schedule:${row.schedule_id}`,
      group: 'author-todos',
      responsible: 'author',
      sourceType: 'schedule',
      sourceId: row.schedule_id,
      title,
      meta: {
        articleId: row.article_id,
        version: row.version,
        status: row.status,
        staleReason: row.stale_reason,
        lastError: row.last_error,
      },
      updatedAt: row.updated_at,
    })),
  })

  return {
    projectionEnabled,
    generatedAt: now,
    groups,
    _facts: { articles: drafts.length, schedules: pending.length + claimed.length + todos.length },
  }
}
