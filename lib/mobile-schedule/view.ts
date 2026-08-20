/**
 * B8-04 — mobile schedule D1 read view (issue #63).
 *
 * Rebuilds a fresh, authoritative view of ONE schedule + its article from D1 —
 * read on every render AND after every action, so the mobile UI never presents
 * client-optimistic facts. Pure reads; writes nothing here.
 */

import type { Database } from '@/lib/repositories/schema'
import type { ScheduleViewStatus } from './model'

const SCHEDULE_COLUMNS = `schedule_id, article_id, version, scheduled_at, timezone, status,
  stale_reason, last_error, created_at, updated_at`

export interface MobileScheduleView {
  scheduleId: string
  articleId: number
  version: number
  scheduledAt: number
  timezone: string
  status: ScheduleViewStatus
  staleReason: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
  /** Article display facts (joined — never treated as a source of truth for commands). */
  title: string
  slug: string
  articleStatus: string
  /** Latest saved article version (authoritative version drift signal). */
  latestVersion: number | null
  /** Whether the article has ever been formally published. */
  published: boolean
}

interface ScheduleRow {
  schedule_id: string
  article_id: number
  version: number
  scheduled_at: number
  timezone: string
  status: string
  stale_reason: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

/** Rebuild the full mobile schedule view for one schedule, or null. */
export async function getMobileScheduleView(
  db: Database,
  scheduleId: string,
): Promise<MobileScheduleView | null> {
  const row = await db
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM publish_schedules WHERE schedule_id = ?`)
    .bind(scheduleId)
    .first<ScheduleRow>()
  if (!row) return null

  const identity = await db
    .prepare(
      `SELECT a.id, a.post_ref,
              COALESCE(p.title, '') AS title, COALESCE(p.slug, '') AS slug, COALESCE(p.status, '') AS status
       FROM articles a LEFT JOIN posts p ON p.id = a.post_ref
       WHERE a.id = ?`,
    )
    .bind(row.article_id)
    .first<{ id: number; post_ref: number; title: string; slug: string; status: string }>()

  const versionRow = await db
    .prepare(
      `SELECT MAX(version) AS version FROM article_versions WHERE article_id = ?`,
    )
    .bind(row.article_id)
    .first<{ version: number | null }>()

  const formal = await db
    .prepare('SELECT 1 AS present FROM formal_publications WHERE article_id = ?')
    .bind(row.article_id)
    .first<{ present: number }>()

  return {
    scheduleId: row.schedule_id,
    articleId: row.article_id,
    version: row.version,
    scheduledAt: row.scheduled_at,
    timezone: row.timezone,
    status: row.status as ScheduleViewStatus,
    staleReason: row.stale_reason,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: identity?.title ?? '',
    slug: identity?.slug ?? '',
    articleStatus: identity?.status ?? '',
    latestVersion: versionRow?.version ?? null,
    published: Boolean(formal),
  }
}
