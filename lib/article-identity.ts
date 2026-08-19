/**
 * B2-02 — shared article identity + initial-version snapshot builder.
 *
 * Pure, framework-free logic imported by BOTH the backfill/reconcile scripts
 * (which run SQL through `wrangler d1 execute`) and the repository-layer tests.
 * It derives the immutable "article identity + version 1" snapshot from an
 * authoritative `posts` row:
 *
 *   - canonical content envelope via the B2-01 kernel (markdown → envelope),
 *   - an audit digest of the pre-migration authoritative fields,
 *   - a fidelity classification of the canonical projection vs the stored HTML,
 *   - a draft-published-at rule that never fabricates a first-published time.
 *
 * The legacy `posts` table stays authoritative; this module only shadows it.
 */

import { createHash } from 'node:crypto'
import type { ContentEnvelope } from '@/lib/content-envelope'
import { contentSnapshotHash, parse, renderHtml, sourceSyncHash } from '@/lib/content-envelope'
import TurndownService from 'turndown'

export const ARTICLE_IDENTITY_FORMAT = 'blogman-article-identity/v1' as const
export const INITIAL_VERSION = 1 as const

export type FidelityClass = 'equivalent' | 'degraded' | 'mismatch' | 'error'

/** Authoritative `posts` row — the full pre-migration surface we shadow. */
export interface PostAuthorityRow {
  id: number
  slug: string
  title: string
  content: string | null
  html: string | null
  description: string | null
  category: string | null
  tags: string | null
  status: string
  password: string | null
  is_pinned: number | null
  is_hidden: number | null
  cover_image: string | null
  deleted_at: number | null
  published_at: number | null
  updated_at: number | null
}

/** Non-body authoritative fields captured verbatim for the audit trail. */
export interface ArticleSnapshotFields {
  slug: string
  title: string
  description: string | null
  category: string | null
  tags: string | null
  status: string
  password: string | null
  is_pinned: number | null
  is_hidden: number | null
  cover_image: string | null
  deleted_at: number | null
  published_at: number | null
  updated_at: number | null
}

export interface ArticleIdentitySnapshot {
  format: typeof ARTICLE_IDENTITY_FORMAT
  post_ref: number
  version: typeof INITIAL_VERSION
  fields: ArticleSnapshotFields
  /** Verbose pre-migration bodies kept verbatim for audit. */
  original_content: string | null
  original_html: string | null
  /** Digest over the authoritative fields + bodies (content drift detection). */
  post_field_sha256: string
  envelope: ContentEnvelope | null
  content_snapshot_sha256: string | null
  source_sync_sha256: string
  fidelity: FidelityClass
  fidelity_detail: string | null
  /** Observable first-published time — NULL for anything not 'published'. */
  published_at: number | null
}

const markdownTurndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

/** Stable operation key so a re-run of the backfill is idempotent. */
export function operationIdFor(postRef: number): string {
  return `backfill:post:${postRef}:v1`
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * First observable published time. Only a `published` post may carry a time;
 * drafts (and soft-deleted rows) must not inherit the legacy default
 * `published_at` from their creation, so they produce NULL.
 */
export function firstPublishedAt(row: PostAuthorityRow): number | null {
  if (row.status === 'published') {
    return row.published_at ?? null
  }
  return null
}

/** Which fidelity source the envelope was built from. */
export type SourceOrigin = 'markdown' | 'html'

/** Fidelity input for the B2-01 kernel: prefer verbatim markdown, fall back to HTML→markdown. */
export function sourceMarkdownFor(row: PostAuthorityRow): { markdown: string; origin: SourceOrigin } {
  const content = (row.content ?? '').trim()
  if (content.length > 0) {
    return { markdown: content, origin: 'markdown' }
  }
  const html = (row.html ?? '').trim()
  if (html.length > 0) {
    return { markdown: markdownTurndown.turndown(html).trim(), origin: 'html' }
  }
  return { markdown: '', origin: 'markdown' }
}

/** Digest over every authoritative (pre-migration) field we shadow, incl. bodies. */
export function postFieldDigest(row: PostAuthorityRow): string {
  const canonical = JSON.stringify({
    slug: row.slug,
    title: row.title,
    content: row.content ?? null,
    html: row.html ?? null,
    description: row.description ?? null,
    category: row.category ?? null,
    tags: row.tags ?? null,
    status: row.status,
    password: row.password ?? null,
    is_pinned: row.is_pinned ?? null,
    is_hidden: row.is_hidden ?? null,
    cover_image: row.cover_image ?? null,
    deleted_at: row.deleted_at ?? null,
    published_at: row.published_at ?? null,
    updated_at: row.updated_at ?? null,
  })
  return sha256Hex(canonical)
}

/** Text tokens only (no tags), whitespace-collapsed — for body-text equality. */
function textSequence(html: string): string {
  const tokens: string[] = []
  const re = /<[^>]*>|([^<]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(String(html))) !== null) {
    if (match[1] !== undefined) {
      const text = match[1].replace(/\s+/g, ' ').trim()
      if (text) tokens.push(text)
    }
  }
  return tokens.join(' ')
}

