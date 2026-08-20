/**
 * B8-05 — mobile publish D1 read view (issue #64).
 *
 * Rebuilds a fresh, authoritative full-page confirmation from D1 on every
 * read — never a client-optimistic snapshot. It resolves the publish path
 * (#33 first vs #34 revision), surfaces the EXACT version content + blocker
 * status, and pre-reads the receipt surfaces (博客 / 排期 / 渠道) so the
 * confirmation page shows real D1 facts. Pure reads; writes nothing here.
 */

import type { Database } from '@/lib/repositories/schema'
import {
  confirmBlockers,
  publishPathFor,
  type MobileConfirmationBlockers,
  type MobilePublishPath,
  type ReceiptSurface,
  shapeReceiptSurfaces,
  type ReceiptSurfacesInput,
} from './model'

export interface MobilePublishConfirmation {
  articleId: number
  postRef: number | null
  title: string
  slug: string
  /** The exact version this page will publish (server truth). */
  exactVersion: number
  /** The latest saved article version — version drift when it differs. */
  latestVersion: number | null
  /** Canonical content hash of the exact version body (evidence). */
  contentSha256: string | null
  /** Preview body of the exact version (html). */
  contentHtml: string
  /** Which publish path applies. */
  path: MobilePublishPath
  /** Confirmation blockers (saved / lifecycle / content) + canConfirm. */
  blockers: MobileConfirmationBlockers
  canConfirm: boolean
  /** true when the article already has a formal publication (revision path). */
  firstPublished: boolean
  /** Existing public address (revision path), null for a first publish. */
  publicUrl: string | null
  /** Active revision id (revision path). */
  revisionId: string | null
  /** Active revision number (revision path). */
  pendingRevisionNumber: number | null
}

interface ArticleRow {
  id: number
  post_ref: number
  title: string
  slug: string
  status: string
  deleted_at: number | null
}

interface FormalRow {
  version: number
  public_url: string
  published_at: number
  event_id: string
}

interface ActiveRevisionRow {
  revision_id: string
  revision_number: number
  slug: string
  title: string
  html: string
  content: string
  content_sha256: string
}

interface VersionRow {
  version: number
  snapshot_json: string | null
  content_snapshot_sha256: string | null
}

/**
 * Build the full mobile publish confirmation for one article, or null when the
 * article does not exist. The exact version content is resolved from:
 *   - the ACTIVE pending revision (for formal articles with a revision), or
 *   - the LATEST `article_versions` snapshot (for a first publish).
 * The public address / formal facts come only from `formal_publications`.
 */
