/**
 * B5-G — shared state helpers for the batch-5 acceptance fixture tests
 * (issue #49).
 *
 * Two complementary ways to build a D1 state the reconciler can read:
 *
 *   - `createWranglerState()` + `applyB5Schema(state)` + `runD1` build a state
 *     purely through `wrangler d1 execute --local --persist-to <dir>`: the
 *     same channel `scripts/reconcile-b5-facts.mjs` reads. Used for the
 *     SQL-seeded aligned / candidate / corruption fixtures.
 *
 *   - `createKernelContext()` boots ONE in-process Miniflare instance whose
 *     D1 persists into the SAME `v3/d1` layout `wrangler --local --persist-to
 *     <dir>` reads (verified experimentally in B4-G: the metadata hash is
 *     derived from the production database_id, so both engines address the
 *     same sqlite file). This lets the scenario tests drive the REAL batch-5
 *     kernels (deriveWechatDraft / saveWechatDraftSettings /
 *     runWechatDraftExecutor / reconcileWechatDraft / replaceWechatDraft)
 *     against a real D1 binding and then hand the resulting fact state to the
 *     read-only reconciler.
 *
 * Zero production: everything is local / tmpdir, the reconciler only ever
 * issues SELECT statements, and the provider is always the in-memory mock
 * (不真调微信 API).
 */

import { Miniflare } from 'miniflare'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { ensurePublishRevisionTables } from '@/lib/publish-revision/ddl'
import { ensureSlugAddressTables } from '@/lib/slug-address'
import { ensureWechatDraftTables } from '@/lib/wechat-draft/ddl'
import { create, save } from '@/lib/article-commands'
import { confirmPublish, preparePublish } from '@/lib/first-publish'
import { promoteRevision } from '@/lib/publish-revision'
import { type ArticleCommandSnapshot } from '@/lib/article-commands/types'

export { configPath, repoRoot, runD1, wranglerPath, spawnOk }

