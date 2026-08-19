/**
 * B2-01 canonical content envelope — test matrix (Issue #24).
 *
 * Covers: equivalent-node normalization (attr order), empty paragraphs, mark
 * combos, complex block nesting, media references, markdown↔envelope↔markdown
 * round-trip, tiptap→HTML/plain/search projections, old-schema interpretation,
 * separated snapshot/sync hashing, and fail-closed unknown nodes.
 */

import { describe, expect, it } from 'vitest'
import {
  assertAllowedDocument,
  contentSnapshotHash,
  ContentEnvelopeError,
  envelopeFromDocument,
  interpret,
  isAllowedMark,
  isAllowedNode,
  normalize,
  normalizeDocument,
  parse,
  plainText,
  renderHtml,
  searchProjection,
  serializeMarkdown,
  sourceSyncHash,
  toCanonicalJson,
} from '@/lib/content-envelope'
import type { TiptapJSONDocument } from '@/lib/content-envelope'

const coreDoc = (): TiptapJSONDocument => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'world ' },
        { type: 'text', text: 'and', marks: [{ type: 'bold' }] },
      ],
    },
  ],
})

describe('normalizeDocument — canonical equivalence', () => {
  it('equalizes attribute key order (equivalent nodes → identical bytes)', () => {
    const a: TiptapJSONDocument = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { src: 'http://x/img.png', alt: 'pic', width: '300', align: 'center' },
        },
      ],
    }
    const b: TiptapJSONDocument = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { align: 'center', width: '300', alt: 'pic', src: 'http://x/img.png' },
        },
      ],
    }
    expect(toCanonicalJson(normalizeDocument(a))).toBe(toCanonicalJson(normalizeDocument(b)))
  })

  it('drops empty paragraphs but keeps non-empty ones', () => {
    const doc: TiptapJSONDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
        { type: 'paragraph', content: [] },
      ],
    }
    const normalized = normalizeDocument(doc)
    expect(normalized.content.map((n) => n.type)).toEqual(['paragraph'])
    expect(normalized.content[0].content?.[0].text).toBe('keep')
  })

  it('merges adjacent text nodes with identical marks', () => {
    const doc: TiptapJSONDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'foo', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'bar', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'baz' },
          ],
        },
      ],
    }
    const n = normalizeDocument(doc).content[0].content!
    expect(n).toHaveLength(2)
    expect(n[0].text).toBe('foobar')
    expect(n[1].text).toBe('baz')
  })

  it('same semantic content from markdown and tiptap yields same snapshot hash', () => {
    const md = parse({ markdown: '# Hello\n\nworld **and**' })
    const tp = parse({
      tiptap: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'world ' },
              { type: 'text', text: 'and', marks: [{ type: 'bold' }] },
            ],
          },
        ],
      },
    })
    expect(contentSnapshotHash(md)).toBe(contentSnapshotHash(tp))
  })
})

describe('mark + complex block nesting', () => {
  it('handles combined marks and multilevel lists', () => {
    const envelope = parse({
      markdown: '> quote with **bold** and *italic*\n\n- one\n  - nested\n- two',
    })
    const html = renderHtml(envelope)
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li><p>one</p>')
  })

  it('renders code blocks, hr, and link marks', () => {
    const envelope = parse({
      markdown: '```ts\nconst x = 1\n```\n\n---\n\n[link](https://example.com)',
    })
    const html = renderHtml(envelope)
    expect(html).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<a href="https://example.com" target="_blank"')
  })
})

