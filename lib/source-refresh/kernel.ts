/**
 * B7-02 — 比较后显式刷新来源网页 command kernel (issue #58).
 *
 * A compare-then-confirm refresh loop for a CLIP (reference) source page:
 *
 *   `proposeRefresh` — fetch the source through the injected provider (mock in
 *   tests, 零生产), reconcile referenced media by PATH-AGNOSTIC content
 *   identity, build the 标题/正文/媒体 diff against the CURRENT article and
 *   FREEZE it into a durable proposal BOUND to the article's current version.
 *   It NEVER writes the article.
 *
 *   `confirmRefresh`   — ONLY after explicit author confirmation does the apply
 *   path commit through the versioned write kernel (`article-commands.save`)
 *   with the proposal's bound version as the expected version + a confirm
 *   operation id (幂等). A DRAFT writes a NEW version (草稿形成新版本); a FORMAL
 *   article routes to its UNIQUE active revision (正式文章只形成修订, 线上版本保
 *   持). Choice of 正式/草稿 is exactly the #34 revision routing that every other
 *   versioned writer already uses.
 *
 * Hard guarantees:
 *
 *   - 版本变化要求重新比较: `proposeRefresh` freezes `proposed_version`;
 *     `confirmRefresh` refuses (stale) unless the caller's expected version AND
 *     the article's CURRENT version both still equal that bound version. Moving
 *     the article between propose and confirm forces a re-propose.
 *   - 媒体失败不得标完成: any provider/media failure in propose OR confirm
 *     returns non-complete, writes no article version and advances no record.
 *   - 来源网页永不取得持续写作权威: the proposal & record role is ALWAYS `clip`;
 *     a refresh never creates/confirms a `primary` link and never touches the
 *     B6 primary-source `source_sync_baselines` / write chain.
 *   - 刷新记录与来源快照持久化: `source_refresh_proposals` persists the frozen
 *     snapshot + diff + bound version; `source_refresh_records` persists each
 *     completed confirm (operation_id UNIQUE → idempotent replay).
 *   - 媒体按内容身份复用: media is deduped by `media_assets.content_sha256` and
 *     never guessed from a filename (不凭文件名推断).
 */

import type { Database } from '@/lib/repositories/schema'
import type { ArticleCommandSnapshot } from '@/lib/article-commands'
import { save } from '@/lib/article-commands'
import { resolveSourceUrl } from '@/lib/source-identity'
import {
  assetUrlFor,
  buildR2Key,
  normalizeTitle,
  renderMarkdown,
  rewriteMarkdownRefs,
  sha256Hex,
  type MediaStore,
  type SourceProvider,
} from '@/lib/source-sync'
import type {
  ConfirmRefreshInput,
  ConfirmRefreshResult,
  ProposeRefreshInput,
  ProposeRefreshResult,
  RefreshDiff,
  RefreshFacts,
  RefreshMediaDiff,
  SourceRefreshProjection,
} from './types'

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------------ */
/* row readers                                                         */
/* ------------------------------------------------------------------ */

interface ArticleRow {
  id: number
  post_ref: number
}

interface ProposalRow {
  operation_id: string
  source_identity_id: number
  article_id: number
  post_ref: number | null
  proposed_version: number
  status: string
  source_title: string
  source_markdown: string
  source_html: string
  snapshot_sha256: string
  diff_json: string
  media_json: string
}

interface RecordRow {
  operation_id: string
  proposal_operation_id: string
  source_identity_id: number
  article_id: number
  post_ref: number | null
  outcome: string
  reason: string | null
  expected_version: number
  applied_version: number | null
  applied_revision_id: string | null
  baseline_sha256: string | null
  projection_json: string | null
  media_json: string | null
  diff_json: string | null
}

