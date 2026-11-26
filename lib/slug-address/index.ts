/**
 * B3-04 — permanent slug address registry (issue #36).
 *
 * Public entry point: exclusivity checks, save-time candidate reservation,
 * promotion-time atomic rotation and the public single-hop resolver. Owns the
 * "当前 / 候选 / 历史地址按文章身份独占" invariant; old addresses permanently
 * single-hop to the article's current address (no redirect chain).
 */

export {
  backfillCurrentAddresses,
  isOwnHistorical,
  isSlugOwnedByOther,
  promoteAddressStatements,
  reserveCandidate,
  resolveArticleAddress,
} from './kernel'
export type { AddressKind, AddressResolution, BackfillResult, PromoteAddressInput, ReserveCandidateResult } from './kernel'