export async function getMobilePublishConfirmation(
  db: Database,
  articleId: number,
): Promise<MobilePublishConfirmation | null> {
  const article = await db
    .prepare(
      `SELECT a.id, a.post_ref,
              COALESCE(p.title,'') AS title, COALESCE(p.slug,'') AS slug,
              COALESCE(p.status,'') AS status, p.deleted_at
       FROM articles a LEFT JOIN posts p ON p.id = a.post_ref
       WHERE a.id = ?`,
    )
    .bind(articleId)
    .first<ArticleRow>()
  if (!article) return null

  const deleted = Boolean(article.deleted_at) || article.status === 'deleted'

  const formal = await db
    .prepare(
      `SELECT version, public_url, published_at, event_id FROM formal_publications WHERE article_id = ?`,
    )
    .bind(articleId)
    .first<FormalRow>()
    .catch(() => null)

  let activeRevision: ActiveRevisionRow | null = null
  try {
    activeRevision = await db
      .prepare(
        `SELECT revision_id, revision_number, slug, title, html, content, content_sha256
         FROM publish_revisions WHERE article_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
      )
      .bind(articleId)
      .first<ActiveRevisionRow>()
  } catch {
    activeRevision = null
  }

  const latest = await db
    .prepare(
      `SELECT version, snapshot_json, content_snapshot_sha256
       FROM article_versions WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<VersionRow>()
    .catch(() => null)

  const hasRevision = Boolean(activeRevision)
  const path = publishPathFor({ formalPresent: Boolean(formal), hasActiveRevision: hasRevision, deleted })

  let title = article.title
  let contentHtml = ''
  let contentSha256: string | null = latest?.content_snapshot_sha256 ?? null
  let exactVersion = latest?.version ?? 0

  if (hasRevision && activeRevision) {
    // Revision path — the exact pending revision IS the publishing surface.
    title = activeRevision.title
    contentHtml = activeRevision.html || activeRevision.content
    contentSha256 = activeRevision.content_sha256 || null
    exactVersion = activeRevision.revision_number
  } else if (latest?.snapshot_json) {
    // First-publish path — read the exact frozen server version body.
    try {
      const record = JSON.parse(latest.snapshot_json) as {
        original_html?: string | null
        original_content?: string | null
        fields?: { title?: string; slug?: string }
      }
      title = record.fields?.title ?? article.title
      contentHtml = record.original_html ?? record.original_content ?? ''
    } catch {
      // fall through with article.title / empty body
    }
  }

  const blockers = confirmBlockers({
    exactVersion,
    latestVersion: latest?.version ?? null,
    deleted,
    title,
    contentHtml,
  })

  return {
    articleId,
    postRef: article.post_ref,
    title,
    slug: activeRevision?.slug ?? article.slug,
    exactVersion,
    latestVersion: latest?.version ?? null,
    contentSha256,
    contentHtml,
    path,
    blockers,
    canConfirm: blockers.saved && blockers.lifecycle && blockers.content,
    firstPublished: Boolean(formal),
    publicUrl: formal?.public_url ?? null,
    revisionId: activeRevision?.revision_id ?? null,
    pendingRevisionNumber: activeRevision?.revision_number ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* receipt surfaces (fresh D1 read after a successful publish)        */
/* ------------------------------------------------------------------ */

/**
 * Re-read the three receipt surfaces from D1 after a publish so the receipt
 * reflects real committed facts. Blog is authoritative from
 * `formal_publications` + the receipt verifier; schedule and WeChat channel are
 * independent reads, guarded so a ledger-only DB (table absent) degrades to
 * "not present" instead of erroring the receipt.
 */
export async function readReceiptSurfaces(
  db: Database,
  articleId: number,
  formalVersion: number,
): Promise<ReceiptSurface[]> {
  let blog: ReceiptSurfacesInput['blog'] = { present: false }
  let schedule: ReceiptSurfacesInput['schedule'] = { present: false, status: null }
  let channel: ReceiptSurfacesInput['channel'] = { present: false, status: null }

  try {
    const formal = await db
      .prepare(
        `SELECT version, public_url FROM formal_publications WHERE article_id = ?`,
      )
      .bind(articleId)
      .first<{ version: number; public_url: string }>()
    if (formal) {
      const receipt = await db
        .prepare(
          `SELECT verified FROM publish_receipts WHERE article_id = ? AND version = ? ORDER BY id DESC LIMIT 1`,
        )
        .bind(articleId, formal.version)
        .first<{ verified: number }>()
        .catch(() => null)
      blog = {
        present: true,
        url: formal.public_url,
        verified: receipt ? Boolean(receipt.verified) : undefined,
      }
    }
  } catch {
    blog = { present: false }
  }

  try {
    const sched = await db
      .prepare(`SELECT status FROM publish_schedules WHERE article_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(articleId)
      .first<{ status: string }>()
    schedule = { present: Boolean(sched), status: sched?.status ?? null }
  } catch {
    schedule = { present: false, status: null }
  }

  try {
    const task = await db
      .prepare(
        `SELECT status FROM wechat_draft_tasks WHERE article_id = ? AND version = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(articleId, formalVersion)
      .first<{ status: string }>()
    channel = { present: Boolean(task), status: task?.status ?? null }
  } catch {
    channel = { present: false, status: null }
  }

  return shapeReceiptSurfaces({ blog, schedule, channel })
}
