/**
 * B2-01 canonical content envelope — normalization & canonical serialization.
 *
 * Normalization turns any semantically-equivalent input document into a single
 * canonicalized form:
 *   - prune attributes to the whitelist (drop unknown attrs)
 *   - recursively sort object keys so byte-output is independent of input key
 *     order (equivalent nodes → identical bytes)
 *   - merge adjacent `text` nodes that carry identical marks
 *   - drop empty `paragraph` nodes (and empty paragraphs in inline contexts)
 *
 * `toCanonicalJson` yields the byte-deterministic string used for envelope
 * storage and hashing.
 */

import { z } from 'zod'
import type { TiptapMark, TiptapNode, TiptapJSONDocument } from './types'
import { ContentEnvelopeError, MARK_WHITELIST, NODE_WHITELIST } from './whitelist'

/** True when the two arrays of marks are identical (same types+attrs). */
function sameMarks(a?: TiptapMark[], b?: TiptapMark[]): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const ma = a[i]
    const mb = b[i]
    if (ma.type !== mb.type) return false
    if (JSON.stringify(ma.attrs) !== JSON.stringify(mb.attrs)) return false
  }
  return true
}

function mergeMarks(a: TiptapMark[], b: TiptapMark[]): TiptapMark[] {
  const out = [...a]
  for (const m of b) {
    if (!out.some((x) => x.type === m.type && JSON.stringify(x.attrs) === JSON.stringify(m.attrs))) {
      out.push(m)
    }
  }
  return out
}

function normalizeMarks(marks?: TiptapMark[]): TiptapMark[] | undefined {
  if (!marks || marks.length === 0) return undefined
  const seen = new Map<string, TiptapMark>()
  for (const mark of marks) {
    const allowed = MARK_WHITELIST[mark.type]
    if (!allowed) {
      throw new ContentEnvelopeError(`unknown mark type "${mark.type}" during normalization`)
    }
    let attrs: Record<string, unknown> | undefined
    if (mark.attrs) {
      for (const key of Object.keys(mark.attrs)) {
        if (!allowed.has(key)) {
          throw new ContentEnvelopeError(`attribute "${key}" is not allowed on mark "${mark.type}"`)
        }
      }
      attrs = Object.keys(mark.attrs)
        .filter((k) => allowed.has(k))
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          if (mark.attrs![k] !== null && mark.attrs![k] !== undefined) acc[k] = mark.attrs![k]
          return acc
        }, {})
      if (Object.keys(attrs).length === 0) attrs = undefined
    }
    const key = mark.type + JSON.stringify(attrs ?? {})
    if (!seen.has(key)) seen.set(key, attrs ? { type: mark.type, attrs } : { type: mark.type })
  }
  const sorted = [...seen.values()].sort((a, b) => a.type.localeCompare(b.type))
  return sorted
}

interface NormalizedOutput {
  node: TiptapNode | null
}

/**
 * Normalize a single node subtree. Returns `null` when the node should be
 * dropped entirely (e.g. an empty paragraph).
 */
function normalizeNode(node: TiptapNode): TiptapNode | null {
  if (node.type === 'text') {
    const text = node.text ?? ''
    const marks = normalizeMarks(node.marks)
    if (text.length === 0) return null
    return { type: 'text', text, ...(marks ? { marks } : {}) }
  }

  const allowedAttrs = NODE_WHITELIST[node.type]
  if (!allowedAttrs) {
    throw new ContentEnvelopeError(`unknown node type "${node.type}" during normalization`)
  }

  let attrs: Record<string, unknown> | undefined
  if (node.attrs) {
    for (const key of Object.keys(node.attrs)) {
      if (!allowedAttrs.has(key)) {
        throw new ContentEnvelopeError(`attribute "${key}" is not allowed on node "${node.type}"`)
      }
    }
    attrs = Object.keys(node.attrs)
      .filter((k) => allowedAttrs.has(k))
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        if (node.attrs![k] !== null && node.attrs![k] !== undefined) acc[k] = node.attrs![k]
        return acc
      }, {})
    if (Object.keys(attrs).length === 0) attrs = undefined
  }

  let content: TiptapNode[] | undefined
  if (node.content) {
    content = []
    for (const child of node.content) {
      const normalizedChild = normalizeNode(child)
      if (normalizedChild) {
        // Fold adjacent text nodes with identical marks into one.
        const last = content[content.length - 1]
        if (
          last &&
          last.type === 'text' &&
          normalizedChild.type === 'text' &&
          sameMarks(last.marks, normalizedChild.marks)
        ) {
          content[content.length - 1] = {
            type: 'text',
            text: (last.text ?? '') + (normalizedChild.text ?? ''),
            ...(last.marks ? { marks: last.marks } : {}),
          }
        } else {
          content.push(normalizedChild)
        }
      }
    }
    // Canonicalize codeBlock text: drop trailing newline (markdown-it fence
    // tokens carry it); keeps markdown & tiptap sources byte-identical.
    if (
      node.type === 'codeBlock' &&
      content.length === 1 &&
      content[0].type === 'text' &&
      content[0].text?.endsWith('\n')
    ) {
      content[0] = { type: 'text', text: content[0].text!.replace(/\n+$/, '') }
    }
    if (content.length === 0) content = undefined
  }

  // Drop empty paragraphs (no content, nothing to render).
  if (node.type === 'paragraph' && !content) {
    return null
  }

  return {
    type: node.type,
    ...(attrs ? { attrs } : {}),
    ...(content ? { content } : {}),
  }
}

/**
 * Normalize a Tiptap JSON document into canonical form. Throws
 * `ContentEnvelopeError` if the document contains non-whitelisted types.
 */
export function normalizeDocument(input: TiptapJSONDocument): TiptapJSONDocument {
  if (input.type !== 'doc') {
    throw new ContentEnvelopeError(`expected doc root, got "${input.type}"`)
  }
  const content: TiptapNode[] = []
  for (const node of input.content) {
    const normalized = normalizeNode(node)
    if (normalized) content.push(normalized)
  }
  return { type: 'doc', content }
}

/**
 * Recursively rebuild an object with its keys sorted (and children visited),
 * producing a canonical string that is independent of input key order.
 * Also prunes empty string keys defensively.
 */
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      next[key] = sortObjectKeys(record[key])
    }
    return next
  }
  return value
}

/**
 * Serialize a normalized (or raw) document to a byte-deterministic canonical
 * JSON string. This is the string used for envelope storage and hashing.
 */
export function toCanonicalJson(doc: TiptapJSONDocument): string {
  return JSON.stringify(sortObjectKeys(doc))
}

/**
 * Zod schema for the envelope metadata and the structural shape of the
 * normalized payload. Whitelist enforcement is performed separately by
 * `assertAllowedDocument` (fail-closed), so this schema focuses on shape.
 */
export const EnvelopeSchema = z.object({
  format: z.literal('blogman-content-envelope/v1'),
  tiptap_json_schema: z.number().int().nonnegative(),
  normalized: z.object({
    type: z.literal('doc'),
    content: z.array(z.unknown()),
  }),
  provenance: z
    .object({
      converter: z.number().int().positive(),
      schemaVersion: z.number().int().positive(),
    })
    .optional(),
})
