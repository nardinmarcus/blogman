/**
 * B4-G — shared state helpers for the batch-4 acceptance fixture tests
 * (issue #45).
 *
 * Two complementary ways to build a D1 state the reconciler can read:
 *
 *   - `createWranglerState()` + `seedB4Schema(state)` + `runD1` build a state
 *     purely through `wrangler d1 execute --local --persist-to <dir>`: the
 *     same channel `scripts/reconcile-b4-facts.mjs` reads. Used for the
 *     SQL-seeded aligned / candidate / corruption fixtures.
 *
 *   - `createKernelContext()` boots ONE in-process Miniflare instance whose
 *     D1 persists into the SAME `v3/d1` layout `wrangler --local --persist-to
 *     <dir>` reads (verified experimentally: the metadata hash is derived from
 *     the production database_id, so both engines address the same sqlite
 *     file). This lets the scenario tests drive the REAL batch-4 kernels
 *     (schedulePublish / scanDueSchedules / pauseSchedule / cancelSchedule /
 *     recordNotification / runEmailReminders) against a real D1 binding and
 *     then hand the resulting fact state to the read-only reconciler.
 *
 * Zero production: everything is local / tmpdir, and the reconciler only ever
 * issues SELECT statements.
 */

import { Miniflare } from 'miniflare'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configPath,
  repoRoot,
  runD1,
  spawnOk,
  wranglerPath,
} from '@/tests/helpers/article-identity-state'
import { splitSqlFile } from '@/tests/lib/article-commands/helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'
import { SLUG_ADDRESS_DDL_STATEMENTS } from '@/lib/slug-address/ddl'
import { ARTICLE_FTS_DDL_STATEMENTS } from '@/lib/article-fts/ddl'
import { ensureScheduledPublishTables } from '@/lib/scheduled-publish/ddl'
import { ensureNotificationTables } from '@/lib/notifications/ddl'
import { ensureEmailReminderTables } from '@/lib/email-reminders/ddl'
import { ensureScheduleControlTables } from '@/lib/schedule-control/ddl'
import { create } from '@/lib/article-commands'
import { type ArticleCommandSnapshot } from '@/lib/article-commands/types'
import { createHash } from 'node:crypto'

export { configPath, repoRoot, runD1, wranglerPath, spawnOk }

/* ------------------------------------------------------------------ */
/* candidate ledger + schema                                           */
/* ------------------------------------------------------------------ */

export const CANDIDATE = 'b'.repeat(40)

