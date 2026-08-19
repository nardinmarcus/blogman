/**
 * B3-01 — first formal publish command kernel (issue #33).
 *
 * The desktop-safe first-publish loop. The author completes deterministic
 * preparation from the workbench (`preparePublish`), then confirms the exact
 * server-saved version (`confirmPublish`). `confirmPublish` re-checks version,
 * lifecycle, slug and the four blockers INSIDE one D1 transaction and writes
 * the first publish time, the single event and the outbox row atomically —
 * external I/O runs only after the transaction commits.
 *
 * Invariants (acceptance criteria):
 *
 *   - 只提升确认版本，后续编辑不被顺带发布 — the in-transaction version guard
 *     requires the latest version fact to equal the confirmed version.
 *   - 同一意图最多一个事件，失败无部分上线 — one event per intent
 *     (`publish_events.intent_id` UNIQUE), everything written in one batch.
 *   - AI 失败或未处理不阻塞发布 — the four blockers never include AI-derived
 *     fields (cover / summary / tags / metadata).
 *   - 草稿不伪造正式版本 — draft/save/publishTemp never write formal facts.
 *   - legacy 状态切换不得绕过准备 — only the prepared + confirmed command may
 *     create a formal publication.
 *
 * Atomicity model (same as B2-03): statement guards no-op on a failed
 * precondition; a hard constraint failure aborts the batch and rolls back
 * everything (no partial online state). Outcomes are resolved by re-reading
 * the live state after the batch — identical behaviour on production D1 and in
 * the CLI-backed/in-process tests.
 */

import { createHash } from 'node:crypto'
import type { Database } from '@/lib/repositories/schema'
import type {
  ConfirmInput,
  ConfirmResult,
  DispatchOutboxInput,
  EventRow,
  FormalPublicationRow,
  FormalPublicationFacts,
  IntentRow,
  OutboxRow,
  PrepareInput,
  PrepareResult,
  PrepareRow,
  PublishBlockers,
  PublicationState,
  ReceiptResult,
  ReceiptRow,
} from './types'
import { blockersAllPass, failingBlockers } from './types'

export const FIRST_PUBLISH_DEFAULT_SITE_URL = 'https://blog.namooca.com'
export const FIRST_PUBLISH_DRAFT_LIFECYCLE = 'draft' as const
export const FIRST_PUBLISH_PUBLISHED_LIFECYCLE = 'published' as const

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function eventIdFor(intentId: string): string {
  return `event:${intentId}`
}

export function outboxIdFor(eventId: string): string {
  return `outbox:${eventId}`
}

/** Deterministic evidence digest over the canonical event payload. */
export function evidenceDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

