import type { NextRequest } from 'next/server'
import { ensureAuthenticatedRequest, getRouteEnvWithDb, jsonError, jsonOk, parseJsonBody } from '@/lib/server/route-helpers'
import { getWechatBridgePublicConfig, saveWechatBridgeConfig } from '@/lib/wechat-bridge-config'
import { rethrowIfDatabaseMigrationRequired, withDatabaseErrorResponse } from '@/lib/database-errors'

interface SaveWechatBridgeBody {
  enabled?: boolean
  base_url?: string
  token?: string
}

async function getWechatBridge(req: NextRequest) {
  const route = await getRouteEnvWithDb('DB unavailable')
  if (!route.ok) return route.response

  const unauthorized = await ensureAuthenticatedRequest(req, route.db)
  if (unauthorized) return unauthorized

  const config = await getWechatBridgePublicConfig(route.db, route.env)
  return jsonOk({ config })
}

async function updateWechatBridge(req: NextRequest) {
  const route = await getRouteEnvWithDb('DB unavailable')
  if (!route.ok) return route.response

  const unauthorized = await ensureAuthenticatedRequest(req, route.db)
  if (unauthorized) return unauthorized

  try {
    const body = await parseJsonBody<SaveWechatBridgeBody>(req)
    const baseUrl = (body.base_url || '').trim()

    if (body.enabled && !baseUrl) {
      return jsonError('启用 bridge 前需要填写 Base URL', 400)
    }

    const config = await saveWechatBridgeConfig(route.db, route.env, {
      enabled: body.enabled,
      base_url: baseUrl,
      token: body.token,
    })

    return jsonOk({ success: true, config })
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    return jsonError(error instanceof Error ? error.message : '保存 bridge 配置失败', 500)
  }
}

export const GET = withDatabaseErrorResponse(getWechatBridge)
export const PUT = withDatabaseErrorResponse(updateWechatBridge)
