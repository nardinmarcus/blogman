/**
 * B5-01 — WeChat draft-task DDL (issue #46).
 *
 * Additive fact surface for deriving WeChat public-account drafts from the
 * EXACT frozen formal version of a formally published article. Delivered
 * through the same independent DDL channel as every earlier additive batch
 * (`scripts/apply-wechat-draft-ddl.mjs`) so the issue-23 delivery canonical
 * migration freeze (exactly 001..007) stays untouched.
 *
 * Boundaries:
 *   - `wechat_draft_tasks` is TASK evidence only — the row binds the frozen
 *     (article identity + exact version) to ONE account and stores the
 *     WeChat-adapted projection body. It never writes to any publish/source
 *     table and never performs an external call (provider is injected and
 *     null in production → 只建草稿, 不发布).
 *   - the UNIQUE (article_id, version, account_id) key is the hard idempotency
 *     enforcer: re-deriving the same version for the same account returns the
 *     SAME deterministic task row (operation id) instead of registering a
 *     duplicate target. A derived row for an older version is superseded when
 *     a newer version of the same (article, account) is derived.
 *   - safe to run repeatedly: `CREATE TABLE IF NOT EXISTS`, never drops/alters.
 */

import type { Database } from '@/lib/repositories/schema'

export const WECHAT_DRAFT_TASK_STATUSES = ['draft', 'submitted', 'failed', 'superseded'] as const

export type WechatDraftTaskStatus = (typeof WECHAT_DRAFT_TASK_STATUSES)[number]

export const WECHAT_DRAFT_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS wechat_draft_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT UNIQUE NOT NULL CHECK(length(task_id) > 0),
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    post_ref INTEGER NOT NULL CHECK(post_ref > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'failed', 'superseded')),
    title TEXT NOT NULL,
    html_projection TEXT NOT NULL,
    plaintext_projection TEXT NOT NULL,
    cover_image_url TEXT,
    digest TEXT,
    content_sha256 TEXT NOT NULL CHECK(content_sha256 = '' OR length(content_sha256) = 64),
    projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64),
    source_url TEXT NOT NULL CHECK(length(source_url) > 0),
    remote_draft_id TEXT,
    provider_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (article_id, version, account_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_wechat_draft_tasks_article
     ON wechat_draft_tasks(article_id, account_id, version)`,
]

/** Idempotently create the WeChat draft-task tables if absent. Never drops/alters. */
export async function ensureWechatDraftTables(db: Database): Promise<void> {
  for (const statement of WECHAT_DRAFT_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}