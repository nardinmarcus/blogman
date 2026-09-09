/**
 * Publication Intent (CONTEXT.md) — the single mapping from canonical facts
 * to the ONE publish-surface action and its copy.
 *
 * Every branch resolves label, modal title/description, wire request, and
 * success message from the SAME decision, so a label/action mismatch (the
 * issue #19 class: 「转为草稿」 button opening the first-publish confirm page
 * for a temp-published article) is structurally inexpressible.
 *
 * Out of scope by definition: the editors' save-time status toggle
 * (publishTemp via lib/editor-save-coordinator — an editing semantic, not an
 * on/off-public-surface decision) and the external write API
 * (lib/external-write-api — its own command surface).
 */

/** The facts one admin row carries (from the list read model). */
export interface PublicationFacts {
  articleId: number | null
  expectedVersion: number | null
  /** Canonical B3 fact — true only when a formal_publications row exists. */
  formalPublished: boolean | null
  status: string
}

export type PublicationCommandRequest =
  | { action: 'unpublish' }
  | { action: 'relive'; content: 'formal' }

export type PublicationIntent =
  /** Versioned authority missing — admin writes are refused (ADR 0011). */
  | { kind: 'refused'; message: string }
  /** Never formally published: the shared prepare/confirm page owns the flow. */
  | { kind: 'first-publish'; articleId: number }
  | { kind: 'command'; request: PublicationCommandRequest; successMsg: string }

export function resolvePublicationIntent(facts: PublicationFacts): PublicationIntent {
  if (typeof facts.articleId !== 'number' || typeof facts.expectedVersion !== 'number') {
    return { kind: 'refused', message: '文章尚未启用版本化写入' }
  }
  // Never formally published — including temp-published drafts (editor
  // publishTemp flipped posts.status without creating a formal_publication):
  // the ONLY correct surface action is the first-publish confirm flow.
  if (facts.formalPublished !== true) {
    return { kind: 'first-publish', articleId: facts.articleId }
  }
  if (facts.status === 'published') {
    return { kind: 'command', request: { action: 'unpublish' }, successMsg: '已取消发布' }
  }
  // Formally published but not live (draft, or deleted — preserved legacy
  // behaviour: a deleted formal article relives through the lifecycle command).
  return { kind: 'command', request: { action: 'relive', content: 'formal' }, successMsg: '已重新上线' }
}

export interface PublicationActionCopy {
  label: string
  modalTitle: string
  modalDescription: string
}

/** Button + confirm-modal copy, derived from the SAME intent as the action. */
export function publicationActionCopy(facts: PublicationFacts): PublicationActionCopy {
  const intent = resolvePublicationIntent(facts)
  switch (intent.kind) {
    case 'refused':
      return {
        label: '发布文章',
        modalTitle: '发布文章',
        modalDescription: '发布后，文章将在首页和 RSS 中显示。',
      }
    case 'first-publish':
      return {
        label: '发布（首次上线）',
        modalTitle: '发布（首次上线）',
        modalDescription: '将进入首次发布确认：展示精确版本与四项阻塞检查，确认后创建正式发布并生成公开地址。',
      }
    case 'command':
      return intent.request.action === 'unpublish'
        ? {
            label: '转为草稿',
            modalTitle: '转为草稿',
            modalDescription: '转为草稿后，文章将不再公开显示。',
          }
        : {
            label: '重新上线',
            modalTitle: '重新上线',
            modalDescription: '将基于正式版本重新上线，文章将在首页和 RSS 中显示。',
          }
  }
}
