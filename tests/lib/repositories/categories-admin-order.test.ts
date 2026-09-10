/**
 * #244 regression — admin category ordering keeps repositories.getSetting
 * failure semantics.
 *
 * `getCategoryOrder` on the ADMIN path (getCategories / updateCategory /
 * deleteCategory) must read through raw `getSetting`: ANY DB error is
 * thrown (schema faults reclassified as DATABASE_MIGRATION_REQUIRED, other
 * faults propagate verbatim). The #244 public batch degrades non-migration
 * faults to defaults — that swallowing must NOT reach the admin write flow,
 * where silently treating category_order as unset would reorder/lose the
 * operator's saved ordering.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapState, teardownState, createDatabase, query } from '@/tests/lib/article-commands/helpers'
import { getCategories, reorderCategories } from '@/lib/db'
import { DatabaseMigrationRequiredError } from '@/lib/database-errors'

let state = ''
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-244-admin-order-'))
  cleanup.push(state)
  await bootstrapState(state)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('lib/repositories/categories — #244 admin ordering failure semantics', { timeout: 600_000 }, () => {
  it('非 schema DB 故障时 admin 读序抛出原始错误（不得吞成空序）', async () => {
    await query(`INSERT OR IGNORE INTO categories (name, slug) VALUES ('甲', 'jia'), ('乙', 'yi')`)
    await reorderCategories(createDatabase(), ['yi', 'jia'])

    // Simulate a NON-schema DB fault (connection/timeout style): make the
    // site_settings read fail with a plain runtime error.
    const db = createDatabase()
    const original = db.prepare.bind(db)
    ;(db as { prepare: unknown }).prepare = (sql: string) => {
      if (/site_settings/.test(sql)) {
        throw new Error('D1_ERROR: connection reset by peer')
      }
      return original(sql)
    }

    // Old (#244-broken) behavior returned [] and succeeded — must instead throw.
    await expect(getCategories(db)).rejects.toThrow('connection reset by peer')
  })

  it('schema 故障仍重分类为 DATABASE_MIGRATION_REQUIRED', async () => {
    const db = createDatabase()
    const original = db.prepare.bind(db)
    ;(db as { prepare: unknown }).prepare = (sql: string) => {
      if (/site_settings/.test(sql)) {
        throw new Error('D1_ERROR: no such table: site_settings: SQLITE_ERROR')
      }
      return original(sql)
    }

    await expect(getCategories(db)).rejects.toBeInstanceOf(DatabaseMigrationRequiredError)
  })
})
