/**
 * B8-05 — mobile full-page publish confirmation model (issue #64).
 *
 * Pure, framework-free model for the mobile 全页发布确认/回执 surface. It never
 * touches React / Next / D1 and never imports `node:crypto` (client-safe —
 * ids are deterministic strings here, the Web `crypto.randomUUID` is only used
 * by components for transient client tokens). Everything is unit-testable in
 * plain node.
 *
 *   - 路径:  one article is either a FIRST publish (#33 kernel, draft with no
 *            formal publication) or a REVISION publish (#34 promote, a formal
 *            article with an active pending revision). A formal article with no
 *            active revision has nothing to publish.
 *   - 阻塞:  the full page shows the exact-version content + blocker status;
 *            confirmation is gated on `canConfirm` (saved / lifecycle /
 *            content) — the server kernel re-evaluates everything against D1.
 *   - 幂等:  first-publish ids are DETERMINISTIC on (article, exactVersion,
 *            contentSha256) so re-submitting the SAME exact publish replays via
 *            the #33 intent/outbox uniqueness; a version/content change is a
 *            fresh auditable operation. Revision promote is idempotent by the
 *            active revision id in the #34 kernel.
 *   - 回执:  a receipt distinguishes 博客 (public page) / 排期 (schedule) /
 *            渠道 (WeChat channel) progress — each surface is an independent
 *            read, never a client guess.
 */

/** Which publish kernel the mobile full page will drive for an article. */
export type MobilePublishPath = 'first' | 'revision' | 'already' | 'unavailable'

/** The three confirmation blockers surfaced on the mobile full page. */
export interface MobileConfirmationBlockers {
  /** The exact version to publish is still the latest saved version (版本漂移终止). */
  saved: boolean
  /** The article may still be published (not deleted / not unpublished-closed). */
  lifecycle: boolean
  /** Title + body are non-blank so the public page is complete. */
  content: boolean
}

/** Inputs to resolve the publish path from the D1 read view. */
export interface PublishPathInput {
  /** true when the article has a formal publication row (曾经正式发布). */
  formalPresent: boolean
  /** true when the article has an ACTIVE pending revision. */
  hasActiveRevision: boolean
  /** true when the article is soft-deleted. */
  deleted: boolean
}

/** Inputs to compute confirmation blockers from the D1 read view. */
export interface ConfirmationBlockerInput {
  /** The exact version this page will publish. */
  exactVersion: number
  /** The latest saved article version (null when no identity yet). */
  latestVersion: number | null
  /** true when the article is soft-deleted. */
  deleted: boolean
  /** The confirmed title (non-blank passes). */
  title: string
  /** The confirmed body preview (non-blank passes). */
  contentHtml: string
}

/* ------------------------------------------------------------------ */
/* path resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve which publish path a mobile full page drives. A never-published,
 * non-deleted draft is a first publish; a formal article with an active
 * revision is a revision promote; a formal article with no pending revision
 * is `already` (nothing new to publish); everything else is `unavailable`.
 */
export function publishPathFor(input: PublishPathInput): MobilePublishPath {
  if (input.deleted) return 'unavailable'
  if (!input.formalPresent) return 'first'
  if (input.hasActiveRevision) return 'revision'
  return 'already'
}

/* ------------------------------------------------------------------ */
/* blockers                                                           */
/* ------------------------------------------------------------------ */

export function blockersAllPass(blockers: MobileConfirmationBlockers): boolean {
  return blockers.saved && blockers.lifecycle && blockers.content
}

export function failingConfirmBlockers(blockers: MobileConfirmationBlockers): Array<keyof MobileConfirmationBlockers> {
  const failed: Array<keyof MobileConfirmationBlockers> = []
  if (!blockers.saved) failed.push('saved')
  if (!blockers.lifecycle) failed.push('lifecycle')
  if (!blockers.content) failed.push('content')
  return failed
}

/** Human-readable reason for each confirmation blocker (mobile display). */
export const CONFIRM_BLOCKER_LABELS: Record<keyof MobileConfirmationBlockers, string> = {
  saved: '文章版本已变化，请返回准备页重新确认到最新版本。',
  lifecycle: '文章已删除或停用，无法发布。',
  content: '标题或正文仍为空，无法公开。',
}

/**
 * Compute the confirmation blockers the mobile full page must satisfy before
 * the single result-type button is enabled. `saved` fails the moment the
 * exact version we loaded is no longer the latest (版本漂移) — the acceptance
 * criterion that a version change during confirmation aborts and returns to
 * the prepare state, enforced again by the server kernel at confirm time.
 */
