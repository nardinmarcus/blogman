'use client'

/**
 * B8-02 — mobile editor view props (issue #61).
 *
 * Thin adapter over the shared Novel editor props that adds the mobile
 * "complex blocks are read-only" rule at the ProseMirror level: the view's
 * `editable` prop returns false whenever the current selection sits inside a
 * complex block, so you can edit 标题 / 普通段落 / 基础行内格式 but never type
 * into a table, code block, media embed, list or task list. Media leaves are
 * additionally non-draggable here (no resize/drag on mobile).
 */

import type { EditorState } from '@tiptap/pm/state'
import {
  buildEditorProps,
  createEditorExtensions,
} from '@/lib/editor-extensions'
import { isEditableContext } from './edit-model'

/** The node-type ancestry from the doc root down to the cursor. */
export function selectionNodeTypes(state: EditorState): string[] {
  const types: string[] = []
  const depth = state.selection.$anchor.depth
  for (let i = 0; i <= depth; i += 1) {
    types.push(state.selection.$anchor.node(i).type.name)
  }
  return types
}

/** ProseMirror `editable` — read-only inside any complex block. */
export function mobileEditable(state: EditorState): boolean {
  return isEditableContext(selectionNodeTypes(state))
}

/**
 * The mobile editor uses the SAME node-providing extensions as desktop so
 * existing content parses and serializes byte-for-byte (a mobile save can
 * never normalize or drop complex blocks — it must confirm against the same
 * snapshot desktop produces). Node-only extensions are reused verbatim; the
 * small-edit limitation is enforced by the `editable` prop above, and the
 * UI simply never offers slash-menu / AI / upload / resize affordances.
 */
export const createMobileEditorExtensions = createEditorExtensions

/**
 * View props for the mobile editor: reuses the shared paste/drop plumbing but
 * NEVER uploads media (no onImageUpload / no non-image handler), and enforces
 * the complex-block read-only rule.
 */
export function buildMobileEditorProps() {
  return {
    ...buildEditorProps(undefined, undefined, 'editor-main-prose'),
    editable: mobileEditable,
  }
}
