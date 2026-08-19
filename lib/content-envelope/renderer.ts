/**
 * B2-01 canonical content envelope — mini HTML renderer.
 *
 * Renders a whitelisted Tiptap JSON document to HTML without pulling in a
 * heavy render engine. Covers exactly the node/mark whitelist in whitelist.ts;
 * unknown types throw (they should have been rejected during normalization).
 */

import type { TiptapMark, TiptapNode, TiptapJSONDocument } from './types'
import { ContentEnvelopeError } from './whitelist'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(value: unknown): string {
  return escapeHtml(String(value ?? ''))
}

function attrString(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return ''
  return Object.keys(attrs)
    .map((key) => ` ${key}="${escapeAttr(attrs[key])}"`)
    .join('')
}

/** Render mark-wrapped text content (used within inline nodes). */
function renderTextWithMarks(text: string, marks: TiptapMark[] | undefined): string {
  let out = escapeHtml(text)
  if (!marks) return out
  // Apply in a stable order so output is deterministic.
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        out = `<strong>${out}</strong>`
        break
      case 'italic':
        out = `<em>${out}</em>`
        break
      case 'strike':
        out = `<s>${out}</s>`
        break
      case 'underline':
        out = `<u>${out}</u>`
        break
      case 'code':
        out = `<code>${out}</code>`
        break
      case 'link': {
        const href = mark.attrs?.href ?? ''
        const rel = mark.attrs?.rel ? ` rel="${escapeAttr(mark.attrs.rel)}"` : ' rel="noopener noreferrer"'
        const target = mark.attrs?.target ? ` target="${escapeAttr(mark.attrs.target)}"` : ' target="_blank"'
        out = `<a href="${escapeAttr(href)}"${target}${rel}>${out}</a>`
        break
      }
      case 'textStyle':
        if (mark.attrs?.color) {
          out = `<span style="color:${escapeAttr(mark.attrs.color)}">${out}</span>`
        }
        break
      case 'highlight':
        if (mark.attrs?.color) {
          out = `<mark style="background-color:${escapeAttr(mark.attrs.color)}">${out}</mark>`
        } else {
          out = `<mark>${out}</mark>`
        }
        break
      default:
        throw new ContentEnvelopeError(`unsupported mark "${mark.type}" in HTML renderer`)
    }
  }
  return out
}

function renderNode(node: TiptapNode): string {
  switch (node.type) {
    case 'text':
      return renderTextWithMarks(node.text ?? '', node.marks)
    case 'paragraph':
      return `<p>${renderContent(node.content)}</p>`
    case 'heading': {
      const level = node.attrs?.level ?? 2
      const tag = `h${level}`
      return `<${tag}>${renderContent(node.content)}</${tag}>`
    }
    case 'hardBreak':
      return '<br>'
    case 'bulletList':
      return `<ul>${renderContent(node.content)}</ul>`
    case 'orderedList':
      return `<ol${node.attrs?.start ? ` start="${escapeAttr(node.attrs.start)}"` : ''}>${renderContent(node.content)}</ol>`
    case 'listItem':
      return `<li>${renderContent(node.content)}</li>`
    case 'taskList':
      return `<ul data-type="taskList">${renderContent(node.content)}</ul>`
    case 'taskItem': {
      const checked = node.attrs?.checked ? ' data-checked="true"' : ''
      return `<li data-type="taskItem"${checked}>${renderContent(node.content)}</li>`
    }
    case 'blockquote':
      return `<blockquote>${renderContent(node.content)}</blockquote>`
    case 'codeBlock': {
      const lang = node.attrs?.language ? ` class="language-${escapeAttr(node.attrs.language)}"` : ''
      const code = escapeHtml(node.content?.[0]?.text ?? '')
      return `<pre><code${lang}>${code}</code></pre>`
    }
    case 'horizontalRule':
      return '<hr>'
    case 'image': {
      const src = escapeAttr(node.attrs?.src ?? '')
      const alt = escapeAttr(node.attrs?.alt ?? '')
      const title = node.attrs?.title ? ` title="${escapeAttr(node.attrs.title)}"` : ''
      const width = node.attrs?.width ? ` width="${escapeAttr(node.attrs.width)}"` : ''
      return `<img src="${src}" alt="${alt}"${title}${width}>`
    }
    case 'table':
      return `<table>${renderContent(node.content)}</table>`
    case 'tableRow':
      return `<tr>${renderContent(node.content)}</tr>`
    case 'tableHeader': {
      const colspan = node.attrs?.colspan ? ` colspan="${escapeAttr(node.attrs.colspan)}"` : ''
      return `<th${colspan}>${renderContent(node.content)}</th>`
    }
    case 'tableCell': {
      const colspan = node.attrs?.colspan ? ` colspan="${escapeAttr(node.attrs.colspan)}"` : ''
      return `<td${colspan}>${renderContent(node.content)}</td>`
    }
    case 'youtube': {
      const src = node.attrs?.src ? ` src="${escapeAttr(node.attrs.src)}"` : ''
      return `<iframe${src} frameborder="0" allowfullscreen></iframe>`
    }
    case 'twitter': {
      const src = escapeAttr(node.attrs?.src ?? '')
      return `<div data-twitter-src="${src}"><a href="${src}" target="_blank" rel="noopener noreferrer">${src}</a></div>`
    }
    case 'audio': {
      const src = node.attrs?.src ? ` src="${escapeAttr(node.attrs.src)}"` : ''
      const title = node.attrs?.title ? ` title="${escapeAttr(node.attrs.title)}"` : ''
      return `<audio controls${src}${title}></audio>`
    }
    case 'video': {
      const src = node.attrs?.src ? ` src="${escapeAttr(node.attrs.src)}"` : ''
      const title = node.attrs?.title ? ` title="${escapeAttr(node.attrs.title)}"` : ''
      return `<video controls${src}${title}></video>`
    }
    case 'mathBlock': {
      const latex = escapeHtml(String(node.attrs?.latex ?? ''))
      const displayMode = node.attrs?.displayMode === false ? 'false' : 'true'
      return `<div data-math-latex="${escapeAttr(node.attrs?.latex ?? '')}" data-display-mode="${displayMode}">${latex}</div>`
    }
    case 'doc':
      return renderContent(node.content)
    default:
      throw new ContentEnvelopeError(`unsupported node "${node.type}" in HTML renderer`)
  }
}

function renderContent(content: TiptapNode[] | undefined): string {
  if (!content) return ''
  return content.map((node) => renderNode(node)).join('')
}

/** Render a normalized envelope document to an HTML string. */
export function renderHtml(doc: TiptapJSONDocument): string {
  return renderNode(doc)
}
