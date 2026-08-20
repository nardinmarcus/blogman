/**
 * B8-05 — mobile full-page publish confirmation + receipt (issue #64).
 *
 * Public entry: the D1 read view for the full-page confirmation, the thin
 * confirm adapter over the SHARED #33 first-publish / #34 revision-promote
 * kernels, the combined 博客/排期/渠道 receipt, and the pure mobile model
 * (path selection, blockers, deterministic ids, receipt shaping) that also
 * drives the client component with no browser/crypto dependency.
 */

export { confirmMobilePublish, type MobileConfirmInput, type MobileConfirmResult } from './kernel'
export {
  getMobilePublishConfirmation,
  readReceiptSurfaces,
  type MobilePublishConfirmation,
} from './view'
export {
  blockersAllPass,
  CONFIRM_BLOCKER_LABELS,
  confirmBlockers,
  failingConfirmBlockers,
  firstIntentId,
  firstPrepareId,
  formatPublishTime,
  publishPathFor,
  revisionOperationId,
  shapeReceiptSurfaces,
  type ConfirmationBlockerInput,
  type MobileConfirmationBlockers,
  type MobilePublishPath,
  type PublishPathInput,
  type ReceiptSurface,
  type ReceiptSurfacesInput,
} from './model'
