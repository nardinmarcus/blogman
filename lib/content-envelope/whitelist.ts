/**
 * B2-01 canonical content envelope — Tiptap node/mark whitelist.
 *
 * The whitelist is the single source of fact for which node/mark types are
 * valid inside a canonical envelope. It is derived from the actual editor
 * extension set in lib/editor-extensions.tsx (StarterKit + custom media nodes).
 * Anything outside the whitelist FAILS CLOSED with a readable error.
 */

import type { TiptapMark, TiptapNode, TiptapJSONDocument } from './types'

/**
 * Allowed node names → allowed attribute keys. Unknown attribute keys are
 * dropped during normalization (semantic equivalence), but unknown NODE TYPES
 * fail closed.
 */
export const NODE_WHITELIST: Record<string, ReadonlySet<string>> = {
  doc: new Set([]),
  text: new Set([]),
  paragraph: new Set([]),
  heading: new Set(['level']),
  bulletList: new Set([]),
  orderedList: new Set(['start', 'type']),
  listItem: new Set([]),
  blockquote: new Set([]),
  codeBlock: new Set(['language']),
  horizontalRule: new Set([]),
  hardBreak: new Set([]),
  image: new Set(['src', 'alt', 'title', 'width', 'align']),
  taskList: new Set([]),
  taskItem: new Set(['checked']),
  table: new Set([]),
  tableRow: new Set([]),
  tableHeader: new Set(['colspan', 'rowspan', 'colwidth']),
  tableCell: new Set(['colspan', 'rowspan', 'colwidth']),
  youtube: new Set(['src']),
  twitter: new Set(['src']),
  audio: new Set(['src', 'title']),
  video: new Set(['src', 'title']),
  mathBlock: new Set(['latex', 'displayMode']),
}

/**
 * Allowed mark names → allowed attribute keys. Same fail-closed rule as nodes:
 * unknown mark types are rejected.
 */
export const MARK_WHITELIST: Record<string, ReadonlySet<string>> = {
  bold: new Set([]),
  italic: new Set([]),
  strike: new Set([]),
  code: new Set([]),
  underline: new Set([]),
  link: new Set(['href', 'title', 'target', 'rel', 'class']),
  textStyle: new Set(['fontFamily', 'color']),
  highlight: new Set(['color']),
}

/** Human-readable node type list for error messages. */
export const NODE_TYPE_NAMES = Object.keys(NODE_WHITELIST).join(', ')
/** Human-readable mark type list for error messages. */
export const MARK_TYPE_NAMES = Object.keys(MARK_WHITELIST).join(', ')

export function isAllowedNode(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(NODE_WHITELIST, type)
}

export function isAllowedMark(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(MARK_WHITELIST, type)
}

/**
 * Validate a whole document against the whitelist. Throws a readable
 * `ContentEnvelopeError` on the first unknown node/mark. Validates types and
 * structure only; normalization (schema.ts) later prunes non-whitelisted
 * attrs and canonicalizes.
 */
export function assertAllowedDocument(doc: TiptapJSONDocument): void {
  if (doc.type !== 'doc') {
    throw new ContentEnvelopeError(`envelope document must be type "doc", got "${doc.type}"`)
  }

  const visitNode = (node: TiptapNode): void => {
    if (node.type === 'text') {
      if (node.marks) {
        for (const mark of node.marks) {
          if (!isAllowedMark(mark.type)) {
            throw new ContentEnvelopeError(
              `unknown mark type "${mark.type}" in node of type "text"; allowed marks: ${MARK_TYPE_NAMES}`,
            )
          }
          assertAllowedMarkAttrs(mark.type, mark.attrs)
        }
      }
      return
    }

    if (!isAllowedNode(node.type)) {
      throw new ContentEnvelopeError(
        `unknown node type "${node.type}"; allowed nodes: ${NODE_TYPE_NAMES}`,
      )
    }

    if (node.content) {
      for (const child of node.content) visitNode(child)
    }
  }

  for (const node of doc.content) visitNode(node)
}

function assertAllowedMarkAttrs(type: string, attrs?: Record<string, unknown>): void {
  if (!attrs) return
  const allowed = MARK_WHITELIST[type]
  for (const key of Object.keys(attrs)) {
    if (!allowed.has(key)) {
      throw new ContentEnvelopeError(
        `attribute "${key}" is not allowed on mark "${type}"; allowed: ${[...allowed].join(', ')}`,
      )
    }
  }
}

/** Error type for all envelope validation/normalization failures. */
export class ContentEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentEnvelopeError'
  }
}
