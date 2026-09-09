/**
 * Publication Intent — truth-table tests.
 *
 * The resolver IS the decision table; these tests pin it. The
 * temp-published row (status='published' ∧ formalPublished=false) is the
 * regression for the live label/action mismatch found in review: the old
 * PostRow labelled it 「转为草稿」 while the click opened the first-publish
 * confirm page (issue #19 class).
 */

import { describe, expect, it } from 'vitest'
import { publicationActionCopy, resolvePublicationIntent, type PublicationFacts } from '@/lib/publication-intent'

const authority = { articleId: 7, expectedVersion: 3 }

function facts(overrides: Partial<PublicationFacts> = {}): PublicationFacts {
  return { articleId: authority.articleId, expectedVersion: authority.expectedVersion, formalPublished: false, status: 'draft', ...overrides }
}

describe('resolvePublicationIntent', () => {
  it.each([
    [
      'never published, draft → first-publish page',
      facts(),
      { kind: 'first-publish', articleId: 7 },
    ],
    [
      'temp-published (editor publishTemp, never formal) → first-publish page (mismatch fix)',
      facts({ status: 'published' }),
      { kind: 'first-publish', articleId: 7 },
    ],
    [
      'formally published → unpublish',
      facts({ formalPublished: true, status: 'published' }),
      { kind: 'command', request: { action: 'unpublish' }, successMsg: '已取消发布' },
    ],
    [
      'formally published, taken offline → relive formal',
      facts({ formalPublished: true, status: 'draft' }),
      { kind: 'command', request: { action: 'relive', content: 'formal' }, successMsg: '已重新上线' },
    ],
    [
      'deleted formal article → relive (preserved legacy behaviour)',
      facts({ formalPublished: true, status: 'deleted' }),
      { kind: 'command', request: { action: 'relive', content: 'formal' }, successMsg: '已重新上线' },
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(resolvePublicationIntent(input)).toEqual(expected)
  })

  it.each([
    ['null articleId', facts({ articleId: null })],
    ['null expectedVersion', facts({ expectedVersion: null })],
    ['both null (ledger-only row)', facts({ articleId: null, expectedVersion: null, status: 'published' })],
  ])('%s → refused with the 409 message', (_label, input) => {
    expect(resolvePublicationIntent(input)).toEqual({
      kind: 'refused',
      message: '文章尚未启用版本化写入',
    })
  })

  it('formalPublished=null counts as never published (read-model tolerance)', () => {
    expect(resolvePublicationIntent(facts({ formalPublished: null }))).toEqual({
      kind: 'first-publish',
      articleId: 7,
    })
  })
})

describe('publicationActionCopy — same source as the action', () => {
  it.each([
    ['first-publish', facts({ status: 'published' }), '发布（首次上线）'],
    ['unpublish', facts({ formalPublished: true, status: 'published' }), '转为草稿'],
    ['relive', facts({ formalPublished: true, status: 'draft' }), '重新上线'],
    ['refused', facts({ articleId: null }), '发布文章'],
  ] as const)('%s branch copy', (_label, input, expectedLabel) => {
    const copy = publicationActionCopy(input)
    expect(copy.label).toBe(expectedLabel)
    expect(copy.modalTitle).toBe(expectedLabel)
    expect(copy.modalDescription).toBeTruthy()
  })

  it('the temp-published row can never show the offline label (mismatch regression)', () => {
    const input = facts({ status: 'published' })
    const copy = publicationActionCopy(input)
    const intent = resolvePublicationIntent(input)
    // Label says first-publish AND the action navigates to the confirm page —
    // never 「转为草稿」.
    expect(copy.label).toBe('发布（首次上线）')
    expect(copy.label).not.toContain('转为草稿')
    expect(intent.kind).toBe('first-publish')
  })
})
