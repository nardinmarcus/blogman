import { invalidatePublicContentCache } from '@/lib/cache'
import { processPost, getAiRuntimeEnv } from '@/lib/ai'
import { isAutoDescription } from '@/lib/post-utils'
import { deletePostFromRelatedIndex, syncPostToRelatedIndex } from '@/lib/related-content'
import { save, type ArticleCommandSnapshot } from '@/lib/article-commands'
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
      `SELECT version, snapshot_json FROM article_versions
       WHERE article_id = ? AND version = ?`,
    )
    .bind(articleId, expectedVersion)
    .first<VersionSnapshotRow>()
}

/** Rebuild the full authoring snapshot from a version fact, applying AI metadata. */
function snapshotFromVersionRecord(
  record: ArticleIdentitySnapshot,
  overrides: Partial<ArticleCommandSnapshot> = {},
): ArticleCommandSnapshot {
  const fields = record.fields
  return {
    slug: fields.slug,
    title: fields.title,
    content: record.original_content ?? '',
    html: record.original_html ?? '',
    description: fields.description,
    category: fields.category,
    tags: fields.tags ? parsePostTags(fields.tags) : null,
    status: fields.status === 'published' ? 'published' : 'draft',
    password: fields.password,
    is_pinned: fields.is_pinned ?? 0,
    is_hidden: fields.is_hidden ?? 0,
    cover_image: fields.cover_image,
    deleted_at: fields.deleted_at,
    published_at: fields.published_at,
    updated_at: fields.updated_at,
    ...overrides,
  }
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

  // Same merge policy as the legacy job — only fill gaps, never overwrite
  // author-authored metadata — evaluated against the anchored version facts.
  const overrides: Partial<ArticleCommandSnapshot> = {}
  const currentTags = fields.tags ? parsePostTags(fields.tags) : []

  if (!fields.category || fields.category === '未分类') {
    overrides.category = aiResult.category
  }
  if (currentTags.length === 0 && aiResult.tags.length > 0) {
    overrides.tags = aiResult.tags
  }
  if (!fields.description || isAutoDescription(fields.description, record.original_content ?? '')) {
    overrides.description = aiResult.description
  }

  if (Object.keys(overrides).length === 0) return

  const snapshot = snapshotFromVersionRecord(record, overrides)

  // Commit the full snapshot through the versioned write kernel. The kernel's
  // expected-version guard is the staleness gate: an author who advanced the
  // version since enqueue gets a conflict — the AI result expires without a
  // single byte written to `posts`.
  const result = await save(env.DB, {
    articleId: article.id,
    expectedVersion,
    operationId,
    snapshot,
    projections: {
      afterCommit: async () => {
        await invalidatePublicContentCache(env)
        await syncPostToRelatedIndex(env, article.post_ref)
      },
    },
  })

  if (result.outcome === 'applied' || result.outcome === 'replayed') {
    console.log(
      `background-jobs: AI metadata committed for post ${article.post_ref} (version ${result.version}, ${result.outcome})`,
    )
  } else if (result.outcome === 'conflict') {
    // Author advanced the version while AI was running — the late result is
    // stale and discarded. Nothing was written, nothing is overwritten.
    console.warn(
      `background-jobs: discarding stale AI result for post ${article.post_ref} (expected v${expectedVersion}, server v${result.serverVersion})`,
    )
  } else {
    console.warn(
      `background-jobs: AI metadata not applied for post ${article.post_ref}: ${result.outcome}`,
    )
  }
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