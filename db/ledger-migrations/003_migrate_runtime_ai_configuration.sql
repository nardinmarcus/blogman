-- migration-number: 003
-- One-time data work that previously ran during AI reads and generation.

UPDATE ai_post_generators
SET label = COALESCE(NULLIF(label, ''), CASE target_key
      WHEN 'summary' THEN '摘要生成'
      WHEN 'tags' THEN '标签生成'
      WHEN 'slug' THEN 'Slug 生成'
      WHEN 'cover' THEN '封面生成'
    END),
    description = COALESCE(NULLIF(description, ''), CASE target_key
      WHEN 'summary' THEN '为文章生成 160 字以内摘要'
      WHEN 'tags' THEN '提取 3-5 个简洁标签'
      WHEN 'slug' THEN '生成英文 kebab-case slug'
      WHEN 'cover' THEN '生成博客封面图'
    END),
    workers_model = COALESCE(NULLIF(workers_model, ''), CASE
      WHEN target_key = 'cover' THEN '@cf/black-forest-labs/flux-1-schnell'
      ELSE '@cf/meta/llama-3.1-8b-instruct'
    END),
    provider_mode = COALESCE(NULLIF(provider_mode, ''), 'workers_ai'),
    aspect_ratio = COALESCE(NULLIF(aspect_ratio, ''), '16:9'),
    resolution = COALESCE(NULLIF(resolution, ''), '2k'),
    temperature = CASE WHEN typeof(temperature) NOT IN ('integer', 'real') OR temperature < 0 OR temperature > 2 THEN CASE target_key
      WHEN 'summary' THEN 0.4
      WHEN 'tags' THEN 0.3
      WHEN 'slug' THEN 0.2
      ELSE 0.7
    END ELSE temperature END,
    max_tokens = CASE WHEN typeof(max_tokens) <> 'integer' OR max_tokens < 1 OR max_tokens > 32768 THEN CASE target_key
      WHEN 'summary' THEN 220
      WHEN 'tags' THEN 180
      WHEN 'slug' THEN 80
      ELSE 2000
    END ELSE max_tokens END,
    updated_at = strftime('%s', 'now')
WHERE is_builtin = 1
  AND target_key IN ('summary', 'tags', 'slug', 'cover')
  AND (
    label = '' OR description = '' OR workers_model = '' OR provider_mode = ''
    OR aspect_ratio = '' OR resolution = ''
    OR typeof(temperature) NOT IN ('integer', 'real') OR temperature < 0 OR temperature > 2
    OR typeof(max_tokens) <> 'integer' OR max_tokens < 1 OR max_tokens > 32768
  );

UPDATE ai_post_generators
SET prompt = '你是资深中文编辑。请根据文章标题和正文内容，写一段会让人想继续读下去的中文摘要。重点不是机械概括，而是先提炼文章真正讨论的问题、矛盾、反常识点或关键洞见，再用自然导语式语言把读者带进去。要求：1. 必须忠于正文，不夸张、不编造；2. 尽量保留具体主题词，让人一眼知道文章在讲什么；3. 像高质量专栏导语，不要像 AI 总结，不要出现“本文/这篇文章/作者认为”等套话；4. 可以保留一点张力或悬念，但不能标题党；5. 输出一段完整中文，不要分点，不要加引号。',
    updated_at = strftime('%s', 'now')
WHERE target_key = 'summary'
  AND is_builtin = 1
  AND (prompt = '' OR prompt IN (
    '你是专业中文编辑。请基于文章标题、分类、标签和正文，输出一个适合博客列表与 SEO 描述使用的中文摘要。要求信息密度高、准确、自然，不要空话，不要标题党，不要加引号。',
    '你是资深中文编辑和 SEO 内容策划。请优先根据文章标题提炼主题，再结合正文前几段的关键信息，写一个适合博客列表、搜索摘要和分享卡片的中文摘要。要求：1. 必须准确点明文章在讲什么，尽量保留具体主题词；2. 像编辑写导语，不要像 AI 总结，不要出现“本文/这篇文章/文章介绍了”等套话；3. 不空泛、不喊口号、不标题党；4. 用自然中文写成一段完整短摘要，必要时可带一点结果或价值点；5. 不要加引号，不要分点。'
  ));

