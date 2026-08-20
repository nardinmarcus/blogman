/**
 * B6-02 — 源稿领先内容安全写入 Blogman command kernel (issue #51).
 *
 * When the writable primary source is AHEAD of Blogman, the sync explicitly
 * pulls in the normalized title, the Markdown body and every referenced media
 * item:
 *
 *   1. resolve the source identity + the live (pending/confirmed) B6-01 link,
 *   2. read source content + referenced media through the injected provider /
 *      media store (mocks in tests, real adapters in a later batch — 零生产),
 *   3. reconcile media by PATH-AGNOSTIC content identity (`media_assets.
 *      content_sha256`) and rewrite the Markdown refs to Blogman asset URLs —
 *      content is REUSED across article paths only when its content is
 *      verifiable, never guessed from a filename (既有 R2 仅在内容身份可验证时复
 *      用, 不凭文件名推断),
 *   4. commit the synced body through the existing versioned write kernel
 *      (`article-commands.save`) — a DRAFT writes a NEW version, a FORMAL
 *      article routes to its UNIQUE active revision (正式文章线上版本保持, 变化只
 *      进修订), with the same expected-version precondition + operation-id
 *      idempotency,
 *   5. advance the sync baseline ONLY when every media item AND that save
 *      succeeded (全部成功才推进基线). ANY media/save/provider failure returns
 *      without advancing the baseline and without touching the article body
 *      (任一媒体/保存失败不产生半同步). Media facts already stored stay durable
 *      and reusable (不丢事实).
 *
 * The baseline fingerprint is computed from SOURCE content only (title +
 * rewritten Markdown + referenced media content hashes) — never from post
 * metadata or rendered HTML, so 发布元数据 / renderer 变化不影响源稿哈希.
 */

import { createHash } from 'node:crypto'
import { remark } from 'remark'
import remarkHtml from 'remark-html'
import type { Database } from '@/lib/repositories/schema'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { save } from '@/lib/article-commands'
import { resolveSourceUrl } from '@/lib/source-identity'
import type {
  MediaSyncFact,
  SourceProjection,
  SyncSourceInput,
  SyncSourceResult,
} from './types'

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function sha256Hex(input: string | Buffer | ArrayBuffer): string {
  const data =
    typeof input === 'string'
      ? Buffer.from(input, 'utf8')
      : input instanceof ArrayBuffer
        ? Buffer.from(input)
        : input
  return createHash('sha256').update(data).digest('hex')
}

/** 规范化标题 — trim + collapse whitespace + strip heading/emphasis markdown. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[*_]{1,3}(.*?)[*_]{1,3}\s*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Path-agnostic R2 key derived purely from the content identity. */
export function buildR2Key(contentSha256: string): string {
  return `source-media/${contentSha256}`
}

export function assetUrlFor(r2Key: string): string {
  return `/api/images/${r2Key.split('/').map(encodeURIComponent).join('/')}`
}

/** Rewrite every referenced source media token to its Blogman asset URL. */
export function rewriteMarkdownRefs(markdown: string, refToUrl: Record<string, string>): string {
  let out = markdown
  for (const [ref, url] of Object.entries(refToUrl)) {
    out = out.split(ref).join(url)
  }
  return out
}

/** Render the synced Markdown body to HTML for the posts / revision projection. */
export async function renderMarkdown(markdown: string): Promise<string> {
  const processed = await remark().use(remarkHtml).process(markdown)
  return processed.toString()
}

/**
 * The advanced-baseline fingerprint — SOURCE content only. Includes the
 * normalized title, the rewritten Markdown and the referenced media content
 * hashes; EXCLUDES post metadata and rendered HTML (render-agnostic).
 */
export function baselineFingerprint(title: string, markdown: string, media: MediaSyncFact[]): string {
  const sorted = [...media]
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((m) => ({ ref: m.ref, contentSha256: m.contentSha256 }))
  return sha256Hex(JSON.stringify({ title, markdown, media: sorted }))
}

/* ------------------------------------------------------------------ */
/* row readers                                                         */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface LiveLinkRow {
  id: number
  status: string
  article_id: number
}

interface MediaAssetRow {
  id: number
  content_sha256: string
  r2_key: string
}

interface SyncAttemptRow {
  operation_id: string
  source_identity_id: number
  article_id: number
  post_ref: number | null
  outcome: string
  reason: string | null
  baseline_sha256: string | null
  synced_version: number | null
  synced_revision_id: string | null
  projection_json: string | null
  media_json: string | null
}

interface PostRow {
  slug: string
  category: string | null
  tags: string | null
  description: string | null
  password: string | null
  is_pinned: number
  is_hidden: number
  cover_image: string | null
  status: string
  published_at: number | null
  deleted_at: number | null
}

