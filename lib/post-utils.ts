export function sanitizePostSlugInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/_{2,}/g, '_')
}

export function normalizePostSlug(value: string): string {
  return sanitizePostSlugInput(value)
    .replace(/^[-_]+|[-_]+$/g, '')
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/
const DESCRIPTION_FRONTMATTER_KEYS = new Set(['description', 'summary', 'excerpt', 'abstract'])

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateDescription(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value)
  if (!normalized || normalized.length <= maxLength) return normalized

  const clipped = normalized.slice(0, maxLength).trim()
  const boundary = Math.max(
    clipped.lastIndexOf('.'),
    clipped.lastIndexOf('!'),
    clipped.lastIndexOf('?'),
    clipped.lastIndexOf(';'),
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('！'),
    clipped.lastIndexOf('？'),
    clipped.lastIndexOf('；'),
  )

  if (boundary >= Math.floor(maxLength * 0.55)) {
    return clipped.slice(0, boundary + 1).trim()
  }

  return clipped
}

function stripSymmetricQuotes(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

export function stripMarkdownFrontmatter(value: string): string {
  return value.replace(FRONTMATTER_PATTERN, '')
}

function readYamlBlockValue(lines: string[], startIndex: number, separator: string): string {
  const values: string[] = []

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) break
    if (!line.trim()) {
      values.push('')
      continue
    }
    if (!/^\s+/.test(line)) break
    values.push(line.trim())
  }

  return values.filter(Boolean).join(separator)
}

function readYamlDescriptionValue(lines: string[], startIndex: number, rawValue: string): string {
  if (/^[>|][-+]?$/.test(rawValue)) {
    return readYamlBlockValue(lines, startIndex, rawValue.startsWith('>') ? ' ' : '\n')
  }

  if (!rawValue) {
    return readYamlBlockValue(lines, startIndex, ' ')
  }

  return stripSymmetricQuotes(rawValue)
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim())
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(FRONTMATTER_PATTERN, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .trim())
    .filter((line) => line && !isMarkdownTableSeparator(line))
    .join(' ')
    .replace(/[*~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isShortUntitledBlock(value: string): boolean {
  return value.length <= 80 && !/[.!?;。！？；]/.test(value)
}

function isMetadataBlock(value: string): boolean {
  return /[|｜]/.test(value) && /[：:]/.test(value)
}

function isStructuralMarkdownBlock(rawBlock: string, cleanedBlock: string): boolean {
  const trimmed = rawBlock.trim()
  if (!cleanedBlock) return true
  if (/^[-*_]{3,}$/.test(trimmed)) return true
  if (isMarkdownTableSeparator(trimmed)) return true
  if (isMetadataBlock(cleanedBlock)) return true
  if (isShortUntitledBlock(cleanedBlock)) return true
  if (
    /^\s{0,3}#{1,6}\s+/.test(trimmed)
    && cleanedBlock.length <= 80
    && !/[.!?;。！？；]$/.test(cleanedBlock)
  ) {
    return true
  }
  return false
}

function buildLegacyAutoDescription(value: string, maxLength = 160): string {
  const normalized = normalizeWhitespace(value)
  if (!normalized) return ''
  return normalized.slice(0, maxLength)
}

export function extractMarkdownDescription(value: string, maxLength = 160): string {
  const match = value.match(FRONTMATTER_PATTERN)
  if (!match) return ''

  const lines = (match[1] || '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!field) continue

    const key = field[1].trim().toLowerCase()
    if (!DESCRIPTION_FRONTMATTER_KEYS.has(key)) continue

    const value = readYamlDescriptionValue(lines, index, field[2].trim())
    const description = truncateDescription(cleanMarkdownText(value), maxLength)
    if (description) return description
  }

  return ''
}

export function buildAutoDescription(value: string, maxLength = 160): string {
  const content = stripMarkdownFrontmatter(value)
  const blocks = content
    .split(/\n{2,}/)
    .map((block) => ({
      raw: block,
      text: cleanMarkdownText(block),
    }))
    .filter((block) => block.text)

  const candidate = blocks.find((block) => !isStructuralMarkdownBlock(block.raw, block.text))?.text
    || blocks[0]?.text
    || cleanMarkdownText(content)

  return truncateDescription(candidate, maxLength)
}

export function isAutoDescription(description: string | null | undefined, source: string, maxLength = 160): boolean {
  const normalizedDescription = normalizeWhitespace(description || '')
  if (!normalizedDescription) return false

  return normalizedDescription === buildAutoDescription(source, maxLength)
    || normalizedDescription === buildLegacyAutoDescription(source, maxLength)
}
