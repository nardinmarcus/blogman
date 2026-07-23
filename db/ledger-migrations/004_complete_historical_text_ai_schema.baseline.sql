-- The repository's pre-ledger 002 + 004 migrations produced exactly these
-- text-AI base identities: A has profile_id before timestamps + DEFAULT 2000;
-- B has no profile_id + DEFAULT 1200; C has profile_id appended after timestamps
-- + DEFAULT 1200. Ordinary trailing columns remain forward-compatible.
WITH
normalized_tables(name, normalized_sql) AS (
  SELECT
    name,
    lower(replace(replace(replace(replace(coalesce(sql, ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''))
  FROM sqlite_schema
  WHERE type = 'table' AND name IN ('ai_actions', 'ai_provider_profiles')
),
all_columns(table_name, column_id, name, type, is_not_null, default_value, primary_key, hidden) AS (
  SELECT 'ai_actions', cid, name, type, "notnull", dflt_value, pk, hidden
  FROM pragma_table_xinfo('ai_actions')
  UNION ALL
  SELECT 'ai_provider_profiles', cid, name, type, "notnull", dflt_value, pk, hidden
  FROM pragma_table_xinfo('ai_provider_profiles')
),
schema_variant(name) AS (
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM all_columns
      WHERE table_name = 'ai_provider_profiles' AND name = 'max_tokens' AND default_value = '2000'
    ) AND EXISTS (
      SELECT 1 FROM all_columns WHERE table_name = 'ai_actions' AND name = 'profile_id'
    ) THEN 'A'
    WHEN EXISTS (
      SELECT 1 FROM all_columns
      WHERE table_name = 'ai_provider_profiles' AND name = 'max_tokens' AND default_value = '1200'
    ) AND NOT EXISTS (
      SELECT 1 FROM all_columns WHERE table_name = 'ai_actions' AND name = 'profile_id'
    ) THEN 'B'
    WHEN EXISTS (
      SELECT 1 FROM all_columns
      WHERE table_name = 'ai_provider_profiles' AND name = 'max_tokens' AND default_value = '1200'
    ) AND EXISTS (
      SELECT 1 FROM all_columns WHERE table_name = 'ai_actions' AND name = 'profile_id'
    ) THEN 'C'
  END
),
expected_base(variant, table_name, column_id, name, type, is_not_null, default_value, primary_key, hidden) AS (
  VALUES
    ('*', 'ai_actions', 0, 'id', 'INTEGER', 0, NULL, 1, 0),
    ('*', 'ai_actions', 1, 'action_key', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_actions', 2, 'label', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_actions', 3, 'description', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_actions', 4, 'prompt', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_actions', 5, 'temperature', 'REAL', 0, '0.6', 0, 0),
    ('*', 'ai_actions', 6, 'sort_order', 'INTEGER', 0, '0', 0, 0),
    ('*', 'ai_actions', 7, 'is_enabled', 'INTEGER', 0, '1', 0, 0),
    ('*', 'ai_actions', 8, 'is_builtin', 'INTEGER', 0, '1', 0, 0),
    ('A', 'ai_actions', 9, 'profile_id', 'INTEGER', 0, NULL, 0, 0),
    ('A', 'ai_actions', 10, 'created_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0, 0),
    ('A', 'ai_actions', 11, 'updated_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0, 0),
    ('B', 'ai_actions', 9, 'created_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0, 0),
    ('B', 'ai_actions', 10, 'updated_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0, 0),
    ('C', 'ai_actions', 9, 'created_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0, 0),
    ('C', 'ai_actions', 10, 'updated_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0, 0),
    ('C', 'ai_actions', 11, 'profile_id', 'INTEGER', 0, NULL, 0, 0),
    ('*', 'ai_provider_profiles', 0, 'id', 'INTEGER', 0, NULL, 1, 0),
    ('*', 'ai_provider_profiles', 1, 'name', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_provider_profiles', 2, 'provider', 'TEXT', 1, '''custom''', 0, 0),
    ('*', 'ai_provider_profiles', 3, 'provider_name', 'TEXT', 1, '''''', 0, 0),
    ('*', 'ai_provider_profiles', 4, 'provider_type', 'TEXT', 1, '''openai_compatible''', 0, 0),
    ('*', 'ai_provider_profiles', 5, 'provider_category', 'TEXT', 1, '''''', 0, 0),
    ('*', 'ai_provider_profiles', 6, 'api_key_url', 'TEXT', 1, '''''', 0, 0),
    ('*', 'ai_provider_profiles', 7, 'base_url', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_provider_profiles', 8, 'model', 'TEXT', 1, NULL, 0, 0),
    ('*', 'ai_provider_profiles', 9, 'temperature', 'REAL', 1, '0.7', 0, 0),
    ('A', 'ai_provider_profiles', 10, 'max_tokens', 'INTEGER', 1, '2000', 0, 0),
    ('B', 'ai_provider_profiles', 10, 'max_tokens', 'INTEGER', 1, '1200', 0, 0),
    ('C', 'ai_provider_profiles', 10, 'max_tokens', 'INTEGER', 1, '1200', 0, 0),
    ('*', 'ai_provider_profiles', 11, 'api_key_encrypted', 'TEXT', 1, '''''', 0, 0),
    ('*', 'ai_provider_profiles', 12, 'api_key_masked', 'TEXT', 1, '''''', 0, 0),
    ('*', 'ai_provider_profiles', 13, 'is_default', 'INTEGER', 1, '0', 0, 0),
    ('*', 'ai_provider_profiles', 14, 'created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0, 0),
    ('*', 'ai_provider_profiles', 15, 'updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0, 0)
),
active_expected AS (
  SELECT expected_base.*
  FROM expected_base, schema_variant
  WHERE expected_base.variant IN ('*', schema_variant.name)
),
base_limits(table_name, maximum_column_id) AS (
  SELECT table_name, max(column_id) FROM active_expected GROUP BY table_name
),
issues(issue, invalid) AS (
  VALUES
    ('historical text AI table mode drift', EXISTS (
      SELECT 1 FROM pragma_table_list
      WHERE name IN ('ai_actions', 'ai_provider_profiles')
        AND (type <> 'table' OR wr <> 0 OR strict <> 0)
    )),
    ('historical text AI base column order drift', EXISTS (
      SELECT 1 FROM active_expected
      WHERE NOT EXISTS (
        SELECT 1 FROM all_columns
        WHERE all_columns.table_name = active_expected.table_name
          AND all_columns.column_id = active_expected.column_id
          AND all_columns.name = active_expected.name
          AND upper(all_columns.type) = active_expected.type
          AND all_columns.is_not_null = active_expected.is_not_null
          AND all_columns.default_value IS active_expected.default_value
          AND all_columns.primary_key = active_expected.primary_key
          AND all_columns.hidden = active_expected.hidden
      )
    )),
    ('historical text AI hidden column drift', EXISTS (
      SELECT 1 FROM all_columns WHERE hidden <> 0
    )),
    ('historical text AI extra column drift', EXISTS (
      SELECT 1
      FROM all_columns
      LEFT JOIN base_limits USING (table_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM active_expected
        WHERE active_expected.table_name = all_columns.table_name
          AND active_expected.name = all_columns.name
      ) AND (
        all_columns.column_id <= base_limits.maximum_column_id
        OR all_columns.primary_key <> 0
        OR (all_columns.is_not_null = 1 AND all_columns.default_value IS NULL)
      )
    )),
    ('historical ai_actions.profile_id semantic drift', EXISTS (
      SELECT 1 FROM all_columns WHERE table_name = 'ai_actions' AND name = 'profile_id'
    ) AND NOT EXISTS (
      SELECT 1 FROM all_columns
      WHERE table_name = 'ai_actions' AND name = 'profile_id'
        AND upper(type) = 'INTEGER' AND is_not_null = 0
        AND default_value IS NULL AND primary_key = 0 AND hidden = 0
    )),
    ('historical ai_provider_profiles.max_tokens semantic drift', NOT EXISTS (
      SELECT 1 FROM all_columns
      WHERE table_name = 'ai_provider_profiles' AND name = 'max_tokens'
        AND upper(type) = 'INTEGER' AND is_not_null = 1
        AND default_value IN ('1200', '2000') AND primary_key = 0 AND hidden = 0
    )),
    ('historical text AI variant drift', NOT EXISTS (
      SELECT 1 FROM schema_variant WHERE name IS NOT NULL
    )),
    ('historical text AI table constraint drift', EXISTS (
      SELECT 1 FROM normalized_tables
      WHERE instr(normalized_sql, 'idintegerprimarykeyautoincrement') = 0
         OR instr(normalized_sql, 'check(') > 0
         OR instr(normalized_sql, 'collate') > 0
         OR instr(normalized_sql, 'onconflict') > 0
         OR instr(normalized_sql, 'references') > 0
         OR instr(normalized_sql, 'foreignkey(') > 0
         OR instr(normalized_sql, 'generated') > 0
         OR instr(normalized_sql, 'withoutrowid') > 0
    )),
    ('historical text AI foreign key drift',
      EXISTS (SELECT 1 FROM pragma_foreign_key_list('ai_actions'))
      OR EXISTS (SELECT 1 FROM pragma_foreign_key_list('ai_provider_profiles'))
    ),
    ('historical ai_actions index drift',
      (SELECT count(*) FROM pragma_index_list('ai_actions')) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pragma_index_list('ai_actions') AS indexes
        WHERE indexes."unique" = 1 AND indexes.origin = 'u' AND indexes.partial = 0
          AND (SELECT count(*) FROM pragma_index_xinfo(indexes.name)) = 2
          AND EXISTS (
            SELECT 1 FROM pragma_index_xinfo(indexes.name)
            WHERE seqno = 0 AND cid = 1 AND name = 'action_key'
              AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
          )
          AND EXISTS (
            SELECT 1 FROM pragma_index_xinfo(indexes.name)
            WHERE seqno = 1 AND cid = -1 AND name IS NULL
              AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
          )
      )
    ),
    ('historical ai_provider_profiles index drift', EXISTS (
      SELECT 1 FROM pragma_index_list('ai_provider_profiles')
    )),
    ('historical text AI trigger drift', EXISTS (
      SELECT 1 FROM sqlite_schema
      WHERE type = 'trigger' AND tbl_name IN ('ai_actions', 'ai_provider_profiles')
    ))
)
SELECT issue FROM issues WHERE invalid ORDER BY issue;