async function findArticle(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db.prepare('SELECT id, post_ref FROM articles WHERE id = ?').bind(articleId).first<ArticleRow>()
}

async function liveLinkFor(db: Database, sourceIdentityId: number, articleId: number): Promise<LiveLinkRow | null> {
  return db
    .prepare(
      `SELECT id, status, article_id FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<LiveLinkRow>()
}

async function findPost(db: Database, postRef: number): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT slug, category, tags, description, password, is_pinned, is_hidden,
              cover_image, status, published_at, deleted_at
       FROM posts WHERE id = ?`,
    )
    .bind(postRef)
    .first<PostRow>()
}

async function findAttempt(db: Database, operationId: string): Promise<SyncAttemptRow | null> {
  return db
    .prepare(
      `SELECT operation_id, article_id, post_ref, outcome, reason, baseline_sha256,
              synced_version, synced_revision_id, projection_json, media_json
       FROM source_sync_attempts WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<SyncAttemptRow>()
}

/* ------------------------------------------------------------------ */
/* media reconciliation (content-identity dedup + source mapping)      */
/* ------------------------------------------------------------------ */

/** Rethrown on a partial media failure so already-reconciled facts aren't lost. */
export class MediaSyncError extends Error {
  readonly completed: MediaSyncFact[]
  constructor(message: string, completed: MediaSyncFact[] = []) {
    super(message)
    this.completed = completed
  }
}

async function reconcileMedia(
  db: Database,
  sourceIdentityId: number,
  content: { media: Array<{ ref: string; contentType: string; filename: string }> },
  provider: SyncSourceInput['provider'],
  mediaStore: SyncSourceInput['mediaStore'],
  now: number,
): Promise<{ facts: MediaSyncFact[]; refToUrl: Record<string, string> }> {
  const facts: MediaSyncFact[] = []
  const refToUrl: Record<string, string> = {}

  for (const ref of content.media) {
    try {
      const bytesResult = await provider.readMediaBytes(ref.ref)
      const sha = sha256Hex(bytesResult.bytes)
      const existing = await db
        .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
        .bind(sha)
        .first<MediaAssetRow>()

      let asset = existing
      const reused = existing !== null
      if (!asset) {
        // Nothing verified with this content identity yet → store it once.
        const r2Key = buildR2Key(sha)
        await mediaStore.put({
          r2Key,
          bytes: bytesResult.bytes,
          contentType: bytesResult.contentType,
          filename: ref.filename,
        })
        try {
          await db
            .prepare(
              `INSERT INTO media_assets (content_sha256, r2_key, media_type, filename, size, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(sha, r2Key, bytesResult.contentType, ref.filename, bytesResult.bytes.byteLength, now)
            .run()
        } catch {
          // A concurrent identical write created the row — converge, don't fail.
        }
        asset = await db
          .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
          .bind(sha)
          .first<MediaAssetRow>()
      }
      if (!asset) throw new MediaSyncError(`media-asset-missing:${ref.ref}`, facts)

      // One persistent source-ref → asset mapping (幂等 by unique key).
      await db
        .prepare(
          `INSERT INTO source_media_mappings (source_identity_id, source_ref, media_asset_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_identity_id, source_ref)
           DO UPDATE SET media_asset_id = excluded.media_asset_id`,
        )
        .bind(sourceIdentityId, ref.ref, asset.id, now)
        .run()

      const assetUrl = assetUrlFor(asset.r2_key)
      refToUrl[ref.ref] = assetUrl
      facts.push({
        ref: ref.ref,
        contentSha256: sha,
        r2Key: asset.r2_key,
        assetUrl,
        reused,
      })
    } catch (error) {
      if (error instanceof MediaSyncError) throw error
      throw new MediaSyncError(`${error instanceof Error ? error.message : String(error)}`, facts)
    }
  }
  return { facts, refToUrl }
}

/* ------------------------------------------------------------------ */
/* attempt / baseline persistence                                      */
/* ------------------------------------------------------------------ */

