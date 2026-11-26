-- migration-number: 010
-- Align two tables that the out-of-band DDL channel never upgraded in place
-- (CREATE TABLE IF NOT EXISTS leaves an existing table untouched):
-- * publish_schedules gains the 'paused' status the #41 schedule controls
--   write (SQLite cannot alter a CHECK, so the table is rebuilt; rows, ids
--   and the due index are preserved);
-- * wechat_draft_tasks gains the B5-02/B5-03 retry and generation columns.
-- migration-conditional-schema
-- migration-add-column-if-table-exists: wechat_draft_tasks.revision | INTEGER NOT NULL DEFAULT 0
-- migration-add-column-if-table-exists: wechat_draft_tasks.attempt_count | INTEGER NOT NULL DEFAULT 0
-- migration-add-column-if-table-exists: wechat_draft_tasks.classification | TEXT
-- migration-add-column-if-table-exists: wechat_draft_tasks.needs_author | INTEGER NOT NULL DEFAULT 0
-- migration-add-column-if-table-exists: wechat_draft_tasks.next_attempt_at | INTEGER
-- migration-add-column-if-table-exists: wechat_draft_tasks.last_error | TEXT
-- migration-add-column-if-table-exists: wechat_draft_tasks.claimed_at | INTEGER
-- migration-add-column-if-table-exists: wechat_draft_tasks.lease_token | TEXT
-- migration-add-column-if-table-exists: wechat_draft_tasks.lease_expires_at | INTEGER
-- migration-add-column-if-table-exists: wechat_draft_tasks.generation | INTEGER NOT NULL DEFAULT 1
-- migration-add-column-if-table-exists: wechat_draft_tasks.settings_revision | INTEGER NOT NULL DEFAULT 0

CREATE TABLE publish_schedules_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
      timezone TEXT NOT NULL CHECK(length(timezone) > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'paused', 'fired', 'stale', 'cancelled')),
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
    ) STRICT;

INSERT INTO publish_schedules_next (id, schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, last_error, claimed_at, lease_expires_at, lease_token, revision, next_attempt_at, stale_reason, fired_event_id, created_at, updated_at)
SELECT id, schedule_id, article_id, version, scheduled_at, timezone, status, attempt_count, last_error, claimed_at, lease_expires_at, lease_token, revision, next_attempt_at, stale_reason, fired_event_id, created_at, updated_at FROM publish_schedules;

DROP TABLE publish_schedules;

ALTER TABLE publish_schedules_next RENAME TO publish_schedules;

CREATE INDEX idx_publish_schedules_due
      ON publish_schedules(status, scheduled_at);
