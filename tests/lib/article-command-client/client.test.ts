/**
 * Article Command Client — wire contract tests.
 *
 * The interface is the test surface: every assertion here pins the exact
 * bytes the seam puts on the wire (issue #19 / PR #239 was a caller
 * drifting off this contract) and the normalization of every outcome the
 * wire can emit. Fakes inject at the factory seam — no React, no server.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createArticleCommandClient } from '@/lib/article-command-client/client'
import type { ArticleCommandRequest, ArticleCommandTarget, FetchLike } from '@/lib/article-command-client/types'

function fakeResponse(ok: boolean, body: unknown) {
  return {
    ok,
    json: async () => {
      // body === undefined models an unparseable body: the real res.json()
      // REJECTS in that case (it never resolves to undefined).
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return body
    },
  }
}

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

function recordingFetch(responses: Array<{ ok: boolean; body: unknown }>): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return fakeResponse(r.ok, r.body)
  }
  return { fetchImpl, calls }
}

const authority: ArticleCommandTarget = { slug: 'hello-world', articleId: 7, expectedVersion: 3 }

let opSeq = 1
const opId = () => `op-${String(opSeq++)}`

beforeEach(() => {
  opSeq = 1
})

function makeClient(fetchImpl: FetchLike) {
  return createArticleCommandClient({ fetchImpl, newOperationId: opId })
}

describe('versioned wire: request bodies', () => {
  it.each([
    [{ action: 'setPinned', is_pinned: 1 }, { is_pinned: 1 }],
    [{ action: 'setHidden', is_hidden: 0 }, { is_hidden: 0 }],
    [{ action: 'setPassword', password: 'pw123' }, { password: 'pw123' }],
    [{ action: 'setCategory', category: '随笔' }, { category: '随笔' }],
    [{ action: 'softDelete' }, {}],
    [{ action: 'restore' }, {}],
    [{ action: 'unpublish' }, {}],
    [{ action: 'relive', content: 'formal' }, { content: 'formal' }],
  ] as Array<[ArticleCommandRequest, Record<string, unknown>]>)('sends %j with the authority envelope', async (request, payload) => {
    const { fetchImpl, calls } = recordingFetch([{ ok: true, body: { outcome: 'applied' } }])
    await makeClient(fetchImpl).execute(authority, request)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/article-commands')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(calls[0].init.body)).toEqual({
      action: request.action,
      slug: 'hello-world',
      articleId: 7,
      expectedVersion: 3,
      operationId: 'op-1',
      ...payload,
    })
  })

  it('generates a fresh operation id per call', async () => {
    const { fetchImpl, calls } = recordingFetch([
      { ok: true, body: { outcome: 'applied' } },
      { ok: true, body: { outcome: 'applied' } },
    ])
    const client = makeClient(fetchImpl)
    await client.execute(authority, { action: 'softDelete' })
    await client.execute(authority, { action: 'softDelete' })
    expect(JSON.parse(calls[0].init.body).operationId).toBe('op-1')
    expect(JSON.parse(calls[1].init.body).operationId).toBe('op-2')
  })
})

describe('refusal without versioned authority (ADR 0011 — bypass retired)', () => {
  it.each([
    { slug: 'hello-world', articleId: null, expectedVersion: null },
    { slug: 'hello-world', articleId: 7, expectedVersion: null },
    { slug: 'hello-world', articleId: null, expectedVersion: 3 },
  ])('never touches the wire for %j — refuses with the 409 message', async (target) => {
    const fetchImpl = vi.fn()
    const result = await makeClient(fetchImpl as unknown as FetchLike).execute(target, { action: 'softDelete' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'error', ok: false, message: '文章尚未启用版本化写入' })
  })

  it('encodes the slug into the versioned envelope once authority exists', async () => {
    const { fetchImpl, calls } = recordingFetch([{ ok: true, body: { outcome: 'applied' } }])
    await makeClient(fetchImpl).execute({ ...authority, slug: 'a b/中文' }, { action: 'softDelete' })
    expect(calls[0].url).toBe('/api/article-commands')
    expect(JSON.parse(calls[0].init.body).slug).toBe('a b/中文')
  })
})

describe('outcome normalization', () => {
  it.each([
    ['applied → ok, not replayed', { outcome: 'applied' }, { kind: 'ok', ok: true, replayed: false }],
    ['replayed → ok, replayed', { outcome: 'replayed' }, { kind: 'ok', ok: true, replayed: true }],
    ['legacy-applied → ok (dead vocabulary folded)', { outcome: 'legacy-applied' }, { kind: 'ok', ok: true, replayed: false }],
    ['legacy wire (no outcome field) → ok', { ok: true }, { kind: 'ok', ok: true, replayed: false }],
  ] as const)('%s', async (_label, wireBody, expected) => {
    const { fetchImpl } = recordingFetch([{ ok: true, body: wireBody }])
    const result = await makeClient(fetchImpl).execute(authority, { action: 'softDelete' })
    expect(result).toEqual(expected)
  })

  it('conflict keeps serverVersion', async () => {
    const { fetchImpl } = recordingFetch([{ ok: true, body: { outcome: 'conflict', serverVersion: 9, facts: null } }])
    const result = await makeClient(fetchImpl).execute(authority, { action: 'softDelete' })
    expect(result).toEqual({ kind: 'conflict', ok: false, serverVersion: 9 })
  })

  it('conflict without serverVersion degrades gracefully', async () => {
    const { fetchImpl } = recordingFetch([{ ok: true, body: { outcome: 'conflict' } }])
    const result = await makeClient(fetchImpl).execute(authority, { action: 'softDelete' })
    expect(result).toEqual({ kind: 'conflict', ok: false, serverVersion: undefined })
  })

  it.each([
    ['HTTP error with message', { error: '文章不存在' }, '文章不存在'],
    ['HTTP error without message falls back', {}, '操作失败，请重试'],
    ['unparseable error body falls back', undefined, '操作失败，请重试'],
  ])('%s', async (_label, wireBody, expectedMessage) => {
    const { fetchImpl } = recordingFetch([{ ok: false, body: wireBody }])
    const result = await makeClient(fetchImpl).execute(authority, { action: 'softDelete' })
    expect(result).toEqual({ kind: 'error', ok: false, message: expectedMessage })
  })

  it('network failure → error with the network message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as FetchLike
    const result = await makeClient(fetchImpl).execute(authority, { action: 'softDelete' })
    expect(result).toEqual({ kind: 'error', ok: false, message: '网络错误，请重试' })
  })
})

describe('batch classification', () => {
  const items = [
    { slug: 'a', articleId: 1, expectedVersion: 1, category: '随笔' },
    { slug: 'b', articleId: 2, expectedVersion: 4, category: null },
    { slug: 'c', articleId: null, expectedVersion: null, category: '随笔' },
  ]

  it('sends each item with its own operation id (rows keep their preconditions)', async () => {
    const { fetchImpl, calls } = recordingFetch([{ ok: true, body: { items: [] } }])
    await makeClient(fetchImpl).runBatchCategory(items)
    const body = JSON.parse(calls[0].init.body)
    expect(body.action).toBe('batchSetCategory')
    expect(body.items).toEqual([
      { slug: 'a', articleId: 1, expectedVersion: 1, operationId: 'op-1', category: '随笔' },
      { slug: 'b', articleId: 2, expectedVersion: 4, operationId: 'op-2', category: null },
      { slug: 'c', articleId: null, expectedVersion: null, operationId: 'op-3', category: '随笔' },
    ])
  })

  it('counts applied / legacy-applied / conflict / skipped exactly like the old list (replayed not counted)', async () => {
    const { fetchImpl } = recordingFetch([
      {
        ok: true,
        body: {
          items: [
            { outcome: 'applied' },
            { outcome: 'legacy-applied' },
            { outcome: 'conflict' },
            { outcome: 'not-found' },
            { outcome: 'invalid' },
            { outcome: 'error' },
            { outcome: 'replayed' },
          ],
        },
      },
    ])
    const result = await makeClient(fetchImpl).runBatchCategory(items)
    expect(result).toEqual({ ok: true, applied: 2, conflicts: 1, skipped: 3 })
  })

  it('HTTP error surfaces the wire message', async () => {
    const { fetchImpl } = recordingFetch([{ ok: false, body: { error: 'items 不能为空' } }])
    const result = await makeClient(fetchImpl).runBatchCategory(items)
    expect(result).toEqual({ ok: false, message: 'items 不能为空' })
  })

  it('network failure surfaces the raw error message (as the old list did)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as FetchLike
    const result = await makeClient(fetchImpl).runBatchCategory(items)
    expect(result).toEqual({ ok: false, message: 'fetch failed' })
  })
})
