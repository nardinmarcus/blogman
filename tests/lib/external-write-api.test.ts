/**
 * B2-08 — external write protocol module tests (issue #31).
 *
 * Unit surface of lib/external-write-api: protocol negotiation, client-type
 * classification, authority gate, privacy-safe legacy telemetry, legacy /
 * versioned snapshot coercion (draft-only + upgrade signal semantics) and
 * versioned action dispatch over a mocked kernel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  save: vi.fn(),
  publishTemp: vi.fn(),
}))

vi.mock('@/lib/article-commands', () => ({
  create: mocks.create,
  save: mocks.save,
  publishTemp: mocks.publishTemp,
}))

import {
  coerceVersionedSnapshot,
  dispatchExternalWrite,
  isVersionedProtocol,
  resolveArticleBySlug,
} from '@/lib/external-write-api'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ outcome: 'created', articleId: 1, postRef: 10, version: 1, operationId: 'create:abc', existing: false, projectionFailures: [] })
  mocks.save.mockResolvedValue({ outcome: 'applied', articleId: 1, postRef: 10, version: 2, operationId: 'op', existing: false, projectionFailures: [] })
  mocks.publishTemp.mockResolvedValue({ outcome: 'applied', articleId: 1, postRef: 10, version: 2, operationId: 'op', existing: false, projectionFailures: [] })
})

describe('protocol negotiation', () => {
  it('recognizes the versioned protocol marker', () => {
    expect(isVersionedProtocol({ protocol: 'v1' })).toBe(true)
    expect(isVersionedProtocol({ protocol: 'v2' })).toBe(false)
    expect(isVersionedProtocol({})).toBe(false)
  })
})

describe('snapshot coercion', () => {
  it('versioned snapshot is coerced to draft and renders html from markdown when absent', async () => {
    const { snapshot, autoSlug } = await coerceVersionedSnapshot({
      slug: 'My Slug!',
      title: '版本化标题',
      content: '## 小节',
      status: 'published',
      tags: ['甲', '', '乙'],
    })
    expect(autoSlug).toBe(false)
    expect(snapshot.slug).toBe('myslug')
    expect(snapshot.status).toBe('draft')
    expect(snapshot.tags).toEqual(['甲', '乙'])
    expect(snapshot.html).toContain('<h2>小节</h2>')
  })
})

describe('versioned dispatch over the kernel (mock)', () => {
  it('create passes the creationId + draft snapshot to the kernel', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'create', {
      creationId: 'obsidian:note-1',
      snapshot: { title: 'T', content: 'C', category: 'AI' },
    })
    expect(mocks.create).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ creationId: 'obsidian:note-1' }),
    )
    const input = mocks.create.mock.calls[0][1].snapshot as { status: string; title: string }
    expect(input.status).toBe('draft')
    expect(input.title).toBe('T')
    expect(result).toMatchObject({ outcome: 'created', articleId: 1 })
  })

  it('create requires a creationId (identity) and rejects blank ones', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'create', { creationId: '  ', snapshot: {} })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 400 })
  })

  it('save requires articleId / expectedVersion / operationId and dispatches the full snapshot', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'save', {
      articleId: '7',
      expectedVersion: '1',
      operationId: 'op-save-1',
      snapshot: { slug: 's', title: 'T', content: 'C' },
    })
    expect(mocks.save).toHaveBeenCalledWith(db, expect.objectContaining({
      articleId: 7,
      expectedVersion: 1,
      operationId: 'op-save-1',
    }))
    expect(result).toMatchObject({ outcome: 'applied', version: 2 })
  })

  it('publishTemp dispatches the version + status preconditions', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    await dispatchExternalWrite(db, 'publishTemp', {
      articleId: '7',
      expectedVersion: '1',
      currentStatus: 'draft',
      operationId: 'op-pub-1',
      status: 'published',
    })
    expect(mocks.publishTemp).toHaveBeenCalledWith(db, expect.objectContaining({
      articleId: 7,
      expectedVersion: 1,
      currentStatus: 'draft',
      operationId: 'op-pub-1',
      status: 'published',
    }))
  })

  it('unknown action is a 400 without touching the kernel', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) } as never
    const result = await dispatchExternalWrite(db, 'explode', {})
    expect(result).toMatchObject({ status: 400 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('article resolution', () => {
  it('returns null when the slug has no identity/version', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.includes('FROM posts')) return null
            return null
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as never
    expect(await resolveArticleBySlug(db, 'missing')).toBeNull()
  })
})