/**
 * B8-05 — mobile publish D1 adapter (issue #64).
 *
 * A THIN adapter between the mobile full-page confirmation UI and the SHARED
 * #33 first-publish / #34 revision-promote kernels. Every confirm re-reads the
 * authoritative confirmation from D1 (server re-verification — version /
 * path / lifecycle are never trusted from the client), then dispatches:
 *
 *   - first:   #33 preparePublish (re-evaluates the four blockers server-side)
 *              then confirmPublish with a DETERMINISTIC (article, version,
 *              content) intent id — duplicate submits of the SAME exact
 *              publish converge on the event/outbox uniqueness;
 *   - revision:#34 promoteRevision, idempotent by the active revision id.
 *
 * A successful confirm re-reads the receipt surfaces (博客 / 排期 / 渠道) from
 * D1 so the independent receipt always reflects committed facts. No new
 * publish fact table is created here.
 */

import type { Database } from '@/lib/repositories/schema'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import { promoteRevision } from '@/lib/publish-revision'
import { getMobilePublishConfirmation, readReceiptSurfaces } from './view'
import {
  firstIntentId,
  firstPrepareId,
  type MobilePublishPath,
  type ReceiptSurface,
} from './model'
import type { MobilePublishConfirmation } from './view'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

export interface MobileConfirmInput {
  articleId: number
  /** The path the page confirmed (re-verified against D1 inside the kernel). */
  path: MobilePublishPath
  /**
   * The EXACT version the confirmation page displayed. Drift detection: if the
   * latest saved version no longer equals this, the confirm aborts and returns
   * to the prepare state (acceptance: 确认期间版本变化终止并返回准备).
   */
  expectedVersion: number
  actor: string
  siteUrl?: string
  now?: number
  /** Out-of-transaction external I/O (cache invalidation) after commit. */
  afterCommit?: () => Promise<void> | void
}

export type MobileConfirmResult =
  | {
      outcome: 'delivered' | 'replayed'
      path: 'first' | 'revision'
      version: number
      eventId: string
      publicUrl: string
      publishedAt: number
      receipt: ReceiptSurface[]
    }
  | {
      outcome: 'already-published'
      path: 'first' | 'revision'
      version: number
      publicUrl: string
      publishedAt: number
      receipt: ReceiptSurface[]
    }
  | { outcome: 'conflict'; reason: string; serverVersion: number | null }
  | { outcome: 'blocked'; reason: string; failures: string[] }
  | { outcome: 'aborted'; reason: string }
  | { outcome: 'not-found'; articleId: number }
  | { outcome: 'invalid'; reason: string }

async function emitAfterCommit(input: MobileConfirmInput): Promise<void> {
  if (!input.afterCommit) return
  try {
    await input.afterCommit()
  } catch {
    // best-effort projection — never fail the confirm because cache I/O broke
  }
}

/**
 * Confirm a mobile full-page publish through the shared kernel + build the
 * combined receipt. Idempotent: the same exact publish (first) replays the
 * first event/outbox; a duplicate promote (revision) replays by revision id.
 */
export async function confirmMobilePublish(
  db: Database,
  input: MobileConfirmInput,
): Promise<MobileConfirmResult> {
  const articleId = input.articleId
  if (!Number.isInteger(articleId) || articleId <= 0) {
    return { outcome: 'invalid', reason: 'articleId is required' }
  }
  const now = input.now ?? unixNow()

  // Server re-verification — rebuild the authoritative confirmation from D1.
  const conf = await getMobilePublishConfirmation(db, articleId)
  if (!conf) return { outcome: 'not-found', articleId }

  const path = conf.path
  if (path === 'unavailable') return { outcome: 'blocked', reason: '文章不可发布', failures: ['lifecycle'] }
  if (path === 'already') {
    const receipt = await readReceiptSurfaces(db, articleId, conf.exactVersion)
    return {
      outcome: 'already-published',
      path: 'revision',
      version: conf.exactVersion,
      publicUrl: conf.publicUrl ?? '',
      publishedAt: now,
      receipt,
    }
  }
  if (path !== input.path) {
    return {
      outcome: 'conflict',
      reason: '发布路径已变化，请返回准备页重试',
      serverVersion: conf.latestVersion,
    }
  }

  // Version drift guard — the EXACT version the page confirmed must still be
  // the server's latest. A save during confirmation moves the latest version,
  // so this aborts and returns to the prepare state (no partial publish).
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion <= 0) {
    return { outcome: 'invalid', reason: 'expectedVersion is required' }
  }
  if (input.expectedVersion !== conf.exactVersion) {
    return {
      outcome: 'conflict',
      reason: '确认期间文章版本已变化，已终止并返回准备',
      serverVersion: conf.exactVersion,
    }
  }

  if (path === 'first') {
    return confirmFirstPublish(db, conf, input, now)
  }
  return confirmRevisionPromote(db, conf, input, now)
}

