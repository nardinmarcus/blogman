/**
 * B2-01 canonical content envelope — mini Markdown serializer.
 *
 * Serializes a whitelisted Tiptap JSON document back to Markdown. The core
 * inline/block whitelist round-trips losslessly through parse/serialize/parse:
 *   paragraph, heading, bold, italic, strike, code, link, codeBlock, lists,
 *   blockquote, horizontalRule, image.
 *
 * Non-Markdown-native nodes (youtube/twitter/audio/video/mathBlock, tables)
 * DEGRADE to an explicit `[[blogman:<type>:<value>]]` directive, documented as
 * a degradation table (lossy by design — Markdown is not their medium).
 */

import type { TiptapMark, TiptapNode, TiptapJSONDocument } from './types'
import { ContentEnvelopeError } from './whitelist'

/** Escape inline-label text (bold/italic/links labels). */
function escapeLabel(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!>~-])/g, '\\$1')
}

/** Escape a URL/attribute destination (only what actually breaks it). */
function escapeUrl(text: string): string {
  return text.replace(/[\\()]/g, '\\$1')
}

function mediaDirective(type: string, value: string): string {
  return `[[blogman:${type}:${value}]]`
}

function degrade(node: TiptapNode): string {
  if (node.type === 'mathBlock') {
    return mediaDirective('math', String(node.attrs?.latex ?? ''))
  }
  if (node.type === 'table') {
    return mediaDirective('table', '')
  }
  if (node.type === 'youtube' || node.type === 'twitter' || node.type === 'audio' || node.type === 'video') {
    return mediaDirective(node.type, String(node.attrs?.src ?? ''))
  }
  throw new ContentEnvelopeError(`cannot serialize node type "${node.type}" to markdown`)
}

/**
 * Render inline content (text + images + breaks) into a single markdown line.
 * Descends one paragraph wrapper where present (listItem/tableCell content).
 */
function renderInline(node: TiptapNode): string {
  if (node.content?.length === 1 && node.content[0].type === 'paragraph') {
    return renderInlineChildren(node.content[0].content ?? [], node)
  }
  return renderInlineChildren(node.content ?? [], node)
}

function renderInlineChildren(children: TiptapNode[], parent: TiptapNode): string {
  let out = ''
  for (const child of children) {
    if (child.type === 'text') {
      out += renderTextWithMarks(child.text ?? '', child.marks ?? [])
    } else if (child.type === 'image') {
      const src = String(child.attrs?.src ?? '')
      const alt = escapeLabel(String(child.attrs?.alt ?? ''))
      const title = child.attrs?.title
        ? ` "${escapeLabel(String(child.attrs.title))}"`
        : ''
      out += `![${alt}](${escapeUrl(src)}${title})`
    } else if (child.type === 'hardBreak') {
      out += '\n'
    } else if (child.type === 'paragraph') {
      out += renderInlineChildren(child.content ?? [], child)
    } else {
      out += degrade(child)
    }
  }
  return out
}

function renderTextWithMarks(text: string, marks: TiptapMark[]): string {
  let linkHref: string | undefined
  let inner = escapeLabel(text)
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        inner = `**${inner}**`
        break
      case 'italic':
        inner = `*${inner}*`
        break
      case 'strike':
        inner = `~~${inner}~~`
        break
      case 'code':
        inner = `\`${inner}\``
        break
      case 'link':
        linkHref = String(mark.attrs?.href ?? '')
        break
      case 'underline':
      case 'textStyle':
      case 'highlight':
        // No portable markdown equivalent — keep the plain text.
        break
      default:
        throw new ContentEnvelopeError(`unsupported mark "${mark.type}" in serializer`)
    }
  }
  if (linkHref !== undefined) {
    inner = `[${inner}](${escapeUrl(linkHref)})`
  }
  return inner
}

/** Render a single node to an array of markdown lines (no blank separators). */
function blockLines(node: TiptapNode): string[] {
  switch (node.type) {
    case 'paragraph':
      return [renderInline(node)]
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2) || 2))
      return [`${'#'.repeat(level)} ${renderInline(node)}`]
    }
    case 'bulletList':
      return (node.content ?? []).map((item) => `- ${itemLines(item)}`)
    case 'orderedList':
      return (node.content ?? []).map((item, index) => `${index + 1}. ${itemLines(item)}`)
    case 'taskList':
      return (node.content ?? []).map((item) => {
        const checked = item.attrs?.checked ? 'x' : ' '
        return `- [${checked}] ${itemLines(item)}`
      })
    case 'blockquote': {
      const childBlocks = (node.content ?? []).flatMap((child) => blockLines(child))
      return childBlocks.map((line) => `> ${line}`)
    }
    case 'codeBlock': {
      const lang = node.attrs?.language ? String(node.attrs.language) : ''
      const code = (node.content?.[0]?.text ?? '').replace(/\n$/, '')
      return ['```' + lang, code, '```']
    }
    case 'horizontalRule':
      return ['---']
    case 'mathBlock':
    case 'youtube':
    case 'twitter':
    case 'audio':
    case 'video':
    case 'table':
      return [degrade(node)]
    default:
      if (node.content && node.content.length > 0) {
        return node.content.flatMap((child) => blockLines(child))
      }
      return []
  }
}

/** Inline markdown for a list item (descends its paragraph). */
function itemLines(node: TiptapNode): string {
  if (node.content?.[0]?.type === 'paragraph') {
    return renderInline(node.content[0])
  }
  return renderInline(node)
}

/** Serialize a normalized envelope document to a Markdown string. */
export function serializeMarkdown(doc: TiptapJSONDocument): string {
  if (doc.type !== 'doc') {
    throw new ContentEnvelopeError(`expected doc root, got "${doc.type}"`)
  }
  const blocks: string[] = []
  for (const node of doc.content ?? []) {
    blocks.push(blockLines(node).join('\n'))
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n'
}