interface PostRow {
  slug: string
  title: string
  content: string
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

interface LiveLinkRow {
  id: number
  status: string
  role: string
}

async function findArticle(db: Database, articleId: number): Promise<ArticleRow | null> {
  return db.prepare('SELECT id, post_ref FROM articles WHERE id = ?').bind(articleId).first<ArticleRow>()
}

async function currentVersion(db: Database, articleId: number): Promise<number> {
  return (
    (await db
      .prepare('SELECT MAX(version) AS v FROM article_versions WHERE article_id = ?')
      .bind(articleId)
      .first<{ v: number }>())?.v ?? 0
  )
}

async function liveClipLink(
  db: Database,
  sourceIdentityId: number,
  articleId: number,
): Promise<LiveLinkRow | null> {
  return db
    .prepare(
      `SELECT id, status, role FROM article_source_links
       WHERE source_identity_id = ? AND article_id = ? AND status != 'cancelled'
       ORDER BY id ASC LIMIT 1`,
    )
    .bind(sourceIdentityId, articleId)
    .first<LiveLinkRow>()
}

async function findPost(db: Database, postRef: number): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT slug, title, content, category, tags, description, password, is_pinned,
              is_hidden, cover_image, status, published_at, deleted_at
       FROM posts WHERE id = ?`,
    )
    .bind(postRef)
    .first<PostRow>()
}

async function findProposal(db: Database, operationId: string): Promise<ProposalRow | null> {
  return db
    .prepare(
      `SELECT operation_id, source_identity_id, article_id, post_ref, proposed_version,
              status, source_title, source_markdown, source_html, snapshot_sha256,
              diff_json, media_json
       FROM source_refresh_proposals WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<ProposalRow>()
}