function sha256OfEmpty(): string {
  return createHash('sha256').update('', 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ */
/* low-level reads                                                     */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface PostsRow {
  id: number
  slug: string
  title: string
  content: string
  status: string
  deleted_at: number | null
  password: string | null
}

async function findArticleById(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db
    .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
    .bind(articleId)
    .first<ArticleRow>()
}

async function findPostById(db: Database, postRef: number): Promise<PostsRow | null> {
  return db
    .prepare('SELECT id, slug, title, content, status, deleted_at, password FROM posts WHERE id = ?')
    .bind(postRef)
    .first<PostsRow>()
}

async function latestVersion(db: Database, articleId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM article_versions WHERE article_id = ?')
    .bind(articleId)
    .first<{ version: number }>()
  return row?.version ?? 0
}

async function latestContentSha256(db: Database, articleId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<{ content_snapshot_sha256: string | null }>()
  return row?.content_snapshot_sha256 ?? null
}

async function findFormalByArticle(db: Database, articleId: number): Promise<FormalPublicationRow | null> {
  return db
    .prepare(
      `SELECT article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id
       FROM formal_publications WHERE article_id = ?`,
    )
    .bind(articleId)
    .first<FormalPublicationRow>()
}

function formalFacts(row: FormalPublicationRow): FormalPublicationFacts {
  return {
    articleId: row.article_id,
    version: row.version,
    slug: row.slug,
    lifecycle: row.lifecycle,
    firstPublishedAt: row.first_published_at,
    publishedAt: row.published_at,
    publicUrl: row.public_url,
    eventId: row.event_id,
  }
}

async function findIntent(db: Database, intentId: string): Promise<IntentRow | null> {
  return db
    .prepare(
      `SELECT id, intent_id, prepare_id, article_id, version, slug, lifecycle, status, created_at
       FROM publish_intents WHERE intent_id = ?`,
    )
    .bind(intentId)
    .first<IntentRow>()
}

async function findPrepare(db: Database, prepareId: string): Promise<PrepareRow | null> {
  return db
    .prepare(
      `SELECT id, prepare_id, article_id, post_ref, prepared_version, prepared_slug, prepared_title,
              prepared_content_sha256, blocker_saved, blocker_lifecycle, blocker_slug, blocker_content,
              status, created_at, updated_at
       FROM publish_prepares WHERE prepare_id = ?`,
    )
    .bind(prepareId)
    .first<PrepareRow>()
}

async function findEventByIntent(db: Database, intentId: string): Promise<EventRow | null> {
  return db
    .prepare(
      `SELECT id, event_id, intent_id, article_id, version, slug, lifecycle,
              first_published_at, evidence_sha256, payload, created_at
       FROM publish_events WHERE intent_id = ?`,
    )
    .bind(intentId)
    .first<EventRow>()
}

async function findOutboxByEvent(db: Database, eventId: string): Promise<OutboxRow | null> {
  return db
    .prepare(
      `SELECT id, outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at, delivered_at
       FROM publish_outbox WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<OutboxRow>()
}

async function findEventById(db: Database, eventId: string): Promise<EventRow | null> {
  return db
    .prepare(
      `SELECT id, event_id, intent_id, article_id, version, slug, lifecycle,
              first_published_at, evidence_sha256, payload, created_at
       FROM publish_events WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<EventRow>()
}

/* ------------------------------------------------------------------ */
/* blocker evaluation (live state)                                     */
/* ------------------------------------------------------------------ */

/**
 * Evaluate the four blockers against the LIVE state.
 *
 * B1 saved:      the latest version fact equals the confirmed version AND its
 *                content hash exists (the exact server-saved snapshot).
 * B2 lifecycle:  no formal publication exists yet and the post is not deleted.
 * B3 slug:       the slug is not used by another formal publication and not used
 *                by another published post (public-address uniqueness).
 * B4 content:    title + body are non-blank and the post is not password
 *                protected. AI-derived fields NEVER block.
 */
export async function evaluateBlockers(
  db: Database,
  input: { articleId: number; postRef: number; confirmedVersion: number; slug: string; contentSha256?: string },
): Promise<PublishBlockers> {
  const { articleId, postRef, confirmedVersion, slug, contentSha256: claimedHash = '' } = input

  const current = await latestVersion(db, articleId)
  const contentSha256 = await latestContentSha256(db, articleId)
  const saved =
    current === confirmedVersion &&
    !!contentSha256 &&
    contentSha256 !== sha256OfEmpty() &&
    (claimedHash === '' || claimedHash === contentSha256)

  const formal = await findFormalByArticle(db, articleId)
  const post = await findPostById(db, postRef)
  const lifecycle = !formal && post !== null && post.status !== 'deleted' && post.deleted_at === null

  const rivalFormal = await db
    .prepare('SELECT article_id FROM formal_publications WHERE slug = ? AND article_id != ?')
    .bind(slug, articleId)
    .first<{ article_id: number }>()
  const rivalPublished = await db
    .prepare("SELECT id FROM posts WHERE slug = ? AND id != ? AND status = 'published'")
    .bind(slug, postRef)
    .first<{ id: number }>()
  const slugOk = rivalFormal === null && rivalPublished === null

  const content =
    post !== null &&
    post.title.trim().length > 0 &&
    post.content.trim().length > 0 &&
    (post.password === null || post.password === '')

  return { saved, lifecycle, slug: slugOk, content }
}

/* ------------------------------------------------------------------ */
/* prepare                                                             */
/* ------------------------------------------------------------------ */

export async function preparePublish(db: Database, input: PrepareInput): Promise<PrepareResult> {
  const { prepareId, articleId, confirmedVersion, slug, title, contentSha256, actor, now = unixNow() } = input
  if (!prepareId || prepareId.trim() === '') return { outcome: 'invalid', reason: 'prepareId is required' }
  if (!Number.isInteger(articleId) || articleId <= 0) return { outcome: 'invalid', reason: 'articleId is required' }
  if (!Number.isInteger(confirmedVersion) || confirmedVersion <= 0) {
    return { outcome: 'invalid', reason: 'confirmedVersion must be a positive integer' }
  }
  if (!slug || slug.trim() === '') return { outcome: 'invalid', reason: 'slug is required' }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'actor is required' }
  if (contentSha256 !== '' && !/^[0-9a-f]{64}$/.test(contentSha256)) {
    return { outcome: 'invalid', reason: 'contentSha256 must be a 64-char hex digest' }
  }
  // A blank title or an absent content hash are NOT input errors — they are
  // evaluated as blockers (B4 / B1) so the workbench sees exactly what blocks.

  const article = await findArticleById(db, articleId)
  if (!article) return { outcome: 'not-found', articleId }

  // Deterministic re-evaluation against the live state — the prepare is the
  // workbench's snapshot of WHY this version may be published.
  const blockers = await evaluateBlockers(db, {
    articleId,
    postRef: article.post_ref,
    confirmedVersion,
    slug,
    contentSha256,
  })
  const pass = blockersAllPass(blockers)
  const status = pass ? 'prepared' : 'aborted'

  // Upsert this prepare (idempotent by prepare_id) and supersede any older
  // prepared plan for the same article so only the latest decision is active.
  await db
    .prepare(
      `UPDATE publish_prepares SET status = 'superseded', updated_at = ?
       WHERE article_id = ? AND prepare_id != ? AND status = 'prepared'`,
    )
    .bind(now, articleId, prepareId)
    .run()

  await db
    .prepare(
      `INSERT INTO publish_prepares
         (prepare_id, article_id, post_ref, prepared_version, prepared_slug, prepared_title,
          prepared_content_sha256, blocker_saved, blocker_lifecycle, blocker_slug, blocker_content,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(prepare_id) DO UPDATE SET
         article_id = excluded.article_id,
         post_ref = excluded.post_ref,
         prepared_version = excluded.prepared_version,
         prepared_slug = excluded.prepared_slug,
         prepared_title = excluded.prepared_title,
         prepared_content_sha256 = excluded.prepared_content_sha256,
         blocker_saved = excluded.blocker_saved,
         blocker_lifecycle = excluded.blocker_lifecycle,
         blocker_slug = excluded.blocker_slug,
         blocker_content = excluded.blocker_content,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .bind(
      prepareId,
      articleId,
      article.post_ref,
      confirmedVersion,
      slug,
      title,
      contentSha256,
      blockers.saved ? 1 : 0,
      blockers.lifecycle ? 1 : 0,
      blockers.slug ? 1 : 0,
      blockers.content ? 1 : 0,
      status,
      now,
      now,
    )
    .run()

  if (pass) {
    return { outcome: 'prepared', prepareId, articleId, confirmedVersion, slug, blockers, preparedAt: now }
  }
  return {
    outcome: 'aborted',
    prepareId,
    articleId,
    confirmedVersion,
    slug,
    blockers,
    failures: failingBlockers(blockers),
    abortedAt: now,
  }
}

export async function cancelPrepare(db: Database, prepareId: string, _actor: string): Promise<{ outcome: 'cancelled' | 'not-found' | 'invalid'; reason?: string }> {
  if (!prepareId || prepareId.trim() === '') return { outcome: 'invalid', reason: 'prepareId is required' }
  const prepare = await findPrepare(db, prepareId)
  if (!prepare) return { outcome: 'not-found' }
  if (prepare.status === 'committed') {
    return { outcome: 'invalid', reason: 'committed prepare cannot be cancelled' }
  }
  await db
    .prepare(`UPDATE publish_prepares SET status = 'aborted', updated_at = ? WHERE prepare_id = ?`)
    .bind(unixNow(), prepareId)
    .run()
  return { outcome: 'cancelled' }
}

/* ------------------------------------------------------------------ */
/* confirm — the single-transaction first publish                      */
/* ------------------------------------------------------------------ */

export async function confirmPublish(db: Database, input: ConfirmInput): Promise<ConfirmResult> {
  const {
    intentId,
    prepareId,
    articleId,
    expectedVersion,
    actor,
    siteUrl = FIRST_PUBLISH_DEFAULT_SITE_URL,
    now = unixNow(),
    afterCommit,
  } = input
  if (!intentId || intentId.trim() === '') return { outcome: 'invalid', reason: 'intentId is required' }
  if (!prepareId || prepareId.trim() === '') return { outcome: 'invalid', reason: 'prepareId is required' }
  if (!Number.isInteger(articleId) || articleId <= 0) return { outcome: 'invalid', reason: 'articleId is required' }
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    return { outcome: 'invalid', reason: 'expectedVersion must be a positive integer' }
  }
  if (!actor || actor.trim() === '') return { outcome: 'invalid', reason: 'actor is required' }

  const article = await findArticleById(db, articleId)
  if (!article) return { outcome: 'invalid', reason: `article ${articleId} not found` }
  const postRef = article.post_ref

  // Idempotent replay: the same intent already produced its event. Checked
  // BEFORE the prepare-status gate so a committed prepare replays cleanly.
  const intentBefore = await findIntent(db, intentId)
  if (intentBefore) {
    const formal = await findFormalByArticle(db, articleId)
    if (!formal) {
      // A dirty partial state (intent without formal facts) — fail closed.
      return { outcome: 'aborted', articleId, reason: 'intent exists without formal publication; manual inspection required' }
    }
    const event = await findEventByIntent(db, intentId)
    const outbox = event ? await findOutboxByEvent(db, event.event_id) : null
    if (!event || !outbox) {
      return { outcome: 'aborted', articleId, reason: 'intent delivered without event/outbox; manual inspection required' }
    }
    return { outcome: 'replayed', ...formalFacts(formal), intentId, outboxId: outbox.outbox_id, existing: true }
  }

  const prepare = await findPrepare(db, prepareId)
  if (!prepare) return { outcome: 'invalid', reason: `prepare ${prepareId} not found` }
  if (prepare.article_id !== articleId) {
    return { outcome: 'invalid', reason: `prepare ${prepareId} belongs to article ${prepare.article_id}` }
  }
  if (prepare.prepared_version !== expectedVersion) {
    return { outcome: 'conflict', articleId, expectedVersion, serverVersion: prepare.prepared_version, reason: 'prepare-version-mismatch' }
  }
  if (prepare.status !== 'prepared') {
    return { outcome: 'invalid', reason: `prepare is not ready (status='${prepare.status}')` }
  }

  const slug = prepare.prepared_slug
  const contentSha256 = prepare.prepared_content_sha256
  const eventId = eventIdFor(intentId)
  const outboxId = outboxIdFor(eventId)
  const publicUrl = `${siteUrl.replace(/\/+$/, '')}/${slug}`

  // Also reject a confirm whose article is already formally published.
  const existingFormal = await findFormalByArticle(db, articleId)
  if (existingFormal) {
    return { outcome: 'already-published', articleId, formal: formalFacts(existingFormal) }
  }

  const payload = JSON.stringify({
    format: 'blogman-first-publish-event/v1',
    eventId,
    intentId,
    articleId,
    version: expectedVersion,
    slug,
    lifecycle: FIRST_PUBLISH_PUBLISHED_LIFECYCLE,
    firstPublishedAt: now,
    publishedAt: now,
    publicUrl,
    contentSha256,
    actor,
    blockerFlags: {
      saved: prepare.blocker_saved,
      lifecycle: prepare.blocker_lifecycle,
      slug: prepare.blocker_slug,
      content: prepare.blocker_content,
    },
  })
  const evidenceSha256 = evidenceDigest(payload)

  const outboxPayload = JSON.stringify({
    format: 'blogman-first-publish-outbox/v1',
    outboxId,
    eventId,
    articleId,
    version: expectedVersion,
    slug,
    publicUrl,
    contentSha256,
  })

  const batch: D1PreparedStatement[] = [
    // (1) Current formal version + public address — every guard re-checked here.
    db
      .prepare(
        `INSERT INTO formal_publications
           (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id)
         SELECT ?, ?, ?, 'published', ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM formal_publications WHERE article_id = ?)
           AND NOT EXISTS (SELECT 1 FROM publish_intents WHERE intent_id = ?)
           AND (SELECT COALESCE(MAX(version), 0) FROM article_versions WHERE article_id = ?) = ?
           AND (SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ? AND version = ?) = ?
           AND (SELECT status FROM posts WHERE id = ?) != 'deleted'
           AND (SELECT deleted_at FROM posts WHERE id = ?) IS NULL
           AND NOT EXISTS (SELECT 1 FROM formal_publications WHERE slug = ? AND article_id != ?)
           AND NOT EXISTS (SELECT 1 FROM posts WHERE slug = ? AND id != ? AND status = 'published')
           AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND length(trim(title)) > 0 AND length(trim(content)) > 0
                        AND (password IS NULL OR password = ''))`,
      )
      .bind(
        articleId,
        expectedVersion,
        slug,
        now,
        now,
        publicUrl,
        eventId,
        articleId,
        intentId,
        articleId,
        expectedVersion,
        articleId,
        expectedVersion,
        contentSha256,
        postRef,
        postRef,
        slug,
        articleId,
        slug,
        postRef,
        postRef,
      ),
    // (2) The intent — one per client intent id.
    db
      .prepare(
        `INSERT INTO publish_intents
           (intent_id, prepare_id, article_id, version, slug, lifecycle, status, created_at)
         SELECT ?, ?, ?, ?, ?, 'published', 'delivered', ?
         WHERE NOT EXISTS (SELECT 1 FROM publish_intents WHERE intent_id = ?)
           AND EXISTS (SELECT 1 FROM formal_publications WHERE article_id = ? AND version = ?)`,
      )
      .bind(intentId, prepareId, articleId, expectedVersion, slug, now, intentId, articleId, expectedVersion),
    // (3) The single immutable event per intent. The hard UNIQUE constraints
    // are the enforcement: a dirty/partial conflicting event row (same intent
    // or same event id) ABORTS the whole batch so no partial facts survive.
    db
      .prepare(
        `INSERT INTO publish_events
           (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at, evidence_sha256, payload, created_at)
         SELECT ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM publish_intents WHERE intent_id = ? AND version = ?)`,
      )
      .bind(eventId, intentId, articleId, expectedVersion, slug, now, evidenceSha256, payload, now, intentId, expectedVersion),
    // (4) The outbox row — at most one per event.
    db
      .prepare(
        `INSERT INTO publish_outbox
           (outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at)
         SELECT ?, ?, ?, ?, 'public-receipt', ?, 'pending', 0, ?
         WHERE NOT EXISTS (SELECT 1 FROM publish_outbox WHERE event_id = ?)
           AND EXISTS (SELECT 1 FROM publish_events WHERE event_id = ?)`,
      )
      .bind(outboxId, eventId, articleId, expectedVersion, outboxPayload, now, eventId, eventId),
    // (5) The prepare commits ONLY if the formal publication for this event
    // actually landed; the posts projection follows the formal fact.
    db
      .prepare(
        `UPDATE publish_prepares SET status = 'committed', updated_at = ?
         WHERE prepare_id = ? AND status = 'prepared'
           AND EXISTS (SELECT 1 FROM formal_publications WHERE article_id = ? AND event_id = ?)`,
      )
      .bind(now, prepareId, articleId, eventId),
    db
      .prepare(
        `UPDATE posts SET status = 'published', published_at = ?, updated_at = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM formal_publications WHERE article_id = ? AND event_id = ?)`,
      )
      .bind(now, now, postRef, articleId, eventId),
  ]

  try {
    await db.batch(batch)
  } catch (error) {
    // The batch aborted atomically — a hard constraint fired (e.g. a dirty
    // partial event row with the same intent). Zero partial facts may exist.
    const formalAfter = await findFormalByArticle(db, articleId)
    const intentAfter = await findIntent(db, intentId)
    if (formalAfter && intentAfter) {
      const event = await findEventByIntent(db, intentId)
      const outbox = event ? await findOutboxByEvent(db, event.event_id) : null
      if (event && outbox) {
        return { outcome: 'delivered', ...formalFacts(formalAfter), intentId, outboxId: outbox.outbox_id, existing: false }
      }
    }
    return {
      outcome: 'aborted',
      articleId,
      reason: `transaction interrupted (no partial online state written): ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Resolve the outcome by re-reading the live state.
  const formal = await findFormalByArticle(db, articleId)
  if (!formal) {
    // A guard no-op'd — determine which precondition failed (fail-closed).
    const liveVersion = await latestVersion(db, articleId)
    if (liveVersion !== expectedVersion) {
      // The prepared plan is stale — supersede it so the workbench can prepare
      // the newer version instead of confirming a dead plan.
      await db
        .prepare(`UPDATE publish_prepares SET status = 'superseded', updated_at = ? WHERE prepare_id = ? AND status = 'prepared'`)
        .bind(now, prepareId)
        .run()
      return { outcome: 'conflict', articleId, expectedVersion, serverVersion: liveVersion, reason: 'version-moved' }
    }
    const versionSha = await db
      .prepare('SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ? AND version = ?')
      .bind(articleId, expectedVersion)
      .first<{ content_snapshot_sha256: string | null }>()
    if (!versionSha || versionSha.content_snapshot_sha256 !== contentSha256) {
      return { outcome: 'conflict', articleId, expectedVersion, serverVersion: liveVersion, reason: 'content-hash-mismatch' }
    }
    const rivalFormal = await db
      .prepare('SELECT article_id FROM formal_publications WHERE slug = ? AND article_id != ?')
      .bind(slug, articleId)
      .first<{ article_id: number }>()
    const rivalPublished = await db
      .prepare("SELECT id FROM posts WHERE slug = ? AND id != ? AND status = 'published'")
      .bind(slug, postRef)
      .first<{ id: number }>()
    if (rivalFormal || rivalPublished) {
      await db
        .prepare(`UPDATE publish_prepares SET status = 'aborted', updated_at = ? WHERE prepare_id = ? AND status = 'prepared'`)
        .bind(now, prepareId)
        .run()
      return { outcome: 'slug-conflict', articleId, slug }
    }
    const post = await findPostById(db, postRef)
    if (!post || post.status === 'deleted' || post.deleted_at !== null) {
      await db
        .prepare(`UPDATE publish_prepares SET status = 'aborted', updated_at = ? WHERE prepare_id = ? AND status = 'prepared'`)
        .bind(now, prepareId)
        .run()
      return { outcome: 'blocked', articleId, expectedVersion, blockers: { saved: true, lifecycle: false, slug: true, content: true }, failures: ['lifecycle'] }
    }
    if (post.title.trim().length === 0 || post.content.trim().length === 0 || (post.password !== null && post.password !== '')) {
      await db
        .prepare(`UPDATE publish_prepares SET status = 'aborted', updated_at = ? WHERE prepare_id = ? AND status = 'prepared'`)
        .bind(now, prepareId)
        .run()
      return { outcome: 'blocked', articleId, expectedVersion, blockers: { saved: true, lifecycle: true, slug: true, content: false }, failures: ['content'] }
    }
    await db
      .prepare(`UPDATE publish_prepares SET status = 'aborted', updated_at = ? WHERE prepare_id = ? AND status = 'prepared'`)
      .bind(now, prepareId)
      .run()
    return { outcome: 'aborted', articleId, reason: 'formal publication was not created by the transaction' }
  }

  const event = await findEventById(db, eventId)
  const outbox = event ? await findOutboxByEvent(db, event.event_id) : null
  if (!event || !outbox) {
    return { outcome: 'aborted', articleId, reason: 'event/outbox missing after transaction; manual inspection required' }
  }

  // External I/O runs ONLY after the transaction committed.
  if (afterCommit) {
    try {
      await afterCommit(outbox)
    } catch (_error) {
      // The outbox row stays pending — a later dispatch retries the delivery.
    }
  }

  return { outcome: 'delivered', ...formalFacts(formal), intentId, outboxId: outbox.outbox_id, existing: false }
}

