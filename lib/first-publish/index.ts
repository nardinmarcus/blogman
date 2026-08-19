/**
 * B3-01 — first formal publish (issue #33).
 *
 * Public entry point: deterministic prepare + single-transaction confirm with
 * separated prepare / intent / event / outbox / formal version / public
 * address facts. Drafts never fabricate formal facts; legacy status switches
 * never bypass preparation.
 */

export { ensureFirstPublishTables, FIRST_PUBLISH_DDL_STATEMENTS } from './ddl'
export {
  cancelPrepare,
  confirmPublish,
  dispatchOutbox,
  evaluateBlockers,
  evidenceDigest,
  eventIdFor,
  listPendingOutbox,
  outboxIdFor,
  preparePublish,
  readPublicationState,
  recordReceipt,
  FIRST_PUBLISH_DEFAULT_SITE_URL,
  FIRST_PUBLISH_DRAFT_LIFECYCLE,
  FIRST_PUBLISH_PUBLISHED_LIFECYCLE,
} from './kernel'
export type {
  BlockerRow,
  ConfirmInput,
  ConfirmResult,
  DispatchOutboxInput,
  EventRow,
  FormalPublicationFacts,
  FormalPublicationRow,
  IntentRow,
  OutboxKind,
  OutboxRow,
  PrepareInput,
  PrepareResult,
  PrepareRow,
  PrepareStatus,
  PublicationState,
  PublishBlockers,
  PublishEvidencePayload,
  PublishLifecycle,
  ReceiptRow,
} from './types'
export { blockersAllPass, failingBlockers } from './types'