/**
 * B6-G — shared state helpers for the batch-6 acceptance fixture tests
 * (issue #56).
 *
 * Two complementary ways to build a D1 state the reconciler can read:
 *
 *   - `createWranglerState()` + `applyB6Schema(state)` + `runD1` build a state
 *     purely through `wrangler d1 execute --local --persist-to <dir>`: the
 *     same channel `scripts/reconcile-b6-facts.mjs` reads. Used for the
 *     SQL-seeded aligned / candidate / corruption fixtures.
 *
 *   - `createKernelContext()` boots ONE in-process Miniflare instance whose
 *     D1 persists into the SAME `v3/d1` layout `wrangler --local --persist-to
 *     <dir>` reads. This lets the scenario tests drive the REAL batch-6
 *     kernels (identity / link / confirm / sync / write-back / conflict /
 *     availability / relink) against a real D1 binding and then hand the
 *     resulting fact state to the read-only reconciler.
 *
 * Zero production: everything is local / tmpdir, the reconciler only ever
 * issues SELECT statements, and every provider is the in-memory mock.
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
import { SLUG_ADDRESS_DDL_STATEMENTS } from '@/lib/slug-address/ddl'
import { ARTICLE_FTS_DDL_STATEMENTS } from '@/lib/article-fts/ddl'
import { ensurePublishRevisionTables } from '@/lib/publish-revision/ddl'
import { ensureSlugAddressTables } from '@/lib/slug-address'
import { SOURCE_IDENTITY_DDL_STATEMENTS } from '@/lib/source-identity'
import { SOURCE_CONFLICT_DDL_STATEMENTS } from '@/lib/source-conflict'
import { SOURCE_AVAILABILITY_DDL_STATEMENTS } from '@/lib/source-availability'

export { configPath, repoRoot, runD1, wranglerPath, spawnOk }

export const CANDIDATE = 'b6'.padEnd(40, '6')

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
    VALUES (1, 'b6-acceptance-fixture', '${'e'.repeat(64)}', '${CANDIDATE}')`,
  )
}

/** Seed the immutable candidate ledger (one row, candidate = CANDIDATE). */
export async function seedLedger(db: { prepare: (sql: string) => { run: () => Promise<unknown> } }): Promise<void> {
  for (const sql of migrationLedgerDdl) {
    await db.prepare(sql).run()
  }
  await db
    .prepare(
      `INSERT INTO migration_ledger (number, name, checksum, candidate_id)
       VALUES (1, 'b6-acceptance-fixture', '${'e'.repeat(64)}', '${CANDIDATE}')`,
    )
    .run()
}

/**
 * Apply the full batch-6 schema on a wrangler-persisted state through the very
 * DDL channel the deployment scripts use: ledger 001 + article-identity +
 * envelope + first-publish + revision + slug-address + source-identity +
 * conflict (union baseline + sync + write-back + resolutions) + availability.
 */
