/**
 * B5-01 — WeChat provider layer (issue #46).
 *
 * The interface real WeChat integrations implement later. THIS BATCH SHIPS THE
 * MOCK ONLY and zero production wiring: production passes `provider: null`, so
 * derivation creates the in-DB draft task and NEVER performs an external call
 * (零生产, 不真调微信 API). The mock exists so tests can prove the EXACT
 * payload the executor would hand to the WeChat draft box and that the draft
 * is never published.
 *
 * B5-02 (issue #47) — failure / retry / result-unknown state machine.
 *
 *   - `WechatDraftProviderResult` gains an optional `classification` so a
 *     rejection can say WHY it happened: 'retryable' (rate limit / temporary
 *     unavailability), 'needs-author' (permanent / configuration error) or
 *     'unknown' (response lost — the request MAY have landed). An absent
 *     classification on a rejection defaults to 'needs-author' (an untyped
 *     rejection is author-actionable, never blindly retried).
 *   - `WechatProviderError` carries the same classification for THROWN errors;
 *     a plain throw defaults to 'retryable' (a transport-level exception is
 *     transient by default).
 *   - `queryDraft` is the reconcile seam: for a result-unknown task the kernel
 *     queries the remote BEFORE any further submission instead of blindly
 *     retrying a possibly-non-idempotent call.
 */

import type {
  WechatDraftProvider,
  WechatDraftProviderResult,
  WechatDraftQueryPayload,
  WechatDraftQueryResult,
  WechatDraftSubmitPayload,
  WechatDraftAttemptClassification,
} from './types'

export const WECHAT_PROVIDER_ERROR_LIMIT = 512

const WECHAT_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization header / Bearer tokens
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  // key=value / key: value secret assignments
  [
    /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|appsecret|authorization|auth)\b\s*[:=]\s*)([^\s,;&]+)/gi,
    '$1[REDACTED]',
  ],
  // URL embedded credentials (scheme://user:pass@)
  [/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@'],
]

/**
 * Bound + sanitise a provider error for the immutable attempt / task fact
 * rows: redact common secret shapes (Bearer tokens, token/secret assignments,
 * URL-embedded credentials), collapse whitespace and cap the length
 * (脱敏分类 — attempt facts never leak secrets).
 */
export function sanitizeWechatProviderError(message: string, maxLength = WECHAT_PROVIDER_ERROR_LIMIT): string {
  let out = String(message ?? '')
  for (const [pattern, replacement] of WECHAT_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  const cleaned = out.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

const WECHAT_CLASSIFICATIONS: ReadonlyArray<WechatDraftAttemptClassification> = [
  'ok',
  'retryable',
  'needs-author',
  'unknown',
]

/** Type guard + normalise for a provider classification hint. */
export function normalizeWechatClassification(
  value: unknown,
): Exclude<WechatDraftAttemptClassification, 'ok'> | null {
  if (typeof value !== 'string') return null
  const candidate = value as string
  if ((WECHAT_CLASSIFICATIONS as string[]).includes(candidate) && candidate !== 'ok') {
    return candidate as Exclude<WechatDraftAttemptClassification, 'ok'>
  }
  return null
}

/**
 * A provider failure that knows WHY it failed. Thrown transport errors (plain
 * `Error`) default to 'retryable' at classification time; adapters that want a
 * different classification throw this instead.
 */
export class WechatProviderError extends Error {
  readonly classification: Exclude<WechatDraftAttemptClassification, 'ok'>

  constructor(
    message: string,
    classification: Exclude<WechatDraftAttemptClassification, 'ok'> = 'retryable',
  ) {
    super(message)
    this.name = 'WechatProviderError'
    this.classification = classification
  }
}

export type { WechatDraftProvider, WechatDraftProviderResult, WechatDraftQueryPayload, WechatDraftQueryResult }

/**
 * In-memory provider recording ACCEPTED draft submissions with injectable
 * outcomes (accept / reject / throw) and query results (found / not-found /
 * unknown). Never touches a network.
 *
 * The `createDraft` outcome queue accepts:
 *   - `{ accepted: true, remoteDraftId }` — accepted (default),
 *   - `{ accepted: false, classification: 'retryable'|'needs-author'|'unknown', error }`,
 *   - `Error` / `WechatProviderError` — thrown to the kernel.
 *
 * The `queries` queue mirrors the same shapes for `queryDraft`:
 *   - `{ found: true, remoteDraftId }`,
 *   - `{ found: false }`,
 *   - `{ unknown: true, error }`,
 *   - `Error` / `WechatProviderError` — thrown (the reconcile stays frozen).
 */
export class MockWechatDraftProvider implements WechatDraftProvider {
  readonly kind = 'mock'
  readonly submitted: WechatDraftSubmitPayload[] = []
  readonly queried: WechatDraftQueryPayload[] = []
  totalCalls = 0
  totalQueryCalls = 0
  private outcomes: Array<WechatDraftProviderResult | Error>
  private queries: Array<WechatDraftQueryResult | Error>

  constructor(
    outcomes: Array<WechatDraftProviderResult | Error> = [{ accepted: true, remoteDraftId: 'mock-draft-1' }],
    queries: Array<WechatDraftQueryResult | Error> = [],
  ) {
    this.outcomes = [...outcomes]
    this.queries = [...queries]
  }

  async createDraft(payload: WechatDraftSubmitPayload): Promise<WechatDraftProviderResult> {
    this.totalCalls += 1
    const outcome = this.outcomes.shift() ?? { accepted: true, remoteDraftId: `mock-draft-${this.totalCalls}` }
    if (outcome instanceof Error) throw outcome
    if (outcome.accepted) this.submitted.push(payload)
    return outcome
  }

  async queryDraft(payload: WechatDraftQueryPayload): Promise<WechatDraftQueryResult> {
    this.totalQueryCalls += 1
    this.queried.push(payload)
    const outcome = this.queries.shift() ?? { found: false }
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}