/**
 * B3-02 — formal-article pending revision loop (issue #34).
 *
 * Public entry point: the shared save choke point for formal articles
 * (`saveRevision`), the single-transaction promotion (`promoteRevision`, which
 * writes the restore point first, then raises the revision and writes the
 * event), discard, and the read model. Editing a formally published article
 * never changes the live version; public reads keep reading the formal
 * projection until promotion.
 */

export { ensurePublishRevisionTables, PUBLISH_REVISION_DDL_STATEMENTS } from './ddl'
export {
  buildPromotedVersionRecord,
  discardRevision,
  evidenceDigest,
  findActiveRevision,
  findRevisionById,
  promoteRevision,
  promotionIdFor,
  readRevisionState,
  resolveFormalAnchor,
  restorePointIdFor,
  revisionIdFor,
  revisionSnapshotFromSave,
  saveRevision,
  snapshotContentHash,
} from './kernel'
export type {
  DiscardResult,
  FormalAnchor,
  PromotionFacts,
  PromotionRow,
  PromoteInput,
  PromoteResult,
  RestorePointRow,
  RevisionRow,
  RevisionSnapshotInput,
  RevisionState,
  RevisionStatus,
  SaveRevisionInput,
  SaveRevisionResult,
} from './types'