async function findRefreshRecord(db: Database, operationId: string): Promise<RecordRow | null> {
  return db
    .prepare(
      `SELECT operation_id, proposal_operation_id, source_identity_id, article_id, post_ref,
              outcome, reason, expected_version, applied_version, applied_revision_id,
              baseline_sha256, projection_json, media_json, diff_json
       FROM source_refresh_records WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<RecordRow>()
}

/* ------------------------------------------------------------------ */
/* media reconciliation (content-identity dedup + mapping) + diff      */
/* ------------------------------------------------------------------ */

/** Rethrown on a partial media failure so already-reconciled facts aren't lost. */
class RefreshMediaError extends Error {
  readonly completed: RefreshMediaDiff[]
  constructor(message: string, completed: RefreshMediaDiff[] = []) {
    super(message)
    this.completed = completed
  }
}

interface PrevMapping {
  source_ref: string
  content_sha256: string
  r2_key: string
  media_type: string
  filename: string | null
}

async function previousMappings(db: Database, sourceIdentityId: number): Promise<Map<string, PrevMapping>> {
  const rows = await db
    .prepare(
      `SELECT sm.source_ref, ma.content_sha256, ma.r2_key, ma.media_type, ma.filename
       FROM source_media_mappings sm
       JOIN media_assets ma ON ma.id = sm.media_asset_id
       WHERE sm.source_identity_id = ?`,
    )
    .bind(sourceIdentityId)
    .all<PrevMapping>()
  return new Map((rows.results ?? []).map((r) => [r.source_ref, r]))
}

interface ReconcileOutcome {
  /** Present-media facts (added / changed / unchanged), each flagged `reused`. */
  facts: RefreshMediaDiff[]
  refToUrl: Record<string, string>
}

async function reconcileMedia(
  db: Database,
  sourceIdentityId: number,
  content: { media: Array<{ ref: string; contentType: string; filename: string }> },
  provider: SourceProvider,
  mediaStore: MediaStore,
  now: number,
): Promise<ReconcileOutcome> {
  const facts: RefreshMediaDiff[] = []
  const refToUrl: Record<string, string> = {}
  const prev = await previousMappings(db, sourceIdentityId)
  const present = new Set<string>()

  for (const ref of content.media) {
    present.add(ref.ref)
    let bytesResult
    try {
      bytesResult = await provider.readMediaBytes(ref.ref)
    } catch (error) {
      throw new RefreshMediaError(
        `media-read-failed:${ref.ref}: ${error instanceof Error ? error.message : String(error)}`,
        facts,
      )
    }
    const sha = sha256Hex(bytesResult.bytes)
    const existing = await db
      .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
      .bind(sha)
      .first<{ id: number; r2_key: string; content_sha256: string }>()
    let asset = existing
    const reusedAsset = existing !== null
    if (!asset) {
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
        // Concurrent identical write converged — reuse the row.
      }
      asset = await db
        .prepare('SELECT id, r2_key, content_sha256 FROM media_assets WHERE content_sha256 = ?')
        .bind(sha)
        .first<{ id: number; r2_key: string; content_sha256: string }>()
    }
    if (!asset) {
      throw new RefreshMediaError(`media-asset-missing:${ref.ref}`, facts)
    }

    await db
      .prepare(
        `INSERT INTO source_media_mappings (source_identity_id, source_ref, media_asset_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_identity_id, source_ref)
         DO UPDATE SET media_asset_id = excluded.media_asset_id`,
      )
      .bind(sourceIdentityId, ref.ref, asset.id, now)
      .run()

    const previous = prev.get(ref.ref)
    const status = !previous ? 'added' : previous.content_sha256 === sha ? 'unchanged' : 'changed'
    facts.push({
      ref: ref.ref,
      contentType: bytesResult.contentType,
      filename: ref.filename,
      contentSha256: sha,
      assetUrl: assetUrlFor(asset.r2_key),
      reused: reusedAsset,
      status,
    })
    refToUrl[ref.ref] = assetUrlFor(asset.r2_key)
  }

  // Removed media: previously-mapped source refs no longer referenced.
  for (const [refToken, mapping] of prev) {
    if (present.has(refToken)) continue
    facts.push({
      ref: refToken,
      contentType: mapping.media_type,
      filename: mapping.filename ?? '',
      contentSha256: mapping.content_sha256,
      assetUrl: assetUrlFor(mapping.r2_key),
      reused: true,
      status: 'removed',
    })
  }

  return { facts, refToUrl }
}

/** Fingerprint of the frozen source snapshot — normalized title + rewritten markdown + present media content hashes. */
export function snapshotFingerprint(
  title: string,
  markdown: string,
  presentMedia: RefreshMediaDiff[],
): string {
  const sorted = [...presentMedia]
    .filter((m) => m.status !== 'removed')
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((m) => ({ ref: m.ref, contentSha256: m.contentSha256 }))
  return sha256Hex(JSON.stringify({ title, markdown, media: sorted }))
}

function buildDiff(
  currentTitle: string,
  currentContent: string,
  sourceTitle: string,
  sourceMarkdown: string,
  media: RefreshMediaDiff[],
): RefreshDiff {
  const titleChanged = sourceTitle !== currentTitle
  const bodyChanged = sourceMarkdown !== currentContent
  const mediaChanged = media.some((m) => m.status !== 'unchanged')
  return {
    titleChanged,
    currentTitle,
    sourceTitle,
    bodyChanged,
    currentContent,
    sourceMarkdown,
    mediaChanged,
    media,
    changed: titleChanged || bodyChanged || mediaChanged,
    sourceSnapshotSha256: snapshotFingerprint(sourceTitle, sourceMarkdown, media),
  }
}

/* ------------------------------------------------------------------ */
/* proposal / record persistence                                       */
/* ------------------------------------------------------------------ */

async function persistProposal(
  db: Database,
  row: ProposalRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_refresh_proposals
         (operation_id, source_identity_id, article_id, post_ref, role, proposed_version,
          status, source_title, source_markdown, source_html, snapshot_sha256,
          diff_json, media_json, created_at)
       VALUES (?, ?, ?, ?, 'clip', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id)
       DO UPDATE SET status = excluded.status,
         source_title = excluded.source_title,
         source_markdown = excluded.source_markdown,
         source_html = excluded.source_html,
         snapshot_sha256 = excluded.snapshot_sha256,
         diff_json = excluded.diff_json,
         media_json = excluded.media_json`,
    )
    .bind(
      row.operation_id,
      row.source_identity_id,
      row.article_id,
      row.post_ref,
      row.proposed_version,
      row.status,
      row.source_title,
      row.source_markdown,
      row.source_html,
      row.snapshot_sha256,
      row.diff_json,
      row.media_json,
      unixNow(),
    )
    .run()
}

