import { NextResponse } from 'next/server'
import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { migrationRequiredResponse } from '@/lib/database-errors'

interface AiImageActionPublic {
  id: number
  action_key: string
  label: string
  description: string
  aspect_ratio: string
  resolution: string
  size: string
  profile_id: number | null
}

export async function GET() {
  const env = await getAppCloudflareEnv()
  const db = env?.DB as D1Database | undefined
  if (!db) {
    return NextResponse.json({ actions: [] })
  }

  try {
    const { results } = await db.prepare(`
      SELECT id, action_key, label, description, aspect_ratio, resolution, size, profile_id
      FROM ai_image_actions
      WHERE is_enabled = 1
      ORDER BY sort_order ASC
    `).all<AiImageActionPublic>()

    return NextResponse.json({ actions: results })
  } catch (error) {
    const response = migrationRequiredResponse(error)
    if (response) return response
    throw error
  }
}