/** Block-aware structural fingerprint (tags + text tokens in order). */
function blockFingerprint(html: string): string {
  const tokens: string[] = []
  const re = /<\/?([a-zA-Z0-9]+)[^>]*>|([^<]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(String(html))) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[0][1] === '/' ? `/${match[1]}` : match[1])
    } else if (match[2] !== undefined) {
      const text = match[2].replace(/\s+/g, ' ').trim()
      if (text) tokens.push(text)
    }
  }
  return tokens.join(' ')
}

/** Same vocabulary as B2-01b: equivalent / degraded / mismatch / error. */
export function classifyFidelity(rendered: string, storedHtml: string): { clazz: FidelityClass; detail: string | null } {
  if (blockFingerprint(rendered) === blockFingerprint(storedHtml)) {
    return { clazz: 'equivalent', detail: null }
  }
  if (textSequence(rendered) === textSequence(storedHtml)) {
    return { clazz: 'degraded', detail: '正文等价、标记/结构不同' }
  }
  return { clazz: 'mismatch', detail: 'canonical 投影与原 html 失配' }
}

/** Build the immutable version-1 snapshot for a single authoritative post row. */
export function buildInitialSnapshot(row: PostAuthorityRow): ArticleIdentitySnapshot {
  const { markdown } = sourceMarkdownFor(row)

  let envelope: ContentEnvelope | null = null
  let fidelity: FidelityClass = 'error'
  let fidelityDetail: string | null = null
  try {
    envelope = parse({ markdown })
    const rendered = renderHtml(envelope)
    const classified = classifyFidelity(rendered, row.html ?? '')
    fidelity = classified.clazz
    fidelityDetail = classified.detail
  } catch (error) {
    fidelity = 'error'
    fidelityDetail = error instanceof Error ? error.message : String(error)
  }

  const publishedAt = firstPublishedAt(row)

  return {
    format: ARTICLE_IDENTITY_FORMAT,
    post_ref: row.id,
    version: INITIAL_VERSION,
    fields: {
      slug: row.slug,
      title: row.title,
      description: row.description ?? null,
      category: row.category ?? null,
      tags: row.tags ?? null,
      status: row.status,
      password: row.password ?? null,
      is_pinned: row.is_pinned ?? null,
      is_hidden: row.is_hidden ?? null,
      cover_image: row.cover_image ?? null,
      deleted_at: row.deleted_at ?? null,
      published_at: row.published_at ?? null,
      updated_at: row.updated_at ?? null,
    },
    original_content: row.content,
    original_html: row.html,
    post_field_sha256: postFieldDigest(row),
    envelope,
    content_snapshot_sha256: envelope ? contentSnapshotHash(envelope) : null,
    source_sync_sha256: sourceSyncHash(markdown),
    fidelity,
    fidelity_detail: fidelityDetail,
    published_at: publishedAt,
  }
}

/** Canonical snapshot JSON (stable key order, retains the envelope as-is). */
export function snapshotJson(snapshot: ArticleIdentitySnapshot): string {
  return JSON.stringify(snapshot)
}
