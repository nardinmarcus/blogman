/**
 * B6-06 — 安全解除并显式重新关联主要源稿 (issue #55).
 *
 * Public surface for the writable-primary-source TERMINATION / RE-ASSOCIATION
 * lifecycle. Fully additive on the B6-01 identity/link tables and the B6-04
 * union baseline: it creates NO new table, ships NOTHING to production (零生产)
 * and never drops or alters any earlier fact surface.
 */

export * from './types'
export * from './kernel'