export const CANDIDATE = 'b5'.padEnd(40, '5')

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
    VALUES (1, 'b5-acceptance-fixture', '${'e'.repeat(64)}', '${CANDIDATE}')`,
  )
}

/** Seed the immutable candidate ledger (one row, candidate = CANDIDATE). */
async function seedLedger(db: { prepare: (sql: string) => { run: () => Promise<unknown> } }): Promise<void> {
  for (const sql of migrationLedgerDdl) {
    await db.prepare(sql).run()
  }
  await db
    .prepare(
      `INSERT INTO migration_ledger (number, name, checksum, candidate_id)
       VALUES (1, 'b5-acceptance-fixture', '${'e'.repeat(64)}', '${CANDIDATE}')`,
    )
    .run()
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
 * Apply the full batch-5 schema on a wrangler-persisted state through the very
 * DDL channel the deployment scripts use: ledger 001 + article-identity +
 * envelope + first-publish + wechat-draft (settings/generations/replacements).
 */
export function applyB5Schema(state: string): void {
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
  // The batch-5 wechat tables are created directly through the exact DDL SQL
  // the modules ship (the apply-wechat-draft-ddl CLI probes PRAGMA without
  // --json and mis-ALTERs a fresh install — this fixture must not touch that
  // deployment quirk, mirroring the B4-03 scheduled-table approach).
  runD1(state, [
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
      revision INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      classification TEXT,
      needs_author INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT,
      claimed_at INTEGER,
      lease_token TEXT,
      lease_expires_at INTEGER,
      generation INTEGER NOT NULL DEFAULT 1,
      settings_revision INTEGER NOT NULL DEFAULT 0,
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
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b5-state-'))
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
 * batch-5 schema applied through the DDL channel the B5 modules ship. Returns
 * the wrangler-addressable directory + the live D1 binding.
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
  for (const column of ['content_envelope', 'content_snapshot_sha256', 'source_sync_sha256']) {
    await db.prepare(`ALTER TABLE posts ADD COLUMN ${column} TEXT`).run()
  }
  await ensureFirstPublishTables(db)
  await ensurePublishRevisionTables(db)
  await ensureSlugAddressTables(db)
  await ensureWechatDraftTables(db)
  await ensureWechatDraftTables(db) // DDL idempotency (B5-02/03 additive columns)
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
/* formal-article fixture through the REAL write kernels               */
/* ------------------------------------------------------------------ */

export interface CreatedFormalArticle {
  articleId: number
  postRef: number
  slug: string
}

const TEST_SITE_URL = 'https://blog.example.test'

function snapshotFor(slug: string, title: string, content: string, status: 'draft' | 'published' = 'draft'): ArticleCommandSnapshot {
  return {
    slug,
    title,
    content,
    html: `<p>${content}</p>`,
    description: null,
    category: null,
    tags: null,
    status,
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: status === 'published' ? 1_700_000_000 : null,
    updated_at: null,
  }
}

let slugCounter = 0
export function freshSlug(prefix: string): string {
  slugCounter += 1
  return `${prefix}-${Date.now()}-${slugCounter}-${Math.floor(Math.random() * 1e6)}`
}

/** Create a draft then formally FIRST-publish it at version 1 (B3-01 loop). */
export async function createFormalArticle(
  db: D1Database,
  slug = freshSlug('b5-formal'),
  title = '正式文章标题',
  content = '# 正式正文\n\n一段正式正文。',
): Promise<CreatedFormalArticle> {
  const snapshot = snapshotFor(slug, title, content, 'published')
  const created = await create(db, { creationId: `formal-${slug}`, snapshot })
  if (created.outcome !== 'created') throw new Error(`createFormalArticle create failed: ${JSON.stringify(created)}`)

  const articleId = created.articleId
  const hashRow = (
    await db.prepare(
      `SELECT content_snapshot_sha256 FROM article_versions
       WHERE article_id = ? AND version = 1 ORDER BY id DESC LIMIT 1`,
    ).bind(articleId).first<{ content_snapshot_sha256: string }>()
  )
  const prepared = await preparePublish(db, {
    prepareId: `prep-${slug}`,
    articleId,
    confirmedVersion: 1,
    slug,
    title,
    contentSha256: hashRow?.content_snapshot_sha256 ?? '',
    actor: 'b5fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`createFormalArticle prepare failed: ${JSON.stringify(prepared)}`)

  const confirmed = await confirmPublish(db, {
    intentId: `intent-${slug}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b5fixture',
    siteUrl: TEST_SITE_URL,
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`createFormalArticle confirm failed: ${JSON.stringify(confirmed)}`)

  return { articleId, postRef: created.postRef, slug }
}

let opSeq = 0
function freshOp(prefix: string): string {
  opSeq += 1
  return `${prefix}-${Date.now()}-${opSeq}`
}

/** Edit + promote the formal article — the formal version moves 1 → 2. */
export async function promoteToVersion2(
  db: D1Database,
  article: CreatedFormalArticle,
  title = '升级后的标题',
  content = '# 升级正文\n\n升级后的正式正文。',
): Promise<{ articleId: number; postRef: number; slug: string; version: 2 }> {
  const saved = await save(db, {
    articleId: article.articleId,
    expectedVersion: 1,
    operationId: freshOp('b5-save'),
    snapshot: snapshotFor(article.slug, title, content, 'published'),
  })
  if (saved.outcome !== 'applied') throw new Error(`promoteToVersion2 save failed: ${JSON.stringify(saved)}`)

  const promoted = await promoteRevision(db, {
    revisionId: `revision:${article.articleId}:v1`,
    actor: 'b5fixture',
    siteUrl: TEST_SITE_URL,
  })
  if (promoted.outcome !== 'promoted') throw new Error(`promoteToVersion2 failed: ${JSON.stringify(promoted)}`)

  return { articleId: article.articleId, postRef: article.postRef, slug: article.slug, version: 2 }
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

export function runReconcileB5(
  state: string,
  report: string,
  extra: string[] = [],
): ReconcileResult {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts', 'reconcile-b5-facts.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
    '--report', report, ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** Tear down every tmpdir created by this file (call in afterAll). */
export async function cleanupB5State(): Promise<void> {
  for (const ctx of contexts.splice(0)) {
    await ctx.dispose().catch(() => undefined)
  }
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export { splitSqlFile }
