-- migration-remote-baseline-replacements: migration_number=001 migration=001_initial_schema baseline_sha256=b3f61982cc36ff2c88d7b4330dd304ef075b5c5c34debf4499671c33ae2b6540 groups=1:2c4d1aa391172c16b128c08a593e252f9e09b4fc151642ce738ae47882c38491:3|3:c61b390568cafc468c6adbbff5b78d08dd5d18a544d917fbc06c043393e3c7bd:3
WITH required_objects(name) AS (
  VALUES
    ('posts'),
    ('posts_fts'),
    ('categories'),
    ('site_settings'),
    ('ai_actions'),
    ('ai_provider_profiles'),
    ('ai_post_generators'),
    ('api_tokens')
)
SELECT 'missing table ' || name AS issue
FROM required_objects
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_schema
  WHERE sqlite_schema.type = 'table'
    AND sqlite_schema.name = required_objects.name
)
ORDER BY issue;

WITH required_objects(name) AS (
  VALUES
    ('idx_posts_slug'),
    ('idx_posts_category'),
    ('idx_posts_published'),
    ('idx_api_tokens_token')
)
SELECT 'missing index ' || name AS issue
FROM required_objects
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_schema
  WHERE sqlite_schema.type = 'index'
    AND sqlite_schema.name = required_objects.name
)
ORDER BY issue;

WITH required_objects(name) AS (
  VALUES
    ('posts_ai'),
    ('posts_au'),
    ('posts_ad')
)
SELECT 'missing trigger ' || name AS issue
FROM required_objects
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_schema
  WHERE sqlite_schema.type = 'trigger'
    AND sqlite_schema.name = required_objects.name
)
ORDER BY issue;

WITH expected_columns(column_name, declared_type, is_not_null, default_value, primary_key) AS (
  VALUES
    ('id', 'INTEGER', 0, NULL, 1),
    ('name', 'TEXT', 1, NULL, 0),
    ('provider', 'TEXT', 1, '''custom''', 0),
    ('provider_name', 'TEXT', 1, '''''', 0),
    ('provider_type', 'TEXT', 1, '''openai_compatible''', 0),
    ('provider_category', 'TEXT', 1, '''''', 0),
    ('api_key_url', 'TEXT', 1, '''''', 0),
    ('base_url', 'TEXT', 1, NULL, 0),
    ('model', 'TEXT', 1, NULL, 0),
    ('temperature', 'REAL', 1, '0.7', 0),
    ('max_tokens', 'INTEGER', 1, '2000', 0),
    ('api_key_encrypted', 'TEXT', 1, '''''', 0),
    ('api_key_masked', 'TEXT', 1, '''''', 0),
    ('is_default', 'INTEGER', 1, '0', 0),
    ('created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0)
),
actual_columns(column_name, declared_type, is_not_null, default_value, primary_key) AS (
  SELECT name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('ai_provider_profiles')
)
SELECT 'column ai_provider_profiles.' || column_name || ' semantic drift' AS issue
FROM expected_columns
WHERE NOT EXISTS (
  SELECT 1
  FROM actual_columns
  WHERE actual_columns.column_name = expected_columns.column_name
    AND upper(actual_columns.declared_type) = expected_columns.declared_type
    AND actual_columns.is_not_null = expected_columns.is_not_null
    AND actual_columns.default_value IS expected_columns.default_value
    AND actual_columns.primary_key = expected_columns.primary_key
)
ORDER BY issue;

WITH expected_columns(column_name, declared_type, is_not_null, default_value, primary_key) AS (
  VALUES
    ('id', 'INTEGER', 0, NULL, 1),
    ('target_key', 'TEXT', 1, NULL, 0),
    ('label', 'TEXT', 1, NULL, 0),
    ('description', 'TEXT', 1, NULL, 0),
    ('prompt', 'TEXT', 1, NULL, 0),
    ('provider_mode', 'TEXT', 1, '''workers_ai''', 0),
    ('text_profile_id', 'INTEGER', 0, NULL, 0),
    ('image_profile_id', 'INTEGER', 0, NULL, 0),
    ('workers_model', 'TEXT', 1, '''''', 0),
    ('temperature', 'REAL', 1, '0.7', 0),
    ('max_tokens', 'INTEGER', 1, '2000', 0),
    ('aspect_ratio', 'TEXT', 1, '''16:9''', 0),
    ('resolution', 'TEXT', 1, '''2k''', 0),
    ('is_enabled', 'INTEGER', 1, '1', 0),
    ('is_builtin', 'INTEGER', 1, '1', 0),
    ('created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0)
),
actual_columns(column_name, declared_type, is_not_null, default_value, primary_key) AS (
  SELECT name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('ai_post_generators')
)
SELECT 'column ai_post_generators.' || column_name || ' semantic drift' AS issue
FROM expected_columns
WHERE NOT EXISTS (
  SELECT 1
  FROM actual_columns
  WHERE actual_columns.column_name = expected_columns.column_name
    AND upper(actual_columns.declared_type) = expected_columns.declared_type
    AND actual_columns.is_not_null = expected_columns.is_not_null
    AND actual_columns.default_value IS expected_columns.default_value
    AND actual_columns.primary_key = expected_columns.primary_key
)
ORDER BY issue;

WITH expected_columns(column_name, declared_type, is_not_null, default_value, primary_key) AS (
  VALUES
    ('id', 'INTEGER', 0, NULL, 1),
    ('token', 'TEXT', 1, NULL, 0),
    ('name', 'TEXT', 1, NULL, 0),
    ('created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('last_used_at', 'INTEGER', 0, NULL, 0),
    ('is_active', 'INTEGER', 0, '1', 0)
),
actual_columns(column_name, declared_type, is_not_null, default_value, primary_key) AS (
  SELECT name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('api_tokens')
)
SELECT 'column api_tokens.' || column_name || ' semantic drift' AS issue
FROM expected_columns
WHERE NOT EXISTS (
  SELECT 1
  FROM actual_columns
  WHERE actual_columns.column_name = expected_columns.column_name
    AND upper(actual_columns.declared_type) = expected_columns.declared_type
    AND actual_columns.is_not_null = expected_columns.is_not_null
    AND actual_columns.default_value IS expected_columns.default_value
    AND actual_columns.primary_key = expected_columns.primary_key
)
ORDER BY issue;
