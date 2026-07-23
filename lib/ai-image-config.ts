import {
  decryptApiKey,
  encryptApiKey,
  maskApiKey,
  normalizeBaseUrl,
} from '@/lib/ai-provider-profiles'
import {
  type AIImageAspectRatio,
  type AIImageResolution,
} from '@/lib/ai-image-options'

export interface AIImageProviderProfileRow {
  id: number
  name: string
  provider: string
  provider_name: string
  provider_type: string
  provider_category: string
  api_key_url: string
  base_url: string
  model: string
  api_key_encrypted: string
  api_key_masked: string
  is_default: number
  created_at: number
  updated_at: number
}

export interface AIImageActionRow {
  id: number
  action_key: string
  label: string
  description: string
  prompt: string
  aspect_ratio: AIImageAspectRatio
  resolution: AIImageResolution
  size: string
  quality: string
  profile_id: number | null
  sort_order: number
  is_enabled: number
  is_builtin: number
  created_at: number
  updated_at: number
}

interface DefaultImageActionSeed {
  action_key: string
  label: string
  description: string
  prompt: string
  aspect_ratio: AIImageAspectRatio
  resolution: AIImageResolution
  size: string
  quality: string
  sort_order: number
}

const DEFAULT_IMAGE_ACTIONS: DefaultImageActionSeed[] = [
  {
    action_key: 'mondo_landscape',
    label: 'Mondo 横版配图',
    description: '16:9 文章主图或章节头图',
    prompt:
      '将主题重构为 Mondo 风格横版概念海报：screen print aesthetic，limited 3-4 color palette，flat color blocks，symbolic storytelling，negative space，bold contrast，vintage poster finish。画面要克制、有主视觉中心，不要堆砌元素。除非用户明确要求，不要出现可读文字、logo、水印。',
    aspect_ratio: '16:9',
    resolution: '2k',
    size: '1536x1024',
    quality: 'high',
    sort_order: 10,
  },
  {
    action_key: 'mondo_portrait',
    label: 'Mondo 竖版海报',
    description: '9:16 强视觉封面或人物海报',
    prompt:
      '将主题转化为 Mondo 风格竖版海报：alternative movie poster，screen print feel，strong silhouette，minimalist symbolism，retro print texture，dramatic negative space。优先做单一焦点和强构图。除非用户明确要求，不要出现可读文字、logo、水印。',
    aspect_ratio: '9:16',
    resolution: '2k',
    size: '1024x1536',
    quality: 'high',
    sort_order: 20,
  },
  {
    action_key: 'chapter_illustration',
    label: '章节插图',
    description: '留白更多，适合正文中穿插',
    prompt:
      '生成一张适合作为中文长文章节插图的概念图。保持 Mondo 系列的 screen print 质感与象征性表达，但减少海报感，多一些留白和阅读友好度。构图简洁、主题明确、氛围统一。除非用户明确要求，不要出现可读文字、logo、水印。',
    aspect_ratio: '4:3',
    resolution: '2k',
    size: '1536x1024',
    quality: 'medium',
    sort_order: 30,
  },
  {
    action_key: 'book_cover_concept',
    label: '书封概念图',
    description: '适合书单、读书笔记或封面灵感',
    prompt:
      '生成一张书籍封面概念图，强调 Mondo 系列常见的象征元素、有限色盘、印刷颗粒和复古张力。画面适合 2D 平面设计再加工。主体要明确，边界干净，保留封面排版空间。除非用户明确要求，不要出现可读文字、logo、水印。',
    aspect_ratio: '2:3',
    resolution: '4k',
    size: '1024x1536',
    quality: 'high',
    sort_order: 40,
  },
]

export function getDefaultImageActionSeed(actionKey?: string) {
  if (!actionKey) return null
  return DEFAULT_IMAGE_ACTIONS.find((seed) => seed.action_key === actionKey) || null
}

