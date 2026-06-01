export interface ArticleOutlineItem {
  id: string
  title: string
  level: 1 | 2 | 3
  children: ArticleOutlineItem[]
}

interface FlatArticleOutlineItem {
  id: string
  title: string
  level: 1 | 2 | 3
}

const HEADING_RE = /<h([1-3])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
const ID_ATTR_RE = /\sid=(["'])(.*?)\1/i
const TAG_RE = /<[^>]*>/g
const ENTITY_RE = /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function safeCodePoint(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}

function decodeHtmlEntities(value: string) {
  return value.replace(ENTITY_RE, (match: string, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (decimal) return safeCodePoint(Number(decimal))
    if (hex) return safeCodePoint(Number.parseInt(hex, 16))
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? `&${named};`
    return match
  })
}

function getHeadingText(innerHtml: string) {
  return decodeHtmlEntities(innerHtml.replace(TAG_RE, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function slugifyHeading(text: string) {
  const normalized = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'section'
}

function uniqueId(base: string, seen: Map<string, number>) {
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count + 1}`
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildOutlineTree(items: FlatArticleOutlineItem[]) {
  const roots: ArticleOutlineItem[] = []
  const stack: ArticleOutlineItem[] = []

  for (const item of items) {
    const node: ArticleOutlineItem = { ...item, children: [] }

    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }

    stack.push(node)
  }

  return roots
}

export function buildArticleOutline(html: string): { html: string; items: ArticleOutlineItem[] } {
  const seenIds = new Map<string, number>()
  const outlineItems: FlatArticleOutlineItem[] = []

  const nextHtml = html.replace(HEADING_RE, (match: string, rawLevel: string, attrs: string, innerHtml: string) => {
    const title = getHeadingText(innerHtml)
    if (!title) return match

    const level = Number(rawLevel) as 1 | 2 | 3
    const existingId = attrs.match(ID_ATTR_RE)?.[2]?.trim()
    const id = uniqueId(existingId || slugifyHeading(title), seenIds)

    outlineItems.push({ id, title, level })

    const escapedId = escapeAttribute(id)

    if (existingId && existingId === id) return match
    if (existingId) return `<h${rawLevel}${attrs.replace(ID_ATTR_RE, ` id="${escapedId}"`)}>${innerHtml}</h${rawLevel}>`

    return `<h${rawLevel}${attrs} id="${escapedId}">${innerHtml}</h${rawLevel}>`
  })

  return {
    html: nextHtml,
    items: buildOutlineTree(outlineItems),
  }
}