UPDATE ai_post_generators
SET prompt = '你是中文编辑。请优先根据正文主线，再结合标题校准语义，提取 3-5 个最能代表主题、对象、方法、技术、产品、人物、议题或领域的中文标签。优先具体概念、专有主题和有辨识度的短词，避免空泛大词、整句、重复词、泛泛分类词，以及“思考”“方法”“问题”这类过宽标签。',
    updated_at = strftime('%s', 'now')
WHERE target_key = 'tags'
  AND is_builtin = 1
  AND (prompt = '' OR prompt IN (
    '你是专业中文编辑。请基于文章信息提取最有区分度的中文标签，偏主题词和领域词，避免空泛词、句子和重复词。',
    '你是中文编辑。请从标题和正文中提取 3-6 个最能代表主题、对象、方法、观点或领域的中文标签。优先具体概念、专有主题和有辨识度的词组，避免空泛大词、整句、重复词和泛泛分类词；除非文章核心就是它，否则尽量少用“思考”“方法”“问题”这类过宽的标签。'
  ));

UPDATE ai_post_generators
SET prompt = 'You are an experienced editor creating English slugs for blog posts. Use the title as the primary source of meaning. If the title is in Chinese, translate only the core topic into natural English instead of transliterating it. Use the article body only to clarify ambiguity. Return exactly one concise, readable, search-friendly lowercase slug in kebab-case, usually 2-5 words. Do not include dates, filler words, pinyin, quotes, or any prefix such as "slug:".',
    updated_at = strftime('%s', 'now')
WHERE target_key = 'slug'
  AND is_builtin = 1
  AND (prompt = '' OR prompt IN (
    'You are an expert editor. Generate a short English slug for a blog post. Use only lowercase English words and hyphens. Keep it specific, readable, and concise. Do not include dates unless necessary.',
    'You are an experienced editor creating English slugs for blog posts. Derive the slug from the title first, then use the article context only to disambiguate the core meaning. Capture the main topic or claim, not a literal full translation of every word. Prefer 2-6 concise lowercase English words, joined by hyphens. Keep it specific, readable, and searchable. Do not include dates, stop words, filler words, or pinyin unless there is no better English term.',
    'You are an experienced editor creating English slugs for blog posts. Use the title as the primary source of meaning and translate the core topic into natural English when needed. Use the article body only to clarify ambiguity. Return one concise, readable, search-friendly lowercase slug in kebab-case. Avoid dates, filler words, pinyin, and prefixes like "slug:".'
  ));

UPDATE ai_post_generators
SET prompt = '你是资深视觉总监。请把文章核心观点转化成一张适合作为中文长文封面的图像：构图明确、主视觉单一、气质现代、有 editorial illustration / concept poster 的完成度。默认不要在图中出现任何可读文字、logo、签名或水印。',
    updated_at = strftime('%s', 'now')
WHERE target_key = 'cover'
  AND is_builtin = 1
  AND prompt = '';

UPDATE ai_provider_profiles
SET is_default = 1,
    updated_at = strftime('%s', 'now')
WHERE id = (SELECT id FROM ai_provider_profiles ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM ai_provider_profiles WHERE is_default = 1);

UPDATE ai_image_provider_profiles
SET is_default = 1,
    updated_at = strftime('%s', 'now')
WHERE id = (SELECT id FROM ai_image_provider_profiles ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM ai_image_provider_profiles WHERE is_default = 1);

UPDATE ai_image_actions
SET profile_id = (
  SELECT id FROM ai_image_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
)
WHERE profile_id IS NULL
  AND EXISTS (SELECT 1 FROM ai_image_provider_profiles);

UPDATE ai_post_generators
SET text_profile_id = (
  SELECT id FROM ai_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
)
WHERE target_key IN ('summary', 'tags', 'slug')
  AND text_profile_id IS NULL
  AND EXISTS (SELECT 1 FROM ai_provider_profiles);

UPDATE ai_post_generators
SET image_profile_id = (
  SELECT id FROM ai_image_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
)
WHERE target_key = 'cover'
  AND image_profile_id IS NULL
  AND EXISTS (SELECT 1 FROM ai_image_provider_profiles);
