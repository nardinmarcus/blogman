/**
 * B7-01 — Chrome 剪藏 entry: shared clip command types (issue #57).
 *
 * A Chrome clip captures a source page as a DRAFT article and records a
 * pending (待确认, not auto-effective) source↔article link whose ROLE is
 * `clip` — a reference source page that NEVER becomes the writable primary
 * source (来源网页不成为主要源稿). Idempotency is keyed by a STABLE creation id
 * derived from the normalized source URL (`clip:<sha256>`), so repeated or
 * concurrent clips of the SAME page create exactly ONE article and return the
 * existing article identity for比较 (不重复建).
 */

import type { ArticleCommandProjections } from '@/lib/article-commands'
import type { SourceFacts } from '@/lib/source-identity'

/** The raw facts a Chrome extension supplies when clipping a page. */
export interface ClipArticleInput {
  /** The page URL; normalized to a stable source identity. */
  url: string
  title: string
  /** Markdown body captured from the page (may be empty for a bare link clip). */
  content: string
  /** Rendered HTML from the page (optional; derive from markdown when absent). */
  html?: string
  projections?: ArticleCommandProjections
}

/** The identity surface shared by a created / replayed / re-converged clip. */
export interface ClipIdentity {
  articleId: number
  postRef: number
  version: number
  /** Stable idempotency key derived from the normalized URL (`clip:<sha256>`). */
  creationId: string
  /** source identity + pending `clip`-role link facts. */
  source: SourceFacts
}

export type ClipArticleResult =
  | ({ outcome: 'created'; existing: false } & ClipIdentity)
  | ({ outcome: 'existing'; existing: true } & ClipIdentity)
  | {
      outcome: 'source-linked'
      existing: true
      /** The URL was already live-linked to an existing article → converge. */
      articleId: number
      postRef: number
      version: number
      creationId: string
      source: SourceFacts
    }
  | { outcome: 'invalid-source'; url: string }
  | { outcome: 'skipped'; reason: 'blank-session' }
