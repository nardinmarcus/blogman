import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyArticleIdentityDdl,
  applyLedger,
  cleanupStates,
  configPath,
  createState,
  repoRoot,
  runD1,
} from '@/tests/helpers/article-identity-state'
import type { Database } from '@/lib/repositories/schema'
import { appendVersion, getByPostRef, listVersions } from '@/lib/repositories/articles'

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function createDatabase(state: string): Database {
  class Statement {
    constructor(private readonly sql: string, private readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values) }
    render() {
      let index = 0
      return this.sql.replace(/\?/g, () => literal(this.values[index++]))
    }
    async all<T>() {
      const result = runD1(state, this.render()).at(-1)
      return { results: (result?.results || []) as T[], success: result?.success ?? true, meta: result?.meta || {} }
    }
    async first<T>() { return (await this.all<T>()).results[0] ?? null }
    async run<T>() { return this.all<T>() }
  }
  return {
    prepare(sql: string) { return new Statement(sql) },
    async batch(statements: Statement[]) {
      const results = []
      for (const s of statements) results.push(await s.run())
      return results
    },
  } as unknown as Database
}

afterEach(() => cleanupStates())

describe('lib/repositories/articles', () => {
  it('appendVersion is idempotent by operation_id and monotonic by version', { timeout: 300_000 }, async () => {
    const state = createState()
    applyLedger(state)
    applyArticleIdentityDdl(state)
    runD1(state, "INSERT INTO articles (post_ref) VALUES (101)")
    const db = createDatabase(state)
    const articleId = runD1(state, 'SELECT id FROM articles WHERE post_ref = 101').at(-1)?.results?.[0]?.id as number

    const v1 = await appendVersion(db, articleId, {
      operationId: 'op-a',
      snapshotJson: JSON.stringify({ version: 1 }),
      contentSnapshotSha256: 'a'.repeat(64),
      publishedAt: 1_700_000_000,
    })
    expect(v1.version).toBe(1)

    const v2 = await appendVersion(db, articleId, {
      operationId: 'op-b',
      snapshotJson: JSON.stringify({ version: 2 }),
      contentSnapshotSha256: 'b'.repeat(64),
      publishedAt: null,
    })
    expect(v2.version).toBe(2)

    const v3 = await appendVersion(db, articleId, {
      operationId: 'op-c',
      snapshotJson: JSON.stringify({ version: 3 }),
      contentSnapshotSha256: 'c'.repeat(64),
      publishedAt: null,
    })
    expect(v3.version).toBe(3)

    // Idempotent: same operation_id returns the existing version, no new row.
    const again = await appendVersion(db, articleId, {
      operationId: 'op-b',
      snapshotJson: JSON.stringify({ version: 999 }),
      contentSnapshotSha256: 'z'.repeat(64),
      publishedAt: null,
    })
    expect(again.id).toBe(v2.id)
    expect(again.version).toBe(2)
    const versions = await listVersions(db, articleId)
    expect(versions).toHaveLength(3)
    // Monotonic + newest-first ordering.
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1])

    // published_at round-trips (null and value).
    expect(versions.find((v) => v.version === 1)?.published_at).toBe(1_700_000_000)
    expect(versions.find((v) => v.version === 2)?.published_at).toBeNull()
  })

  it('getByPostRef returns the identity and preserves the not-guessed NULL identity columns', { timeout: 300_000 }, async () => {
    const state = createState()
    applyLedger(state)
    applyArticleIdentityDdl(state)
    runD1(state, "INSERT INTO articles (post_ref) VALUES (7)")
    const db = createDatabase(state)

    const ident = await getByPostRef(db, 7)
    expect(ident).not.toBeNull()
    expect(ident!.post_ref).toBe(7)
    expect(ident!.slug).toBeNull()
    expect(ident!.draft_ref).toBeNull()
    expect(ident!.source_page_identity).toBeNull()

    expect(await getByPostRef(db, 999)).toBeNull()
  })
})
