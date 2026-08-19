/**
 * B2-01 canonical content envelope — shared TypeScript types.
 *
 * Pure type definitions only; no logic lives here so the envelope contract is
 * reviewable in one place. See schema.ts for runtime validation and
 * normalization.
 */

/**
 * A single ProseMirror/Tiptap mark (inline decoration), e.g. `bold`, `link`.
 */
export interface TiptapMark {
  type: string
  /** Attribute values carried by the mark (sorted by normalization). */
  attrs?: Record<string, unknown>
}

/**
 * A ProseMirror/Tiptap node. `text` nodes carry `text` and optionally `marks`;
 * every other node carries `type`, optional `attrs`, and optional `content`.
 */
export interface TiptapNode {
  type: string
  attrs?: Record<string, unknown>
  content?: TiptapNode[]
  text?: string
  marks?: TiptapMark[]
}

/**
 * The canonical Tiptap JSON document. Root is always `doc` with a `content`
 * array of block nodes.
 */
export interface TiptapJSONDocument {
  type: 'doc'
  content: TiptapNode[]
}

/**
 * Canonical content envelope — the single immutable body-of-truth record.
 */
export interface ContentEnvelope {
  format: 'blogman-content-envelope/v1'
  /** Document schema version of the `normalized` payload. First version is 1. */
  tiptap_json_schema: number
  /** Canonicalized (byte-deterministic) Tiptap JSON document. */
  normalized: TiptapJSONDocument
  /**
   * Converter provenance. Lets an older envelope be interpreted according to
   * the converter version that produced it, and lets upgrades avoid inventing
   * fake article revisions.
   */
  provenance?: {
    /** Converter interface version that produced this envelope. */
    converter: number
    /** Mirrors the envelope `tiptap_json_schema` for easier consumption. */
    schemaVersion: number
  }
}

/**
 * A source-input union accepted by the envelope `parse` entry point.
 */
export type EnvelopeSource =
  | { markdown: string }
  | { tiptap: TiptapJSONDocument }

export const ENVELOPE_FORMAT = 'blogman-content-envelope/v1' as const
export const DOCUMENT_SCHEMA_VERSION = 1 as const
export const CONVERTER_VERSION = 1 as const
