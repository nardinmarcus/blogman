/**
 * B6-04 — 明确选边解决主要源稿内容冲突 command kernel (issue #53).
 *
 * The conflict surface owns ONE read-only derivation and THREE explicit entry
 * points. Nothing else may resolve a both-sides deviation; there is no
 * auto-merge (允许手工复制但不建复杂合并器):
 *
 *   - `probeConflict`        — READ-ONLY. Derives, from both sides' projections
 *     vs the baseline, whether the source moved past the baseline (`source-
 *     ahead`), Blogman moved past it (`blogman-ahead`), BOTH moved (`conflict`,
 *     the paused state) or neither (`synced`). Always produces the full
 *     title/body/media diff projection. Writes NOTHING — 暂停同步, 不自动合并.
 *   - `resolveConflictSide`  — the author EXPLICITLY picks a side.
 *       · 选源稿: saves a restore point first (恢复点), then commits the
 *         captured source projection through the versioned write kernel with
 *         the expected-version precondition — 冲突时旧写入不能覆盖新内容; formal
 *         articles only update the active pending revision (正式文章选择源稿只
 *         更新待发布修订) — and only then advances the baseline.
 *       · 选 Blogman: records a durable intent bound to the article version +
 *         baseline + the source fingerprint the choice saw, and hands off to
 *         the B6-03-style write-back lifecycle (`executeConflictWriteBack` →
 *         `confirmConflictWriteBack`). The EXTERNAL confirmation is the ONLY
 *         thing that advances the baseline (确认前不推进基线); late confirmations
 *         after a version move are refused (迟到确认).
 *   - A change on EITHER side after a choice expires it (任一方变化使旧选择过
 *     期): re-verification compares the now-current source fingerprint /
 *     article version against what the choice was anchored to. Expired
 *     resolutions are refused; the author must re-probe and re-choose. Every
 *     step is idempotent by operation id (重复操作幂等) — a lost response
 *     re-queries the same operation.
 */

import type { Database } from '@/lib/repositories/schema'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { save } from '@/lib/article-commands'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import { saveRestorePoint } from '@/lib/publish-revision'
import { resolveSourceUrl } from '@/lib/source-identity'
import {
  assetUrlFor,
  baselineFingerprint,
  buildR2Key,
  normalizeTitle,
  renderMarkdown,
  rewriteMarkdownRefs,
  sha256Hex,
  type MediaSyncFact,
  type SourceContent,
  type SourceProvider,
} from '@/lib/source-sync'
import type { SourceWriteProvider } from '@/lib/source-writeback'
import type { MediaStore } from '@/lib/source-sync'
import { CONFLICT_SAVE_OP_PREFIX, CONFLICT_WRITE_BACK_OP_PREFIX } from './ddl'
import type {
  BlogmanView,
  ConflictBaseline,
  ConflictResolution,
  ConfirmConflictWriteBackInput,
  ConfirmConflictWriteBackResult,
  DerivedSyncState,
  DiffProjection,
  ExecuteConflictWriteBackInput,
  ExecuteConflictWriteBackResult,
  MediaItemDiff,
  ProbeConflictResult,
  ResolveConflictInput,
  ResolveConflictResult,
  SideProjectionDiff,
  SourceView,
  WriteBackIntent,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* shared constants / pure helpers (unit-testable)                     */
/* ------------------------------------------------------------------ */

const MEDIA_URL_RE = /\/api\/images\/source-media\/([0-9a-f]{64})/g

/** Unique, sorted content-addressed asset URLs referenced from a markdown body. */
export function mediaUrlsFromBody(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(MEDIA_URL_RE)) {
    found.add(`/api/images/source-media/${match[1]}`)
  }
  return [...found].sort()
}

/** Bounded, deterministic word-token diff (same shape as the editor workbench). */
export function tokenDiff(a: string, b: string): Array<{ type: 'same' | 'removed' | 'added'; value: string }> {
  const toks = (s: string) => (s || '').split(/\s+/).filter(Boolean)
  const at = toks(a)
  const bt = toks(b)
  const out: Array<{ type: 'same' | 'removed' | 'added'; value: string }> = []
  let i = 0
  let j = 0
  while (i < at.length && j < bt.length) {
    if (at[i] === bt[j]) {
      out.push({ type: 'same', value: at[i] })
      i += 1
      j += 1
    } else {
      out.push({ type: 'removed', value: at[i] })
      out.push({ type: 'added', value: bt[j] })
      i += 1
      j += 1
    }
  }
  while (i < at.length) out.push({ type: 'removed', value: at[i++] })
  while (j < bt.length) out.push({ type: 'added', value: bt[j++] })
  return out
}

/** Media differences between the baseline set and the current side's set. */
export function diffMedia(
  baseline: Array<{ ref: string; contentSha256: string }>,
  current: Array<{ ref: string; contentSha256: string }>,
): MediaItemDiff[] {
  const baselineByRef = new Map(baseline.map((m) => [m.ref, m.contentSha256]))
  const currentByRef = new Map(current.map((m) => [m.ref, m.contentSha256]))
  const refs = [...new Set([...baselineByRef.keys(), ...currentByRef.keys()])].sort()
  const out: MediaItemDiff[] = []
  for (const ref of refs) {
    const b = baselineByRef.get(ref)
    const c = currentByRef.get(ref)
    out.push({
      ref,
      change: b === undefined ? 'added' : c === undefined ? 'removed' : b === c ? 'same' : 'changed',
      baselineSha256: b ?? null,
      currentSha256: c ?? null,
      assetUrl: c ? assetUrlFor(buildR2Key(c)) : null,
    })
  }
  return out
}

/** Derive the four-state conclusion from the two deviation flags. */
export function deriveState(sourceChanged: boolean, blogmanChanged: boolean): DerivedSyncState {
  if (sourceChanged && blogmanChanged) return 'conflict'
  if (sourceChanged) return 'source-ahead'
  if (blogmanChanged) return 'blogman-ahead'
  return 'synced'
}

