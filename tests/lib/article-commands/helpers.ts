/**
 * B2-03 — in-process D1 test adapter for the versioned write command kernel.
 *
 * One `Miniflare` instance (the same workerd engine the wrangler CLI uses)
 * is bootstrapped ONCE per test file and shared by every test — zero wrangler
 * CLI spawns during test execution. The schema subset mirrors what the
 * command layer actually writes:
 *
 *   - ledger migration 001 (posts incl. FTS triggers, categories, settings,
 *     ai_actions, api_tokens…) — later migrations only add unrelated tables
 *     the kernel never reads or writes,
 *   - the B2-02 article-identity DDL (articles + article_versions), mirrored
 *     verbatim from scripts/apply-article-identity-ddl.mjs,
 *   - the B2-01b envelope columns (content_envelope, *sha256) on `posts`,
 *     mirrored from scripts/apply-content-envelope-ddl.mjs.
 *
 * `db.batch()` goes straight to the real D1 binding, so multi-statement
 * batches have genuine transaction semantics (mid-batch failure rolls back
 * everything — verified experimentally). Staleness injection lets standalone
 * (pre-read) statements return canned rows to simulate the pre-read/batch
 * race window; batch statements always execute against the live state.
 */

import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '@/lib/repositories/schema'
import { repoRoot } from '@/tests/helpers/article-identity-state'

let mf: Miniflare | null = null
let sharedDb: D1Database | null = null

/**
 * Split a ledger SQL file into single statements. Handles `CREATE TRIGGER
 * BEGIN … END` bodies that contain internal `;` separators.
 */
export function splitSqlFile(filePath: string): string[] {
  const raw = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  const statements: string[] = []
  let pending = ''
  for (const part of raw.split(';')) {
    pending = pending ? `${pending};${part}` : part
    const trimmed = pending.trim()
    if (trimmed.startsWith('CREATE TRIGGER') && !/END\s*$/.test(trimmed)) continue
    if (trimmed) statements.push(trimmed)
    pending = ''
  }
  return statements
}

export interface BootstrapOptions {
  /**
   * #234 Phase A — drop the legacy `posts` / `posts_fts` tables (and their FTS
   * triggers) after the ledger migration so any residual kernel reference
   * fails loudly. Proves the write kernels work against canonical facts only.
   */
  postsless?: boolean
}

/** Bootstrap the shared in-process D1 for the whole test file. */
export async function bootstrapState(stateDir: string, options: BootstrapOptions = {}): Promise<void> {
  const { postsless = false } = options
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'b203-command-kernel' },
    persist: stateDir,
  })
  sharedDb = (await mf.getD1Database('DB')) as D1Database

  for (const statement of splitSqlFile(join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.sql'))) {
    await sharedDb.prepare(statement).run()
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
  for (const statement of identityDdl) await sharedDb.prepare(statement).run()

  // B3-04 slug address registry — the single slug authority (ADR 0009).
  // Idempotent; applied in both modes so every suite sees the same surfaces.
  const { SLUG_ADDRESS_DDL_STATEMENTS } = await import('@/lib/slug-address/ddl')
  for (const statement of SLUG_ADDRESS_DDL_STATEMENTS) await sharedDb.prepare(statement).run()

  // #234 — canonical article search index (rebuildable, projection-free).
  const { ARTICLE_FTS_DDL_STATEMENTS } = await import('@/lib/article-fts/ddl')
  for (const statement of ARTICLE_FTS_DDL_STATEMENTS) await sharedDb.prepare(statement).run()

  if (postsless) {
    for (const trigger of ['posts_ai', 'posts_au', 'posts_ad']) {
      await sharedDb.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run()
    }
    await sharedDb.prepare('DROP TABLE IF EXISTS posts_fts').run()
    await sharedDb.prepare('DROP TABLE IF EXISTS posts').run()
    return
  }

  for (const column of ['content_envelope', 'content_snapshot_sha256', 'source_sync_sha256']) {
    await sharedDb.prepare(`ALTER TABLE posts ADD COLUMN ${column} TEXT`).run()
  }
}

export async function teardownState(): Promise<void> {
  sharedDb = null
  await mf?.dispose()
  mf = null
}

export interface StaleRead {
  /** Match against the SQL template of a standalone (non-batch) statement. */
  sqlIncludes: string
  /** Canned rows returned by first()/all(). */
  rows: unknown[]
  /** Served at most this many times (default 1) — later reads hit the live state. */
  remaining?: number
}

export interface TestDatabaseOptions {
  stale?: StaleRead[]
}

class CommandStatement {
  private readonly values: unknown[] = []

  constructor(
    private readonly db: D1Database,
    private readonly sql: string,
    private readonly stale: StaleRead[],
  ) {}

  bind(...values: unknown[]): CommandStatement {
    const next = new CommandStatement(this.db, this.sql, this.stale)
    next.values.push(...values)
    return next
  }

  prepared(): D1PreparedStatement {
    return this.db.prepare(this.sql).bind(...this.values)
  }

  private canned(): unknown[] | null {
    for (const read of this.stale) {
      if ((read.remaining ?? 1) > 0 && this.sql.includes(read.sqlIncludes)) {
        read.remaining = (read.remaining ?? 1) - 1
        return read.rows
      }
    }
    return null
  }

  async all<T>(): Promise<{ results: T[]; success?: boolean }> {
    const rows = this.canned()
    if (rows !== null) return { results: rows as T[], success: true }
    return this.prepared().all<T>()
  }

  async first<T>(): Promise<T | null> {
    const rows = this.canned()
    if (rows !== null) return (rows as T[])[0] ?? null
    return this.prepared().first<T>()
  }

  async run(): Promise<{ meta: { last_row_id: number }; results?: unknown[]; success?: boolean }> {
    const rows = this.canned()
    if (rows !== null) return { meta: { last_row_id: 0 }, results: rows, success: true }
    return this.prepared().run()
  }
}

/** Wraps the shared D1 binding; `batch()` delegates to the real binding. */
export function createDatabase(options: TestDatabaseOptions = {}): Database {
  const db = sharedDb
  if (!db) throw new Error('createDatabase: bootstrapState() must run first')
  const stale = [...(options.stale ?? [])]
  return {
    prepare(sql: string): CommandStatement {
      return new CommandStatement(db, sql, stale)
    },
    async batch(statements: CommandStatement[]): Promise<Array<{ results: unknown[]; meta: { last_row_id: number } }>> {
      return db.batch(statements.map((statement) => statement.prepared()))
    },
  } as unknown as Database
}

/** Convenience: run a SQL command against the shared live state. */
export async function query<T>(sql: string): Promise<T[]> {
  if (!sharedDb) throw new Error('query: bootstrapState() must run first')
  const { results } = await sharedDb.prepare(sql).all<T>()
  return results
}