/* ------------------------------------------------------------------ */
/* outbox dispatch + receipts (external I/O after the transaction)     */
/* ------------------------------------------------------------------ */

export async function listPendingOutbox(db: Database, limit = 10): Promise<OutboxRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at, delivered_at
       FROM publish_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?`,
    )
    .bind(limit)
    .all<OutboxRow>()
  return results
}

/**
 * Drive the durable outbox queue. Runs strictly AFTER the transaction that
 * wrote the rows; each row is delivered at most once (a successful `deliver`
 * marks it delivered, a throw marks it failed).
 */
export async function dispatchOutbox(db: Database, input: DispatchOutboxInput): Promise<{ delivered: number; failed: number }> {
  const { deliver, limit = 10 } = input
  const rows = await listPendingOutbox(db, limit)
  let delivered = 0
  let failed = 0
  for (const row of rows) {
    try {
      await deliver(row)
      await db
        .prepare(
          `UPDATE publish_outbox SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`,
        )
        .bind(unixNow(), row.id)
        .run()
      delivered += 1
    } catch (_error) {
      await db
        .prepare(`UPDATE publish_outbox SET status = 'failed', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`)
        .bind(row.id)
        .run()
      failed += 1
    }
  }
  return { delivered, failed }
}

/**
 * Record the independent blog receipt. The external verifier posts back the
 * verified public page facts bound to the event that produced the address.
 */
export async function recordReceipt(
  db: Database,
  input: { eventId: string; verified: boolean; receiptPayload: string; now?: number },
): Promise<ReceiptResult> {
  const { eventId, verified, receiptPayload, now = unixNow() } = input
  if (!eventId || eventId.trim() === '') return { outcome: 'invalid', reason: 'eventId is required' }
  const event = await findEventById(db, eventId)
  if (!event) return { outcome: 'not-found' }

  const existing = await db
    .prepare('SELECT * FROM publish_receipts WHERE event_id = ?')
    .bind(eventId)
    .first<ReceiptRow>()
  if (existing) return { outcome: 'replayed', row: existing }

  const formal = await findFormalByArticle(db, event.article_id)
  const publicUrl = formal?.public_url ?? `${FIRST_PUBLISH_DEFAULT_SITE_URL}/${event.slug}`

  await db
    .prepare(
      `INSERT INTO publish_receipts
         (event_id, article_id, version, slug, public_url, receipt_payload, verified, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(eventId, event.article_id, event.version, event.slug, publicUrl, receiptPayload, verified ? 1 : 0, now, now)
    .run()

  const row = await db
    .prepare('SELECT * FROM publish_receipts WHERE event_id = ?')
    .bind(eventId)
    .first<ReceiptRow>()
  if (!row) {
    throw new Error(`recordReceipt: receipt for event '${eventId}' not found after insert`)
  }
  return { outcome: 'recorded', row }
}

