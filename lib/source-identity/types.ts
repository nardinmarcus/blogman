/**
 * B6-01 — 主要源稿身份与待确认关联: shared command types (issue #50).
 *
 * The author-facing command surface for a writable primary source. A source
 * is identified by a normalized canonical URL; a link to an article is
 * `pending` until the author confirms it (待确认关联 — NOT auto-effective).
 * Replaying the same stable operation id returns the original facts with zero
 * new rows, and a duplicate URL always converges on the identity's existing
 * live link instead of creating a second article.
 */

/** Lifecycle of one source↔article association. */
export type SourceLinkStatus = 'pending' | 'confirmed' | 'cancelled'

/**
 * The link's ROLE — what this source means to the article (B7-01, issue #57).
 *
 *   - `primary` — the writable PRIMARY 源稿 (作者选归属, B6-01). Its live link
 *     drives the B6 primary-source sync / write-back / conflict machinery.
 *   - `clip`    — a Chrome 剪藏 reference source page (B7-01). Never promoted
 *     to the primary source; it exists for重现/比较 and does NOT join the
 *     primary-source write chain. The same article can hold a `primary` link
 *     AND a `clip` link to different URLs (主要源稿与一个来源网页可共存).
 */
export type SourceLinkRole = 'primary' | 'clip'

/** One `source_identities` row surface. */
export interface SourceIdentity {
  id: number
  canonicalUrl: string
  identitySha256: string
  /** True when the identity row already existed (idempotent replay). */
  existing: boolean
  createdAt: number
}

/** One `article_source_links` row surface. */
export interface SourceLink {
  id: number
  sourceIdentityId: number
  articleId: number
  status: SourceLinkStatus
  role: SourceLinkRole
  /** Stable idempotency key that created this link. */
  operationId: string
  createdAt: number
  resolvedAt: number | null
}

/** Source facts surfaced by a versioned create that carried a `source.url`. */
export interface SourceFacts {
  sourceIdentity: SourceIdentity
  /** The live link (pending/confirmed) or null when none exists yet. */
  link: SourceLink | null
}

/** A URL that cannot be turned into a source identity (unparseable / not http). */
export interface InvalidSourceResult {
  outcome: 'invalid-source'
  url: string
}

/** The URL already lives on a DIFFERENT article — author must pick ownership. */
export interface SourceCollisionResult {
  outcome: 'collision'
  sourceIdentity: SourceIdentity
  /** The existing live link the URL already belongs to. */
  existingLink: SourceLink
  /** The article this attach was refused for. */
  articleId: number
  postRef: number
}

export type LinkResult =
  | { outcome: 'applied'; link: SourceLink; existing: false }
  | { outcome: 'replayed'; link: SourceLink; existing: true }
  | { outcome: 'collision'; sourceIdentity: SourceIdentity; existingLink: SourceLink }
  | InvalidSourceResult
  | { outcome: 'not-found' }

export interface ConfirmLinkInput {
  sourceIdentityId: number
  articleId: number
  /** Idempotency key — replay returns the original outcome. */
  operationId: string
  /** Precondition: the link must currently be in this status to transition. */
  expectedStatus: 'pending'
}

export type ConfirmLinkResult =
  | { outcome: 'confirmed'; link: SourceLink }
  | { outcome: 'replayed'; link: SourceLink; existing: true }
  | { outcome: 'already-final'; link: SourceLink }
  | { outcome: 'transition-refused'; link: SourceLink }
  | { outcome: 'not-found' }

export interface CancelLinkInput {
  sourceIdentityId: number
  articleId: number
  operationId: string
  expectedStatus: 'pending'
}

export type CancelLinkResult =
  | { outcome: 'cancelled'; link: SourceLink }
  | { outcome: 'replayed'; link: SourceLink; existing: true }
  | { outcome: 'already-final'; link: SourceLink }
  | { outcome: 'not-found' }

export interface MergeVariantInput {
  operationId: string
  /** The SEMANTIC variant URL the author declares belongs to `targetIdentityId`. */
  variantUrl: string
  targetIdentityId: number
}

export type MergeVariantResult =
  | { outcome: 'merged'; targetIdentityId: number; variantCanonicalUrl: string }
  | { outcome: 'replayed'; targetIdentityId: number }
  | { outcome: 'unchanged'; targetIdentityId: number }
  | { outcome: 'variant-conflict'; targetIdentityId: number; variantCanonicalUrl: string }
  | InvalidSourceResult
  | { outcome: 'target-not-found' }

export interface AttachSourceInput {
  operationId: string
  url: string
  articleId: number
  /** The link's role — defaults to `primary` (B6-01 writable source). The Chrome
   *  clip entry (B7-01) passes `clip` so a clipped page never becomes the
   *  primary source. */
  role?: SourceLinkRole
}
