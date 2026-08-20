import { processPost, getAiRuntimeEnv } from '@/lib/ai'
import { isAutoDescription } from '@/lib/post-utils'
import { deletePostFromRelatedIndex, syncPostToRelatedIndex } from '@/lib/related-content'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { findActiveRevision } from '@/lib/publish-revision'
import { recordPreparedSuggestions } from '@/lib/publish-suggestions'
import type { PreparedSuggestion } from '@/lib/publish-suggestions/types'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import { parsePostTags } from '@/lib/repositories/post-mappers'

export type BackgroundJob =
  | {
      type: 'process-post-ai'
      postId: number
      /**
       * B2-07 (issue #30): the job records the article identity, the expected
       * version at enqueue time and a stable operation id so the AI result is
       * committed through the versioned write kernel — a late result against an
       * author-advanced version is a kernel conflict and is discarded, never an
       * overwrite. Fields are optional for messages enqueued by the legacy
       * `/api/posts` path (which has no article identity row); the handler
       * resolves them at job start, or skips the job without writing when no
       * identity exists (legacy / queue / waitUntil / cached flows are never
       * migrated into article facts).
       */
      articleId?: number
      expectedVersion?: number
      operationId?: string
    }
  | {
      type: 'sync-post-related-index'
      postId: number
    }
  | {
      type: 'delete-post-related-index'
      postId: number
    }

export interface BackgroundJobEnv extends Partial<CloudflareEnv> {
  DB?: D1Database
  CACHE?: KVNamespace
  BACKGROUND_QUEUE?: QueueBinding
  VECTOR_INDEX?: VectorizeIndex
}

interface BackgroundJobMessage<T> {
  body: T
  ack?: () => void
  retry?: () => void
}

interface BackgroundJobBatch<T> {
  messages: Array<BackgroundJobMessage<T>>
}

interface EnqueueBackgroundJobOptions {
  waitUntil?: (promise: Promise<unknown>) => void
}

function readFlag(value: unknown): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function shouldUseQueue(env?: BackgroundJobEnv | null): boolean {
  return Boolean(env?.BACKGROUND_QUEUE) && readFlag(env?.ENABLE_BACKGROUND_JOBS)
}

/**
 * B2-07 — stable operation id for one background AI enrichment run. Derived from
 * the post ref + the article version the run is anchored to: retrying the same
 * job (queue retry / duplicate dispatch) replays the original version through
 * the kernel instead of writing a new one, while a job anchored to a newer
 * version gets a distinct id and may apply.
 */
export function aiProcessPostOperationId(postRef: number, expectedVersion: number): string {
  return `ai:process-post:${postRef}:v${expectedVersion}`
}

interface ArticleIdentityRef {
  id: number
  post_ref: number
}

interface VersionSnapshotRow {
  version: number
  snapshot_json: string
  content_snapshot_sha256: string | null
}

async function resolveArticleIdentity(
  db: D1Database,
  job: { postId: number; articleId?: number },
): Promise<ArticleIdentityRef | null> {
  if (typeof job.articleId === 'number' && Number.isInteger(job.articleId)) {
    const article = await db
      .prepare('SELECT id, post_ref FROM articles WHERE id = ?')
      .bind(job.articleId)
      .first<ArticleIdentityRef>()
    // A message whose identity and post ref disagree is malformed: never write
    // for a pairing the queue cannot vouch for.
    if (!article || article.post_ref !== job.postId) return null
    return article
  }
  // Legacy message shape — resolve by post ref when an identity row exists.
  return (
    (await db
      .prepare('SELECT id, post_ref FROM articles WHERE post_ref = ?')
      .bind(job.postId)
      .first<ArticleIdentityRef>()) ?? null
  )
}

async function findVersionSnapshot(
  db: D1Database,
  articleId: number,
  expectedVersion: number,
): Promise<VersionSnapshotRow | null> {
  return db
    .prepare(
      `SELECT version, snapshot_json, content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = ?`,
    )
    .bind(articleId, expectedVersion)
    .first<VersionSnapshotRow>()
}