export function confirmBlockers(input: ConfirmationBlockerInput): MobileConfirmationBlockers {
  const saved = input.latestVersion === null || input.latestVersion === input.exactVersion
  return {
    saved,
    lifecycle: !input.deleted,
    content: input.title.trim().length > 0 && input.contentHtml.trim().length > 0,
  }
}

/* ------------------------------------------------------------------ */
/* deterministic first-publish ids (single event / outbox uniqueness) */
/* ------------------------------------------------------------------ */

/**
 * Deterministic #33 first-publish prepare id, seeded by the exact article +
 * version + content hash. Re-submitting the SAME exact publish resolves to the
 * same prepare; a version or content change produces a fresh prepare. Pure
 * string — no crypto import.
 */
export function firstPrepareId(articleId: number, version: number, contentSha256: string): string {
  return `b8-05:prep:${articleId}:${version}:${contentSha256}`
}

/**
 * Deterministic #33 first-publish intent id, seeded by the exact article +
 * version + content hash. The #33 kernel enforces at most ONE event per intent
 * (`publish_events.intent_id` UNIQUE), so a duplicate submit of the same exact
 * publish replays the first event/outbox instead of double-publishing.
 */
export function firstIntentId(articleId: number, version: number, contentSha256: string): string {
  return `b8-05:intent:${articleId}:${version}:${contentSha256}`
}

/** Deterministic #34 promote operation suffix (promote is idempotent by revisionId). */
export function revisionOperationId(articleId: number, revisionId: string): string {
  return `b8-05:promote:${articleId}:${revisionId}`
}

/* ------------------------------------------------------------------ */
/* time — fixed Asia/Shanghai display (same wall clock as mobile-schedule) */
/* ------------------------------------------------------------------ */

const SHANGHAI_UTC_OFFSET_SEC = 8 * 3600

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Format an epoch second to the Asia/Shanghai wall clock as
 * `YYYY-MM-DD HH:mm:ss`. Asia/Shanghai is a fixed UTC+8 (no DST), so this is
 * exact regardless of the runtime timezone and fully deterministic in tests.
 */
export function formatPublishTime(epochSec: number): string {
  const d = new Date((epochSec + SHANGHAI_UTC_OFFSET_SEC) * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/* ------------------------------------------------------------------ */
/* receipt shaping — 区分博客 / 排期 / 渠道                            */
/* ------------------------------------------------------------------ */

/** One progress surface of the publish receipt. */
export interface ReceiptSurface {
  key: 'blog' | 'schedule' | 'channel'
  label: string
  /** Human progress state (已上线 / 已排期 / 未生成 …). */
  state: string
  /** null = not applicable / absent (e.g. no schedule, no WeChat task). */
  present: boolean
  url?: string
}

/** Raw per-surface facts read from D1 after a successful publish. */
export interface ReceiptSurfacesInput {
  blog: { present: boolean; url?: string; verified?: boolean }
  schedule: { present: boolean; status: string | null }
  channel: { present: boolean; status: string | null }
}

const SCHEDULE_STATUS_LABELS: Record<string, string> = {
  pending: '已排期',
  paused: '已暂停',
  stale: '需处理',
  claimed: '处理中',
  fired: '已发布',
  cancelled: '已取消',
}

const CHANNEL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿已生成',
  submitted: '已递交',
  failed: '递交失败',
  superseded: '已被新版本取代',
}

/**
 * Shape the independent receipt surfaces from the post-publish D1 facts.
 * 博客 always present after success; 排期 / 渠道 are independent and reported
 * as `present:false` when no fact exists (never fabricated).
 */
export function shapeReceiptSurfaces(input: ReceiptSurfacesInput): ReceiptSurface[] {
  const blogState = input.blog.present
    ? (input.blog.verified === false ? '已上线（待确证）' : '已上线')
    : '未上线'
  const blog: ReceiptSurface = {
    key: 'blog',
    label: '博客',
    state: blogState,
    present: true,
    url: input.blog.url,
  }
  const schedule: ReceiptSurface = {
    key: 'schedule',
    label: '排期',
    state: input.schedule.status ? (SCHEDULE_STATUS_LABELS[input.schedule.status] ?? input.schedule.status) : '未排期',
    present: input.schedule.present,
  }
  const channel: ReceiptSurface = {
    key: 'channel',
    label: '渠道',
    state: input.channel.status ? (CHANNEL_STATUS_LABELS[input.channel.status] ?? input.channel.status) : '未生成',
    present: input.channel.present,
  }
  return [blog, schedule, channel]
}
