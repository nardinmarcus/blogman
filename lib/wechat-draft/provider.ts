/**
 * B5-01 — WeChat provider layer (issue #46).
 *
 * The interface real WeChat integrations implement later. THIS BATCH SHIPS THE
 * MOCK ONLY and zero production wiring: production passes `provider: null`, so
 * derivation creates the in-DB draft task and NEVER performs an external call
 * (零生产, 不真调微信 API). The mock exists so tests can prove the EXACT
 * payload the executor would hand to the WeChat draft box and that the draft
 * is never published.
 */

import type { WechatDraftProvider, WechatDraftProviderResult, WechatDraftSubmitPayload } from './types'

export const WECHAT_PROVIDER_ERROR_LIMIT = 512

/** Bound + sanitise a provider error for the retry-visible fact row. */
export function sanitizeWechatProviderError(message: string, maxLength = WECHAT_PROVIDER_ERROR_LIMIT): string {
  const cleaned = message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

/** An alias for the mock's result type so wiring code reads the same. */
export type { WechatDraftProvider, WechatDraftProviderResult, WechatDraftSubmitPayload }

/**
 * In-memory provider recording ACCEPTED draft submissions with injectable
 * outcomes (accept / reject / throw). Never touches a network.
 */
export class MockWechatDraftProvider implements WechatDraftProvider {
  readonly kind = 'mock'
  readonly submitted: WechatDraftSubmitPayload[] = []
  totalCalls = 0
  private outcomes: Array<WechatDraftProviderResult | Error>

  constructor(outcomes: Array<WechatDraftProviderResult | Error> = [{ accepted: true, remoteDraftId: 'mock-draft-1' }]) {
    this.outcomes = [...outcomes]
  }

  async createDraft(payload: WechatDraftSubmitPayload): Promise<WechatDraftProviderResult> {
    this.totalCalls += 1
    const outcome = this.outcomes.shift() ?? { accepted: true, remoteDraftId: `mock-draft-${this.totalCalls}` }
    if (outcome instanceof Error) throw outcome
    if (outcome.accepted) this.submitted.push(payload)
    return outcome
  }
}