async function setProposalStatus(db: Database, operationId: string, status: string): Promise<void> {
  await db
    .prepare(`UPDATE source_refresh_proposals SET status = ? WHERE operation_id = ?`)
    .bind(status, operationId)
    .run()
}

async function persistRefreshRecord(db: Database, row: RecordRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_refresh_records
         (operation_id, proposal_operation_id, source_identity_id, article_id, post_ref, role,
          outcome, reason, expected_version, applied_version, applied_revision_id,
          baseline_sha256, projection_json, media_json, diff_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'clip', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
    )
    .bind(
      row.operation_id,
      row.proposal_operation_id,
      row.source_identity_id,
      row.article_id,
      row.post_ref,
      row.outcome,
      row.reason,
      row.expected_version,
      row.applied_version,
      row.applied_revision_id,
      row.baseline_sha256,
      row.projection_json,
      row.media_json,
      row.diff_json,
      unixNow(),
    )
    .run()
}

/* ------------------------------------------------------------------ */
/* result reconstruction                                               */
/* ------------------------------------------------------------------ */

function mediaFromJson(json: string | null): RefreshMediaDiff[] {
  try {
    return (JSON.parse(json ?? '[]') as RefreshMediaDiff[]) ?? []
  } catch {
    return []
  }
}

function diffFromJson(json: string | null): RefreshDiff | null {
  try {
    return JSON.parse(json ?? 'null') as RefreshDiff
  } catch {
    return null
  }
}

function projectionFromProposal(p: ProposalRow): SourceRefreshProjection {
  return {
    title: p.source_title,
    markdown: p.source_markdown,
    html: p.source_html,
    snapshotSha256: p.snapshot_sha256,
  }
}

/* ------------------------------------------------------------------ */
/* proposeRefresh — 提出 (freeze diff + snapshot, NO article write)    */
/* ------------------------------------------------------------------ */

