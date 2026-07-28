-- Issue #23 clean-start only. Authorization must bind these exact bytes and the existing D1 UUID.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS rollout_control_events;
DROP TABLE IF EXISTS rollout_controls;
DROP TABLE IF EXISTS migration_ledger;
DROP TABLE IF EXISTS ai_image_actions;
DROP TABLE IF EXISTS ai_image_provider_profiles;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS ai_post_generators;
DROP TABLE IF EXISTS ai_provider_profiles;
DROP TABLE IF EXISTS ai_actions;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS posts_fts;
DROP TABLE IF EXISTS posts;

PRAGMA foreign_keys = ON;
