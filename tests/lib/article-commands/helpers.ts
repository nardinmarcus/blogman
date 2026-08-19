/**
 * B2-03 — isolated D1 test adapter for the versioned write command kernel.
 *
 * Uses the same real local D1 (wrangler d1 execute --local --persist-to) as the
 * B2-02 repository tests. Differences from the repository adapter:
 *
 *   - `batch()` executes every statement in ONE `wrangler d1 execute --command`
 *     call, so a mid-batch constraint failure rolls back the whole batch —
 *     real D1 transaction semantics (verified experimentally).
 *   - staleness injection: a prepared statement whose rendered SQL contains a
 *     registered fragment returns canned rows for standalone reads, simulating
 *     the pre-read/batch race window for concurrency tests. `batch()` always
 *     executes against the real state.
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Database } from '@/lib/repositories/schema'
import {
  applyArticleIdentityDdl,
  applyLedger,
  configPath,
  repoRoot,
  runD1,
  wranglerPath,
} from '@/tests/helpers/article-identity-state'

export function applyContentEnvelopeDdl(state: string): void {
  const ddlPath = join(repoRoot, 'scripts', 'apply-content-envelope-ddl.mjs')
  const result = spawnSync(
    process.execPath,
    [ddlPath, '--local', '--persist-to', state, '--database', 'DB', '--config', configPath],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`content-envelope ddl failed: ${result.stderr || result.stdout}`)
  }
}

/** Bootstrap the full schema (ledger + article-identity + envelope columns). */
export function bootstrapState(state: string): void {
  applyLedger(state)
  applyArticleIdentityDdl(state)
  applyContentEnvelopeDdl(state)
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

export interface StaleRead {
  /** Match against the rendered SQL of a standalone (non-batch) statement. */
  sqlIncludes: string
  /** Canned rows returned by first()/all(). */
  rows: unknown[]
  /** Served at most this many times (default 1) — later reads hit the real state. */
  remaining?: number
}

function executeCommand(state: string, sql: string): Array<{ results?: unknown[]; success?: boolean }> {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', state,
    '--config', configPath, '--command', sql, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `d1 execute failed (${result.stderr ? 'stderr' : 'stdout'}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`,
    )
  }
  return JSON.parse(result.stdout) as Array<{ results?: unknown[]; success?: boolean }>
}

export interface TestDatabaseOptions {
  stale?: StaleRead[]
}

export function createDatabase(state: string, options: TestDatabaseOptions = {}): Database {
  const stale = options.stale ?? []

  class Statement {
    constructor(
      private readonly sql: string,
      private readonly values: unknown[] = [],
      private readonly isStale: boolean = false,
    ) {}

    bind(...values: unknown[]): Statement {
      return new Statement(this.sql, values, this.isStale)
    }

    render(): string {
      let index = 0
      return this.sql.replace(/\?/g, () => literal(this.values[index++]))
    }

    private canned(): unknown[] | null {
      const rendered = this.render()
      for (const read of stale) {
        if (rendered.includes(read.sqlIncludes)) {
          if ((read.remaining ?? 1) > 0) {
            read.remaining = (read.remaining ?? 1) - 1
            return read.rows
          }
        }
      }
      return null
    }

    async all<T>(): Promise<{ results: T[]; success: boolean }> {
      const rows = this.canned()
      if (rows !== null) return { results: rows as T[], success: true }
      const out = executeCommand(state, this.render())
      return { results: (out.at(-1)?.results ?? []) as T[], success: true }
    }

    async first<T>(): Promise<T | null> {
      return (await this.all<T>()).results[0] ?? null
    }

    async run<T>(): Promise<{ meta: Record<string, unknown>; results: T[]; success: boolean }> {
      const { results } = await this.all<T>()
      return { meta: {}, results, success: true }
    }
  }

  return {
    prepare(sql: string): Statement {
      return new Statement(sql)
    },
    async batch(statements: Statement[]): Promise<Array<{ meta: Record<string, unknown>; results: unknown[]; success: boolean }>> {
      // One wrangler call => one real D1 transaction. A failing statement
      // aborts (and rolls back) the whole batch.
      const sql = statements.map((statement) => statement.render()).join(';\n')
      const out = executeCommand(state, sql)
      return out.map((entry) => ({
        meta: {},
        results: (entry.results ?? []) as unknown[],
        success: entry.success ?? true,
      }))
    },
  } as unknown as Database
}

/** Convenience: run a SQL command against the state and return the last result rows. */
export function query<T>(state: string, sql: string): T[] {
  return (runD1(state, sql).at(-1)?.results ?? []) as T[]
}
