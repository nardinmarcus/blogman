/**
 * B2-04 — editor save coordinator protocol tests (issue #27).
 *
 * Unit-level coverage of the main editor's versioned save/confirm protocol,
 * exactly the high-level flows the ticket asks to verify, without a browser:
 *
 *   - 请求期间继续输入: a stale success can never mark new input as saved
 *   - 响应丢失: the same operation id is reused so the server replays (no dup)
 *   - 刷新恢复: the device's local draft is restored and re-submitted at its base version
 *   - 临时断网: error -> draft persisted -> backoff retry -> confirm -> draft cleared
 *   - 三种冲突选择: adopt server / safe re-submit / save-as-new
 *   - 空白页不建稿 + 新建重试不复制文章 (creationId idempotency)
 *   - 发布动作走 publishTemp（状态变更时才触发）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EditorSaveCoordinator,
  articleDraftKey,
  newDraftKey,
} from '@/lib/editor-save-coordinator'
import type {
  CommandResult,
  CommandTransport,
  CoordinatorState,
  EditorContent,
  EditorSnapshot,
  LocalDraftRecord,
} from '@/lib/editor-save-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((res) => res())

function baseContent(overrides: Partial<EditorContent> = {}): EditorContent {
  return {
    slug: 's1',
    title: '标题',
    html: '<p>正文</p>',
    content: '正文',
    description: '',
    category: '',
    tags: [],
    coverImage: '',
    ...overrides,
  }
}

function fullSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    ...baseContent(),
    status: 'draft',
    password: null,
    isHidden: 0,
    publishedAt: null,
    ...overrides,
  }
}

function applied(overrides: Partial<Extract<CommandResult, { outcome: 'applied' }>> = {}): CommandResult {
  return {
    outcome: 'applied',
    articleId: 5,
    postRef: 9,
    version: 2,
    operationId: 'op1',
    existing: false,
    slug: 's1',
    publishedAt: null,
    ...overrides,
  }
}

function conflict(overrides: Partial<Extract<CommandResult, { outcome: 'conflict' }>> = {}): CommandResult {
  return {
    outcome: 'conflict',
    articleId: 5,
    postRef: 9,
    expectedVersion: 1,
    serverVersion: 3,
    facts: { title: '服务器版', updated_at: null },
    ...overrides,
  }
}

interface Harness {
  coordinator: EditorSaveCoordinator
  transport: {
    create: ReturnType<typeof vi.fn>
    save: ReturnType<typeof vi.fn>
    publishTemp: ReturnType<typeof vi.fn>
    getServerSnapshot: ReturnType<typeof vi.fn>
  }
  store: Map<string, LocalDraftRecord>
  states: CoordinatorState[]
  content: (patch: Partial<EditorContent>) => void
}

function makeHarness(
  article: { articleId?: number | null; version?: number | null; store?: Map<string, LocalDraftRecord> } = {},
): Harness {
  let current: EditorContent = baseContent()
  const store = article.store ?? new Map<string, LocalDraftRecord>()
  const articleId = article.articleId !== undefined ? article.articleId : 5
  const version = article.version !== undefined ? article.version : 1
  const states: CoordinatorState[] = []
  const transport = {
    create: vi.fn(async () => ({
      outcome: 'created' as const,
      articleId: 5,
      postRef: 9,
      version: 1,
      operationId: 'create:creation',
      existing: false,
      slug: 's1',
    })),
    save: vi.fn(async () => applied()),
    publishTemp: vi.fn(async () => applied()),
    getServerSnapshot: vi.fn(async () => ({ articleId: 5, version: 2, snapshot: fullSnapshot() })),
  }
  let opSeq = 0
  const coordinator = new EditorSaveCoordinator({
    articleId,
    version,
    creationId: 'creation',
    getContent: () => ({ ...current }),
    transport: transport as unknown as CommandTransport,
    draftStore: {
      load: (key) => store.get(key) ?? null,
      save: (key, record) => void store.set(key, record),
      remove: (key) => void store.delete(key),
    },
    onStateChange: (s) =>
      states.push({
        ...s,
        applied: { ...s.applied },
        conflict: s.conflict ? { ...s.conflict } : null,
      }),
    debounceMs: 1500,
    maxRetryDelayMs: 10000,
    newOperationId: () => `op${(opSeq += 1)}`,
    now: () => 1_700_000_000,
  })
  return {
    coordinator,
    transport,
    store,
    states,
    content: (patch) => {
      current = { ...current, ...patch }
    },
  }
}

function lastStatus(h: Harness): CoordinatorState['status'] {
  return h.states.at(-1)?.status ?? 'saved'
}

function saveCall(h: Harness, index = 0): { expectedVersion: number; operationId: string; snapshot: EditorSnapshot } {
  return h.transport.save.mock.calls[index][0] as { expectedVersion: number; operationId: string; snapshot: EditorSnapshot }
}

describe('EditorSaveCoordinator — autosave / confirm protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('请求期间继续输入：旧请求成功不能把新输入标为已保存', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed() // 确认基线 = 标题
    h.content({ title: 'B' }) // 用户输入 B

    const d1 = deferred<CommandResult>()
    h.transport.save.mockReturnValueOnce(d1.promise)
    const p1 = h.coordinator.flush() // B 的保存请求在途
    await tick()
    expect(h.transport.save).toHaveBeenCalledTimes(1)
    expect(saveCall(h, 0).expectedVersion).toBe(1)
    expect(saveCall(h, 0).snapshot.title).toBe('B')

    // 请求期间用户继续输入 C，并再次触发保存（pending）
    h.content({ title: 'C' })
    const d2 = deferred<CommandResult>()
    h.transport.save.mockReturnValueOnce(d2.promise)
    void h.coordinator.flush()
    await tick()

    // B 的成功响应到达 —— 必须不能把 C 标为已保存
    d1.resolve(applied({ version: 2, operationId: 'op1' }))
    await tick()
    await tick()
    expect(h.transport.save).toHaveBeenCalledTimes(2)
    expect(saveCall(h, 1).expectedVersion).toBe(2) // 以服务端确认版本 2 为基
    expect(saveCall(h, 1).snapshot.title).toBe('C')
    expect(lastStatus(h)).not.toBe('saved')

    d2.resolve(applied({ version: 3, operationId: 'op2' }))
    await p1
    expect(lastStatus(h)).toBe('saved')
    expect(lastStatus(h)).not.toBe('dirty')
  })

  it('响应丢失：重试复用同一 operation id，服务端重放不出新版本', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed()
    h.content({ title: 'B' })

    h.transport.save.mockRejectedValueOnce(new Error('network lost'))
    const ok1 = await h.coordinator.flush()
    expect(ok1).toBe(false)
    expect(lastStatus(h)).toBe('error')
    const first = saveCall(h, 0)

    // 重试复用同一 operation id + 相同快照
    h.transport.save.mockResolvedValueOnce(applied({ version: 2, operationId: first.operationId, existing: true, outcome: 'replayed' }))
    await vi.advanceTimersByTimeAsync(2500) // backoff 2000ms 触发重试
    expect(h.transport.save).toHaveBeenCalledTimes(2)
    expect(saveCall(h, 1).operationId).toBe(first.operationId)
    expect(saveCall(h, 1).snapshot.title).toBe('B')
    expect(lastStatus(h)).toBe('saved')
  })

  it('刷新恢复：本机未确认稿被恢复，并以其基线版本安全重提', async () => {
    const h1 = makeHarness()
    h1.coordinator.setAppliedState({ status: 'draft' })
    h1.coordinator.setInitialConfirmed()
    h1.content({ title: 'B' })
    h1.transport.save.mockRejectedValue(new Error('offline'))
    await h1.coordinator.flush() // 未确认 → 写入本机草稿
    expect(lastStatus(h1)).toBe('error')
    const key = articleDraftKey(5)
    expect(h1.store.has(key)).toBe(true)
    expect(h1.store.get(key)!.snapshot.title).toBe('B')

    // 刷新（新实例、同一 draftStore）
    const h2 = makeHarness({ store: h1.store })
    h2.coordinator.setAppliedState({ status: 'draft' })
    h2.coordinator.setInitialConfirmed() // 基线 = 标题（A）
    const restored = h2.coordinator.restoreLocalDraft()
    expect(restored).not.toBeNull()
    expect(restored!.title).toBe('B')

    h2.content(restored!) // 应用到编辑器
    h2.coordinator.schedule()
    await vi.advanceTimersByTimeAsync(1600) // 自动保存重提
    expect(h2.transport.save).toHaveBeenCalledTimes(1)
    expect(saveCall(h2, 0).snapshot.title).toBe('B')
    expect(saveCall(h2, 0).expectedVersion).toBe(1) // 基于稿基线版本
  })

  it('临时断网：报错 → 写入草稿 → 退避重试成功后清除匹配本机稿', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed()
    h.content({ title: 'B' })
    h.transport.save.mockRejectedValueOnce(new Error('offline'))
    await h.coordinator.flush()
    expect(lastStatus(h)).toBe('error')
    expect(h.store.has(articleDraftKey(5))).toBe(true)

    h.transport.save.mockResolvedValueOnce(applied({ version: 2, operationId: 'op1', existing: true, outcome: 'replayed' }))
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.transport.save).toHaveBeenCalledTimes(2)
    expect(lastStatus(h)).toBe('saved')
    // 服务端确认后才清除匹配的本机未确认稿
    expect(h.store.has(articleDraftKey(5))).toBe(false)
  })

  it('冲突：暂停自动保存且绝不自动合并；三种选择', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed()
    h.content({ title: 'B' })
    h.transport.save.mockResolvedValueOnce(conflict({ expectedVersion: 1, serverVersion: 3 }))
    const ok = await h.coordinator.flush()
    expect(ok).toBe(false)
    expect(lastStatus(h)).toBe('conflict')
    expect(h.states.at(-1)!.conflict!.serverVersion).toBe(3)

    // 冲突暂停自动保存：继续输入也不触发
    h.content({ title: 'C' })
    h.coordinator.schedule()
    await vi.advanceTimersByTimeAsync(4000)
    expect(h.transport.save).toHaveBeenCalledTimes(1) // 没有再发
  })

  it('冲突选择一：服务器版（adoptServerVersion）丢弃本机未确认稿', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed()
    h.content({ title: 'B' })
    h.transport.save.mockResolvedValueOnce(conflict({ expectedVersion: 1, serverVersion: 3 }))
    await h.coordinator.flush()
    expect(lastStatus(h)).toBe('conflict')
    const key = articleDraftKey(5)
    expect(h.store.has(key)).toBe(true) // 冲突时保有本机草稿

    h.transport.getServerSnapshot.mockResolvedValueOnce({
      articleId: 5,
      version: 3,
      snapshot: fullSnapshot({ title: '服务器最新版', slug: 'server-slug' }),
    })
    const serverSnap = await h.coordinator.adoptServerVersion()
    expect(serverSnap?.title).toBe('服务器最新版')
    expect(lastStatus(h)).toBe('saved')
    expect(h.store.has(key)).toBe(false) // 明确采用服务器版 → 清除本机稿
  })

  it('冲突选择二：本机版安全重提（resubmitLocal）以服务端版本为基', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed()
    h.content({ title: 'B' })
    h.transport.save.mockResolvedValueOnce(conflict({ expectedVersion: 1, serverVersion: 3 }))
    await h.coordinator.flush()
    expect(lastStatus(h)).toBe('conflict')

    h.transport.save.mockResolvedValueOnce(applied({ version: 4, operationId: 'op1', existing: true, outcome: 'replayed' }))
    const ok = await h.coordinator.resubmitLocal()
    expect(ok).toBe(true)
    expect(h.transport.save).toHaveBeenCalledTimes(2)
    expect(saveCall(h, 1).expectedVersion).toBe(3) // 采用服务端版本当基
    expect(saveCall(h, 1).snapshot.title).toBe('B') // 本机内容
    expect(saveCall(h, 1).operationId).toBe('op1') // 复用同一 operation id
    expect(lastStatus(h)).toBe('saved')
  })

  it('冲突选择三：另存为新草稿不碰服务器版本', async () => {
    const h = makeHarness()
    h.coordinator.setAppliedState({ status: 'draft' })
    h.coordinator.setInitialConfirmed()
    h.content({ title: 'B' })
    h.transport.save.mockResolvedValueOnce(conflict({ expectedVersion: 1, serverVersion: 3 }))
    await h.coordinator.flush()
    expect(lastStatus(h)).toBe('conflict')

    h.transport.create.mockResolvedValueOnce({
      outcome: 'created',
      articleId: 99,
      postRef: 100,
      version: 1,
      operationId: 'opNew',
      existing: false,
      slug: '2026-01-01-copied',
    })
    const res = await h.coordinator.saveAsNewDraft()
    expect(res.ok).toBe(true)
    expect(res.slug).toBe('2026-01-01-copied')
    // 另存用自动 slug，绝不复用被冲突的原 slug
    expect(h.transport.create.mock.calls[0][0].snapshot.slug).toBe('')
    expect(h.transport.create.mock.calls[0][0].creationId).toMatch(/^op\d+$/)
    expect(lastStatus(h)).toBe('saved')
  })

  it('空白页不建稿；新建重试不复制文章（creationId 幂等）', async () => {
    const h = makeHarness({ articleId: null, version: null })
    h.coordinator.setInitialConfirmed()
    // 空白会话
    h.content({ title: '', html: '', content: '' })
    h.coordinator.schedule()
    await vi.advanceTimersByTimeAsync(1600)
    expect(h.transport.create).not.toHaveBeenCalled() // 不建稿
    expect(lastStatus(h)).toBe('saved')

    // 有内容 → 创建，携带稳定 creationId
    h.content({ title: '新文章', html: '<p>x</p>', content: 'x' })
    h.transport.create.mockRejectedValueOnce(new Error('lost')) // 建稿响应丢失
    await h.coordinator.flush()
    expect(h.transport.create).toHaveBeenCalledTimes(1)
    expect(h.transport.create.mock.calls[0][0].creationId).toBe('creation')
    expect(h.states.at(-1)!.articleId).toBeNull() // 尚未获得身份

    // 重试仍用同一 creationId → 服务端 existing 重放，绝不复制
    h.transport.create.mockResolvedValueOnce({ outcome: 'existing', articleId: 5, postRef: 9, version: 1, operationId: 'create:creation', existing: true, slug: '2026-01-01-abc' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.transport.create).toHaveBeenCalledTimes(2)
    expect(h.transport.create.mock.calls[1][0].creationId).toBe('creation') // 同一 key
    expect(h.states.at(-1)!.articleId).toBe(5)
    expect(h.states.at(-1)!.status).toBe('saved')
  })

  it('发布动作改接 publishTemp：内容保存保持当前状态，仅状态变更走临时版本化发布', async () => {
    const h = makeHarness({ articleId: 5, version: 1 })
    h.coordinator.setAppliedState({ status: 'published', publishedAt: 100 })
    h.coordinator.setInitialConfirmed()
    h.content({ title: '新标题' }) // 有内容变更

    h.transport.save.mockResolvedValueOnce(applied({ version: 2, operationId: 'op1', publishedAt: 100 }))
    h.transport.publishTemp.mockResolvedValueOnce({ outcome: 'applied', articleId: 5, postRef: 9, version: 3, operationId: 'opP', existing: false, publishedAt: 100 })
    const res = await h.coordinator.saveAndPublish({ status: 'draft' })

    expect(res.ok).toBe(true)
    // 内容保存的 snapshot 保持当前服务端状态（published），不改状态
    expect(saveCall(h, 0).snapshot.status).toBe('published')
    // 状态变更走 publishTemp，带版本 + 状态前置条件
    const pub = h.transport.publishTemp.mock.calls[0][0] as { expectedVersion: number; currentStatus: string; status: string }
    expect(pub.expectedVersion).toBe(2)
    expect(pub.currentStatus).toBe('published')
    expect(pub.status).toBe('draft')
    expect(lastStatus(h)).toBe('saved')
  })
})

describe('EditorSaveCoordinator — 每篇文章每台设备最多一份本机未确认稿', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('草稿按文章/设备槽位保存；新会话键随建稿迁移到文章身份', async () => {
    // 新文章：草稿存在 new:<creationId>
    const h = makeHarness({ articleId: null, version: null })
    h.coordinator.setInitialConfirmed()
    h.content({ title: '草稿一', html: '<p>a</p>', content: 'a' })
    h.transport.create.mockRejectedValueOnce(new Error('offline'))
    await h.coordinator.flush()
    expect(h.store.has(newDraftKey('creation'))).toBe(true)

    // 网络恢复 → 建稿成功 → 草稿迁移/清除，后续存入 article:<id>
    h.transport.create.mockResolvedValueOnce({ outcome: 'created', articleId: 5, postRef: 9, version: 1, operationId: 'create:creation', existing: false, slug: '2026-01-01-abc' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.store.has(newDraftKey('creation'))).toBe(false)
    expect(h.states.at(-1)!.articleId).toBe(5)
  })
})
