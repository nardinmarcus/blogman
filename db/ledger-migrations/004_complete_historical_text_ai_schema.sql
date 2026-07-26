-- migration-number: 004
-- Complete the text AI shape previously owned by request-time schema repair.
-- migration-baseline-compatibility
-- migration-baseline-allow-issues: column ai_actions.profile_id semantic drift | column ai_provider_profiles.max_tokens semantic drift
-- migration-baseline-allow-issues: column ai_provider_profiles.max_tokens semantic drift
-- migration-baseline-allow-issues: definition index idx_api_tokens_token drift | definition index idx_posts_category drift | definition index idx_posts_published drift | definition index idx_posts_slug drift | missing index idx_api_tokens_token | missing index idx_posts_category | missing index idx_posts_published | missing index idx_posts_slug
-- migration-conditional-schema
-- migration-add-column-if-table-exists: ai_actions.profile_id | INTEGER

UPDATE ai_actions
SET profile_id = (
  SELECT id FROM ai_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
)
WHERE profile_id IS NULL
  AND EXISTS (SELECT 1 FROM ai_provider_profiles);
