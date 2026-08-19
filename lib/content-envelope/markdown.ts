/**
 * B2-01 canonical content envelope — Markdown → Tiptap JSON parser.
 *
 * Uses the repo's existing `markdown-it` parser (same engine as
 * lib/editor-markdown.ts) and maps its token stream to the whitelisted Tiptap
 * node/mark vocabulary. The output is a raw (unnormalized) document intended
 * to be passed through `normalizeDocument`.
 */

import markdownit from 'markdown-it'
import type { TiptapMark, TiptapNode } from './types'

const markdownParser = markdownit({
  html: false,
  linkify: true,
})

function attrMap(token: { attrs?: [string, string][] | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (token.attrs) for (const [key, value] of token.attrs) out[key] = value
  return out
}

function getAttr(token: { attrs?: [string, string][] | null }, name: string): string | undefined {
  if (!token.attrs) return undefined
  const found = token.attrs.find(([key]) => key === name)
  return found ? found[1] : undefined
}

/** Parse inline children (marks + text + image) into an array of nodes. */
function parseInline(children: unknown[]): TiptapNode[] {
  const nodes: TiptapNode[] = []
  const marks: TiptapMark[] = []

  const pushText = (text: string, extraMarks: TiptapMark[] = []): void => {
    if (!text) return
    const combined = [...marks, ...extraMarks]
    nodes.push(combined.length ? { type: 'text', text, marks: combined } : { type: 'text', text })
  }

  for (const raw of children) {
    const token = raw as {
      type: string
      tag?: string
      nesting?: number
      content?: string
      attrs?: [string, string][]
      children?: unknown[]
      markup?: string
    }
    const type = token.type
    const nesting = token.nesting ?? 0

    if (nesting === 1) {
      // Opening mark / inline container
      switch (type) {
        case 'strong_open':
          marks.push({ type: 'bold' })
          break
        case 'em_open':
          marks.push({ type: 'italic' })
          break
        case 's_open':
          marks.push({ type: 'strike' })
          break
        case 'link_open': {
          const mark: TiptapMark = { type: 'link', attrs: { href: getAttr(token, 'href') ?? '' } }
          const title = getAttr(token, 'title')
          if (title) mark.attrs!.title = title
          marks.push(mark)
          break
        }
        default:
          break
      }
      continue
    }

    if (nesting === -1) {
      marks.pop()
      continue
    }

    switch (type) {
      case 'text':
      case 'entity':
        pushText(token.content ?? '')
        break
      case 'code_inline':
        pushText(token.content ?? '', [{ type: 'code' }])
        break
      case 'softbreak':
        // Collapse soft breaks to a space; normalization keeps it stable.
        if (nodes.length > 0) pushText(' ')
        break
      case 'hardbreak':
        nodes.push({ type: 'hardBreak' })
        break
      case 'image': {
        const attrs: Record<string, string> = { src: getAttr(token, 'src') ?? '' }
        const alt = getAttr(token, 'alt')
        if (alt) attrs.alt = alt
        const title = getAttr(token, 'title')
        if (title) attrs.title = title
        nodes.push({ type: 'image', attrs })
        break
      }
      default:
        // html_inline and anything else: skipped (html:false keeps input safe).
        break
    }
  }

  return nodes
}

/**
 * Parse a Markdown string into a raw Tiptap JSON document. Pass through
 * `normalizeDocument` (schema.ts) before use. Throws on unrepresentable
 * structure only for safety.
 */
export function markdownToDocument(markdown: string): TiptapNode {
  const tokens = markdownParser.parse(markdown.trim(), {})
  const root: TiptapNode = { type: 'doc', content: [] }
  const stack: TiptapNode[] = [root]

  for (const raw of tokens) {
    const token = raw as {
      type: string
      tag?: string
      nesting?: number
      content?: string
      attrs?: [string, string][]
      children?: unknown[]
      info?: string
      map?: number[] | null
    }
    const type = token.type
    const nesting = token.nesting ?? 0

    if (nesting === 1) {
      let node: TiptapNode
      switch (type) {
        case 'heading_open': {
          const level = Number((token.tag ?? 'h2').replace('h', '')) || 2
          node = { type: 'heading', attrs: { level }, content: [] }
          break
        }
        case 'paragraph_open':
          node = { type: 'paragraph', content: [] }
          break
        case 'blockquote_open':
          node = { type: 'blockquote', content: [] }
          break
        case 'bullet_list_open':
          node = { type: 'bulletList', content: [] }
          break
        case 'ordered_list_open': {
          const start = Number(getAttr(token, 'start')) || 1
          node = { type: 'orderedList', attrs: { start }, content: [] }
          break
        }
        case 'list_item_open':
          node = { type: 'listItem', content: [] }
          break
        case 'table_open':
          node = { type: 'table', content: [] }
          break
        case 'table_row_open':
          node = { type: 'tableRow', content: [] }
          break
        case 'table_header_open':
          node = { type: 'tableHeader', content: [] }
          break
        case 'table_cell_open':
          node = { type: 'tableCell', content: [] }
          break
        default:
          node = { type: 'paragraph', content: [] }
          break
      }
      stack[stack.length - 1].content!.push(node)
      stack.push(node)
      continue
    }

    if (nesting === -1) {
      stack.pop()
      continue
    }

    // nesting === 0 leaf tokens
    const parent = stack[stack.length - 1]
    switch (type) {
      case 'inline':
        parent.content!.push(...parseInline(token.children ?? []))
        break
      case 'fence': {
        const language = (token.info ?? '').trim()
        parent.content!.push({
          type: 'codeBlock',
          ...(language ? { attrs: { language } } : {}),
          content: [{ type: 'text', text: token.content ?? '' }],
        })
        break
      }
      case 'code_block':
        parent.content!.push({
          type: 'codeBlock',
          content: [{ type: 'text', text: token.content ?? '' }],
        })
        break
      case 'hr':
        parent.content!.push({ type: 'horizontalRule' })
        break
      default:
        break
    }
  }

  return root
}
