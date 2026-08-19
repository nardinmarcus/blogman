/**
 * B2-01 canonical content envelope — plain text & search projection.
 */

import type { TiptapNode, TiptapJSONDocument } from './types'
import { ContentEnvelopeError } from './whitelist'

/** Collect visible text from a node tree in document order (single string). */
function collectText(node: TiptapNode): string {
  const parts: string[] = []
  switch (node.type) {
    case 'text':
      if (node.text) parts.push(node.text)
      break
    case 'codeBlock':
      if (node.content?.[0]?.text) parts.push(node.content[0].text)
      break
    case 'mathBlock':
      if (node.attrs?.latex) parts.push(String(node.attrs.latex))
      break
    default:
      if (node.content) for (const child of node.content) parts.push(collectText(child))
  }
  return parts.join('')
}

function hasContent(node: TiptapNode): boolean {
  return (node.content?.length ?? 0) > 0
}

/**
 * Produce the plain-text rendering of a document. Block boundaries are
 * preserved as single newlines so headings/lists read down the page.
 */
export function plainText(doc: TiptapJSONDocument): string {
  if (doc.type !== 'doc') {
    throw new ContentEnvelopeError(`expected doc root, got "${doc.type}"`)
  }
  const blocks: string[] = []
  const walk = (node: TiptapNode): string[] => {
    switch (node.type) {
      case 'paragraph':
        if (hasContent(node)) return [collectText(node)]
        return []
      case 'heading':
        return [collectText(node)]
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return (node.content ?? []).flatMap((item) => walk(item))
      case 'listItem':
      case 'taskItem':
      case 'blockquote':
      case 'table':
      case 'tableRow':
      case 'tableHeader':
      case 'tableCell':
        return (node.content ?? []).flatMap((child) => walk(child))
      case 'codeBlock':
        return [node.content?.[0]?.text ?? '']
      case 'horizontalRule':
        return []
      case 'text':
        return node.text ? [node.text] : []
      default:
        return [collectText(node)]
    }
  }
  for (const block of doc.content ?? []) {
    const lines = walk(block)
    for (const line of lines) {
      if (line !== undefined && line !== '') blocks.push(line)
    }
  }
  return blocks.join('\n')
}

export interface SearchProjection {
  text: string
  /** Lowercased, tokenized text suitable for simple search indexing. */
  tokens: string[]
  /** Distinct media reference URLs (images, youtube, twitter, audio, video). */
  mediaUrls: string[]
  /** Heading fragments (titles/anchors). */
  headings: string[]
}

/** Extract distinct media URLs found in the document. */
function extractMedia(doc: TiptapJSONDocument): string[] {
  const urls: string[] = []
  const walk = (node: TiptapNode): void => {
    switch (node.type) {
      case 'image':
      case 'youtube':
      case 'twitter':
      case 'audio':
      case 'video':
        if (node.attrs?.src) urls.push(String(node.attrs.src))
        return
      default:
        if (node.content) for (const child of node.content) walk(child)
    }
  }
  for (const node of doc.content ?? []) walk(node)
  // Preserve order, de-duplicate.
  return [...new Set(urls)]
}

/** Extract heading text fragments. */
function extractHeadings(doc: TiptapJSONDocument): string[] {
  const headings: string[] = []
  const walk = (node: TiptapNode): void => {
    if (node.type === 'heading') {
      headings.push(collectText(node))
    }
    if (node.content) for (const child of node.content) walk(child)
  }
  for (const node of doc.content ?? []) walk(node)
  return headings
}

/**
 * Search projection: plain text, lowercased word tokens, distinct media URLs
 * and heading fragments.
 */
export function searchProjection(doc: TiptapJSONDocument): SearchProjection {
  const text = plainText(doc)
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
  return {
    text,
    tokens,
    mediaUrls: extractMedia(doc),
    headings: extractHeadings(doc),
  }
}