export function applyB6Schema(state: string): void {
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
  spawnOk('publish-revision ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-publish-revision-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('slug-address ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-slug-address-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('source-identity ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-source-identity-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  // The union baseline + sync + write-back + conflict tables come from the
  // conflict DDL channel (the single-owner union shape).
  spawnOk('conflict ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-conflict-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  // The availability DDL script shells out to `npx` which fails inside the
  // test sandbox — apply the exact module DDL directly (idempotent), matching
  // the B4-03 scheduled-table approach.
  runD1(state, [
    `CREATE TABLE IF NOT EXISTS source_availability_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_identity_id INTEGER NOT NULL CHECK(source_identity_id > 0),
      operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
      outcome TEXT NOT NULL CHECK(outcome IN ('readable', 'temporarily-unavailable', 'confirmed-missing')),
      detail TEXT,
      observed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS idx_source_avail_identity
       ON source_availability_observations(source_identity_id, observed_at)`,
    `CREATE TABLE IF NOT EXISTS source_baseline_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_identity_id INTEGER NOT NULL UNIQUE CHECK(source_identity_id > 0),
      content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
      advanced_by_operation_id TEXT NOT NULL CHECK(length(advanced_by_operation_id) > 0),
      advanced_at INTEGER NOT NULL
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
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b6-state-'))
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
 * layout `wrangler d1 execute --local --persist-to <dir>` reads. The full
 * batch-6 schema is applied through the ledger + the DDL statements the
 * modules ship.
 */
export async function createKernelContext(dir = createWranglerState()): Promise<KernelContext> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: productionDatabaseId() },
    d1Persist: join(dir, 'v3', 'd1'),
  })
  const db = (await mf.getD1Database('DB')) as D1Database

  // Ledger 001 + article-identity + envelope columns (the bootstrapState
  // surface) applied directly on THIS Miniflare db so the wrangler-addressable
  // sqlite carries the full schema.
  for (const statement of splitSqlFile(join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.sql'))) {
    await db.prepare(statement).run()
  }
  const idDdl = [
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
  for (const statement of idDdl) await db.prepare(statement).run()
  // #234 Phase A — canonical slug registry + article FTS (kernel dependencies).
  for (const statement of SLUG_ADDRESS_DDL_STATEMENTS) await db.prepare(statement).run()
  for (const statement of ARTICLE_FTS_DDL_STATEMENTS) await db.prepare(statement).run()
  for (const column of ['content_envelope', 'content_snapshot_sha256', 'source_sync_sha256']) {
    await db.prepare(`ALTER TABLE posts ADD COLUMN ${column} TEXT`).run()
  }
  await ensureFirstPublishTables(db)
  await ensurePublishRevisionTables(db)
  await ensureSlugAddressTables(db)
  await seedLedger(db)
  // Miniflare-only accommodation (see the B6-04 tests): the ledger's FTS
  // external-content triggers corrupt on markdown-image parens — FTS is a
  // search projection irrelevant to the source-chain surface.
  await db.prepare('DROP TRIGGER IF EXISTS posts_ai').run()
  await db.prepare('DROP TRIGGER IF EXISTS posts_au').run()
  await db.prepare('DROP TRIGGER IF EXISTS posts_ad').run()
  await db.prepare('DROP TABLE IF EXISTS posts_fts').run()
  for (const stmt of SOURCE_IDENTITY_DDL_STATEMENTS) await db.prepare(stmt).run()
  for (const stmt of SOURCE_CONFLICT_DDL_STATEMENTS) await db.prepare(stmt).run()
  for (const stmt of SOURCE_AVAILABILITY_DDL_STATEMENTS) await db.prepare(stmt).run()

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

export function snapshotFor(slug: string, title: string, content: string, status: 'draft' | 'published' = 'draft') {
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
  slug = freshSlug('b6-formal'),
  title = '正式文章标题',
  content = '# 正式正文\n\n一段正式正文。',
): Promise<CreatedFormalArticle> {
  const { create } = await import('@/lib/article-commands')
  const { preparePublish, confirmPublish } = await import('@/lib/first-publish')
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
    actor: 'b6fixture',
  })
  if (prepared.outcome !== 'prepared') throw new Error(`createFormalArticle prepare failed: ${JSON.stringify(prepared)}`)
  const confirmed = await confirmPublish(db, {
    intentId: `intent-${slug}`,
    prepareId: prepared.prepareId,
    articleId,
    expectedVersion: 1,
    actor: 'b6fixture',
    siteUrl: TEST_SITE_URL,
  })
  if (confirmed.outcome !== 'delivered') throw new Error(`createFormalArticle confirm failed: ${JSON.stringify(confirmed)}`)
  return { articleId, postRef: created.postRef, slug }
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

export function runReconcileB6(
  state: string,
  report: string,
  extra: string[] = [],
): ReconcileResult {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts', 'reconcile-b6-facts.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
    '--report', report, ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** Tear down every tmpdir created by this file (call in afterAll). */
export async function cleanupB6State(): Promise<void> {
  for (const ctx of contexts.splice(0)) {
    await ctx.dispose().catch(() => undefined)
  }
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