/* ------------------------------------------------------------------ */
/* read model                                                          */
/* ------------------------------------------------------------------ */

/** Full publication state for the workbench/editor confirmation surface. */
export async function readPublicationState(db: Database, articleId: number): Promise<PublicationState> {
  const article = await findArticleById(db, articleId)
  if (!article) {
    return { articleId, prepare: null, intent: null, event: null, outbox: null, formal: null, receipt: null }
  }
  const prepare = await db
    .prepare(
      `SELECT id, prepare_id, article_id, post_ref, prepared_version, prepared_slug, prepared_title,
              prepared_content_sha256, blocker_saved, blocker_lifecycle, blocker_slug, blocker_content,
              status, created_at, updated_at
       FROM publish_prepares WHERE article_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<PrepareRow>()
  const formalRow = await findFormalByArticle(db, articleId)
  const intent = formalRow
    ? await db
        .prepare('SELECT id, intent_id, prepare_id, article_id, version, slug, lifecycle, status, created_at FROM publish_intents WHERE article_id = ? ORDER BY created_at DESC LIMIT 1')
        .bind(articleId)
        .first<IntentRow>()
    : null
  const event = intent ? await findEventByIntent(db, intent.intent_id) : null
  const outbox = event ? await findOutboxByEvent(db, event.event_id) : null
  const receipt = event ? await db.prepare('SELECT * FROM publish_receipts WHERE event_id = ?').bind(event.event_id).first<ReceiptRow>() : null
  return { articleId, prepare, intent, event, outbox, formal: formalRow, receipt }
}