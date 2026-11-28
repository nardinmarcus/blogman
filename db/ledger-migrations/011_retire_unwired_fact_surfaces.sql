-- migration-number: 011
-- Retire the never-wired WeChat draft, primary-source sync and email reminder
-- fact surfaces (#263). Their kernels and tests are removed; the data sidecar
-- fails closed if any of these tables holds a row, so no fact is discarded.
DROP TABLE IF EXISTS wechat_draft_replacements;
DROP TABLE IF EXISTS wechat_draft_generations;
DROP TABLE IF EXISTS wechat_draft_settings;
DROP TABLE IF EXISTS wechat_draft_attempts;
DROP TABLE IF EXISTS wechat_draft_tasks;
DROP TABLE IF EXISTS source_refresh_records;
DROP TABLE IF EXISTS source_refresh_proposals;
DROP TABLE IF EXISTS source_baseline_facts;
DROP TABLE IF EXISTS source_availability_observations;
DROP TABLE IF EXISTS source_conflict_resolutions;
DROP TABLE IF EXISTS source_write_back_intents;
DROP TABLE IF EXISTS source_sync_attempts;
DROP TABLE IF EXISTS source_media_mappings;
DROP TABLE IF EXISTS source_sync_baselines;
DROP TABLE IF EXISTS media_assets;
DROP TABLE IF EXISTS email_deliveries;
DROP TABLE IF EXISTS email_reminder_config;