const migrationLedgerDdl = [
  `CREATE TABLE IF NOT EXISTS migration_ledger (
    number INTEGER PRIMARY KEY CHECK(number > 0),
    name TEXT UNIQUE NOT NULL,
    checksum TEXT NOT NULL CHECK(length(checksum) = 64),
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0)
  ) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS migration_ledger_no_update
BEFORE UPDATE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  `CREATE TRIGGER IF NOT EXISTS migration_ledger_no_delete
BEFORE DELETE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  `CREATE TRIGGER IF NOT EXISTS migration_ledger_no_replace
BEFORE INSERT ON migration_ledger
WHEN EXISTS (
  SELECT 1 FROM migration_ledger
  WHERE number = NEW.number OR name = NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
]

/** Seed the immutable candidate ledger (one row, candidate = CANDIDATE). */
async function seedLedger(db: { prepare: (sql: string) => { run: () => Promise<unknown> } }): Promise<void> {
  for (const sql of migrationLedgerDdl) {
    await db.prepare(sql).run()
  }
  await db
    .prepare(
      `INSERT INTO migration_ledger (number, name, checksum, candidate_id)
       VALUES (1, 'b4-acceptance-fixture', '${'f'.repeat(64)}', '${CANDIDATE}')`,
    )
    .run()
}

/** Insert one candidate ledger row through `wrangler d1 execute --local`. */
export function seedLedgerViaD1(state: string): void {
  runD1(state, `
    CREATE TABLE IF NOT EXISTS migration_ledger (
      number INTEGER PRIMARY KEY CHECK(number > 0),
      name TEXT UNIQUE NOT NULL,
      checksum TEXT NOT NULL CHECK(length(checksum) = 64),
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0)
    ) STRICT;
    INSERT INTO migration_ledger (number, name, checksum, candidate_id)
    VALUES (1, 'b4-acceptance-fixture', '${'f'.repeat(64)}', '${CANDIDATE}')`,
  )
}

const identityDdl = [
  `CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_ref INTEGER UNIQUE NOT NULL,
    slug TEXT,
    draft_ref TEXT,
    source_page_identity TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS article_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    snapshot_json TEXT NOT NULL,
    content_snapshot_sha256 TEXT NOT NULL,
    published_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE (article_id, version)
  )`,
]

/**
 * Apply the full batch-4 schema on a wrangler-persisted state: ledger 001
 * base schema + identity + envelope columns + first-publish + scheduled +
 * notifications + email + schedule-control + immutable candidate ledger.
 */
export function applyB4Schema(state: string): void {
  spawnOk('ledger apply', [
    process.execPath, join(repoRoot, 'scripts', 'migrations.mjs'), 'apply',
    '--candidate', CANDIDATE, '--database', 'DB', '--local', '--persist-to', state, '--config', configPath,
  ])
  spawnOk('article-identity ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-article-identity-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('envelope ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-content-envelope-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('first-publish ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-first-publish-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  // Scheduled tables are created through the SAME DDL SQL the module ships
  // (the apply-*-ddl CLI probes PRAGMA without --json and mis-ALTERs a fresh
  // B4-03-shaped install; the fixture must not touch that deployment channel).
  runD1(state, [
    `CREATE TABLE IF NOT EXISTS publish_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
      timezone TEXT NOT NULL CHECK(length(timezone) > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'paused', 'fired', 'stale', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      lease_token TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      stale_reason TEXT,
      fired_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS idx_publish_schedules_due
      ON publish_schedules(status, scheduled_at)`,
    `CREATE TABLE IF NOT EXISTS publish_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
      schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
      attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
      started_at INTEGER NOT NULL CHECK(started_at > 0),
      finished_at INTEGER,
      outcome TEXT CHECK(outcome IN ('fired', 'stale', 'retried', 'failed', 'abandoned', 'cancelled')),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(schedule_id, attempt_no)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS idx_publish_attempts_schedule
      ON publish_attempts(schedule_id, attempt_no)`,
  ].join(';\n'))
  // Notification / email / schedule-control tables have no dedicated CLI apply
  // script for this fixture, so they are created through the exact DDL SQL the
  // modules ship (safe to run repeatedly; never drops/alters).
  runD1(state, [
    `CREATE TABLE IF NOT EXISTS activity_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id TEXT UNIQUE NOT NULL CHECK(length(notification_id) > 0),
      source_type TEXT NOT NULL CHECK(length(source_type) > 0),
      source_id TEXT NOT NULL CHECK(length(source_id) > 0),
      title TEXT NOT NULL CHECK(length(title) > 0),
      detail TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS email_reminder_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL CHECK(length(key) > 0),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      recipients_json TEXT NOT NULL,
      from_address TEXT,
      threshold_seconds INTEGER NOT NULL DEFAULT 0 CHECK(threshold_seconds >= 0),
      quiet_start_minute INTEGER NOT NULL DEFAULT 0 CHECK(quiet_start_minute BETWEEN 0 AND 1439),
      quiet_end_minute INTEGER NOT NULL DEFAULT 0 CHECK(quiet_end_minute BETWEEN 0 AND 1439),
      utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
      cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_seconds >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS email_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK(length(source_type) > 0),
      source_id TEXT NOT NULL CHECK(length(source_id) > 0),
      last_attempt_at INTEGER,
      last_sent_at INTEGER,
      sent_count INTEGER NOT NULL DEFAULT 0 CHECK(sent_count >= 0),
      last_status TEXT NOT NULL DEFAULT 'skipped' CHECK(last_status IN ('skipped', 'sent', 'failed')),
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS schedule_control_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
      schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
      action TEXT NOT NULL CHECK(action IN ('pause', 'reconfirm', 'reschedule', 'cancel', 'publish_now')),
      result TEXT NOT NULL CHECK(length(result) > 0),
      created_at INTEGER NOT NULL
    ) STRICT`,
  ].join(';\n'))
}

/* ------------------------------------------------------------------ */
/* in-process kernel context (wrangler-addressable persist)            */
/* ------------------------------------------------------------------ */

export interface KernelContext {
  dir: string
  db: D1Database
  query: <T = Record<string, unknown>>(sql: string) => Promise<T[]>
  dispose: () => Promise<void>
}

const stateDirs: string[] = []
const contexts: KernelContext[] = []

/** Create an empty state directory (wrangler `--persist-to` root). */
export function createWranglerState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b4-state-'))
  stateDirs.push(dir)
  return dir
}

/** Extract the production database_id from wrangler.toml (no TOML dep). */
function productionDatabaseId(): string {
  const toml = readFileSync(join(repoRoot, 'wrangler.toml'), 'utf8')
  const match = toml.match(/database_id\s*=\s*"([^"]+)"/)
  if (!match) throw new Error('wrangler.toml has no database_id')
  return match[1]
}

/**
 * Boot an in-process Miniflare whose D1 persists into the same `<dir>/v3/d1`
 * layout `wrangler d1 execute --local --persist-to <dir>` reads, with the full
 * batch-4 schema applied through the very DDL channel the deployment scripts
 * use. Returns the wrangler-addressable directory + the live D1 binding.
 */
export async function createKernelContext(dir = createWranglerState()): Promise<KernelContext> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: productionDatabaseId() },
    d1Persist: join(dir, 'v3', 'd1'),
  })
  const db = (await mf.getD1Database('DB')) as D1Database

  for (const statement of splitSqlFile(join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.sql'))) {
    await db.prepare(statement).run()
  }
  for (const statement of identityDdl) await db.prepare(statement).run()
  // #234 Phase A — canonical slug registry + article FTS (kernel dependencies).
  for (const statement of SLUG_ADDRESS_DDL_STATEMENTS) await db.prepare(statement).run()
  for (const statement of ARTICLE_FTS_DDL_STATEMENTS) await db.prepare(statement).run()
  for (const column of ['content_envelope', 'content_snapshot_sha256', 'source_sync_sha256']) {
    await db.prepare(`ALTER TABLE posts ADD COLUMN ${column} TEXT`).run()
  }
  await ensureFirstPublishTables(db)
  await ensureScheduledPublishTables(db)
  await ensureScheduledPublishTables(db) // idempotency (B4-03 additive columns)
  await ensureNotificationTables(db)
  await ensureEmailReminderTables(db)
  await ensureScheduleControlTables(db)
  await seedLedger(db)

  const ctx: KernelContext = {
    dir,
    db,
    query: <T = Record<string, unknown>>(sql: string) =>
      db.prepare(sql).all<T>().then((r) => (r.results ?? []) as T[]),
    dispose: async () => {
      await mf.dispose()
    },
  }
  contexts.push(ctx)
  return ctx
}

/* ------------------------------------------------------------------ */
/* article fixture through the REAL write kernel                       */
/* ------------------------------------------------------------------ */

export interface CreatedArticle {
  articleId: number
  postRef: number
  slug: string
}

function snapshotFor(slug: string, title: string, content: string): ArticleCommandSnapshot {
  return {
    slug,
    title,
    content,
    html: `<p>${content}</p>`,
    description: null,
    category: null,
    tags: null,
    status: 'draft',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: null,
    updated_at: null,
  }
}

let slugCounter = 0
export function freshSlug(prefix: string): string {
  slugCounter += 1
  return `${prefix}-${Date.now()}-${slugCounter}-${Math.floor(Math.random() * 1e6)}`
}

/** Create a draft article through the write kernel (v1 version fact). */
export async function createDraftArticle(
  db: D1Database,
  slug = freshSlug('b4-draft'),
  title = '草稿标题',
  content = '# 草稿正文\n\n一段草稿。',
): Promise<CreatedArticle> {
  const created = await create(db, { creationId: `draft-${slug}`, snapshot: snapshotFor(slug, title, content) })
  if (created.outcome !== 'created') throw new Error(`createDraftArticle failed: ${JSON.stringify(created)}`)
  return { articleId: created.articleId, postRef: created.postRef, slug }
}

export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ */
/* reconcile runner                                                    */
/* ------------------------------------------------------------------ */

export interface ReconcileResult {
  status: number
  stdout: string
  stderr: string
}

export function runReconcileB4(
  state: string,
  report: string,
  extra: string[] = [],
): ReconcileResult {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts', 'reconcile-b4-facts.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
    '--report', report, ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** Tear down every tmpdir created by this file (call in afterAll). */
export async function cleanupB4State(): Promise<void> {
  for (const ctx of contexts.splice(0)) {
    await ctx.dispose().catch(() => undefined)
  }
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export { splitSqlFile }