/** Build one side's title/body/media diff against the baseline projection. */
export function deriveSideDiff(
  baseline: ConflictBaseline,
  current: { title: string; body: string; media: Array<{ ref: string; contentSha256: string }> },
): SideProjectionDiff {
  const baselineBody = baseline.markdown ?? ''
  const baselineMedia = baseline.media ?? []
  const body = tokenDiff(baselineBody, current.body)
  const media = diffMedia(baselineMedia, current.media)
  return {
    title: {
      changed: (baseline.title ?? '') !== current.title,
      baseline: baseline.title,
      current: current.title,
    },
    body,
    bodyChanged: body.some((t) => t.type !== 'same'),
    media,
    mediaChanged: media.some((m) => m.change !== 'same'),
  }
}

/** Build the full diff projection (source side + blogman side). */
export function deriveDiffProjection(
  baseline: ConflictBaseline,
  source: SourceView,
  blogman: BlogmanView,
): DiffProjection {
  return {
    source: deriveSideDiff(baseline, {
      title: source.title,
      body: source.markdown,
      media: source.media.map((m) => ({ ref: m.ref, contentSha256: m.contentSha256 })),
    }),
    blogman: deriveSideDiff(baseline, {
      title: blogman.title,
      body: blogman.body,
      media: blogman.mediaUrls.map((url) => ({ ref: url, contentSha256: url.split('/').pop() ?? '' })),
    }),
  }
}

/* ------------------------------------------------------------------ */
/* row readers                                                         */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface BaselineRow {
  article_version: number | null
  source_sync_sha256: string | null
  baseline_sha256: string | null
  synced_version: number | null
  synced_revision_id: string | null
  synced_title: string | null
  synced_markdown: string | null
  synced_html: string | null
  synced_media_json: string | null
}

interface LinkRow {
  id: number
  status: string
}

interface VersionRow {
  version: number
  snapshot_json: string
}

interface RevisionRow {
  revision_id: string
  revision_number: number
  title: string
  content: string
  html: string
}

