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
 *
 * B5-02 (issue #47) — provider failure / retry / result-unknown state machine.
 *
 * The B5-01 status CHECK is additive-only and may LEGALLY contain only the
 * four original statuses — a D1 table's CHECK constraint cannot be altered in
 * place, so the retry lifecycle is NOT new statuses. It is a set of NEW
 * additive columns on `wechat_draft_tasks` (classification, needs_author,
 * attempt_count, next_attempt_at, lease_token, lease_expires_at, claimed_at,
 * last_error, revision — all PRAGMA-guarded ALTER TABLE ADD COLUMN for
 * B5-01-era installs) plus a NEW immutable `wechat_draft_attempts` table:
 *
 *   - `status` keeps the four B5-01 values (draft / submitted / failed /
 *     superseded). The B5-02 state machine lives in `classification`:
 *       * 'ok'            — remote outcome known and favorable (media_id
 *                           saved in `remote_draft_id`,永久保存),
 *       * 'retryable'     — transient failure (rate limit / temporary
 *                           unavailability / transport error): re-armed with
 *                           next_attempt_at under a cap + exponential backoff,
 *       * 'needs-author'  — permanent / configuration / unclassifiable
 *                           rejection: author todo, NEVER auto-retried,
 *       * 'unknown'       — dropped / lost response: outcome uncertain,
 *                           blind retry forbidden — frozen as an author todo
 *                           until a query/reconcile resolves it,
 *   - `needs_author` marks an author todo (unknown / needs-author rows),
 *   - `attempt_count` / `next_attempt_at` implement the retry policy,
 *   - `revision` bumps on every transition; `lease_token` + `lease_expires_at`
 *     own in-flight executions so concurrent executors converge on one winner,
 *   - `wechat_draft_attempts` is ONE IMMUTABLE row per execution (derivation
 *     hand-off, executor submission, or reconcile query) with a deterministic
 *     attempt key and a SANITIZED classification + error. Rows are never
 *     deleted or re-written; recovery only appends.
 */

import type { Database } from '@/lib/repositories/schema'

export const WECHAT_DRAFT_TASK_STATUSES = ['draft', 'submitted', 'failed', 'superseded'] as const

export type WechatDraftTaskStatus = (typeof WECHAT_DRAFT_TASK_STATUSES)[number]

export const WECHAT_DRAFT_ATTEMPT_CLASSIFICATIONS = ['ok', 'retryable', 'needs-author', 'unknown'] as const

export type WechatDraftAttemptClassification = (typeof WECHAT_DRAFT_ATTEMPT_CLASSIFICATIONS)[number]

export const WECHAT_DRAFT_ATTEMPT_OUTCOMES = [
  'submitted',
  'retried',
  'failed',
  'unknown',
  'reconciled',
  'abandoned',
  'cancelled',
] as const

export type WechatDraftAttemptOutcome = (typeof WECHAT_DRAFT_ATTEMPT_OUTCOMES)[number]

/** Additive B5-02 columns for `wechat_draft_tasks` (PRAGMA-guarded ALTER). */
export const WECHAT_DRAFT_ADDITIVE_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
  { name: 'revision', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'attempt_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'classification', definition: 'TEXT' },
  { name: 'needs_author', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'next_attempt_at', definition: 'INTEGER' },
  { name: 'last_error', definition: 'TEXT' },
  { name: 'claimed_at', definition: 'INTEGER' },
  { name: 'lease_token', definition: 'TEXT' },
  { name: 'lease_expires_at', definition: 'INTEGER' },
]

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
  `CREATE TABLE IF NOT EXISTS wechat_draft_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
    task_id TEXT NOT NULL CHECK(length(task_id) > 0),
    attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
    classification TEXT NOT NULL CHECK(
      classification IN ('ok', 'retryable', 'needs-author', 'unknown')
    ),
    outcome TEXT NOT NULL CHECK(
      outcome IN ('submitted', 'retried', 'failed', 'unknown', 'reconciled', 'abandoned', 'cancelled')
    ),
    started_at INTEGER NOT NULL CHECK(started_at > 0),
    finished_at INTEGER,
    remote_draft_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_wechat_draft_attempts_task
     ON wechat_draft_attempts(task_id, id)`,
]

/**
 * Idempotently create the WeChat draft-task tables if absent and upgrade a
 * B5-01-era `wechat_draft_tasks` to the B5-02 shape. Never drops/alters
 * existing rows or tables. The CHECK constraint on `status` intentionally
 * keeps the four B5-01 values — the retry state machine lives in the new
 * additive columns, not new statuses.
 */
export async function ensureWechatDraftTables(db: Database): Promise<void> {
  for (const statement of WECHAT_DRAFT_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
  const { results } = await db.prepare('PRAGMA table_info(wechat_draft_tasks)').all<{ name: string }>()
  const existing = new Set(results.map((row) => row.name))
  for (const column of WECHAT_DRAFT_ADDITIVE_COLUMNS) {
    if (!existing.has(column.name)) {
      await db.prepare(`ALTER TABLE wechat_draft_tasks ADD COLUMN ${column.name} ${column.definition}`).run()
    }
  }
}