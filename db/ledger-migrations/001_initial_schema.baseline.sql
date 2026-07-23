-- Baseline contract for databases created before the migration ledger.
-- Extra objects and columns are retained for forward compatibility, but every
-- canonical object, column semantic, and executable definition established by
-- the legacy db/schema.sql must still match. Mutable business rows are excluded.
WITH required_objects(type, name) AS (
  VALUES
    ('table', 'posts'),
    ('table', 'posts_fts'),
    ('table', 'categories'),
    ('table', 'site_settings'),
    ('table', 'ai_actions'),
    ('table', 'ai_provider_profiles'),
    ('table', 'ai_post_generators'),
    ('table', 'api_tokens'),
    ('index', 'idx_posts_slug'),
    ('index', 'idx_posts_category'),
    ('index', 'idx_posts_published'),
    ('index', 'idx_api_tokens_token'),
    ('trigger', 'posts_ai'),
    ('trigger', 'posts_au'),
    ('trigger', 'posts_ad')
)
SELECT 'missing ' || type || ' ' || name AS issue
FROM required_objects
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_schema
  WHERE sqlite_schema.type = required_objects.type
    AND sqlite_schema.name = required_objects.name
)
ORDER BY issue;

WITH
expected_columns(table_name, column_name, declared_type, is_not_null, default_value, primary_key) AS (
  VALUES
    ('posts', 'id', 'INTEGER', 0, NULL, 1),
    ('posts', 'slug', 'TEXT', 1, NULL, 0),
    ('posts', 'title', 'TEXT', 1, NULL, 0),
    ('posts', 'content', 'TEXT', 1, NULL, 0),
    ('posts', 'html', 'TEXT', 1, NULL, 0),
    ('posts', 'description', 'TEXT', 0, NULL, 0),
    ('posts', 'category', 'TEXT', 0, '''未分类''', 0),
    ('posts', 'tags', 'TEXT', 0, NULL, 0),
    ('posts', 'status', 'TEXT', 0, '''published''', 0),
    ('posts', 'password', 'TEXT', 0, NULL, 0),
    ('posts', 'is_pinned', 'INTEGER', 0, '0', 0),
    ('posts', 'is_hidden', 'INTEGER', 0, '0', 0),
    ('posts', 'cover_image', 'TEXT', 0, NULL, 0),
    ('posts', 'deleted_at', 'INTEGER', 0, NULL, 0),
    ('posts', 'published_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0),
    ('posts', 'updated_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0),
    ('posts', 'view_count', 'INTEGER', 0, '0', 0),
    ('categories', 'id', 'INTEGER', 0, NULL, 1),
    ('categories', 'name', 'TEXT', 1, NULL, 0),
    ('categories', 'slug', 'TEXT', 1, NULL, 0),
    ('categories', 'post_count', 'INTEGER', 0, '0', 0),
    ('site_settings', 'key', 'TEXT', 0, NULL, 1),
    ('site_settings', 'value', 'TEXT', 1, NULL, 0),
    ('ai_actions', 'id', 'INTEGER', 0, NULL, 1),
    ('ai_actions', 'action_key', 'TEXT', 1, NULL, 0),
    ('ai_actions', 'label', 'TEXT', 1, NULL, 0),
    ('ai_actions', 'description', 'TEXT', 1, NULL, 0),
    ('ai_actions', 'prompt', 'TEXT', 1, NULL, 0),
    ('ai_actions', 'temperature', 'REAL', 0, '0.6', 0),
    ('ai_actions', 'sort_order', 'INTEGER', 0, '0', 0),
    ('ai_actions', 'is_enabled', 'INTEGER', 0, '1', 0),
    ('ai_actions', 'is_builtin', 'INTEGER', 0, '1', 0),
    ('ai_actions', 'profile_id', 'INTEGER', 0, NULL, 0),
    ('ai_actions', 'created_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0),
    ('ai_actions', 'updated_at', 'INTEGER', 0, 'strftime(''%s'', ''now'')', 0)
),
actual_columns(table_name, column_name, declared_type, is_not_null, default_value, primary_key) AS (
  SELECT 'posts', name, type, "notnull", dflt_value, pk FROM pragma_table_info('posts')
  UNION ALL
  SELECT 'categories', name, type, "notnull", dflt_value, pk FROM pragma_table_info('categories')
  UNION ALL
  SELECT 'site_settings', name, type, "notnull", dflt_value, pk FROM pragma_table_info('site_settings')
  UNION ALL
  SELECT 'ai_actions', name, type, "notnull", dflt_value, pk FROM pragma_table_info('ai_actions')
)
SELECT 'column ' || table_name || '.' || column_name || ' semantic drift' AS issue
FROM expected_columns
WHERE NOT EXISTS (
  SELECT 1
  FROM actual_columns
  WHERE actual_columns.table_name = expected_columns.table_name
    AND actual_columns.column_name = expected_columns.column_name
    AND upper(actual_columns.declared_type) = expected_columns.declared_type
    AND actual_columns.is_not_null = expected_columns.is_not_null
    AND actual_columns.default_value IS expected_columns.default_value
    AND actual_columns.primary_key = expected_columns.primary_key
)
ORDER BY issue;

WITH
expected_columns(table_name, column_name, declared_type, is_not_null, default_value, primary_key) AS (
  VALUES
    ('ai_provider_profiles', 'id', 'INTEGER', 0, NULL, 1),
    ('ai_provider_profiles', 'name', 'TEXT', 1, NULL, 0),
    ('ai_provider_profiles', 'provider', 'TEXT', 1, '''custom''', 0),
    ('ai_provider_profiles', 'provider_name', 'TEXT', 1, '''''', 0),
    ('ai_provider_profiles', 'provider_type', 'TEXT', 1, '''openai_compatible''', 0),
    ('ai_provider_profiles', 'provider_category', 'TEXT', 1, '''''', 0),
    ('ai_provider_profiles', 'api_key_url', 'TEXT', 1, '''''', 0),
    ('ai_provider_profiles', 'base_url', 'TEXT', 1, NULL, 0),
    ('ai_provider_profiles', 'model', 'TEXT', 1, NULL, 0),
    ('ai_provider_profiles', 'temperature', 'REAL', 1, '0.7', 0),
    ('ai_provider_profiles', 'max_tokens', 'INTEGER', 1, '2000', 0),
    ('ai_provider_profiles', 'api_key_encrypted', 'TEXT', 1, '''''', 0),
    ('ai_provider_profiles', 'api_key_masked', 'TEXT', 1, '''''', 0),
    ('ai_provider_profiles', 'is_default', 'INTEGER', 1, '0', 0),
    ('ai_provider_profiles', 'created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('ai_provider_profiles', 'updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('ai_post_generators', 'id', 'INTEGER', 0, NULL, 1),
    ('ai_post_generators', 'target_key', 'TEXT', 1, NULL, 0),
    ('ai_post_generators', 'label', 'TEXT', 1, NULL, 0),
    ('ai_post_generators', 'description', 'TEXT', 1, NULL, 0),
    ('ai_post_generators', 'prompt', 'TEXT', 1, NULL, 0),
    ('ai_post_generators', 'provider_mode', 'TEXT', 1, '''workers_ai''', 0),
    ('ai_post_generators', 'text_profile_id', 'INTEGER', 0, NULL, 0),
    ('ai_post_generators', 'image_profile_id', 'INTEGER', 0, NULL, 0),
    ('ai_post_generators', 'workers_model', 'TEXT', 1, '''''', 0),
    ('ai_post_generators', 'temperature', 'REAL', 1, '0.7', 0),
    ('ai_post_generators', 'max_tokens', 'INTEGER', 1, '2000', 0),
    ('ai_post_generators', 'aspect_ratio', 'TEXT', 1, '''16:9''', 0),
    ('ai_post_generators', 'resolution', 'TEXT', 1, '''2k''', 0),
    ('ai_post_generators', 'is_enabled', 'INTEGER', 1, '1', 0),
    ('ai_post_generators', 'is_builtin', 'INTEGER', 1, '1', 0),
    ('ai_post_generators', 'created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('ai_post_generators', 'updated_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('api_tokens', 'id', 'INTEGER', 0, NULL, 1),
    ('api_tokens', 'token', 'TEXT', 1, NULL, 0),
    ('api_tokens', 'name', 'TEXT', 1, NULL, 0),
    ('api_tokens', 'created_at', 'INTEGER', 1, 'strftime(''%s'', ''now'')', 0),
    ('api_tokens', 'last_used_at', 'INTEGER', 0, NULL, 0),
    ('api_tokens', 'is_active', 'INTEGER', 0, '1', 0)
),
actual_columns(table_name, column_name, declared_type, is_not_null, default_value, primary_key) AS (
  SELECT 'ai_provider_profiles', name, type, "notnull", dflt_value, pk FROM pragma_table_info('ai_provider_profiles')
  UNION ALL
  SELECT 'ai_post_generators', name, type, "notnull", dflt_value, pk FROM pragma_table_info('ai_post_generators')
  UNION ALL
  SELECT 'api_tokens', name, type, "notnull", dflt_value, pk FROM pragma_table_info('api_tokens')
)
SELECT 'column ' || table_name || '.' || column_name || ' semantic drift' AS issue
FROM expected_columns
WHERE NOT EXISTS (
  SELECT 1
  FROM actual_columns
  WHERE actual_columns.table_name = expected_columns.table_name
    AND actual_columns.column_name = expected_columns.column_name
    AND upper(actual_columns.declared_type) = expected_columns.declared_type
    AND actual_columns.is_not_null = expected_columns.is_not_null
    AND actual_columns.default_value IS expected_columns.default_value
    AND actual_columns.primary_key = expected_columns.primary_key
)
ORDER BY issue;

WITH
expected_definitions(type, name, normalized_sql) AS (
  VALUES
    ('table', 'posts_fts', 'createvirtualtableposts_ftsusingfts5(title,content,content=posts,content_rowid=id,tokenize=''unicode61'')'),
    ('index', 'idx_posts_slug', 'createindexidx_posts_slugonposts(slug)'),
    ('index', 'idx_posts_category', 'createindexidx_posts_categoryonposts(category)'),
    ('index', 'idx_posts_published', 'createindexidx_posts_publishedonposts(published_atdesc)'),
    ('index', 'idx_api_tokens_token', 'createindexidx_api_tokens_tokenonapi_tokens(token)'),
    ('trigger', 'posts_ai', 'createtriggerposts_aiafterinsertonpostsbegininsertintoposts_fts(rowid,title,content)values(new.id,new.title,new.content);end'),
    ('trigger', 'posts_au', 'createtriggerposts_auafterupdateonpostsbeginupdateposts_ftssettitle=new.title,content=new.contentwhererowid=new.id;end'),
    ('trigger', 'posts_ad', 'createtriggerposts_adafterdeleteonpostsbegindeletefromposts_ftswhererowid=old.id;end')
),
expected_table_fragments(name, normalized_fragment) AS (
  VALUES
    ('posts', 'idintegerprimarykeyautoincrement'),
    ('posts', 'slugtextuniquenotnull'),
    ('posts', 'statustextdefault''published''check(statusin(''draft'',''published'',''deleted''))'),
    ('categories', 'idintegerprimarykeyautoincrement'),
    ('categories', 'nametextuniquenotnull'),
    ('categories', 'slugtextuniquenotnull'),
    ('ai_actions', 'idintegerprimarykeyautoincrement'),
    ('ai_actions', 'action_keytextuniquenotnull'),
    ('ai_provider_profiles', 'idintegerprimarykeyautoincrement'),
    ('ai_post_generators', 'idintegerprimarykeyautoincrement'),
    ('ai_post_generators', 'target_keytextuniquenotnull'),
    ('api_tokens', 'idintegerprimarykeyautoincrement'),
    ('api_tokens', 'tokentextuniquenotnull')
),
normalized_schema(type, name, normalized_sql) AS (
  SELECT
    type,
    name,
    lower(replace(replace(replace(replace(coalesce(sql, ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''))
  FROM sqlite_schema
)
SELECT 'definition ' || type || ' ' || name || ' drift' AS issue
FROM expected_definitions
WHERE NOT EXISTS (
  SELECT 1 FROM normalized_schema
  WHERE normalized_schema.type = expected_definitions.type
    AND normalized_schema.name = expected_definitions.name
    AND normalized_schema.normalized_sql = expected_definitions.normalized_sql
)
UNION ALL
SELECT 'constraint table ' || name || ' drift'
FROM expected_table_fragments
WHERE NOT EXISTS (
  SELECT 1 FROM normalized_schema
  WHERE normalized_schema.type = 'table'
    AND normalized_schema.name = expected_table_fragments.name
    AND instr(normalized_schema.normalized_sql, expected_table_fragments.normalized_fragment) > 0
)
ORDER BY issue;
