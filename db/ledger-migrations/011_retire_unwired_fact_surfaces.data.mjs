const TABLES = [
  'wechat_draft_replacements',
  'wechat_draft_generations',
  'wechat_draft_settings',
  'wechat_draft_attempts',
  'wechat_draft_tasks',
  'source_refresh_records',
  'source_refresh_proposals',
  'source_baseline_facts',
  'source_availability_observations',
  'source_conflict_resolutions',
  'source_write_back_intents',
  'source_sync_attempts',
  'source_media_mappings',
  'source_sync_baselines',
  'media_assets',
  'email_deliveries',
  'email_reminder_config'
]

export async function prepare({ query }) {
  const present = new Set(
    query("SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name),
  )
  const existing = TABLES.filter((name) => present.has(name))
  if (existing.length === 0) return ''

  const countSql = existing.map((name) => `(SELECT COUNT(*) FROM ${name})`).join(' + ')
  const [row] = query(`SELECT ${countSql} AS count`)
  const count = Number(row?.count)
  if (count > 0) {
    throw new Error(`retired fact surfaces still hold ${count} row(s); export or migrate them before dropping the tables`)
  }

  return `
CREATE TABLE __blogman_migration_011_empty_guard (
  verified INTEGER NOT NULL,
  CONSTRAINT "retired fact surfaces gained rows after migration preparation"
    CHECK(verified = 1)
);
INSERT INTO __blogman_migration_011_empty_guard (verified)
SELECT CASE WHEN (${countSql}) = 0 THEN 1 ELSE 0 END;
DROP TABLE __blogman_migration_011_empty_guard;
`.trim()
}