async function persistAttempt(db: Database, row: SyncAttemptRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_sync_attempts
         (operation_id, source_identity_id, article_id, post_ref, outcome, reason,
          baseline_sha256, synced_version, synced_revision_id, projection_json,
          media_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id)
       DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason,
         baseline_sha256 = excluded.baseline_sha256,
         synced_version = excluded.synced_version,
         synced_revision_id = excluded.synced_revision_id,
         projection_json = excluded.projection_json,
         media_json = excluded.media_json,
         post_ref = COALESCE(excluded.post_ref, source_sync_attempts.post_ref)`,
    )
    .bind(
      row.operation_id,
      row.source_identity_id,
      row.article_id,
      row.post_ref,
      row.outcome,
      row.reason,
      row.baseline_sha256,
      row.synced_version,
      row.synced_revision_id,
      row.projection_json,
      row.media_json,
      unixNow(),
    )
    .run()
}

/** Advance the baseline — called ONLY when the whole sync succeeded. */
export async function advanceBaseline(
  db: Database,
  sourceIdentityId: number,
  articleId: number,
  baselineSha256: string,
  syncedVersion: number,
  syncedRevisionId: string | null,
  projection: SourceProjection,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_sync_baselines
         (source_identity_id, article_id, baseline_sha256, synced_version,
          synced_revision_id, synced_title, synced_markdown, synced_html, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_identity_id, article_id)
       DO UPDATE SET baseline_sha256 = excluded.baseline_sha256,
         synced_version = excluded.synced_version,
         synced_revision_id = excluded.synced_revision_id,
         synced_title = excluded.synced_title,
         synced_markdown = excluded.synced_markdown,
         synced_html = excluded.synced_html,
         updated_at = excluded.updated_at`,
    )
    .bind(
      sourceIdentityId,
      articleId,
      baselineSha256,
      syncedVersion,
      syncedRevisionId,
      projection.title,
      projection.markdown,
      projection.html,
      now,
    )
    .run()
}

/* ------------------------------------------------------------------ */
/* syncSourceAhead — the public command                               */
/* ------------------------------------------------------------------ */

