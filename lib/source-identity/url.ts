/**
 * B6-01 — 主要源稿身份的规范化 URL 幂等识别 (issue #50).
 *
 * Deterministic canonicalization of a source-page URL into a single stable
 * identity. The SAME physical source recorded many times (different tracking
 * parameters, fragments, case, default ports, repeated clips) MUST map to one
 * identity; the same input ALWAYS maps to the same canonical URL + sha256 so a
 * re-run never fabricates a second identity.
 *
 * Guessing policy ("不猜身份"): only structural noise is normalized. Semantic
 * variants — different scheme (http vs https), www / non-www host, trailing
 * slash, different path — are treated as DISTINCT identities and are merged
 * only by the author through the explicit `mergeSourceVariant` command. This
 * module never decides "these two pages are the same".
 *
 * Pure and framework-free: no DB, no side effects, unit-testable with node.
 */

import { createHash } from 'node:crypto'

export interface NormalizedSourceUrl {
  /** Canonical, normalized URL — the identity key surface. */
  canonicalUrl: string
  /** sha256 hex of the canonical URL — immutable identity fingerprint. */
  identitySha256: string
}

/** Known trackers stripped for stable identity (safe noise, not semantics). */
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|ref|spm|igshid|igsh)$/i

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Normalize a source-page URL to its canonical identity.
 *
 * Normalizes: scheme + host lowercasing (WHATWG), default ports, fragment
 * removal, tracking-parameter removal, stable query ordering, empty-path →
 * `/`. Does NOT guess semantic identity (scheme / host / trailing slash
 * variants stay distinct).
 *
 * @returns the canonical URL + sha256, or null when the input is not an
 *          `http(s)` absolute URL (the only sources this system accepts).
 */
export function normalizeSourceUrl(raw: string): NormalizedSourceUrl | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const protocol = url.protocol.toLowerCase() // 'http:' | 'https:'
  const host = url.hostname.toLowerCase()
  // WHATWG already drops the default port for the scheme; keep only non-default.
  const port = url.port ? `:${url.port}` : ''
  const pathname = url.pathname || '/'

  // Drop tracking params, then sort deterministically for a stable query.
  const params = new URLSearchParams()
  for (const [key, value] of url.searchParams.entries()) {
    if (!TRACKING_PARAM.test(key)) params.append(key, value)
  }
  params.sort()
  const search = params.toString() ? `?${params.toString()}` : ''

  const canonicalUrl = `${protocol}//${host}${port}${pathname}${search}`

  return {
    canonicalUrl,
    identitySha256: sha256Hex(canonicalUrl),
  }
}