async function confirmFirstPublish(
  db: Database,
  conf: MobilePublishConfirmation,
  input: MobileConfirmInput,
  now: number,
): Promise<MobileConfirmResult> {
  if (!conf.contentSha256) {
    return { outcome: 'invalid', reason: '无法确定精确版本内容哈希' }
  }
  const exactVersion = conf.exactVersion
  const prepareId = firstPrepareId(conf.articleId, exactVersion, conf.contentSha256)
  const intentId = firstIntentId(conf.articleId, exactVersion, conf.contentSha256)

  // #33 prepare — re-evaluates the four blockers against D1.
  const prepared = await preparePublish(db, {
    prepareId,
    articleId: conf.articleId,
    confirmedVersion: exactVersion,
    slug: conf.slug,
    title: conf.title,
    contentSha256: conf.contentSha256,
    actor: input.actor,
    now,
  })
  if (prepared.outcome === 'not-found') return { outcome: 'aborted', reason: '文章不存在' }
  if (prepared.outcome === 'invalid') return { outcome: 'invalid', reason: prepared.reason }
  if (prepared.outcome === 'aborted') {
    return { outcome: 'blocked', reason: '发布准备未通过', failures: prepared.failures.map(String) }
  }

  // #33 confirm — single transaction, at most one event per deterministic intent.
  const confirmed = await confirmPublish(db, {
    intentId,
    prepareId,
    articleId: conf.articleId,
    expectedVersion: exactVersion,
    actor: input.actor,
    siteUrl: input.siteUrl,
    now,
    afterCommit: async () => {
      await emitAfterCommit(input)
    },
  })

  if (confirmed.outcome === 'invalid') return { outcome: 'invalid', reason: confirmed.reason }
  if (confirmed.outcome === 'aborted') return { outcome: 'aborted', reason: confirmed.reason }
  if (confirmed.outcome === 'already-published') {
    const receipt = await readReceiptSurfaces(db, conf.articleId, confirmed.formal.version)
    return {
      outcome: 'already-published',
      path: 'first',
      version: confirmed.formal.version,
      publicUrl: confirmed.formal.publicUrl,
      publishedAt: confirmed.formal.publishedAt,
      receipt,
    }
  }
  if (confirmed.outcome === 'conflict') {
    return { outcome: 'conflict', reason: confirmed.reason, serverVersion: confirmed.serverVersion }
  }
  if (confirmed.outcome === 'blocked') {
    return { outcome: 'blocked', reason: '发布被阻塞项拦截', failures: confirmed.failures.map(String) }
  }
  if (confirmed.outcome === 'slug-conflict') {
    return { outcome: 'blocked', reason: 'slug 冲突', failures: ['slug'] }
  }

  const receipt = await readReceiptSurfaces(db, conf.articleId, (confirmed as { version: number }).version)
  return {
    outcome: confirmed.outcome === 'replayed' ? 'replayed' : 'delivered',
    path: 'first',
    version: (confirmed as { version: number }).version,
    eventId: (confirmed as { eventId: string }).eventId,
    publicUrl: (confirmed as { publicUrl: string }).publicUrl,
    publishedAt: (confirmed as { publishedAt: number }).publishedAt,
    receipt,
  }
}

async function confirmRevisionPromote(
  db: Database,
  conf: MobilePublishConfirmation,
  input: MobileConfirmInput,
  now: number,
): Promise<MobileConfirmResult> {
  if (!conf.revisionId) {
    return { outcome: 'invalid', reason: '没有可发布的活跃修订' }
  }

  const promoted = await promoteRevision(db, {
    revisionId: conf.revisionId,
    actor: input.actor,
    siteUrl: input.siteUrl,
    now,
    afterCommit: async () => {
      await emitAfterCommit(input)
    },
  })

  if (promoted.outcome === 'not-found') return { outcome: 'aborted', reason: promoted.reason }
  if (promoted.outcome === 'invalid') return { outcome: 'invalid', reason: promoted.reason }
  if (promoted.outcome === 'blocked') {
    return { outcome: 'blocked', reason: '修订上线被阻塞', failures: promoted.failures }
  }
  if (promoted.outcome === 'conflict') {
    return { outcome: 'conflict', reason: promoted.reason, serverVersion: null }
  }

  const version = promoted.promotedVersion
  const receipt = await readReceiptSurfaces(db, conf.articleId, version)
  return {
    outcome: promoted.outcome === 'replayed' ? 'replayed' : 'delivered',
    path: 'revision',
    version,
    eventId: promoted.promotionId,
    publicUrl: promoted.publicUrl,
    publishedAt: now,
    receipt,
  }
}
