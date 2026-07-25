import { NextRequest } from 'next/server'
import { GET as getSearch } from '@/app/api/search/route'
import { GET as getAppearance } from '@/app/api/settings/appearance/route'

interface Env {
  DB: D1Database
}

interface SmokeExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

interface WorkerdRequest extends Request {
  cf?: unknown
}

function withRuntimeMarker(response: Response) {
  const marked = new Response(response.body, response)
  marked.headers.set('x-blogman-smoke-runtime', 'workerd')
  return marked
}

const worker = {
  async fetch(request: WorkerdRequest, env: Env, ctx: SmokeExecutionContext) {
    globalThis.__BLOGMAN_RESTORED_D1_WORKER_CONTEXT__ = {
      env,
      ctx,
      cf: request.cf,
    }

    const url = new URL(request.url)
    if (url.pathname === '/__smoke/health') {
      return new Response(null, {
        status: 204,
        headers: { 'x-blogman-smoke-runtime': 'workerd' },
      })
    }
    if (url.pathname === '/api/search') {
      return withRuntimeMarker(await getSearch(new NextRequest(request)))
    }
    if (url.pathname === '/api/settings/appearance') {
      return withRuntimeMarker(await getAppearance())
    }
    return new Response('Not Found', { status: 404 })
  },
}

export default worker

declare global {
  var __BLOGMAN_RESTORED_D1_WORKER_CONTEXT__: {
    env: Env
    ctx: SmokeExecutionContext
    cf: unknown
  } | undefined
}
