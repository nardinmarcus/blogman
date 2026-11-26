-- Rebuild and extend only the table shapes that migration 008 records.
WITH expected_tables(name, sql) AS (
  VALUES
    ('publish_schedules', 'CREATE TABLE publish_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
      timezone TEXT NOT NULL CHECK(length(timezone) > 0),
      status TEXT NOT NULL CHECK(status IN (''pending'', ''claimed'', ''fired'', ''stale'', ''cancelled'')),
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
    ) STRICT'),
    ('wechat_draft_tasks', 'CREATE TABLE wechat_draft_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL CHECK(length(task_id) > 0),
      article_id INTEGER NOT NULL CHECK(article_id > 0),
      post_ref INTEGER NOT NULL CHECK(post_ref > 0),
      version INTEGER NOT NULL CHECK(version > 0),
      account_id TEXT NOT NULL CHECK(length(account_id) > 0),
      status TEXT NOT NULL CHECK(status IN (''draft'', ''submitted'', ''failed'', ''superseded'')),
      title TEXT NOT NULL,
      html_projection TEXT NOT NULL,
      plaintext_projection TEXT NOT NULL,
      cover_image_url TEXT,
      digest TEXT,
      content_sha256 TEXT NOT NULL CHECK(content_sha256 = '''' OR length(content_sha256) = 64),
      projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64),
      source_url TEXT NOT NULL CHECK(length(source_url) > 0),
      remote_draft_id TEXT,
      provider_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (article_id, version, account_id)
    ) STRICT')
)
SELECT expected_tables.name || ' shape differs from migration 008' AS issue
FROM expected_tables
JOIN sqlite_schema ON sqlite_schema.type = 'table' AND sqlite_schema.name = expected_tables.name
WHERE sqlite_schema.sql IS NOT expected_tables.sql
ORDER BY issue;
