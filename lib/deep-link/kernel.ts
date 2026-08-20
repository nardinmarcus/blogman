/**
 * B4-04 — safe deep-link resolver (issue #43).
 *
 * PURE READ ONLY: it never writes to any table and never trusts request
 * parameters for anything but the raw identity. For a given `source_type` +
 * `source_id` it re-reads the CURRENT authoritative state and resolves a
 * navigation:
 *
 *   - article · live   → published & formally live → navigate to the live URL
 *   - article · draft  → not formally published → navigate to the editor/draft
 *   - article · missing→ no such article → fall through to the admin post list
 *   - schedule · live status → navigate by its CURRENT status; if the schedule
 *     row is gone or terminal (fired/cancelled) it FALLS THROUGH to the
 *     article's current reality or the today workbench — never to stale data.
 *
 * The "安全深链" contract: only navigate + re-read current state; expired deep
 * links land on current reality. Delivering this is a single read of
 * authoritative facts — no side effects by construction.
 */

import type { Database } from '@/lib/repositories/schema'
import type { ResponsibleParty } from '@/lib/workbench/types'
import type { DeepLinkResolution, DeepLinkTarget } from './types'

interface ArticleRow {
  id: number
  slug: string | null
  post_ref: number
}

interface PostRow {
  id: number
  slug: string
  title: string
  status: string
}

interface FormalRow {
  article_id: number
  lifecycle: string
  public_url: string
  slug: string
}

interface ScheduleRow {
  schedule_id: string
  article_id: number
  status: string
  stale_reason: string | null
  fired_event_id: string | null
  scheduled_at: number
}

const SCHEDULE_COLUMNS = `schedule_id, article_id, status, stale_reason, fired_event_id, scheduled_at`

async function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db.prepare('SELECT id, slug, post_ref FROM articles WHERE id = ?').bind(articleId).first<ArticleRow>()
}

async function findPostById(db: Database, postRef: number): Promise<PostRow | null> {
  return db.prepare('SELECT id, slug, title, status FROM posts WHERE id = ?').bind(postRef).first<PostRow>()
}

async function findFormal(db: Database, articleId: number): Promise<FormalRow | null> {
  return db
    .prepare('SELECT article_id, lifecycle, public_url, slug FROM formal_publications WHERE article_id = ?')
    .bind(articleId)
    .first<FormalRow>()
}

async function findSchedule(db: Database, scheduleId: string): Promise<ScheduleRow | null> {
  return db
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM publish_schedules WHERE schedule_id = ?`)
    .bind(scheduleId)
    .first<ScheduleRow>()
}

function scheduleResponsible(status: string): ResponsibleParty {
  return status === 'claimed' ? 'system' : 'author'
}

/**
 * Resolve a deep-link identity to a live navigation. Read-only.
 * `failClosed` is an internal flag; external callers only pass `target`.
 */
export async function resolveDeepLink(
  db: Database,
  target: DeepLinkTarget,
): Promise<DeepLinkResolution> {
  const { sourceType, sourceId } = target

  if (sourceType === 'article') {
    const articleId = Number(sourceId)
    if (!Number.isInteger(articleId) || articleId <= 0) {
      return articleFallback('invalid-article-id', '无效的文章链接')
    }
    const article = await findArticleById(db, articleId)
    if (!article) return articleFallback('article-missing', '文章已不存在')
    const post = article.post_ref ? await findPostById(db, article.post_ref) : null
    const title = post?.title || article.slug || '文章'
    const formal = await findFormal(db, articleId)
    if (formal && formal.lifecycle === 'published') {
      // Live — navigate to the CURRENT public url (re-read, never from request).
      const href = formal.public_url || `/${formal.slug}`
      return {
        outcome: 'article-live',
        sourceType,
        sourceId,
        liveStatus: 'published',
        liveTitle: title,
        navigation: { href, label: '查看文章' },
        responsible: 'author',
        fallback: false,
      }
    }
    // Draft / unpublished — navigate to the editor by live article id.
    return {
      outcome: 'article-draft',
      sourceType,
      sourceId,
      liveStatus: post?.status ?? 'draft',
      liveTitle: title,
      navigation: { href: `/editor?article=${articleId}`, label: '继续编辑' },
      responsible: 'author',
      fallback: false,
    }
  }

  // schedule
  const schedule = await findSchedule(db, sourceId)
  if (!schedule) {
    // Expired / gone — land on current reality (the today workbench).
    return {
      outcome: 'schedule-expired',
      sourceType,
      sourceId,
      liveStatus: null,
      liveTitle: '已过期的排期',
      navigation: { href: '/admin/posts', label: '回到文章列表' },
      responsible: null,
      fallback: true,
    }
  }

  // Re-read the schedule's current status from live facts.
  const article = await findArticleById(db, schedule.article_id)
  const post = article?.post_ref ? await findPostById(db, article.post_ref) : null
  const title = post?.title || '排期文章'
  const responsible = scheduleResponsible(schedule.status)

  const terminalStatuses = ['fired', 'cancelled']
  if (terminalStatuses.includes(schedule.status)) {
    // Terminal — fall through to the article's current reality.
    const formal = article ? await findFormal(db, article.id) : null
    if (formal && formal.lifecycle === 'published') {
      return {
        outcome: `schedule-${schedule.status}`,
        sourceType,
        sourceId,
        liveStatus: schedule.status,
        liveTitle: title,
        navigation: { href: formal.public_url || `/${formal.slug}`, label: '查看文章' },
        responsible: null,
        fallback: true,
      }
    }
    return {
      outcome: `schedule-${schedule.status}`,
      sourceType,
      sourceId,
      liveStatus: schedule.status,
      liveTitle: title,
      navigation: { href: '/admin/posts', label: '回到文章列表' },
      responsible: null,
      fallback: true,
    }
  }

  // Active (pending/claimed/paused/stale) — navigate to its current status by
  // re-reading state; never carry stale parameters.
  return {
    outcome: `schedule-${schedule.status}`,
    sourceType,
    sourceId,
    liveStatus: schedule.status,
    liveTitle: title,
    navigation: { href: '/admin/posts', label: '管理该排期' },
    responsible,
    fallback: false,
  }
}

function articleFallback(outcome: string, liveTitle: string): DeepLinkResolution {
  return {
    outcome,
    sourceType: 'article',
    sourceId: '',
    liveStatus: null,
    liveTitle,
    navigation: { href: '/admin/posts', label: '回到文章列表' },
    responsible: null,
    fallback: true,
  }
}
