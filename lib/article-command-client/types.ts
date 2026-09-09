/**
 * Article Command Client — types (CONTEXT.md).
 *
 * The client-side seam for every admin-surface command on the
 * /api/article-commands wire. Deliberately distinct from:
 *  - the editor save protocol (create/save confirmation) that lives in
 *    `lib/editor-command-transport`;
 *  - the Article-Level Command domain concept, which these requests
 *    transport but do not decide ("which publish command applies" stays
 *    with callers until a publication façade exists).
 */

/** Identity facts one admin row carries; nulls trigger the legacy bypass. */
export interface ArticleCommandTarget {
  slug: string
  articleId: number | null
  expectedVersion: number | null
}

/** One typed command request; payload fields are flattened per action. */
export type ArticleCommandRequest =
  | { action: 'setPinned'; is_pinned: 0 | 1 }
  | { action: 'setHidden'; is_hidden: 0 | 1 }
  | { action: 'setPassword'; password: string | null }
  | { action: 'setCategory'; category: string | null }
  | { action: 'softDelete' }
  | { action: 'restore' }
  | { action: 'unpublish' }
  | { action: 'relive'; content: 'formal' | 'revision' }
  | { action: 'publishTemp'; currentStatus: string; status: string }

/**
 * Normalized outcome. The raw wire vocabulary (`applied` / `replayed` /
 * `legacy-applied` / `conflict` / bare HTTP errors) never leaks past this
 * seam — that is what makes the legacy-wire retirement (candidate ④) a
 * one-spot change later.
 */
export type ArticleCommandOutcome =
  | { kind: 'ok'; ok: true; replayed: boolean }
  | { kind: 'conflict'; ok: false; serverVersion?: number }
  | { kind: 'error'; ok: false; message: string }

/** One batch classification item; each row keeps its own preconditions. */
export interface BatchCategoryItem {
  slug: string
  articleId: number | null
  expectedVersion: number | null
  category: string | null
}

export type BatchCategoryOutcome =
  | { ok: true; applied: number; conflicts: number; skipped: number }
  | { ok: false; message: string }

/** Minimal fetch shape the pure client needs (test-injectable). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Pick<Response, 'ok' | 'json'>>

/** Post-command refresh strategies ('reload' covers the password flow). */
export type RefreshStrategy = 'router' | 'reload' | 'none' | (() => void)
