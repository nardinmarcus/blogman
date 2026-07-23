-- Accept absent tables, the known legacy ai_image_actions shape, or the current shape.
-- Reject incompatible existing objects before any migration statement runs.
WITH expected_columns(table_name, column_name, declared_type, is_not_null, default_value, primary_key, required) AS (
  VALUES
    ('ai_image_provider_profiles', 'id', 'INTEGER', 0, NULL, 1, 1),
    ('ai_image_provider_profiles', 'name', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_provider_profiles', 'provider', 'TEXT', 1, '''custom''', 0, 1),
    ('ai_image_provider_profiles', 'provider_name', 'TEXT', 1, '''''', 0, 1),
    ('ai_image_provider_profiles', 'provider_type', 'TEXT', 1, '''openai_images''', 0, 1),
    ('ai_image_provider_profiles', 'provider_category', 'TEXT', 1, '''''', 0, 1),
    ('ai_image_provider_profiles', 'api_key_url', 'TEXT', 1, '''''', 0, 1),
    ('ai_image_provider_profiles', 'base_url', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_provider_profiles', 'model', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_provider_profiles', 'api_key_encrypted', 'TEXT', 1, '''''', 0, 1),
    ('ai_image_provider_profiles', 'api_key_masked', 'TEXT', 1, '''''', 0, 1),
    ('ai_image_provider_profiles', 'is_default', 'INTEGER', 1, '0', 0, 1),
    ('ai_image_provider_profiles', 'created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0, 1),
    ('ai_image_provider_profiles', 'updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0, 1),
    ('ai_image_actions', 'id', 'INTEGER', 0, NULL, 1, 1),
    ('ai_image_actions', 'action_key', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_actions', 'label', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_actions', 'description', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_actions', 'prompt', 'TEXT', 1, NULL, 0, 1),
    ('ai_image_actions', 'aspect_ratio', 'TEXT', 1, '''auto''', 0, 0),
    ('ai_image_actions', 'resolution', 'TEXT', 1, '''auto''', 0, 0),
    ('ai_image_actions', 'size', 'TEXT', 1, '''auto''', 0, 0),
    ('ai_image_actions', 'quality', 'TEXT', 1, '''auto''', 0, 0),
    ('ai_image_actions', 'profile_id', 'INTEGER', 0, NULL, 0, 0),
    ('ai_image_actions', 'sort_order', 'INTEGER', 1, '0', 0, 1),
    ('ai_image_actions', 'is_enabled', 'INTEGER', 1, '1', 0, 1),
    ('ai_image_actions', 'is_builtin', 'INTEGER', 1, '1', 0, 1),
    ('ai_image_actions', 'created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0, 1),
    ('ai_image_actions', 'updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0, 1)
),
actual_columns(table_name, column_name, declared_type, is_not_null, default_value, primary_key) AS (
  SELECT 'ai_image_provider_profiles', name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('ai_image_provider_profiles')
  UNION ALL
  SELECT 'ai_image_actions', name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('ai_image_actions')
)
SELECT 'column ' || expected.table_name || '.' || expected.column_name || ' incompatible' AS issue
FROM expected_columns AS expected
WHERE EXISTS (
  SELECT 1 FROM sqlite_schema
  WHERE type = 'table' AND name = expected.table_name
)
AND (
  (expected.required = 1 AND NOT EXISTS (
    SELECT 1 FROM actual_columns AS actual
    WHERE actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
  ))
  OR EXISTS (
    SELECT 1 FROM actual_columns AS actual
    WHERE actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
      AND (
        upper(actual.declared_type) <> expected.declared_type
        OR actual.is_not_null <> expected.is_not_null
        OR actual.default_value IS NOT expected.default_value
        OR actual.primary_key <> expected.primary_key
      )
  )
)
ORDER BY issue;

WITH normalized_schema(name, normalized_sql) AS (
  SELECT name, lower(replace(replace(replace(replace(coalesce(sql, ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''))
  FROM sqlite_schema
  WHERE type = 'table' AND name IN ('ai_image_provider_profiles', 'ai_image_actions')
),
expected_fragments(name, fragment) AS (
  VALUES
    ('ai_image_provider_profiles', 'idintegerprimarykeyautoincrement'),
    ('ai_image_actions', 'idintegerprimarykeyautoincrement'),
    ('ai_image_actions', 'action_keytextuniquenotnull')
)
SELECT 'constraint table ' || expected.name || ' incompatible' AS issue
FROM expected_fragments AS expected
WHERE EXISTS (SELECT 1 FROM normalized_schema WHERE name = expected.name)
  AND NOT EXISTS (
    SELECT 1 FROM normalized_schema
    WHERE name = expected.name AND instr(normalized_sql, expected.fragment) > 0
  )
ORDER BY issue;
