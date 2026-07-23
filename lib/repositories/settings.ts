import type { Database } from '@/lib/repositories/schema'
import type { SettingRow } from '@/lib/repositories/types'
import { throwDatabaseMigrationRequired } from '@/lib/database-errors'

// ── 站点设置 ──
export async function getSetting(db: Database, key: string): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT value FROM site_settings WHERE key = ?')
      .bind(key)
      .first<SettingRow>()
    return row?.value ?? null
  } catch (error) {
    throwDatabaseMigrationRequired(error)
  }
}

export async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)').bind(key, value).run()
}