export async function syncSourceAhead(
  db: Database,
  input: SyncSourceInput,
): Promise<SyncSourceResult> {
  const { sourceUrl, articleId, expectedVersion, operationId, provider, mediaStore } = input
  if (!operationId || operationId.trim() === '' || !sourceUrl || !articleId) {
    return { outcome: 'invalid', reason: 'sourceUrl, articleId and operationId are required' }
  }
  if (!provider || !mediaStore) {
    return { outcome: 'invalid', reason: 'provider and mediaStore are required' }
  }

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }

  const now = unixNow()

  // B6-01 identity resolution — the source must be a real, resolvable identity.
  const identityResult = await resolveSourceUrl(db, sourceUrl)
  if (identityResult.outcome !== 'resolved') {
    return { outcome: 'invalid', reason: `invalid-source: ${sourceUrl}` }
  }
  const identity = identityResult.identity

  // The source must have a live (pending/confirmed) link to THIS article.
  const link = await liveLinkFor(db, identity.id, articleId)
  if (!link) {
    return { outcome: 'not-linked', reason: `source '${sourceUrl}' is not linked to article ${articleId}`, articleId, sourceUrl }
  }

  // Idempotent replay: an ALREADY-SUCCEEDED operation returns its original facts.
  const prior = await findAttempt(db, operationId)
  if (prior?.outcome === 'synced') {
    let projection: SourceProjection
    let media: MediaSyncFact[]
    try {
      projection = JSON.parse(prior.projection_json ?? '{}') as SourceProjection
      media = JSON.parse(prior.media_json ?? '[]') as MediaSyncFact[]
    } catch {
      projection = { title: '', markdown: '', html: '' }
      media = []
    }
    return {
      outcome: 'replayed',
      articleId,
      postRef: prior.post_ref ?? article.post_ref,
      version: prior.synced_version ?? 0,
      revisionId: prior.synced_revision_id,
      operationId,
      existing: true,
      baselineSha256: prior.baseline_sha256 ?? '',
      projection,
      media,
    }
  }

  // Read the source snapshot (title + Markdown + referenced media).
  let content: { title: string; markdown: string; media: Array<{ ref: string; contentType: string; filename: string }> }
  try {
    content = await provider.readSource({ sourceUrl })
  } catch (error) {
    await persistAttempt(db, {
      operation_id: operationId,
      source_identity_id: identity.id,
      article_id: articleId,
      post_ref: article.post_ref,
      outcome: 'failed',
      reason: `provider-read-failed: ${error instanceof Error ? error.message : String(error)}`,
      baseline_sha256: null,
      synced_version: null,
      synced_revision_id: null,
      projection_json: null,
      media_json: null,
    } as SyncAttemptRow)
    return {
      outcome: 'media-failed',
      reason: `provider-read-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
      operationId,
      completed: [],
    }
  }

  // Reconcile every referenced media item (content-identity dedup + mapping).
  let facts: MediaSyncFact[]
  let refToUrl: Record<string, string>
  try {
    ;({ facts, refToUrl } = await reconcileMedia(db, identity.id, content, provider, mediaStore, now))
  } catch (error) {
    const completed = error instanceof MediaSyncError ? error.completed : []
    await persistAttempt(db, {
      operation_id: operationId,
      source_identity_id: identity.id,
      article_id: articleId,
      post_ref: article.post_ref,
      outcome: 'failed',
      reason: `media-failed: ${error instanceof Error ? error.message : String(error)}`,
      baseline_sha256: null,
      synced_version: null,
      synced_revision_id: null,
      projection_json: null,
      media_json: JSON.stringify(completed),
    } as SyncAttemptRow)
    return {
      outcome: 'media-failed',
      reason: `media-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
      operationId,
      completed,
    }
  }

  // Build the synced projection + snapshot, preserving non-source post metadata.
  const projection: SourceProjection = {
    title: normalizeTitle(content.title),
    markdown: rewriteMarkdownRefs(content.markdown, refToUrl),
    html: await renderMarkdown(rewriteMarkdownRefs(content.markdown, refToUrl)),
  }
  const post = await findPost(db, article.post_ref)
  if (!post) {
    return { outcome: 'not-found', reason: `post ${article.post_ref} not found`, articleId }
  }
  let tags: string[] | null = null
  try {
    tags = post.tags ? (JSON.parse(post.tags) as string[]) : null
  } catch {
    tags = null
  }
  const snapshot: ArticleCommandSnapshot = {
    slug: post.slug,
    title: projection.title,
    content: projection.markdown,
    html: projection.html,
    description: post.description,
    category: post.category,
    tags,
    password: post.password,
    is_pinned: post.is_pinned ?? 0,
    is_hidden: post.is_hidden ?? 0,
    cover_image: post.cover_image,
    status: (post.status as ArticleCommandSnapshot['status']) ?? 'draft',
    deleted_at: post.deleted_at,
    published_at: post.published_at,
    updated_at: now,
  }

  // Commit through the versioned write kernel (draft→new version; formal→unique revision).
  const saveResult = await save(db, { articleId, expectedVersion, operationId, snapshot })

  if (saveResult.outcome === 'conflict') {
    await persistAttempt(db, {
      operation_id: operationId,
      source_identity_id: identity.id,
      article_id: articleId,
      post_ref: article.post_ref,
      outcome: 'failed',
      reason: 'save-conflict: version-moved',
      baseline_sha256: null,
      synced_version: null,
      synced_revision_id: null,
      projection_json: null,
      media_json: JSON.stringify(facts),
    } as SyncAttemptRow)
    return {
      outcome: 'save-conflict',
      reason: 'version-moved',
      articleId,
      expectedVersion,
      serverVersion: saveResult.serverVersion,
      operationId,
    }
  }

  if (saveResult.outcome === 'slug-conflict') {
    await persistAttempt(db, {
      operation_id: operationId,
      source_identity_id: identity.id,
      article_id: articleId,
      post_ref: article.post_ref,
      outcome: 'failed',
      reason: 'save-conflict: slug-conflict',
      baseline_sha256: null,
      synced_version: null,
      synced_revision_id: null,
      projection_json: null,
      media_json: JSON.stringify(facts),
    } as SyncAttemptRow)
    return {
      outcome: 'save-conflict',
      reason: 'slug-conflict',
      articleId,
      expectedVersion,
      serverVersion: expectedVersion,
      operationId,
    }
  }

  // save() succeeded (applied | replayed) — advance the baseline + record success.
  if (saveResult.outcome !== 'applied' && saveResult.outcome !== 'replayed') {
    throw new Error(`syncSourceAhead: unexpected save outcome '${(saveResult as { outcome: string }).outcome}'`)
  }
  const syncedVersion = saveResult.version
  const revisionId = (saveResult as { revisionId?: string }).revisionId ?? null
  const baselineSha256 = baselineFingerprint(projection.title, projection.markdown, facts)

  await advanceBaseline(db, identity.id, articleId, baselineSha256, syncedVersion, revisionId, projection, now)
  await persistAttempt(db, {
    operation_id: operationId,
    source_identity_id: identity.id,
    article_id: articleId,
    post_ref: article.post_ref,
    outcome: 'synced',
    reason: null,
    baseline_sha256: baselineSha256,
    synced_version: syncedVersion,
    synced_revision_id: revisionId,
    projection_json: JSON.stringify(projection),
    media_json: JSON.stringify(facts),
  } as SyncAttemptRow)

  if (saveResult.outcome === 'replayed') {
    return {
      outcome: 'replayed' as const,
      articleId,
      postRef: article.post_ref,
      version: syncedVersion,
      revisionId,
      operationId,
      existing: true,
      baselineSha256,
      projection,
      media: facts,
    }
  }
  return {
    outcome: 'synced' as const,
    articleId,
    postRef: article.post_ref,
    version: syncedVersion,
    revisionId,
    operationId,
    existing: false,
    baselineSha256,
    projection,
    media: facts,
  }
}