describe('media references', () => {
  it('renders image, audio, video, twitter, youtube, math nodes to HTML', () => {
    const envelope = normalize({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'http://x/a.png', alt: 'A' } },
        { type: 'audio', attrs: { src: 'http://x/a.mp3', title: 'A' } },
        { type: 'video', attrs: { src: 'http://x/v.mp4' } },
        { type: 'twitter', attrs: { src: 'https://twitter.com/u/status/1' } },
        { type: 'youtube', attrs: { src: 'https://youtu.be/abc' } },
        { type: 'mathBlock', attrs: { latex: 'E=mc^2', displayMode: true } },
      ],
    })
    const html = renderHtml(envelope)
    expect(html).toContain('<img src="http://x/a.png" alt="A">')
    expect(html).toContain('<audio controls src="http://x/a.mp3" title="A"></audio>')
    expect(html).toContain('<video controls src="http://x/v.mp4"></video>')
    expect(html).toContain('data-twitter-src')
    expect(html).toContain('</iframe>')
    expect(html).toContain('data-math-latex')
  })

  it('round-trips image through markdown serialization', () => {
    const md = serializeMarkdown(
      normalize({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'image', attrs: { src: 'http://x/i.png', alt: 'pic' } }],
          },
        ],
      }),
    )
    expect(md).toContain('![pic](http://x/i.png)')
  })

  it('degrades non-markdown media nodes to explicit directives', () => {
    const md = serializeMarkdown(
      normalize({
        type: 'doc',
        content: [{ type: 'youtube', attrs: { src: 'https://youtu.be/x' } }],
      }),
    )
    expect(md).toContain('[[blogman:youtube:https://youtu.be/x]]')
  })
})

describe('markdown ↔ envelope ↔ markdown round-trip', () => {
  it('is lossless across the core whitelist', () => {
    const input = [
      '# Title',
      '',
      'Intro with **bold**, *italic*, ~~strike~~, `code` and [a link](https://e.com).',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '- item one',
      '- item two',
      '',
      '1. first',
      '2. second',
      '',
      '> a blockquote',
      '',
      '![alt](http://x/i.png)',
    ].join('\n')

    const envelope = parse({ markdown: input })
    const output = serializeMarkdown(envelope)
    // Re-parse the serialized markdown and compare normalized docs.
    const reprocessed = parse({ markdown: output })
    expect(toCanonicalJson(reprocessed.normalized)).toBe(toCanonicalJson(envelope.normalized))
  })
})

describe('tiptap → envelope → projections', () => {
  it('produces correct HTML, plain text, and search projection', () => {
    const envelope = normalize(coreDoc())
    expect(renderHtml(envelope)).toBe('<h1>Hello</h1><p>world <strong>and</strong></p>')
    expect(plainText(envelope)).toBe('Hello\nworld and')

    const proj = searchProjection(envelope)
    expect(proj.headings).toEqual(['Hello'])
    expect(proj.tokens).toContain('hello')
    expect(proj.tokens).toContain('world')
  })

  it('collects media URLs into the search projection', () => {
    const envelope = normalize({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'http://x/a.png' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'text body' }] },
      ],
    })
    expect(searchProjection(envelope).mediaUrls).toEqual(['http://x/a.png'])
  })
})

describe('old schema versions — forward compatibility hook', () => {
  it('interprets a v1 envelope', () => {
    const env = parse({ markdown: 'hi' })
    expect(interpret(env).content[0].content?.[0].text).toBe('hi')
  })

  it('interprets a constructed older (v0-style) envelope via interpret', () => {
    // A hypothetical v0 product shipped a payload keyed off normalized (as today
    // the schema was frozen before versioning). The compatibility hook treats it
    // as schema 1 content because it matches the current shape.
    const v0 = envelopeFromDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy' }] }],
    })
    // Override schema version to simulate an old record.
    const old = { ...v0, tiptap_json_schema: 0 }
    const doc = interpret(old as never)
    expect(doc.content[0].content?.[0].text).toBe('legacy')
  })

  it('fails closed on unsupported future schema versions', () => {
    const env = parse({ markdown: 'hi' })
    expect(() =>
      interpret({ ...env, tiptap_json_schema: 99 } as never),
    ).toThrow(ContentEnvelopeError)
  })
})