interface PostMetaRow {
  slug: string
  title: string
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

interface ResolutionRow {
  operation_id: string
  source_identity_id: number
  article_id: number
  chosen_side: string
  baseline_version: number
  baseline_sha256: string
  anchored_source_sha256: string
  anchored_article_version: number
  source_projection_json: string
  source_media_json: string
  pre_resolution_snapshot_json: string
  write_back_content_json: string | null
  status: string
  created_at: number
  applied_at: number | null
}

interface IntentRow {
  id: number
  source_identity_id: number
  article_id: number
  article_version: number
  baseline_version: number
  operation_id: string
  status: string
  external_ref: string | null
  source_sync_sha256: string | null
  intent_at: number
  written_at: number | null
  confirmed_at: number | null
}

async function findArticle(db: Database, id: number): Promise<ArticleRow | null> {
  return db.prepare('SELECT id, post_ref FROM articles WHERE id = ?').bind(id).first<ArticleRow>()
}

async function liveLinkFor(db: Database, sourceIdentityId: number, articleId: number): Promise<LinkRow | null> {
  return db
    .prepare(
      `SELECT id, status FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<LinkRow>()
}

async function findBaselineRow(db: Database, sourceIdentityId: number, articleId: number): Promise<BaselineRow | null> {
  return db
    .prepare(
      `SELECT article_version, source_sync_sha256, baseline_sha256, synced_version,
              synced_revision_id, synced_title, synced_markdown, synced_html,
              synced_media_json
       FROM source_sync_baselines
       WHERE source_identity_id = ? AND article_id = ?`,
    )
    .bind(sourceIdentityId, articleId)
    .first<BaselineRow>()
}

async function findLatestVersion(db: Database, articleId: number): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT version, snapshot_json FROM article_versions
       WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<VersionRow>()
}

async function findActiveRevision(db: Database, articleId: number): Promise<RevisionRow | null> {
  return db
    .prepare(
      `SELECT revision_id, revision_number, title, content, html
       FROM publish_revisions WHERE article_id = ? AND status = 'active'
       ORDER BY revision_number DESC LIMIT 1`,
    )
    .bind(articleId)
    .first<RevisionRow>()
}

async function findPostMeta(db: Database, postRef: number): Promise<PostMetaRow | null> {
  return db
    .prepare(
      `SELECT slug, title, category, tags, description, password, is_pinned, is_hidden,
              cover_image, status, published_at, deleted_at
       FROM posts WHERE id = ?`,
    )
    .bind(postRef)
    .first<PostMetaRow>()
}

function mapResolution(row: ResolutionRow): ConflictResolution {
  let sourceProjection: ConflictResolution['sourceProjection']
  try {
    sourceProjection = JSON.parse(row.source_projection_json) as ConflictResolution['sourceProjection']
  } catch {
    sourceProjection = { title: '', markdown: '', html: '' }
  }
  let sourceMedia: MediaSyncFact[]
  try {
    sourceMedia = JSON.parse(row.source_media_json) as MediaSyncFact[]
  } catch {
    sourceMedia = []
  }
  let writeBackContent: ConflictResolution['writeBackContent']
  try {
    writeBackContent = row.write_back_content_json
      ? (JSON.parse(row.write_back_content_json) as ConflictResolution['writeBackContent'])
      : null
  } catch {
    writeBackContent = null
  }
  return {
    operationId: row.operation_id,
    sourceIdentityId: row.source_identity_id,
    articleId: row.article_id,
    chosenSide: row.chosen_side as ConflictResolution['chosenSide'],
    baselineVersion: row.baseline_version,
    baselineSha256: row.baseline_sha256,
    anchoredSourceSha256: row.anchored_source_sha256,
    anchoredArticleVersion: row.anchored_article_version,
    sourceProjection,
    sourceMedia,
    preResolutionSnapshotJson: row.pre_resolution_snapshot_json,
    writeBackContent,
    status: row.status as ConflictResolution['status'],
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  }
}

async function findResolution(db: Database, operationId: string): Promise<ConflictResolution | null> {
  const row = await db
    .prepare(
      `SELECT operation_id, source_identity_id, article_id, chosen_side, baseline_version,
              baseline_sha256, anchored_source_sha256, anchored_article_version,
              source_projection_json, source_media_json, pre_resolution_snapshot_json,
              write_back_content_json, status, created_at, applied_at
       FROM source_conflict_resolutions WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<ResolutionRow>()
  return row ? mapResolution(row) : null
}

function mapIntent(row: IntentRow): WriteBackIntent {
  return {
    id: row.id,
    sourceIdentityId: row.source_identity_id,
    articleId: row.article_id,
    articleVersion: row.article_version,
    baselineVersion: row.baseline_version,
    operationId: row.operation_id,
    status: row.status as WriteBackIntent['status'],
    externalRef: row.external_ref,
    sourceSyncSha256: row.source_sync_sha256,
    intentAt: row.intent_at,
    writtenAt: row.written_at,
    confirmedAt: row.confirmed_at,
  }
}

async function findIntent(db: Database, operationId: string): Promise<WriteBackIntent | null> {
  const row = await db
    .prepare(
      `SELECT id, source_identity_id, article_id, article_version, baseline_version,
              operation_id, status, external_ref, source_sync_sha256,
              intent_at, written_at, confirmed_at
       FROM source_write_back_intents WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<IntentRow>()
  return row ? mapIntent(row) : null
}

async function canonicalUrlFor(db: Database, sourceIdentityId: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT canonical_url FROM source_identities WHERE id = ?')
    .bind(sourceIdentityId)
    .first<{ canonical_url: string }>()
  return row?.canonical_url ?? null
}

function versionSnapshotContent(versionRow: VersionRow): { title: string; content: string; html: string } {
  let parsed: ArticleIdentitySnapshot | null = null
  try {
    parsed = JSON.parse(versionRow.snapshot_json) as ArticleIdentitySnapshot
  } catch {
    parsed = null
  }
  return {
    title: parsed?.fields?.title ?? '',
    content: parsed?.original_content ?? '',
    html: parsed?.original_html ?? '',
  }
}

/* ------------------------------------------------------------------ */
/* source reading (read-only)                                          */
/* ------------------------------------------------------------------ */

/**
 * Read the source's current title/markdown/media + compute its fingerprint.
 * READ-ONLY — media bytes are hashed but never stored; existing assets are
 * looked up (for `reused` + asset URLs) but nothing is inserted.
 */
export async function readSourceView(
  db: Database,
  sourceIdentityId: number,
  provider: SourceProvider,
  options: { sourceUrl: string },
): Promise<SourceView> {
  const content: SourceContent = await provider.readSource({ sourceUrl: options.sourceUrl })
  const media: MediaSyncFact[] = []
  const refToUrl: Record<string, string> = {}
  for (const ref of content.media) {
    const bytes = await provider.readMediaBytes(ref.ref)
    const sha = sha256Hex(bytes.bytes)
    const existing = await db
      .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
      .bind(sha)
      .first<{ id: number; r2_key: string; content_sha256: string }>()
    const r2Key = existing?.r2_key ?? buildR2Key(sha)
    const assetUrl = assetUrlFor(r2Key)
    refToUrl[ref.ref] = assetUrl
    media.push({
      ref: ref.ref,
      contentSha256: sha,
      r2Key,
      assetUrl,
      reused: existing !== null,
    })
  }
  const title = normalizeTitle(content.title)
  const markdown = rewriteMarkdownRefs(content.markdown, refToUrl)
  return {
    title,
    markdown,
    media,
    fingerprint: baselineFingerprint(title, markdown, media),
  }
}

/**
 * The Blogman side: an active revision's editable content wins over the formal
 * projection; version token = the revision number for formal, else latest
 * article version.
 */
export async function readBlogmanView(db: Database, articleId: number): Promise<BlogmanView | null> {
  const latest = await findLatestVersion(db, articleId)
  const revision = await findActiveRevision(db, articleId)
  if (revision) {
    return {
      version: revision.revision_number,
      title: revision.title,
      body: revision.content,
      mediaUrls: mediaUrlsFromBody(revision.content),
    }
  }
  if (!latest) return null
  const parsed = versionSnapshotContent(latest)
  return {
    version: latest.version,
    title: parsed.title,
    body: parsed.content,
    mediaUrls: mediaUrlsFromBody(parsed.content),
  }
}

/* ------------------------------------------------------------------ */
/* probeConflict — 只读推导, 不写任何行                                 */
/* ------------------------------------------------------------------ */

export async function probeConflict(
  db: Database,
  provider: SourceProvider,
  input: { sourceUrl: string; articleId: number },
): Promise<ProbeConflictResult> {
  const { sourceUrl, articleId } = input
  if (!sourceUrl || !articleId) return { outcome: 'invalid', reason: 'sourceUrl and articleId are required' }

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }

  const identityResult = await resolveSourceUrl(db, sourceUrl)
  if (identityResult.outcome !== 'resolved') {
    return { outcome: 'invalid', reason: `invalid-source: ${sourceUrl}` }
  }
  const identity = identityResult.identity
  const link = await liveLinkFor(db, identity.id, articleId)
  if (!link) {
    return { outcome: 'not-linked', reason: `source '${sourceUrl}' is not linked to article ${articleId}`, articleId, sourceUrl }
  }

  const baselineRow = await findBaselineRow(db, identity.id, articleId)
  if (!baselineRow) {
    return { outcome: 'no-baseline', reason: `no confirmed baseline for article ${articleId}`, articleId, sourceIdentityId: identity.id }
  }
  let baselineMedia: MediaSyncFact[]
  try {
    baselineMedia = JSON.parse(baselineRow.synced_media_json ?? '[]') as MediaSyncFact[]
  } catch {
    baselineMedia = []
  }
  const baseline: ConflictBaseline = {
    articleVersion: baselineRow.article_version ?? baselineRow.synced_version ?? 0,
    sourceSha256: baselineRow.source_sync_sha256 ?? baselineRow.baseline_sha256 ?? '',
    title: baselineRow.synced_title,
    markdown: baselineRow.synced_markdown,
    html: baselineRow.synced_html,
    media: baselineMedia,
  }

  let source: SourceView
  try {
    source = await readSourceView(db, identity.id, provider, { sourceUrl })
  } catch (error) {
    return {
      outcome: 'unreadable',
      reason: `source-read-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
    }
  }

  const blogman = await readBlogmanView(db, articleId)
  if (!blogman) {
    return { outcome: 'not-found', reason: `article ${articleId} has no version snapshot`, articleId }
  }

  const sourceChanged = source.fingerprint !== baseline.sourceSha256
  const blogmanChanged =
    blogman.version > baseline.articleVersion ||
    (baseline.title !== null && (baseline.title !== blogman.title || (baseline.markdown ?? '') !== blogman.body))
  const state = deriveState(sourceChanged, blogmanChanged)
  const diff = deriveDiffProjection(baseline, source, blogman)

  return {
    outcome: 'probed',
    articleId,
    sourceIdentityId: identity.id,
    state,
    conflict: state === 'conflict',
    sourceChanged,
    blogmanChanged,
    baseline,
    source,
    blogman,
    diff,
  }
}

/* ------------------------------------------------------------------ */
/* resolution helpers                                                  */
/* ------------------------------------------------------------------ */

function baselineFromRow(row: BaselineRow): ConflictBaseline {
  let media: MediaSyncFact[]
  try {
    media = JSON.parse(row.synced_media_json ?? '[]') as MediaSyncFact[]
  } catch {
    media = []
  }
  return {
    articleVersion: row.article_version ?? row.synced_version ?? 0,
    sourceSha256: row.source_sync_sha256 ?? row.baseline_sha256 ?? '',
    title: row.synced_title,
    markdown: row.synced_markdown,
    html: row.synced_html,
    media,
  }
}

/** Build the full editable snapshot for the chosen source projection. */
function sourceSnapshot(
  sourceProj: { title: string; markdown: string; html: string },
  post: PostMetaRow,
  now: number,
): ArticleCommandSnapshot {
  let tags: string[] | null = null
  try {
    tags = post.tags ? (JSON.parse(post.tags) as string[]) : null
  } catch {
    tags = null
  }
  return {
    slug: post.slug,
    title: sourceProj.title,
    content: sourceProj.markdown,
    html: sourceProj.html,
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
}

/** Materialise one chosen source ref into Blogman media (content-identity dedup). */
async function materialiseMedia(
  db: Database,
  sourceIdentityId: number,
  fact: MediaSyncFact,
  provider: SourceProvider,
  mediaStore: MediaStore,
  now: number,
): Promise<MediaSyncFact> {
  const bytes = await provider.readMediaBytes(fact.ref)
  const sha = sha256Hex(bytes.bytes)
  if (sha !== fact.contentSha256) {
    throw new Error(`media-changed:${fact.ref}`)
  }
  const existing = await db
    .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
    .bind(sha)
    .first<{ id: number; r2_key: string; content_sha256: string }>()
  const reused = existing !== null
  let asset = existing
  if (!asset) {
    const r2Key = buildR2Key(sha)
    await mediaStore.put({
      r2Key,
      bytes: bytes.bytes,
      contentType: bytes.contentType,
      filename: fact.ref.split('/').pop() ?? fact.ref,
    })
    try {
      await db
        .prepare(
          `INSERT INTO media_assets (content_sha256, r2_key, media_type, filename, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(sha, r2Key, bytes.contentType, fact.ref.split('/').pop() ?? fact.ref, bytes.bytes.byteLength, now)
        .run()
    } catch {
      // A concurrent identical write created the row — converge, don't fail.
    }
    asset = await db
      .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
      .bind(sha)
      .first<{ id: number; r2_key: string; content_sha256: string }>()
  }
  if (!asset) throw new Error(`media-asset-missing:${fact.ref}`)
  await db
    .prepare(
      `INSERT INTO source_media_mappings (source_identity_id, source_ref, media_asset_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_identity_id, source_ref)
       DO UPDATE SET media_asset_id = excluded.media_asset_id`,
    )
    .bind(sourceIdentityId, fact.ref, asset.id, now)
    .run()
  return { ...fact, r2Key: asset.r2_key, assetUrl: assetUrlFor(asset.r2_key), reused }
}

/** Advance the baseline — called ONLY after a full successful resolution. */
export async function advanceConflictBaseline(
  db: Database,
  row: {
    sourceIdentityId: number
    articleId: number
    articleVersion: number
    sourceSha256: string
    project: { title: string; markdown: string; html: string }
    media: MediaSyncFact[]
    revisionId: string | null
    now: number
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_sync_baselines
         (source_identity_id, article_id, article_version, source_sync_sha256, baseline_sha256,
          synced_version, synced_revision_id, synced_title, synced_markdown, synced_html,
          synced_media_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_identity_id, article_id) DO UPDATE SET
         article_version = excluded.article_version,
         source_sync_sha256 = excluded.source_sync_sha256,
         baseline_sha256 = excluded.baseline_sha256,
         synced_version = excluded.synced_version,
         synced_revision_id = excluded.synced_revision_id,
         synced_title = excluded.synced_title,
         synced_markdown = excluded.synced_markdown,
         synced_html = excluded.synced_html,
         synced_media_json = excluded.synced_media_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      row.sourceIdentityId,
      row.articleId,
      row.articleVersion,
      row.sourceSha256,
      row.sourceSha256,
      row.articleVersion,
      row.revisionId,
      row.project.title,
      row.project.markdown,
      row.project.html,
      JSON.stringify(row.media),
      row.now,
    )
    .run()
}

async function expireResolution(db: Database, operationId: string): Promise<void> {
  await db
    .prepare(`UPDATE source_conflict_resolutions SET status = 'expired' WHERE operation_id = ? AND status = 'open'`)
    .bind(operationId)
    .run()
}

async function markIntentStale(db: Database, operationId: string): Promise<WriteBackIntent | null> {
  await db.prepare(`UPDATE source_write_back_intents SET status = 'stale' WHERE operation_id = ?`).bind(operationId).run()
  return findIntent(db, operationId)
}

/* ------------------------------------------------------------------ */
/* resolveConflictSide — 作者显式选边                                    */
/* ------------------------------------------------------------------ */

export async function resolveConflictSide(
  db: Database,
  input: ResolveConflictInput,
): Promise<ResolveConflictResult> {
  const { sourceUrl, articleId, chosenSide, expectedVersion, operationId, actor, provider, mediaStore, writeProvider, now } = input
  if (!articleId || !operationId || operationId.trim() === '') {
    return { outcome: 'invalid', reason: 'resolveConflictSide: articleId and operationId are required' }
  }
  if (chosenSide !== 'source' && chosenSide !== 'blogman') {
    return { outcome: 'invalid', reason: `resolveConflictSide: invalid chosenSide '${String(chosenSide)}'` }
  }
  if (!actor || actor.trim() === '') {
    return { outcome: 'invalid', reason: 'resolveConflictSide: actor is required' }
  }
  if (!provider || !writeProvider) {
    return { outcome: 'invalid', reason: 'resolveConflictSide: provider and writeProvider are required' }
  }
  if (chosenSide === 'source' && !mediaStore) {
    return { outcome: 'invalid', reason: 'resolveConflictSide: mediaStore is required when choosing the source' }
  }
  const ts = now ?? unixNow()

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }

  const identityResult = await resolveSourceUrl(db, sourceUrl)
  if (identityResult.outcome !== 'resolved') {
    return { outcome: 'invalid', reason: `invalid-source: ${sourceUrl}` }
  }
  const identity = identityResult.identity
  const link = await liveLinkFor(db, identity.id, articleId)
  if (!link) {
    return { outcome: 'not-linked', reason: `source '${sourceUrl}' is not linked to article ${articleId}`, articleId, sourceUrl }
  }

  // Idempotent replay: same operation id → the original resolution facts.
  const existing = await findResolution(db, operationId)
  if (existing) {
    if (existing.status !== 'open') {
      return { outcome: 'replayed', resolution: existing, existing: true, articleId }
    }
    if (existing.chosenSide === 'blogman') {
      const intent = await findIntent(db, `${CONFLICT_WRITE_BACK_OP_PREFIX}${operationId}`)
      if (intent) return { outcome: 'replayed', resolution: existing, existing: true, articleId }
      // Recorded before the intent minted (crash window) — mint it now.
      return mintBlogmanIntent(db, articleId, existing, { identityId: identity.id, ts })
    }
    // An open SOURCE resolution: re-verify + continue the apply (idempotent by
    // the derived save operation id).
    return applySourceSide(db, articleId, existing, { identityId: identity.id, provider, mediaStore, ts })
  }

  const baselineRow = await findBaselineRow(db, identity.id, articleId)
  if (!baselineRow) {
    return { outcome: 'no-baseline', reason: `no confirmed baseline for article ${articleId}`, articleId, sourceIdentityId: identity.id }
  }
  const baseline = baselineFromRow(baselineRow)

  let source: SourceView
  try {
    source = await readSourceView(db, identity.id, provider, { sourceUrl })
  } catch (error) {
    return {
      outcome: 'unreadable',
      reason: `source-read-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
    }
  }
  const blogman = await readBlogmanView(db, articleId)
  if (!blogman) {
    return { outcome: 'not-found', reason: `article ${articleId} has no version snapshot`, articleId }
  }

  const sourceChanged = source.fingerprint !== baseline.sourceSha256
  const blogmanChanged =
    blogman.version > baseline.articleVersion ||
    (baseline.title !== null && (baseline.title !== blogman.title || (baseline.markdown ?? '') !== blogman.body))
  const state = deriveState(sourceChanged, blogmanChanged)
  if (state !== 'conflict') {
    return {
      outcome: 'not-conflict',
      articleId,
      state: state as Exclude<DerivedSyncState, 'conflict' | 'unknown'>,
      sourceChanged,
      blogmanChanged,
    }
  }
  if (expectedVersion !== blogman.version) {
    return { outcome: 'version-moved', articleId, expectedVersion, serverVersion: blogman.version }
  }
  // 选 Blogman pushes content OUT to the source — an ownership action that
  // requires the author-confirmed association (mirrors B6-03 initiate).
  if (chosenSide === 'blogman' && link.status !== 'confirmed') {
    return {
      outcome: 'link-not-confirmed',
      articleId,
      sourceIdentityId: identity.id,
      reason: 'blogman write-back requires a confirmed source link',
    }
  }

  // Capture the full Blogman editable state as the pre-resolution 恢复点.
  const latest = await findLatestVersion(db, articleId)
  const post = await findPostMeta(db, article.post_ref)
  if (!post) return { outcome: 'not-found', reason: `post ${article.post_ref} not found`, articleId }
  const versionContent = latest ? versionSnapshotContent(latest) : { title: '', content: '', html: '' }

  const recorded: ConflictResolution = {
    operationId,
    sourceIdentityId: identity.id,
    articleId,
    chosenSide,
    baselineVersion: baseline.articleVersion,
    baselineSha256: baseline.sourceSha256,
    anchoredSourceSha256: source.fingerprint,
    anchoredArticleVersion: blogman.version,
    sourceProjection: {
      title: source.title,
      markdown: source.markdown,
      html: await renderMarkdown(source.markdown),
    },
    sourceMedia: source.media,
    preResolutionSnapshotJson: JSON.stringify({
      title: blogman.title || versionContent.title || post.title,
      content: blogman.body || versionContent.content || '',
      html: versionContent.html || '',
      slug: post.slug,
      description: post.description,
      category: post.category,
      tags: post.tags,
      password: post.password,
      is_pinned: post.is_pinned,
      is_hidden: post.is_hidden,
      cover_image: post.cover_image,
      status: post.status,
      published_at: post.published_at,
      deleted_at: post.deleted_at,
    }),
    writeBackContent: null,
    status: 'open',
    createdAt: ts,
    appliedAt: null,
  }

  try {
    await db
      .prepare(
        `INSERT INTO source_conflict_resolutions
           (operation_id, source_identity_id, article_id, chosen_side, baseline_version,
            baseline_sha256, anchored_source_sha256, anchored_article_version,
            source_projection_json, source_media_json, pre_resolution_snapshot_json,
            write_back_content_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?)`,
      )
      .bind(
        operationId,
        identity.id,
        articleId,
        chosenSide,
        baseline.articleVersion,
        baseline.sourceSha256,
        source.fingerprint,
        blogman.version,
        JSON.stringify(recorded.sourceProjection),
        JSON.stringify(source.media),
        recorded.preResolutionSnapshotJson,
        ts,
      )
      .run()
  } catch {
    const raced = await findResolution(db, operationId)
    if (raced) return { outcome: 'replayed', resolution: raced, existing: true, articleId }
    throw new Error(`resolveConflictSide: unexpected insert failure for operation '${operationId}'`)
  }

  if (chosenSide === 'source') {
    return applySourceSide(db, articleId, recorded, { identityId: identity.id, provider, mediaStore, ts })
  }
  return mintBlogmanIntent(db, articleId, recorded, { identityId: identity.id, ts })
}

/* ------------------------------------------------------------------ */
/* 选源稿 — 先建恢复点, 再走版本内核                                     */
/* ------------------------------------------------------------------ */

async function applySourceSide(
  db: Database,
  articleId: number,
  resolution: ConflictResolution,
  ctx: { identityId: number; provider: SourceProvider; mediaStore: MediaStore; ts: number },
): Promise<ResolveConflictResult> {
  const { provider, mediaStore, ts } = ctx
  const canonicalUrl = await canonicalUrlFor(db, ctx.identityId)
  if (!canonicalUrl) {
    await expireResolution(db, resolution.operationId)
    return { outcome: 'refused', resolution: { ...resolution, status: 'expired' }, reason: 'no-canonical-url' }
  }

  // Re-verify currency: the source must still equal what the choice saw.
  let fresh: SourceView
  try {
    fresh = await readSourceView(db, ctx.identityId, provider, { sourceUrl: canonicalUrl })
  } catch {
    await expireResolution(db, resolution.operationId)
    return { outcome: 'unreadable', reason: 'source-read-failed', articleId, sourceUrl: canonicalUrl }
  }
  if (fresh.fingerprint !== resolution.anchoredSourceSha256) {
    await expireResolution(db, resolution.operationId)
    return { outcome: 'stale-choice', resolution: { ...resolution, status: 'expired' }, reason: 'source-changed' }
  }

  // Re-verify the article version before any write (旧写入不能覆盖新内容).
  const latest = await findLatestVersion(db, articleId)
  if (!latest || latest.version !== resolution.anchoredArticleVersion) {
    await expireResolution(db, resolution.operationId)
    return {
      outcome: 'version-moved',
      articleId,
      expectedVersion: resolution.anchoredArticleVersion,
      serverVersion: latest?.version ?? 0,
    }
  }

  // 先建恢复点: canonical pre-promotion snapshot for formal articles (drafts
  // keep the captured pre-resolution snapshot + the versioned history).
  let restorePointId: string | null = null
  try {
    const rp = await saveRestorePoint(db, {
      articleId,
      actor: 'conflict-resolution',
      reason: `conflict-pick-source:${resolution.operationId}`,
    })
    if (rp.outcome === 'saved') restorePointId = rp.restorePointId
  } catch {
    restorePointId = null
  }

  // Materialise the chosen source media (content-identity dedup; all-or-nothing).
  const completed: MediaSyncFact[] = []
  try {
    for (const fact of fresh.media) {
      completed.push(await materialiseMedia(db, ctx.identityId, fact, provider, mediaStore, ts))
    }
  } catch (error) {
    return {
      outcome: 'media-failed',
      resolution: { ...resolution, status: 'open' },
      articleId,
      reason: `media-failed: ${error instanceof Error ? error.message : String(error)}`,
      completed,
    }
  }

  // Commit through the versioned write kernel (draft→new version; formal→revision).
  const post = (await findPostMeta(db, (await findArticle(db, articleId))?.post_ref ?? 0)) ?? null
  if (!post) {
    await expireResolution(db, resolution.operationId)
    return { outcome: 'not-found', reason: `post for article ${articleId} not found`, articleId }
  }
  const saveResult = await save(db, {
    articleId,
    expectedVersion: resolution.anchoredArticleVersion,
    operationId: `${CONFLICT_SAVE_OP_PREFIX}${resolution.operationId}`,
    snapshot: sourceSnapshot(resolution.sourceProjection, post, ts),
  })
  if (saveResult.outcome === 'conflict') {
    await expireResolution(db, resolution.operationId)
    return {
      outcome: 'save-conflict',
      resolution: { ...resolution, status: 'expired' },
      articleId,
      expectedVersion: resolution.anchoredArticleVersion,
      serverVersion: saveResult.serverVersion,
    }
  }
  if (saveResult.outcome !== 'applied' && saveResult.outcome !== 'replayed') {
    await expireResolution(db, resolution.operationId)
    return {
      outcome: 'save-conflict',
      resolution: { ...resolution, status: 'expired' },
      articleId,
      expectedVersion: resolution.anchoredArticleVersion,
      serverVersion: resolution.anchoredArticleVersion,
    }
  }

  const revisionId = (saveResult as { revisionId?: string }).revisionId ?? null
  await advanceConflictBaseline(db, {
    sourceIdentityId: ctx.identityId,
    articleId,
    articleVersion: saveResult.version,
    sourceSha256: fresh.fingerprint,
    project: {
      title: resolution.sourceProjection.title,
      markdown: resolution.sourceProjection.markdown,
      html: resolution.sourceProjection.html,
    },
    media: completed,
    revisionId,
    now: ts,
  })

  await db
    .prepare(`UPDATE source_conflict_resolutions SET status = 'applied', applied_at = ? WHERE operation_id = ?`)
    .bind(ts, resolution.operationId)
    .run()
  const applied = (await findResolution(db, resolution.operationId)) ?? { ...resolution, status: 'applied' as const, appliedAt: ts }

  return {
    outcome: 'resolved-source',
    resolution: applied,
    articleId,
    version: saveResult.version,
    revisionId,
    restorePointId,
    baselineSha256: fresh.fingerprint,
    media: completed,
  }
}

/* ------------------------------------------------------------------ */
/* 选 Blogman — 走 B6-03 显式写回确认 (确认前不推进基线)                */
/* ------------------------------------------------------------------ */

async function mintBlogmanIntent(
  db: Database,
  articleId: number,
  resolution: ConflictResolution,
  ctx: { identityId: number; ts: number },
): Promise<ResolveConflictResult> {
  const intentOp = `${CONFLICT_WRITE_BACK_OP_PREFIX}${resolution.operationId}`
  const existing = await findIntent(db, intentOp)
  if (existing) return { outcome: 'replayed', resolution, existing: true, articleId }
  try {
    await db
      .prepare(
        `INSERT INTO source_write_back_intents
           (source_identity_id, article_id, article_version, baseline_version,
            operation_id, status, intent_at)
         VALUES (?, ?, ?, ?, ?, 'intent', ?)`,
      )
      .bind(ctx.identityId, articleId, resolution.anchoredArticleVersion, resolution.baselineVersion, intentOp, resolution.createdAt)
      .run()
  } catch {
    const raced = await findIntent(db, intentOp)
    if (raced) return { outcome: 'replayed', resolution, existing: true, articleId }
    throw new Error(`resolveConflictSide: unexpected intent insert failure for operation '${CONFLICT_WRITE_BACK_OP_PREFIX}${resolution.operationId}'`)
  }
  const intent = (await findIntent(db, intentOp)) ?? {
    id: 0,
    sourceIdentityId: ctx.identityId,
    articleId,
    articleVersion: resolution.anchoredArticleVersion,
    baselineVersion: resolution.baselineVersion,
    operationId: intentOp,
    status: 'intent',
    externalRef: null,
    sourceSyncSha256: null,
    intentAt: resolution.createdAt,
    writtenAt: null,
    confirmedAt: null,
  }
  return { outcome: 'intent', resolution, intent, articleId }
}

/** Push the chosen Blogman content to the source (awaits external confirmation). */
export async function executeConflictWriteBack(
  db: Database,
  providers: { read: SourceProvider; write: SourceWriteProvider },
  input: ExecuteConflictWriteBackInput,
): Promise<ExecuteConflictWriteBackResult> {
  const { operationId } = input
  if (!operationId || operationId.trim() === '') throw new Error('executeConflictWriteBack: operationId is required')

  const resolution = await findResolution(db, operationId)
  if (!resolution) return { outcome: 'not-found' }
  if (resolution.chosenSide !== 'blogman') return { outcome: 'refused', resolution, reason: 'resolution-chose-source' }
  if (resolution.status === 'applied') return { outcome: 'refused', resolution, reason: 'already-applied' }
  if (resolution.status === 'expired') return { outcome: 'stale', resolution, reason: 'source-changed' }

  const intentOp = `${CONFLICT_WRITE_BACK_OP_PREFIX}${operationId}`
  const intent = await findIntent(db, intentOp)
  if (!intent) return { outcome: 'not-found' }
  if (intent.status === 'written') return { outcome: 'replayed', resolution, intent, existing: true }
  if (intent.status === 'confirmed') return { outcome: 'replayed', resolution, intent, existing: true }
  if (intent.status === 'stale') return { outcome: 'stale', resolution, reason: 'source-changed' }

  // 版本变化 → 选择过期 (任一方变化使旧选择过期). The Blogman side's current
  // version token (revision number for a formal article) must equal the choice's.
  const blogmanNow = await readBlogmanView(db, resolution.articleId)
  if (!blogmanNow || blogmanNow.version !== resolution.anchoredArticleVersion) {
    await expireResolution(db, operationId)
    await markIntentStale(db, intentOp)
    return { outcome: 'stale', resolution: { ...resolution, status: 'expired' }, reason: 'version-changed' }
  }

  // 源稿变化 → 选择过期 (the author would overwrite content they never saw).
  const canonicalUrl = await canonicalUrlFor(db, resolution.sourceIdentityId)
  if (!canonicalUrl) return { outcome: 'refused', resolution, reason: 'no-canonical-url' }
  let fresh: SourceView
  try {
    fresh = await readSourceView(db, resolution.sourceIdentityId, providers.read, { sourceUrl: canonicalUrl })
  } catch {
    return { outcome: 'provider-error', resolution, intent }
  }
  if (fresh.fingerprint !== resolution.anchoredSourceSha256) {
    await expireResolution(db, operationId)
    await markIntentStale(db, intentOp)
    return { outcome: 'stale', resolution: { ...resolution, status: 'expired' }, reason: 'source-changed' }
  }

  const html = await renderMarkdown(blogmanNow.body)
  let push: { externalRef: string; sourceSyncSha256: string }
  try {
    push = await providers.write.pushWriteBack(canonicalUrl, { title: blogmanNow.title, body: blogmanNow.body })
  } catch {
    // 设备不可用 → push 未发生; intent 保持 intent, 可重试.
    return { outcome: 'provider-error', resolution, intent }
  }

  await db
    .prepare(
      `UPDATE source_write_back_intents
         SET status = 'written', written_at = ?, external_ref = ?, source_sync_sha256 = ?
       WHERE id = ? AND status = 'intent'`,
    )
    .bind(unixNow(), push.externalRef, push.sourceSyncSha256, intent.id)
    .run()
  await db
    .prepare(
      `UPDATE source_conflict_resolutions SET write_back_content_json = ? WHERE operation_id = ?`,
    )
    .bind(JSON.stringify({ title: blogmanNow.title, body: blogmanNow.body, html }), operationId)
    .run()

  const updatedIntent = (await findIntent(db, intentOp)) ?? intent
  const updatedResolution = (await findResolution(db, operationId)) ?? resolution
  return { outcome: 'written', resolution: updatedResolution, intent: updatedIntent }
}

/** The EXTERNAL confirmation — the ONLY step that advances the baseline. */
export async function confirmConflictWriteBack(
  db: Database,
  providers: { read: SourceProvider; write: SourceWriteProvider },
  input: ConfirmConflictWriteBackInput,
): Promise<ConfirmConflictWriteBackResult> {
  const { operationId } = input
  if (!operationId || operationId.trim() === '') throw new Error('confirmConflictWriteBack: operationId is required')

  const resolution = await findResolution(db, operationId)
  if (!resolution) return { outcome: 'not-found' }
  if (resolution.chosenSide !== 'blogman') return { outcome: 'refused', resolution, reason: 'resolution-chose-source' }

  const intentOp = `${CONFLICT_WRITE_BACK_OP_PREFIX}${operationId}`
  const intent = await findIntent(db, intentOp)
  if (intent?.status === 'confirmed' || resolution.status === 'applied') {
    const confirmedIntent = intent ?? (await findIntent(db, intentOp))
    if (!confirmedIntent) return { outcome: 'not-found' }
    return { outcome: 'replayed', resolution, intent: confirmedIntent, existing: true }
  }
  if (resolution.status === 'expired') return { outcome: 'stale', resolution, reason: 'version-changed' }
  if (!intent) return { outcome: 'not-found' }
  if (intent.status === 'stale') return { outcome: 'stale', resolution, reason: 'version-changed' }
  if (intent.status !== 'written') return { outcome: 'refused', resolution, reason: 'intent-not-written' }
  if (!intent.sourceSyncSha256) return { outcome: 'refused', resolution, reason: 'intent-has-no-source-hash' }

  // 版本变化 → 迟到确认被拒绝.
  const blogmanNow = await readBlogmanView(db, resolution.articleId)
  if (!blogmanNow || blogmanNow.version !== resolution.anchoredArticleVersion) {
    await expireResolution(db, operationId)
    await markIntentStale(db, intentOp)
    return { outcome: 'stale', resolution: { ...resolution, status: 'expired' }, reason: 'version-changed' }
  }

  // 源稿在推送后又变化 → 拒绝确认 (the pushed state is no longer current).
  const canonicalUrl = await canonicalUrlFor(db, resolution.sourceIdentityId)
  if (!canonicalUrl) return { outcome: 'refused', resolution, reason: 'no-canonical-url' }
  try {
    const currentHash = await providers.write.readSourceHash(canonicalUrl)
    if (currentHash !== intent.sourceSyncSha256) {
      await expireResolution(db, operationId)
      await markIntentStale(db, intentOp)
      return { outcome: 'stale', resolution: { ...resolution, status: 'expired' }, reason: 'source-changed' }
    }
  } catch {
    return { outcome: 'refused', resolution, reason: 'source-unreadable' }
  }

  const wb = resolution.writeBackContent ?? { title: '', body: '', html: '' }
  const ts = unixNow()
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO source_sync_baselines
             (source_identity_id, article_id, article_version, source_sync_sha256, baseline_sha256,
              synced_version, synced_revision_id, synced_title, synced_markdown, synced_html,
              synced_media_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '[]', ?)
           ON CONFLICT(source_identity_id, article_id) DO UPDATE SET
             article_version = excluded.article_version,
             source_sync_sha256 = excluded.source_sync_sha256,
             baseline_sha256 = excluded.baseline_sha256,
             synced_version = excluded.synced_version,
             synced_revision_id = NULL,
             synced_title = excluded.synced_title,
             synced_markdown = excluded.synced_markdown,
             synced_html = excluded.synced_html,
             synced_media_json = excluded.synced_media_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          resolution.sourceIdentityId,
          resolution.articleId,
          intent.articleVersion,
          intent.sourceSyncSha256,
          intent.sourceSyncSha256,
          intent.articleVersion,
          wb.title,
          wb.body,
          wb.html,
          ts,
        ),
      db
        .prepare(
          `UPDATE source_write_back_intents SET status = 'confirmed', confirmed_at = ?
           WHERE id = ? AND status = 'written'`,
        )
        .bind(ts, intent.id),
      db
        .prepare(`UPDATE source_conflict_resolutions SET status = 'applied', applied_at = ? WHERE operation_id = ?`)
        .bind(ts, operationId),
    ])
  } catch {
    const freshRes = await findResolution(db, operationId)
    if (freshRes?.status === 'applied') return { outcome: 'replayed', resolution: freshRes, intent, existing: true }
    if (freshRes?.status === 'expired') return { outcome: 'stale', resolution: freshRes, reason: 'version-changed' }
    throw new Error(`confirmConflictWriteBack: unexpected failure confirming operation '${operationId}'`)
  }

  const updatedResolution = (await findResolution(db, operationId)) ?? { ...resolution, status: 'applied' as const }
  const updatedIntent = (await findIntent(db, intentOp)) ?? intent
  return { outcome: 'confirmed', resolution: updatedResolution, intent: updatedIntent }
}

/* ------------------------------------------------------------------ */
/* query surface                                                       */
/* ------------------------------------------------------------------ */

/** Read a resolution by operation id (响应丢失可 query 同一操作). */
export async function conflictResolutionByOperation(
  db: Database,
  operationId: string,
): Promise<ConflictResolution | null> {
  return findResolution(db, operationId)
}

/** Re-derive the current state (read-only) — the client polls before acting. */
export async function currentConflictState(
  db: Database,
  provider: SourceProvider,
  input: { sourceUrl: string; articleId: number },
): Promise<ProbeConflictResult> {
  return probeConflict(db, provider, input)
}