export async function selectDefaultImageProfileId(db: D1Database): Promise<number | null> {
  const defaultRow = await db.prepare(`
    SELECT id FROM ai_image_provider_profiles
    WHERE is_default = 1
    ORDER BY id ASC
    LIMIT 1
  `).first<{ id: number }>()
  if (defaultRow?.id) return defaultRow.id

  const firstRow = await db.prepare(`
    SELECT id FROM ai_image_provider_profiles
    ORDER BY id ASC
    LIMIT 1
  `).first<{ id: number }>()
  return firstRow?.id ?? null
}

export function buildImageProfileReconciliationStatements(
  db: D1Database,
  removedProfileId?: number,
): D1PreparedStatement[] {
  const removed = Number.isFinite(removedProfileId) ? Number(removedProfileId) : null
  const actionWhere = removed === null ? 'profile_id IS NULL' : 'profile_id IS NULL OR profile_id = ?'
  const generatorWhere = removed === null
    ? 'image_profile_id IS NULL'
    : 'image_profile_id IS NULL OR image_profile_id = ?'

  return [
    db.prepare(`
      UPDATE ai_image_provider_profiles
      SET is_default = 1, updated_at = strftime('%s', 'now')
      WHERE id = (SELECT id FROM ai_image_provider_profiles ORDER BY id ASC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM ai_image_provider_profiles WHERE is_default = 1)
    `),
    db.prepare(`
      UPDATE ai_image_actions
      SET profile_id = (
        SELECT id FROM ai_image_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
      )
      WHERE ${actionWhere}
    `).bind(...(removed === null ? [] : [removed])),
    db.prepare(`
      UPDATE ai_post_generators
      SET image_profile_id = (
        SELECT id FROM ai_image_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
      )
      WHERE target_key = 'cover' AND (${generatorWhere})
    `).bind(...(removed === null ? [] : [removed])),
  ]
}

export async function batchImageProfileMutation(
  db: D1Database,
  mutationStatements: D1PreparedStatement[],
  removedProfileId?: number,
) {
  return db.batch([
    ...mutationStatements,
    ...buildImageProfileReconciliationStatements(db, removedProfileId),
  ])
}

export async function reconcileImageProfileReferencesAfterMutation(
  db: D1Database,
  removedProfileId?: number,
): Promise<number | null> {
  await db.batch(buildImageProfileReconciliationStatements(db, removedProfileId))
  return selectDefaultImageProfileId(db)
}

export async function resolveAiImageProfileConfig(
  db: D1Database,
  secret: string,
  profileId?: number,
): Promise<{
  id: number
  name: string
  provider: string
  provider_name: string
  provider_type: string
  provider_category: string
  api_key_url: string
  base_url: string
  model: string
  api_key: string
  api_key_masked: string
  is_default: number
} | null> {
  const selected = Number.isFinite(profileId) && Number(profileId) > 0
    ? await db.prepare(`
        SELECT *
        FROM ai_image_provider_profiles
        WHERE id = ?
        LIMIT 1
      `).bind(Number(profileId)).first<AIImageProviderProfileRow>()
    : await db.prepare(`
        SELECT *
        FROM ai_image_provider_profiles
        ORDER BY is_default DESC, id ASC
        LIMIT 1
      `).first<AIImageProviderProfileRow>()

  if (!selected?.base_url || !selected.model) return null

  const apiKey = await decryptApiKey(selected.api_key_encrypted || '', secret)
  if (!apiKey) return null

  return {
    id: selected.id,
    name: selected.name,
    provider: selected.provider,
    provider_name: selected.provider_name,
    provider_type: selected.provider_type,
    provider_category: selected.provider_category,
    api_key_url: selected.api_key_url,
    base_url: normalizeBaseUrl(selected.base_url),
    model: selected.model,
    api_key: apiKey,
    api_key_masked: selected.api_key_masked,
    is_default: selected.is_default,
  }
}

export async function saveEncryptedAiImageApiKey(
  apiKey: string,
  secret: string,
): Promise<{ encrypted: string; masked: string }> {
  const normalized = apiKey.trim()
  if (!normalized) {
    return { encrypted: '', masked: '' }
  }

  return {
    encrypted: await encryptApiKey(normalized, secret),
    masked: maskApiKey(normalized),
  }
}
