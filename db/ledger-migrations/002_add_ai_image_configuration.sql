-- migration-number: 002
-- Move image-provider schema and its first-install actions out of request handling.
-- migration-add-column-if-table-exists: ai_image_actions.aspect_ratio | TEXT NOT NULL DEFAULT 'auto'
-- migration-add-column-if-table-exists: ai_image_actions.resolution | TEXT NOT NULL DEFAULT 'auto'
-- migration-add-column-if-table-exists: ai_image_actions.size | TEXT NOT NULL DEFAULT 'auto'
-- migration-add-column-if-table-exists: ai_image_actions.quality | TEXT NOT NULL DEFAULT 'auto'
-- migration-add-column-if-table-exists: ai_image_actions.profile_id | INTEGER

CREATE TABLE _migration_002_image_configuration_state (
  should_seed_actions INTEGER NOT NULL CHECK(should_seed_actions IN (0, 1)),
  had_aspect_ratio INTEGER NOT NULL CHECK(had_aspect_ratio IN (0, 1)),
  had_resolution INTEGER NOT NULL CHECK(had_resolution IN (0, 1))
);

INSERT INTO _migration_002_image_configuration_state (
  should_seed_actions, had_aspect_ratio, had_resolution
)
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'ai_image_actions'
  ) THEN 0 ELSE 1 END,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('ai_image_actions') WHERE name = 'aspect_ratio'
  ) THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('ai_image_actions') WHERE name = 'resolution'
  ) THEN 1 ELSE 0 END;

-- migration-conditional-schema

CREATE TABLE IF NOT EXISTS ai_image_provider_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom',
  provider_name TEXT NOT NULL DEFAULT '',
  provider_type TEXT NOT NULL DEFAULT 'openai_images',
  provider_category TEXT NOT NULL DEFAULT '',
  api_key_url TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL DEFAULT '',
  api_key_masked TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS ai_image_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT 'auto',
  resolution TEXT NOT NULL DEFAULT 'auto',
  size TEXT NOT NULL DEFAULT 'auto',
  quality TEXT NOT NULL DEFAULT 'auto',
  profile_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

UPDATE ai_image_actions
SET aspect_ratio = CASE
      WHEN (SELECT had_aspect_ratio FROM _migration_002_image_configuration_state) = 1
        THEN aspect_ratio
      WHEN size = '1536x1024' THEN '3:2'
      WHEN size = '1024x1536' THEN '2:3'
      WHEN size = '1024x1024' THEN '1:1'
      WHEN action_key = 'mondo_landscape' THEN '16:9'
      WHEN action_key = 'mondo_portrait' THEN '9:16'
      WHEN action_key = 'chapter_illustration' THEN '4:3'
      WHEN action_key = 'book_cover_concept' THEN '2:3'
      ELSE 'auto'
    END,
    resolution = CASE
      WHEN (SELECT had_resolution FROM _migration_002_image_configuration_state) = 1
        THEN resolution
      WHEN lower(quality) = 'low' THEN '1k'
      WHEN lower(quality) = 'medium' THEN '2k'
      WHEN lower(quality) = 'high' THEN '4k'
      WHEN action_key IN ('mondo_landscape', 'mondo_portrait', 'chapter_illustration') THEN '2k'
      WHEN action_key = 'book_cover_concept' THEN '4k'
      ELSE 'auto'
    END,
    updated_at = strftime('%s', 'now')
WHERE (SELECT should_seed_actions FROM _migration_002_image_configuration_state) = 0
  AND (
    (SELECT had_aspect_ratio FROM _migration_002_image_configuration_state) = 0
    OR (SELECT had_resolution FROM _migration_002_image_configuration_state) = 0
  );

INSERT INTO ai_image_actions (
  action_key, label, description, prompt, aspect_ratio, resolution,
  size, quality, sort_order, is_builtin
)
SELECT
  'mondo_landscape',
  'Mondo 横版配图',
  '16:9 文章主图或章节头图',
  '将主题重构为 Mondo 风格横版概念海报：screen print aesthetic，limited 3-4 color palette，flat color blocks，symbolic storytelling，negative space，bold contrast，vintage poster finish。画面要克制、有主视觉中心，不要堆砌元素。除非用户明确要求，不要出现可读文字、logo、水印。',
  '16:9', '2k', '1536x1024', 'high', 10, 1
WHERE (SELECT should_seed_actions FROM _migration_002_image_configuration_state) = 1
UNION ALL
SELECT
  'mondo_portrait',
  'Mondo 竖版海报',
  '9:16 强视觉封面或人物海报',
  '将主题转化为 Mondo 风格竖版海报：alternative movie poster，screen print feel，strong silhouette，minimalist symbolism，retro print texture，dramatic negative space。优先做单一焦点和强构图。除非用户明确要求，不要出现可读文字、logo、水印。',
  '9:16', '2k', '1024x1536', 'high', 20, 1
WHERE (SELECT should_seed_actions FROM _migration_002_image_configuration_state) = 1
UNION ALL
SELECT
  'chapter_illustration',
  '章节插图',
  '留白更多，适合正文中穿插',
  '生成一张适合作为中文长文章节插图的概念图。保持 Mondo 系列的 screen print 质感与象征性表达，但减少海报感，多一些留白和阅读友好度。构图简洁、主题明确、氛围统一。除非用户明确要求，不要出现可读文字、logo、水印。',
  '4:3', '2k', '1536x1024', 'medium', 30, 1
WHERE (SELECT should_seed_actions FROM _migration_002_image_configuration_state) = 1
UNION ALL
SELECT
  'book_cover_concept',
  '书封概念图',
  '适合书单、读书笔记或封面灵感',
  '生成一张书籍封面概念图，强调 Mondo 系列常见的象征元素、有限色盘、印刷颗粒和复古张力。画面适合 2D 平面设计再加工。主体要明确，边界干净，保留封面排版空间。除非用户明确要求，不要出现可读文字、logo、水印。',
  '2:3', '4k', '1024x1536', 'high', 40, 1
WHERE (SELECT should_seed_actions FROM _migration_002_image_configuration_state) = 1;

DROP TABLE _migration_002_image_configuration_state;
