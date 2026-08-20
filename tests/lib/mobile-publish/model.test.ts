/**
 * B8-05 — mobile full-page publish confirmation model tests (issue #64).
 *
 * Pure node tests (no browser, no D1): publish path selection, confirmation
 * blockers (incl. the version-drift "confirm during → abort" rule), the
 * deterministic first-publish ids behind single-event/outbox idempotency, and
 * the combined 博客/排期/渠道 receipt shaping. Client-safe (no node:crypto).
 */

import { describe, expect, it } from 'vitest'
import {
  blockersAllPass,
  CONFIRM_BLOCKER_LABELS,
  confirmBlockers,
  failingConfirmBlockers,
  firstIntentId,
  firstPrepareId,
  formatPublishTime,
  publishPathFor,
  revisionOperationId,
  shapeReceiptSurfaces,
} from '@/lib/mobile-publish'

const baseInput = {
  exactVersion: 3,
  latestVersion: 3,
  deleted: false,
  title: '标题',
  contentHtml: '<p>正文</p>',
}

describe('mobile-publish model — path selection', () => {
  it('a never-published non-deleted draft is a FIRST publish', () => {
    expect(publishPathFor({ formalPresent: false, hasActiveRevision: false, deleted: false })).toBe('first')
  })
  it('a formal article with an active revision is a REVISION promote', () => {
    expect(publishPathFor({ formalPresent: true, hasActiveRevision: true, deleted: false })).toBe('revision')
  })
  it('a formal article with no pending revision is already published (nothing new)', () => {
    expect(publishPathFor({ formalPresent: true, hasActiveRevision: false, deleted: false })).toBe('already')
  })
  it('a deleted article (even with a revision) is unavailable', () => {
    expect(publishPathFor({ formalPresent: true, hasActiveRevision: true, deleted: true })).toBe('unavailable')
    expect(publishPathFor({ formalPresent: false, hasActiveRevision: false, deleted: true })).toBe('unavailable')
  })
})

describe('mobile-publish model — confirmation blockers', () => {
  it('passes when the exact version is latest, not deleted, and content is present', () => {
    const blockers = confirmBlockers(baseInput)
    expect(blockers).toEqual({ saved: true, lifecycle: true, content: true })
    expect(blockersAllPass(blockers)).toBe(true)
    expect(failingConfirmBlockers(blockers)).toEqual([])
  })

  it('version drift (exact version no longer latest) fails `saved` and blocks confirm', () => {
    const blockers = confirmBlockers({ ...baseInput, latestVersion: 4 })
    expect(blockers.saved).toBe(false)
    expect(CONFIRM_BLOCKER_LABELS.saved).toContain('版本已变化')
    expect(blockersAllPass(blockers)).toBe(false)
    expect(failingConfirmBlockers(blockers)).toEqual(['saved'])
  })

  it('a deleted article fails `lifecycle`', () => {
    const blockers = confirmBlockers({ ...baseInput, deleted: true })
    expect(blockers.lifecycle).toBe(false)
    expect(CONFIRM_BLOCKER_LABELS.lifecycle).toContain('删除')
  })

  it('empty title or body fails `content`', () => {
    expect(confirmBlockers({ ...baseInput, title: '  ' }).content).toBe(false)
    expect(confirmBlockers({ ...baseInput, contentHtml: '' }).content).toBe(false)
  })

  it('a null latest version (no identity yet) does not drift — treated as latest', () => {
    expect(confirmBlockers({ ...baseInput, latestVersion: null }).saved).toBe(true)
  })
})

describe('mobile-publish model — deterministic first-publish ids (single event)', () => {
  it('is stable for the SAME exact (article, version, content)', () => {
    const a = firstPrepareId(7, 3, 'abc')
    const b = firstPrepareId(7, 3, 'abc')
    const ia = firstIntentId(7, 3, 'abc')
    const ib = firstIntentId(7, 3, 'abc')
    expect(a).toBe(b)
    expect(ia).toBe(ib)
    expect(a).toContain('b8-05:prep:7:3:abc')
    expect(ia).toContain('b8-05:intent:7:3:abc')
  })

  it('a version or content change is a FRESH id (new auditable operation)', () => {
    expect(firstPrepareId(7, 3, 'abc')).not.toBe(firstPrepareId(7, 4, 'abc'))
    expect(firstIntentId(7, 3, 'abc')).not.toBe(firstIntentId(7, 3, 'def'))
    expect(firstPrepareId(7, 3, 'abc')).not.toBe(firstPrepareId(8, 3, 'abc'))
  })

  it('revision promote operation id is keyed by (article, revision)', () => {
    expect(revisionOperationId(7, 'rev-1')).toContain('b8-05:promote:7:rev-1')
    expect(revisionOperationId(7, 'rev-1')).toBe(revisionOperationId(7, 'rev-1'))
    expect(revisionOperationId(7, 'rev-1')).not.toBe(revisionOperationId(7, 'rev-2'))
  })
})

describe('mobile-publish model — fixed Asia/Shanghai publish time', () => {
  it('renders epoch seconds in Asia/Shanghai deterministically', () => {
    // 1700000000 == 2023-11-14 22:13:20 UTC == 2023-11-15 06:13:20 Asia/Shanghai.
    expect(formatPublishTime(1700000000)).toBe('2023-11-15 06:13:20')
  })
})

describe('mobile-publish model — receipt distinguishes 博客 / 排期 / 渠道', () => {
  const noExtras = { schedule: { present: false, status: null }, channel: { present: false, status: null } }

  it('always reports the blog surface with the public url after success', () => {
    const surfaces = shapeReceiptSurfaces({
      blog: { present: true, url: 'https://blog.example.test/x', verified: true },
      ...noExtras,
    })
    expect(surfaces.map((s) => s.key)).toEqual(['blog', 'schedule', 'channel'])
    expect(surfaces[0].label).toBe('博客')
    expect(surfaces[0].state).toBe('已上线')
    expect(surfaces[0].url).toBe('https://blog.example.test/x')
    expect(surfaces[1].state).toBe('未排期')
    expect(surfaces[1].present).toBe(false)
    expect(surfaces[2].state).toBe('未生成')
    expect(surfaces[2].present).toBe(false)
  })

  it('an unverified receipt surfaces "待确证" on the blog surface', () => {
    const surfaces = shapeReceiptSurfaces({ blog: { present: true, verified: false }, ...noExtras })
    expect(surfaces[0].state).toBe('已上线（待确证）')
  })

  it('reports schedule status independently (fired = 已发布)', () => {
    const surfaces = shapeReceiptSurfaces({
      blog: { present: true },
      schedule: { present: true, status: 'fired' },
      channel: { present: false, status: null },
    })
    expect(surfaces[1].state).toBe('已发布')
    expect(surfaces[1].present).toBe(true)
  })

  it('reports WeChat channel status independently (submitted = 已递交)', () => {
    const surfaces = shapeReceiptSurfaces({
      blog: { present: true },
      schedule: { present: false, status: null },
      channel: { present: true, status: 'submitted' },
    })
    expect(surfaces[2].state).toBe('已递交')
    expect(surfaces[2].present).toBe(true)
  })
})
