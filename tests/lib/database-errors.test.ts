import { describe, expect, it } from 'vitest'
import {
  DatabaseMigrationRequiredError,
  getDatabaseMigrationRequiredError,
  migrationRequiredResponse,
} from '@/lib/database-errors'

describe('database migration error classification', () => {
  it.each([
    'D1_ERROR: no such table: site_settings',
    'D1_ERROR: no such column: posts.deleted_at',
    'table ai_actions has no column named profile_id',
  ])('classifies schema failures without exposing the D1 message: %s', async (message) => {
    const classified = getDatabaseMigrationRequiredError(new Error(message))

    expect(classified).toBeInstanceOf(DatabaseMigrationRequiredError)
    expect(classified?.code).toBe('DATABASE_MIGRATION_REQUIRED')
    expect(classified?.message).not.toContain(message)

    const response = migrationRequiredResponse(classified)
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toEqual({
      error: '数据库结构未就绪，请先运行账本迁移',
      code: 'DATABASE_MIGRATION_REQUIRED',
    })
  })

  it('does not misclassify unrelated runtime failures', () => {
    expect(getDatabaseMigrationRequiredError(new Error('provider timeout'))).toBeNull()
    expect(migrationRequiredResponse(new Error('provider timeout'))).toBeNull()
  })
})