export async function proposeRefresh(
  db: Database,
  input: ProposeRefreshInput,
): Promise<ProposeRefreshResult> {
  const { sourceUrl, articleId, operationId, provider, mediaStore } = input
  if (!operationId || operationId.trim() === '' || !sourceUrl || !articleId) {
    return { outcome: 'invalid', reason: 'sourceUrl, articleId and operationId are required' }
  }
  if (!provider || !mediaStore) {
    return { outcome: 'invalid', reason: 'provider and mediaStore are required' }
  }

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }
  const now = unixNow()

  const identityResult = await resolveSourceUrl(db, sourceUrl)
  if (identityResult.outcome !== 'resolved') {
    return { outcome: 'invalid', reason: `invalid-source: ${sourceUrl}` }
  }
  const identity = identityResult.identity

  // The source must be a live CLIP (reference) link to this article.
  const link = await liveClipLink(db, identity.id, articleId)
  if (!link || link.role !== 'clip') {
    return {
      outcome: 'not-linked',
      reason: `source '${sourceUrl}' has no live clip link to article ${articleId}`,
      articleId,
      sourceUrl,
    }
  }

  // Idempotent replay by propose operation id.
  const prior = await findProposal(db, operationId)
  if (prior && (prior.status === 'proposed' || prior.status === 'no-diff')) {
    return replayPropose(db, articleId, prior)
  }

  const proposedVersion = await currentVersion(db, articleId)

  // Read the source snapshot (provider mock in tests — 零生产).
  let content
  try {
    content = await provider.readSource({ sourceUrl })
  } catch (error) {
    return {
      outcome: 'media-failed',
      reason: `provider-read-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
      operationId,
      completed: [],
    }
  }

  // Reconcile referenced media (content-identity dedup + mapping + diff status).
  let facts: RefreshMediaDiff[]
  let refToUrl: Record<string, string>
  try {
    ;({ facts, refToUrl } = await reconcileMedia(db, identity.id, content, provider, mediaStore, now))
  } catch (error) {
    const completed = error instanceof RefreshMediaError ? error.completed : []
    return {
      outcome: 'media-failed',
      reason: `media-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
      operationId,
      completed,
    }
  }

  // Build the frozen projection + diff against the CURRENT article.
  const title = normalizeTitle(content.title)
  const markdown = rewriteMarkdownRefs(content.markdown, refToUrl)
  const projection: SourceRefreshProjection = {
    title,
    markdown,
    html: await renderMarkdown(markdown),
    snapshotSha256: '',
  }
  projection.snapshotSha256 = snapshotFingerprint(title, markdown, facts)

  const post = await findPost(db, article.post_ref)
  if (!post) return { outcome: 'not-found', reason: `post ${article.post_ref} not found`, articleId }
  const diff = buildDiff(post.title, post.content ?? '', title, markdown, facts)

  const status = diff.changed ? 'proposed' : 'no-diff'
  await persistProposal(db, {
    operation_id: operationId,
    source_identity_id: identity.id,
    article_id: articleId,
    post_ref: article.post_ref,
    proposed_version: proposedVersion,
    status,
    source_title: title,
    source_markdown: markdown,
    source_html: projection.html,
    snapshot_sha256: projection.snapshotSha256,
    diff_json: JSON.stringify(diff),
    media_json: JSON.stringify(facts),
  })

  if (status === 'no-diff') {
    return {
      outcome: 'no-diff',
      existing: false,
      articleId,
      postRef: article.post_ref,
      proposalOperationId: operationId,
      proposedVersion,
      diff,
      projection,
      media: facts,
    }
  }
  return {
    outcome: 'proposed',
    existing: false,
    articleId,
    postRef: article.post_ref,
    proposalOperationId: operationId,
    proposedVersion,
    diff,
    projection,
    media: facts,
  }
}

function replayPropose(
  _db: Database,
  articleId: number,
  prior: ProposalRow,
): ProposeRefreshResult {
  const diff = diffFromJson(prior.diff_json) ?? null
  const media = mediaFromJson(prior.media_json)
  const projection = projectionFromProposal(prior)
  const base = {
    articleId,
    postRef: prior.post_ref ?? articleId,
    proposalOperationId: prior.operation_id,
    proposedVersion: prior.proposed_version,
    diff: diff ?? {
      titleChanged: false, currentTitle: '', sourceTitle: prior.source_title, bodyChanged: false,
      currentContent: '', sourceMarkdown: prior.source_markdown, mediaChanged: false,
      media, changed: false, sourceSnapshotSha256: prior.snapshot_sha256,
    },
    projection,
    media,
  }
  if (prior.status === 'no-diff') {
    return { outcome: 'no-diff' as const, existing: true, ...base }
  }
  return { outcome: 'replayed' as const, existing: true, ...base }
}

/* ------------------------------------------------------------------ */
/* confirmRefresh — 确认 (apply through the versioned write kernel)    */
/* ------------------------------------------------------------------ */

