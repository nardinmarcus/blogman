/**
 * B6-03 — 显式写回 Blogman 领先内容到主要源稿 (issue #52).
 *
 * Public surface for confirmation-gated write-back of Blogman-leading content
 * to the writable primary source: author-initiated intent (bound to article
 * version + source identity + operation id), the external push, and the
 * external confirmation that is the ONLY thing that advances the baseline.
 */

export * from './ddl'
export * from './types'
export * from './provider'
export * from './kernel'
