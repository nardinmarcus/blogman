/**
 * B4-04 — /api/workbench + /api/notifications + /api/deep-link route dispatch
 * tests (issue #43).
 *
 * Thin-adapter behavior: auth gating, grouping preserved through the route,
 * deep-link fallback on expired identity, and no side effects (route handlers
 * only read / dispatch; the kernels own all state). The kernels & D1 are
 * exercised by the shared-Miniflare suites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const deferred = vi.hoisted(() => {
  const workbenchMocks = {
    buildTodayWorkbench: vi.fn(),
    getRouteContextWithDb: vi.fn(),
    ensureAuthenticatedRequest: vi.fn(),
  }
  const notifMocks = {
    listNotifications: vi.fn(),
    recordNotification: vi.fn(),
    acknowledgeNotification: vi.fn(),
    resolveNotification: vi.fn(),
    getRouteContextWithDb: vi.fn(),
    ensureAuthenticatedRequest: vi.fn(),
    parseJsonBody: vi.fn(),
  }
  const deepLinkMocks = {
    resolveDeepLink: vi.fn(),
    getRouteContextWithDb: vi.fn(),
    ensureAuthenticatedRequest: vi.fn(),
    parseJsonBody: vi.fn(),
  }
  return { workbenchMocks, notifMocks, deepLinkMocks }
})

vi.mock('@/lib/workbench', () => ({ buildTodayWorkbench: deferred.workbenchMocks.buildTodayWorkbench }))
vi.mock('@/lib/notifications', () => ({
  listNotifications: deferred.notifMocks.listNotifications,
  recordNotification: deferred.notifMocks.recordNotification,
  acknowledgeNotification: deferred.notifMocks.acknowledgeNotification,
  resolveNotification: deferred.notifMocks.resolveNotification,
}))
vi.mock('@/lib/deep-link', () => ({ resolveDeepLink: deferred.deepLinkMocks.resolveDeepLink }))

vi.mock('@/lib/server/route-helpers', () => ({
  ensureAuthenticatedRequest: deferred.workbenchMocks.ensureAuthenticatedRequest,
  getRouteContextWithDb: deferred.workbenchMocks.getRouteContextWithDb,
  jsonError: (message: string, status = 500) => Response.json({ error: message }, { status }),
  jsonOk: (data: unknown, status = 200) => Response.json(data, { status }),
  parseJsonBody: deferred.notifMocks.parseJsonBody,
}))

import { GET as WorkbenchGET } from '@/app/api/workbench/route'
import { POST as NotifPOST } from '@/app/api/notifications/route'
import { POST as DeepLinkPOST } from '@/app/api/deep-link/route'

function fakeDb() {
  return {
    prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { last_row_id: 1 } }) }) }),
  } as never
}

const okRoute = { ok: true, env: {}, db: fakeDb(), ctx: { waitUntil: vi.fn() } }

beforeEach(() => {
  vi.clearAllMocks()
  ;(deferred.workbenchMocks.getRouteContextWithDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(okRoute)
  ;(deferred.notifMocks.getRouteContextWithDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(okRoute)
  ;(deferred.deepLinkMocks.getRouteContextWithDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(okRoute)
  ;(deferred.workbenchMocks.ensureAuthenticatedRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  ;(deferred.notifMocks.ensureAuthenticatedRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  ;(deferred.deepLinkMocks.ensureAuthenticatedRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
})

describe('/api/workbench — grouping preserved through the route', () => {
  it('returns the grouped projection with responsibility intact', async () => {
    const grouped = {
      projectionEnabled: true,
      generatedAt: 1700000000,
      groups: [
        { group: 'drafts', responsible: 'author', label: '草稿', items: [{ key: 'drafts:article:1', sourceType: 'article', sourceId: '1', title: 'A', group: 'drafts', responsible: 'author', meta: {}, updatedAt: 1 }] },
        { group: 'system-in-progress', responsible: 'system', label: '系统处理中', items: [] as never[] },
      ],
    }
    ;(deferred.workbenchMocks.buildTodayWorkbench as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(grouped)

    const res = await WorkbenchGET(new Request('http://x/api/workbench') as never)
    const body = await res.json()
    expect(res.status).toBe(200)
    const drafts = body.groups.find((g: { group: string }) => g.group === 'drafts')
    expect(drafts.responsible).toBe('author')
    expect(body.groups.find((g: { group: string }) => g.group === 'system-in-progress').responsible).toBe('system')
    expect(deferred.workbenchMocks.buildTodayWorkbench).toHaveBeenCalled()
  })
})

describe('/api/notifications — acknowledge never resolves (route 已知晓不伪造解决)', () => {
  it('ack dispatch keeps status open', async () => {
    ;(deferred.notifMocks.parseJsonBody as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: 'ack',
      sourceType: 'schedule',
      sourceId: 'sched-1',
    })
    ;(deferred.notifMocks.acknowledgeNotification as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: 'acknowledged',
      dedupKey: 'schedule:sched-1',
      acknowledgedAt: 1700000000,
      status: 'open',
    })
    const res = await NotifPOST({} as never)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.outcome).toBe('acknowledged')
    expect(body.status).toBe('open')
    expect(deferred.notifMocks.resolveNotification).not.toHaveBeenCalled()
  })

  it('records a notification by source (dedup source of record)', async () => {
    ;(deferred.notifMocks.parseJsonBody as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: 'record',
      notificationId: 'n-1',
      sourceType: 'schedule',
      sourceId: 'sched-1',
      title: '版本漂移',
    })
    ;(deferred.notifMocks.recordNotification as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: 'recorded',
      notificationId: 'n-1',
      dedupKey: 'schedule:sched-1',
      created: true,
      createdAt: 1700000000,
    })
    const res = await NotifPOST({} as never)
    expect(res.status).toBe(200)
    expect(deferred.notifMocks.recordNotification).toHaveBeenCalled()
  })
})

describe('/api/deep-link — expired identity falls back, no side effect', () => {
  it('returns the current-reality fallback for a fired schedule', async () => {
    ;(deferred.notifMocks.parseJsonBody as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      sourceType: 'schedule',
      sourceId: 'fired-1',
    })
    ;(deferred.deepLinkMocks.resolveDeepLink as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: 'schedule-fired',
      sourceType: 'schedule',
      sourceId: 'fired-1',
      liveStatus: 'fired',
      liveTitle: '已发布文章',
      navigation: { href: 'https://blog.example.test/x', label: '查看文章' },
      responsible: null,
      fallback: true,
    })
    const res = await DeepLinkPOST({} as never)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.resolution.fallback).toBe(true)
    expect(body.resolution.liveStatus).toBe('fired')
    // The route only reads state — it must never write.
    expect(body.resolution.navigation.href).toContain('blog.example.test')
  })

  it('rejects an invalid sourceType without calling the kernel', async () => {
    ;(deferred.notifMocks.parseJsonBody as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      sourceType: 'bogus',
      sourceId: 'x',
    })
    const res = await DeepLinkPOST({} as never)
    expect(res.status).toBe(400)
    expect(deferred.deepLinkMocks.resolveDeepLink).not.toHaveBeenCalled()
  })
})

describe('auth gating (无副作用)', () => {
  it('workbench GET rejects unauthenticated requests', async () => {
    ;(deferred.workbenchMocks.ensureAuthenticatedRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    )
    const res = await WorkbenchGET(new Request('http://x/api/workbench') as never)
    expect(res.status).toBe(401)
    expect(deferred.workbenchMocks.buildTodayWorkbench).not.toHaveBeenCalled()
  })
})