export async function confirmRefresh(
  db: Database,
  input: ConfirmRefreshInput,
): Promise<ConfirmRefreshResult> {
  const { sourceUrl, articleId, proposalOperationId, expectedVersion, operationId, provider, mediaStore } = input
  if (!operationId || operationId.trim() === '' || !sourceUrl || !articleId || !proposalOperationId) {
    return { outcome: 'invalid', reason: 'sourceUrl, articleId, proposalOperationId and operationId are required' }
  }
  if (!provider || !mediaStore) {
    return { outcome: 'invalid', reason: 'provider and mediaStore are required' }
  }

  const article = await findArticle(db, articleId)
  if (!article) return { outcome: 'not-found', reason: `article ${articleId} not found`, articleId }

  const identityResult = await resolveSourceUrl(db, sourceUrl)
  if (identityResult.outcome !== 'resolved') {
    return { outcome: 'invalid', reason: `invalid-source: ${sourceUrl}` }
  }
  const identity = identityResult.identity

  const link = await liveClipLink(db, identity.id, articleId)
  if (!link || link.role !== 'clip') {
    return {
      outcome: 'not-linked',
      reason: `source '${sourceUrl}' has no live clip link to article ${articleId}`,
      articleId,
      sourceUrl,
    }
  }

  // Idempotent replay by confirm operation id.
  const priorRecord = await findRefreshRecord(db, operationId)
  if (priorRecord) return replayConfirm(db, articleId, article.post_ref, priorRecord)

  const proposal = await findProposal(db, proposalOperationId)
  if (!proposal || proposal.article_id !== articleId || proposal.source_identity_id !== identity.id) {
    return {
      outcome: 'proposal-missing',
      reason: `proposal '${proposalOperationId}' not found for article ${articleId}`,
      articleId,
      proposalOperationId,
    }
  }
  if (proposal.status === 'no-diff') {
    return { outcome: 'no-diff', reason: 'proposal has no diff — nothing to refresh', articleId, proposalOperationId }
  }
  if (proposal.status !== 'proposed') {
    return {
      outcome: 'proposal-missing',
      reason: `proposal '${proposalOperationId}' is ${proposal.status}, not confirmable`,
      articleId,
      proposalOperationId,
    }
  }

  // 版本变化要求重新比较 — the bound proposal version must equal the article's
  // CURRENT version AND the caller's expected version.
  const currentVersionNow = await currentVersion(db, articleId)
  if (expectedVersion !== proposal.proposed_version || currentVersionNow !== proposal.proposed_version) {
    await setProposalStatus(db, proposalOperationId, 'stale')
    return {
      outcome: 'stale',
      reason: 'version moved since proposal — re-comparison required (版本变化要求重新比较)',
      articleId,
      proposalOperationId,
      proposedVersion: proposal.proposed_version,
      currentVersion: currentVersionNow,
    }
  }

  // 媒体失败不得标完成 — re-verify every present media ref still resolves to
  // the exact content frozen by the proposal. Any failure → non-complete.
  const media = mediaFromJson(proposal.media_json)
  try {
    for (const m of media) {
      if (m.status === 'removed') continue
      const bytesResult = await provider.readMediaBytes(m.ref)
      if (sha256Hex(bytesResult.bytes) !== m.contentSha256) {
        throw new Error(`media-content-changed:${m.ref}`)
      }
    }
  } catch (error) {
    return {
      outcome: 'media-failed',
      reason: `media-verify-failed: ${error instanceof Error ? error.message : String(error)}`,
      articleId,
      sourceUrl,
      operationId,
      proposalOperationId,
      completed: media,
    }
  }

  // Build the snapshot from the frozen projection, preserving post metadata.
  const post = await findPost(db, article.post_ref)
  if (!post) return { outcome: 'not-found', reason: `post ${article.post_ref} not found`, articleId }
  let tags: string[] | null = null
  try {
    tags = post.tags ? (JSON.parse(post.tags) as string[]) : null
  } catch {
    tags = null
  }
  const snapshot: ArticleCommandSnapshot = {
    slug: post.slug,
    title: proposal.source_title,
    content: proposal.source_markdown,
    html: proposal.source_html,
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
    updated_at: unixNow(),
  }

  // Commit through the versioned write kernel (draft→new version; formal→unique revision).
  const saveResult = await save(db, { articleId, expectedVersion: proposal.proposed_version, operationId, snapshot })

  if (saveResult.outcome === 'conflict') {
    await setProposalStatus(db, proposalOperationId, 'stale')
    return {
      outcome: 'save-conflict',
      reason: 'version-moved',
      articleId,
      expectedVersion: proposal.proposed_version,
      serverVersion: saveResult.serverVersion,
      operationId,
      proposalOperationId,
    }
  }
  if (saveResult.outcome === 'slug-conflict') {
    return {
      outcome: 'save-conflict',
      reason: 'slug-conflict',
      articleId,
      expectedVersion: proposal.proposed_version,
      serverVersion: proposal.proposed_version,
      operationId,
      proposalOperationId,
    }
  }
  if (saveResult.outcome !== 'applied' && saveResult.outcome !== 'replayed') {
    throw new Error(`confirmRefresh: unexpected save outcome '${(saveResult as { outcome: string }).outcome}'`)
  }

  const appliedVersion = saveResult.version
  const revisionId = (saveResult as { revisionId?: string }).revisionId ?? null
  const diff = diffFromJson(proposal.diff_json) ?? null
  const projection = projectionFromProposal(proposal)
  const refreshedDiff: RefreshDiff | null = diff

  await persistRefreshRecord(db, {
    operation_id: operationId,
    proposal_operation_id: proposalOperationId,
    source_identity_id: identity.id,
    article_id: articleId,
    post_ref: article.post_ref,
    outcome: 'refreshed',
    reason: null,
    expected_version: proposal.proposed_version,
    applied_version: appliedVersion,
    applied_revision_id: revisionId,
    baseline_sha256: projection.snapshotSha256,
    projection_json: JSON.stringify(projection),
    media_json: JSON.stringify(media),
    diff_json: proposal.diff_json,
  })
  await setProposalStatus(db, proposalOperationId, 'confirmed')

  const facts: RefreshFacts = {
    articleId,
    postRef: article.post_ref,
    proposalOperationId,
    version: appliedVersion,
    revisionId,
    operationId,
    snapshotSha256: projection.snapshotSha256,
    diff: refreshedDiff ?? {
      titleChanged: false, currentTitle: '', sourceTitle: projection.title, bodyChanged: false,
      currentContent: '', sourceMarkdown: projection.markdown, mediaChanged: false,
      media, changed: false, sourceSnapshotSha256: projection.snapshotSha256,
    },
    projection,
    media,
  }
  return { outcome: 'refreshed', existing: false, ...facts }
}

