/**
 * B8-02 — mobile small-edit read model (issue #61).
 *
 * Pure, framework-free model for the mobile editor's "small edit" surface.
 * The mobile editor only allows 标题 / 普通段落 / 基础行内格式; every other
 * block (tables, code, media embeds, task lists, …) is complex and rendered
 * READ-ONLY, with a desktop handoff that carries only identity + location.
 *
 * The mobile editor reuses B2-04's `EditorSaveCoordinator` + the shared
 * command transport verbatim (a mobile 版本表 is NOT created) — so the save /
 * offline-recovery / three-way-conflict protocol is byte-for-byte identical to
 * desktop and confirmation ("saved") is shown only after the server confirms
 * the current input. Everything here is kept free of React / ProseMirror so it
 * unit-tests in plain node with no browser.
 */

/** The only node types the mobile editor lets you edit in place. */
export const MOBILE_EDITABLE_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
])

/** Anything else (table*, codeBlock, taskList, image/video/audio/…, math, embeds) is complex. */
export function isComplexBlockType(type: string): boolean {
  return !MOBILE_EDITABLE_NODE_TYPES.has(type)
}

/**
 * Whether a selection context (the ancestry of node types from the doc root
 * down to the cursor) is editable on mobile. If ANY ancestor is a complex
 * block the whole context is read-only — you can type in a paragraph, but not
 * inside a table cell, code block, list, media or embed.
 */
export function isEditableContext(nodeTypes: Iterable<string>): boolean {
  for (const type of nodeTypes) {
    if (isComplexBlockType(type)) return false
  }
  return true
}

/** A minimal JSON-node silhouette so this walks a tiptap JSONContent without a browser. */
export interface JsonNode {
  type: string
  content?: JsonNode[] | null
  text?: string
}

/** True when the document contains at least one complex (read-only) block. */
export function hasComplexBlock(doc: JsonNode | null | undefined): boolean {
  if (!doc) return false
  if (isComplexBlockType(doc.type)) return true
  return (doc.content ?? []).some(hasComplexBlock)
}

/**
 * Desktop handoff URL. The handoff intentionally carries ONLY identity +
 * location (the existing article's slug) — never an in-memory draft. Desktop
 * then re-reads server facts and its own device draft per the B2-04 protocol.
 */
export function desktopHandoffUrl(slug: string | null | undefined): string {
  const identity = slug && slug.trim() ? encodeURIComponent(slug.trim()) : ''
  // `desktop=1` is a view hint only (never content) so the handoff opens the
  // full desktop editor even on a phone.
  return identity ? `/editor?edit=${identity}&desktop=1` : '/editor'
}

/** Mobile save-status label — "saved" is only ever shown after server confirmation. */
export function mobileSaveStatusLabel(status: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'): string {
  switch (status) {
    case 'saved':
      return '已保存'
    case 'saving':
      return '保存中…'
    case 'dirty':
      return '未保存'
    case 'conflict':
      return '版本冲突'
    default:
      return '保存失败'
  }
}
