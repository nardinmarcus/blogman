/**
 * B2-01 canonical content envelope — public entry point.
 *
 * A pure, self-contained kernel module that turns Markdown or Tiptap input into
 * a single canonical body-of-truth envelope, and rebuilds HTML / Markdown /
 * plain text / search projection from it. It does NOT touch the existing posts
 * ingestion flow; it is a drop-in kernel for later wiring.
 */

export type {
  ContentEnvelope,
  EnvelopeSource,
  TiptapJSONDocument,
  TiptapMark,
  TiptapNode,
} from './types'
export type { SearchProjection } from './plaintext'
export {
  ENVELOPE_FORMAT,
  DOCUMENT_SCHEMA_VERSION,
  CONVERTER_VERSION,
} from './types'
export { ContentEnvelopeError } from './whitelist'
export {
  NODE_WHITELIST,
  MARK_WHITELIST,
  isAllowedNode,
  isAllowedMark,
  assertAllowedDocument,
} from './whitelist'
export {
  normalizeDocument,
  toCanonicalJson,
  EnvelopeSchema,
} from './schema'
export {
  parse,
  normalize,
  renderHtml,
  serializeMarkdown,
  plainText,
  searchProjection,
  interpret,
  envelopeFromDocument,
  LATEST_SCHEMA_VERSION,
} from './converter'
export { contentSnapshotHash, sourceSyncHash } from './hash'
