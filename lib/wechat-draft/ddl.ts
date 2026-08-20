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
 *
 * B5-03 (issue #48) — 交付前设置调整、替代草稿与历史.
 *
 *   - `wechat_draft_settings` holds the per-(article, account) chosen delivery
 *     settings; the FIRST save maps to settings revision 1 (初始配置映射初始修订,
 *     不猜历史) and every later save bumps the revision. Settings revisions are
 *     SEPARATE from the article body version and from the delivery generation,
 *     so adjusting settings never moves either.
 *   - a pre-delivery derivation re-projects the SAME task row in place with the
 *     current settings (沿用代次): same task id / version / generation, updated
 *     title / html / cover / digest + settings_revision.
 *   - after a draft is DELIVERED ('submitted', 待微信确认), derive never touches
 *     the row; only the EXPLICIT `replaceWechatDraft` command creates a
 *     replacement draft: the NEXT monotonic generation of the (article, account)
 *     group (`wechat_draft_generations` ledger), referencing the prior
 *     generation (`replaces_task_id`), with the old row (media_id + history)
 *     preserved as superseded (旧 media_id/代次不可删除或假装覆盖).
 *   - `wechat_draft_replacements` reuse the SAME lifecycle columns as tasks, so
 *     the executor / retry / reconcile state machine processes them uniformly; a
 *     replacement is delivered to the WeChat DRAFT BOX only — automation stops
 *     at the draft and never claims to be published (绝不自动群发或声称已发布).
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
  /* B5-03 — 交付代次与设置修订：设置修订与代次分离、与正文版本分离。 */
  { name: 'generation', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { name: 'settings_revision', definition: 'INTEGER NOT NULL DEFAULT 0' },
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
  /* B5-03 — 账号/设置修订：每个（正式文章, 账号）一份可调设置，设置修订与正文版本/代次分离。 */
  `CREATE TABLE IF NOT EXISTS wechat_draft_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    settings_revision INTEGER NOT NULL CHECK(settings_revision > 0),
    title_override TEXT,
    digest_override TEXT,
    cover_image_override TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (article_id, account_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_wechat_draft_settings_article
     ON wechat_draft_settings(article_id, account_id)`,
  /* B5-03 — 渠道交付组任务代次台账：每（文章, 账号）一串单调递增加法交付代次；
     替代代次引用前代（replaces_task_id），旧代次/旧 media_id 一律保留。 */
  `CREATE TABLE IF NOT EXISTS wechat_draft_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    generation INTEGER NOT NULL CHECK(generation > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    task_id TEXT NOT NULL CHECK(length(task_id) > 0),
    replaces_task_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'failed', 'superseded')),
    settings_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (article_id, account_id, generation),
    UNIQUE (task_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_wechat_draft_generations_group
     ON wechat_draft_generations(article_id, account_id, generation)`,
  /* B5-03 — 交付后显式替代草稿（新代次）：完整生命周期列与 wechat_draft_tasks 一致，
     这样同一个执行器/重试/对账状态机可以统一处理；replacement_key 即该代的 task 键。 */
  `CREATE TABLE IF NOT EXISTS wechat_draft_replacements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    replacement_key TEXT UNIQUE NOT NULL CHECK(length(replacement_key) > 0),
    article_id INTEGER NOT NULL CHECK(article_id > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    account_id TEXT NOT NULL CHECK(length(account_id) > 0),
    replaces_task_id TEXT NOT NULL CHECK(length(replaces_task_id) > 0),
    generation INTEGER NOT NULL CHECK(generation > 0),
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
    settings_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    classification TEXT,
    needs_author INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error TEXT,
    claimed_at INTEGER,
    lease_token TEXT,
    lease_expires_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_wechat_draft_replacements_group
     ON wechat_draft_replacements(article_id, account_id, version)`,
  `CREATE INDEX IF NOT EXISTS idx_wechat_draft_replacements_status
     ON wechat_draft_replacements(status, next_attempt_at)`,
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