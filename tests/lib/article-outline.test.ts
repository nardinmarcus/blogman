import { describe, expect, it } from 'vitest'
import { buildArticleOutline } from '@/lib/article-outline'

describe('buildArticleOutline', () => {
  it('adds stable heading ids and builds a nested outline', () => {
    const result = buildArticleOutline([
      '<p>Intro</p>',
      '<h2>First section</h2>',
      '<p>Body</p>',
      '<h3>Deep topic</h3>',
      '<h2>Second section</h2>',
    ].join(''))

    expect(result.html).toContain('<h2 id="first-section">First section</h2>')
    expect(result.html).toContain('<h3 id="deep-topic">Deep topic</h3>')
    expect(result.items).toEqual([
      {
        id: 'first-section',
        title: 'First section',
        level: 2,
        children: [
          {
            id: 'deep-topic',
            title: 'Deep topic',
            level: 3,
            children: [],
          },
        ],
      },
      {
        id: 'second-section',
        title: 'Second section',
        level: 2,
        children: [],
      },
    ])
  })

  it('preserves existing unique ids and deduplicates repeated headings', () => {
    const result = buildArticleOutline([
      '<h2 class="lead" id="custom-id">Overview</h2>',
      '<h2>Overview</h2>',
      '<h2>Overview</h2>',
      '<h3><strong>Nested</strong> &amp; encoded</h3>',
    ].join(''))

    expect(result.html).toContain('<h2 class="lead" id="custom-id">Overview</h2>')
    expect(result.html).toContain('<h2 id="overview">Overview</h2>')
    expect(result.html).toContain('<h2 id="overview-2">Overview</h2>')
    expect(result.items[0].id).toBe('custom-id')
    expect(result.items[1].id).toBe('overview')
    expect(result.items[2].children[0]).toMatchObject({
      id: 'nested-encoded',
      title: 'Nested & encoded',
      level: 3,
    })
  })

  it('skips empty headings and leaves content without headings unchanged', () => {
    const html = '<p>No outline here</p><h2><span> </span></h2>'
    const result = buildArticleOutline(html)

    expect(result.html).toBe(html)
    expect(result.items).toEqual([])
  })
})
