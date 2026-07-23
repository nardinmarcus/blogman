import type { AiPostGeneratorRow, AiPostGeneratorTarget } from '@/lib/ai-post-generator/types'
import {
  clampMaxTokens,
  clampTemperature,
} from '@/lib/ai-provider-profiles'
import {
  normalizeAiImageAspectRatio,
  normalizeAiImageResolution,
} from '@/lib/ai-image-options'

function normalizeGeneratorRow(row: AiPostGeneratorRow): AiPostGeneratorRow {
  return {
    ...row,
    provider_mode: row.provider_mode === 'profile' ? 'profile' : 'workers_ai',
    workers_model: (row.workers_model || '').trim(),
    temperature: clampTemperature(Number(row.temperature)),
    max_tokens: clampMaxTokens(Number(row.max_tokens)),
    aspect_ratio: normalizeAiImageAspectRatio(row.aspect_ratio),
    resolution: normalizeAiImageResolution(row.resolution),
  }
}

export async function listAiPostGenerators(
  db: D1Database,
) {
  const { results } = await db.prepare(`
    SELECT *
    FROM ai_post_generators
    ORDER BY CASE target_key
      WHEN 'summary' THEN 1
      WHEN 'tags' THEN 2
      WHEN 'slug' THEN 3
      WHEN 'cover' THEN 4
      ELSE 99
    END ASC
  `).all<AiPostGeneratorRow>()

  return (results || []).map(normalizeGeneratorRow)
}

export async function getAiPostGeneratorByTarget(
  db: D1Database,
  target: AiPostGeneratorTarget,
) {
  const row = await db.prepare(`
    SELECT *
    FROM ai_post_generators
    WHERE target_key = ?
    LIMIT 1
  `).bind(target).first<AiPostGeneratorRow>()

  return row ? normalizeGeneratorRow(row) : null
}
