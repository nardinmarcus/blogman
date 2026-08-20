/**
 * B4-04 — safe deep-link types (issue #43).
 *
 * A deep link is just an IDENTITY (`source_type` + `source_id`) — it never
 * carries stale state as parameters. The resolver re-reads the CURRENT
 * authoritative state for that identity and produces a navigation that always
 * reflects live facts, never the request's (possibly stale) parameters.
 * When the identity no longer resolves to a live item (expired schedule or
 * missing article) the link FALLS THROUGH to current reality (workbench / list)
 * instead of pointing at a stale or fabricated target.
 */

import type { ResponsibleParty } from '@/lib/workbench/types'

/** The only thing a deep link carries: an authoritative source identity. */
export interface DeepLinkTarget {
  sourceType: 'article' | 'schedule'
  sourceId: string
}

/**
 * A resolved navigation. `outcome` states what the CURRENT facts say; `fallback`
 * is true when the requested identity was expired / missing and we landed on
 * current reality. `navigation` is the safe href to send the user to.
 */
export interface DeepLinkResolution {
  outcome: string
  sourceType: DeepLinkTarget['sourceType']
  sourceId: string
  /** The current authoritative status of the identity (never stale params). */
  liveStatus: string | null
  /** Title re-read from live facts (never from the request). */
  liveTitle: string
  /** Where to navigate, derived ONLY from live facts. */
  navigation: { href: string; label: string }
  /** Responsibility derived from live facts, for the UI group badge. */
  responsible: ResponsibleParty | null
  /** True when the identity was expired and we fell through to current reality. */
  fallback: boolean
}