async function runProcessPostAiJob(env: BackgroundJobEnv, job: Extract<BackgroundJob, { type: 'process-post-ai' }>) {
  if (!env.DB) return

  // Resolve the article identity the job is anchored to. Non-versioned posts
  // (no `articles` identity row) are skipped: the queue / waitUntil / cached
  // legacy flows are never migrated into article facts.
  const article = await resolveArticleIdentity(env.DB, job)
  if (!article) {
    console.warn(
      `background-jobs: skipping process-post-ai for post ${job.postId}: no article identity (legacy post)`,
    )
    return
  }

  // A deleted post must not be re-enriched (legacy soft-deletes touch `posts`
  // without a version fact).
  const live = await env.DB
    .prepare('SELECT deleted_at FROM posts WHERE id = ?')
    .bind(article.post_ref)
    .first<{ deleted_at: number | null }>()
  if (live?.deleted_at != null) return

  // B3-02 (issue #34): a formally published article with an ACTIVE pending
  // revision is edited through the shared revision surface — the AI writer
  // anchors to the ACTIVE REVISION (title/body from the revision) and its
  // revision number is the version token; every writer lands in the same row.
  // Drafts keep the monotonic article_versions anchor below. On a DB where the
  // revision/first-publish tables are absent the branch is skipped.
  let activeRevision: Awaited<ReturnType<typeof findActiveRevision>> = null
  try {
    activeRevision = await findActiveRevision(env.DB, article.id)
  } catch {
    activeRevision = null
  }
  if (activeRevision) {
    const expectedVersion = activeRevision.revision_number
    const operationId =
      job.operationId && job.operationId.trim() !== ''
        ? job.operationId
        : `ai:process-post:${article.post_ref}:rev${expectedVersion}`

    let currentTags: string[] = []
    try {
      const parsed = JSON.parse(activeRevision.tags ?? '[]')
      currentTags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
    } catch {
      currentTags = []
    }
    const baseSnapshot: ArticleCommandSnapshot = {
      slug: activeRevision.slug,
      title: activeRevision.title,
      content: activeRevision.content,
      html: activeRevision.html,
      description: activeRevision.description,
      category: activeRevision.category,
      tags: currentTags.length > 0 ? currentTags : null,
      status: 'published',
      password: activeRevision.password,
      is_pinned: activeRevision.is_pinned,
      is_hidden: activeRevision.is_hidden,
      cover_image: activeRevision.cover_image,
      deleted_at: null,
      published_at: null,
      updated_at: null,
    }

    const aiResult = await processPost(
      baseSnapshot.title,
      baseSnapshot.content,
      getAiRuntimeEnv(env),
      2,
      env.DB,
    )
    if (!aiResult) return

    // B3-06 (issue #38): the AI NEVER writes a live fact. It records
    // VERSION-BOUND suggestions the author previews/applies/revokes/ignores;
    // a suggestion whose bound version / body / field has moved is stale and
    // is never silently applied.
    const prepared: PreparedSuggestion[] = []
    if (!baseSnapshot.category || baseSnapshot.category === '未分类') {
      prepared.push({ field: 'category', value: JSON.stringify(aiResult.category), fieldBefore: JSON.stringify(baseSnapshot.category ?? null) })
    }
    if (currentTags.length === 0 && aiResult.tags.length > 0) {
      prepared.push({ field: 'tags', value: JSON.stringify(aiResult.tags), fieldBefore: '[]' })
    }
    if (!baseSnapshot.description || isAutoDescription(baseSnapshot.description, baseSnapshot.content)) {
      prepared.push({ field: 'description', value: JSON.stringify(aiResult.description), fieldBefore: JSON.stringify(baseSnapshot.description ?? null) })
    }
    if (prepared.length === 0) return

    const rec = await recordPreparedSuggestions(env.DB, {
      articleId: article.id,
      postRef: article.post_ref,
      boundVersion: expectedVersion,
      boundRevision: activeRevision.revision_id,
      source: operationId,
      basisSha256: activeRevision.content_sha256,
      suggestions: prepared,
    })
    console.log(
      `background-jobs: recorded AI suggestions for post ${article.post_ref} (rev ${expectedVersion}, ${rec.outcome})`,
    )
    return
  }

  // Expected version + stable operation id: prefer the job's recorded values,
  // fall back to the latest version at job start for legacy-shaped messages.
  const latest = await env.DB
    .prepare(
      `SELECT version FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(article.id)
    .first<{ version: number }>()
  const expectedVersion =
    typeof job.expectedVersion === 'number' && Number.isInteger(job.expectedVersion)
      ? job.expectedVersion
      : (latest?.version ?? 0)
  const operationId =
    job.operationId && job.operationId.trim() !== ''
      ? job.operationId
      : aiProcessPostOperationId(article.post_ref, expectedVersion)

  if (expectedVersion < 1) return

  // Anchor the AI input to the exact version the run was enqueued against, so a
  // late result can never describe a body the author has since moved past.
  const anchored = await findVersionSnapshot(env.DB, article.id, expectedVersion)
  if (!anchored) return

  let record: ArticleIdentitySnapshot
  try {
    record = JSON.parse(anchored.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    return
  }
  const fields = record.fields

  const aiResult = await processPost(
    fields.title,
    record.original_content ?? '',
    getAiRuntimeEnv(env),
    2,
    env.DB,
  )
  if (!aiResult) return

  // B3-06 (issue #38): record version-bound suggestions — never write directly.
  const currentTags = fields.tags ? parsePostTags(fields.tags) : []
  const prepared: PreparedSuggestion[] = []
  if (!fields.category || fields.category === '未分类') {
    prepared.push({ field: 'category', value: JSON.stringify(aiResult.category), fieldBefore: JSON.stringify(fields.category ?? null) })
  }
  if (currentTags.length === 0 && aiResult.tags.length > 0) {
    prepared.push({ field: 'tags', value: JSON.stringify(aiResult.tags), fieldBefore: '[]' })
  }
  if (!fields.description || isAutoDescription(fields.description, record.original_content ?? '')) {
    prepared.push({ field: 'description', value: JSON.stringify(aiResult.description), fieldBefore: JSON.stringify(fields.description ?? null) })
  }
  if (prepared.length === 0) return

  await recordPreparedSuggestions(env.DB, {
    articleId: article.id,
    postRef: article.post_ref,
    boundVersion: expectedVersion,
    boundRevision: null,
    source: operationId,
    basisSha256: anchored.content_snapshot_sha256 ?? '',
    suggestions: prepared,
  })
}

async function runSyncPostRelatedIndexJob(env: BackgroundJobEnv, postId: number) {
  await syncPostToRelatedIndex(env, postId)
}

async function runDeletePostRelatedIndexJob(env: BackgroundJobEnv, postId: number) {
  await deletePostFromRelatedIndex(env, postId)
}

export async function runBackgroundJob(env: BackgroundJobEnv, job: BackgroundJob): Promise<void> {
  switch (job.type) {
    case 'process-post-ai':
      await runProcessPostAiJob(env, job)
      return
    case 'sync-post-related-index':
      await runSyncPostRelatedIndexJob(env, job.postId)
      return
    case 'delete-post-related-index':
      await runDeletePostRelatedIndexJob(env, job.postId)
      return
  }
}

export async function enqueueBackgroundJob(
  env: BackgroundJobEnv,
  job: BackgroundJob,
  options?: EnqueueBackgroundJobOptions,
): Promise<'queue' | 'waitUntil' | 'inline'> {
  if (shouldUseQueue(env)) {
    try {
      await env.BACKGROUND_QUEUE!.send(job)
      return 'queue'
    } catch (error) {
      console.error('Failed to enqueue background job, falling back to inline execution:', error)
    }
  }

  const task = runBackgroundJob(env, job)

  if (options?.waitUntil) {
    options.waitUntil(
      task.catch((error) => {
        console.error('Background job failed:', error)
      }),
    )
    return 'waitUntil'
  }

  void task.catch((error) => {
    console.error('Background job failed:', error)
  })
  return 'inline'
}

export async function consumeBackgroundJobBatch(
  batch: BackgroundJobBatch<BackgroundJob>,
  env: BackgroundJobEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runBackgroundJob(env, message.body)
      message.ack?.()
    } catch (error) {
      console.error('Queue background job failed:', error)
      message.retry?.()
    }
  }
}