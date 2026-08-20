/**
 * B4-04 — safe deep-link public entry (issue #43).
 *
 * Deep links carry ONLY an identity (source type + id) and the resolver
 * RE-READS current authoritative state to navigate; expired links fall through
 * to current reality. Pure read-only — never writes, never trusts stale params.
 */

export { resolveDeepLink } from './kernel'
export type { DeepLinkResolution, DeepLinkTarget } from './types'