function replayConfirm(_db: Database, articleId: number, postRef: number, row: RecordRow): ConfirmRefreshResult {
  const media = mediaFromJson(row.media_json)
  const diff = diffFromJson(row.diff_json)
  const projection: SourceRefreshProjection = {
    title: '',
    markdown: '',
    html: '',
    snapshotSha256: row.baseline_sha256 ?? '',
  }
  try {
    const parsed = JSON.parse(row.projection_json ?? 'null') as SourceRefreshProjection
    projection.title = parsed.title
    projection.markdown = parsed.markdown
    projection.html = parsed.html
    projection.snapshotSha256 = parsed.snapshotSha256 || row.baseline_sha256 || ''
  } catch {
    // fall back to the stored baseline fingerprint
  }
  return {
    outcome: 'replayed',
    existing: true,
    articleId,
    postRef,
    proposalOperationId: row.proposal_operation_id,
    version: row.applied_version ?? 0,
    revisionId: row.applied_revision_id,
    operationId: row.operation_id,
    snapshotSha256: projection.snapshotSha256,
    diff: diff ?? {
      titleChanged: false, currentTitle: '', sourceTitle: projection.title, bodyChanged: false,
      currentContent: '', sourceMarkdown: projection.markdown, mediaChanged: false,
      media, changed: false, sourceSnapshotSha256: projection.snapshotSha256,
    },
    projection,
    media,
  }
}
