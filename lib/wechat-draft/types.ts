/**
 * B5-01 — WeChat draft-task types (issue #46).
 *
 * The derivation surface is deliberately small: an article identity + EXACT
 * version (never "latest"), one account target, a frozen-projection body, and
 * the deterministic operation id that makes the whole derivation idempotent.
 * Channel groups / generations / account-setting revisions / remote identity
 * facts belong to the later batch-5 surfaces and are intentionally NOT part of
 * this row — the draft task only binds what it must.
 */

import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import type { WechatDraftTaskStatus } from './ddl'

export type { WechatDraftTaskStatus }

/** A single derived WeChat draft task row (`wechat_draft_tasks`). */
export interface WechatDraftTaskRow {
  id: number
  task_id: string
  article_id: number
  post_ref: number
  version: number
  account_id: string
  status: WechatDraftTaskStatus
  title: string
  html_projection: string
  plaintext_projection: string
  cover_image_url: string | null
  digest: string | null
  content_sha256: string
  projection_sha256: string
  source_url: string
  remote_draft_id: string | null
  provider_error: string | null
  created_at: number
  updated_at: number
}

/** The WeChat-adapted projection body built from one frozen version snapshot. */
export interface WechatDraftProjection {
  title: string
  html: string
  plaintext: string
  coverImageUrl: string
  digest: string
  sourceUrl: string
}

/** Payload handed to a provider adapter when the executor submits the draft. */
export interface WechatDraftSubmitPayload extends WechatDraftProjection {
  taskId: string
  articleId: number
  version: number
  accountId: string
  contentSha256: string
}

export interface WechatDraftProviderResult {
  accepted: boolean
  remoteDraftId?: string
  error?: string
}

/**
 * The WeChat API layer interface. This batch ships the MOCK only — real API
 * calls are deferred to a later batch. Providers are injected via `deps`;
 * production is `null` ⇒ 只建草稿 (in-DB task), 不发布, 不真调微信 API.
 */
export interface WechatDraftProvider {
  readonly kind: string
  /** Create a DRAFT in the WeChat draft box — never a live publication. */
  createDraft(payload: WechatDraftSubmitPayload): Promise<WechatDraftProviderResult>
}

export interface DeriveWechatDraftInput {
  articleId: number
  version: number
  accountId: string
  /** Optional injected adapter (mock in tests; null/absent in production). */
  provider?: WechatDraftProvider | null
  /** Frozen epoch clock for deterministic timestamps. */
  now?: number
  /** Site origin used to absolutize relative cover URLs. */
  siteUrl?: string
}

export type DeriveWechatDraftResult =
  | { outcome: 'invalid'; reason: string }
  | {
      outcome: 'not-found'
      reason: string
      articleId: number
      version: number
      accountId: string
    }
  | {
      outcome: 'created' | 'existing' | 'submitted' | 'failed'
      articleId: number
      version: number
      accountId: string
      taskId: string
      task: WechatDraftTaskRow
      created: boolean
      projection: WechatDraftProjection
    }

export interface ReadWechatDraftTaskResult {
  task: WechatDraftTaskRow | null
  projection?: WechatDraftProjection
}

export type { ArticleIdentitySnapshot }