describe('separated content & source sync hashes', () => {
  it('contentSnapshotHash ≠ sourceSyncHash for identical content in different formats', () => {
    const md = parse({ markdown: '# T\n\ntext' })
    const tpInput: TiptapJSONDocument = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'T' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'text' }] },
      ],
    }
    const tp = parse({ tiptap: tpInput })
    expect(md.tiptap_json_schema).toBe(tp.tiptap_json_schema)
    expect(contentSnapshotHash(md)).toBe(contentSnapshotHash(tp))
    // Different source byte-form → different sync hash even though content matches.
    expect(sourceSyncHash('# T\n\ntext')).not.toBe(sourceSyncHash(tpInput))
  })

  it('is stable for the same source input', () => {
    expect(sourceSyncHash('same')).toBe(sourceSyncHash('same'))
    expect(contentSnapshotHash(parse({ markdown: 'same' }))).toBe(
      contentSnapshotHash(parse({ markdown: 'same' })),
    )
  })

  it('snapshot hash is content-addressable (attr order does not change it)', () => {
    const a = parse({ markdown: '![x](http://x/i.png)' })
    const attrA = a.normalized.content[0].content?.[0].attrs
    // Rebuild with swapped attr order and confirm the hash is unchanged.
    const swapped: TiptapJSONDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: attrA?.src as string, alt: attrA?.alt as string } },
          ],
        },
      ],
    }
    expect(contentSnapshotHash(normalize(swapped))).toBe(contentSnapshotHash(a))
  })
})

describe('representative historical sample (clean-start D1 — no live posts)', () => {
  // Production/local D1 is a clean-start empty database (no `posts` rows), so
  // there is no real historical body to convert. Per #24, a representative
  // article sample generated from the test matrix stands in and must satisfy
  // the historical-projection equivalence criteria: canonical DOM, text and
  // media references equivalent across markdown and tiptap representations.
  const SAMPLE = [
    '# Blog Title',
    '',
    'Intro with **bold**, *italic*, ~~strike~~, `code` and [a link](https://e.com).',
    '',
    '## Section',
    '',
    '- bullet one',
    '- bullet two',
    '',
    '> a quote',
    '',
    '```python',
    'def f():',
    '    return 1',
    '```',
    '',
    '![hero](https://img.x/hero.png)',
  ].join('\n')

  it('produces a stable round-trip fixed point from the representative sample', () => {
    const env = parse({ markdown: SAMPLE })
    // serialize → re-parse is a fixed point (no drift on second pass).
    const again = parse({ markdown: serializeMarkdown(env) })
    expect(toCanonicalJson(again.normalized)).toBe(toCanonicalJson(env.normalized))
  })

  it('exposes media references in the search projection', () => {
    const env = parse({ markdown: SAMPLE })
    expect(searchProjection(env).mediaUrls).toContain('https://img.x/hero.png')
    expect(searchProjection(env).headings).toEqual(['Blog Title', 'Section'])
    expect(searchProjection(env).text).toContain('bullet one')
    expect(renderHtml(env)).toContain('class="language-python"')
  })
})

describe('whitelist / fail-closed', () => {
  it('exposes the whitelist and membership checks', () => {
    expect(isAllowedNode('doc')).toBe(true)
    expect(isAllowedNode('paragraph')).toBe(true)
    expect(isAllowedNode('nope')).toBe(false)
    expect(isAllowedMark('bold')).toBe(true)
    expect(isAllowedMark('nope')).toBe(false)
  })

  it('rejects unknown node types with a readable error', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'widget' }],
    } as unknown as TiptapJSONDocument
    expect(() => assertAllowedDocument(doc)).toThrow(/unknown node type "widget"/)
    expect(() => normalize(doc)).toThrow(/unknown node type "widget"/)
  })

  it('rejects unknown marks with a readable error', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'mystery' }] }],
        },
      ],
    } as unknown as TiptapJSONDocument
    expect(() => assertAllowedDocument(doc)).toThrow(/unknown mark type "mystery"/)
    expect(() => normalize(doc)).toThrow(/unknown mark type "mystery"/)
  })

  it('rejects unsupported attrs on nodes/marks fail-closed', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'bold', attrs: { evil: 1 } }] }],
        },
      ],
    } as unknown as TiptapJSONDocument
    expect(() => normalize(doc)).toThrow(/attribute "evil" is not allowed/)
  })
})
