/**
 * B2-01 canonical content envelope — versioned converter interface.
 *
 * Public entry points:
 *   parse(input)          → ContentEnvelope  (markdown | tiptap)
 *   normalize(tiptap)     → ContentEnvelope
 *   renderHtml(envelope)  → string
 *   serializeMarkdown(envelope) → string
 *   plainText(envelope)   → string
 *   searchProjection(envelope) → SearchProjection
 *   interpret(envelope)   → normalized doc, honoring recorded schema version
 *
 * Every produced envelope carries `provenance` (converter + schema version) so
 * an older envelope can be interpreted per the converter version that created
 * it, and so converter/schema upgrades never invent fake article revisions.
 */

import type {
  ContentEnvelope,
  EnvelopeSource,
  TiptapJSONDocument,
} from './types'
import {
  CONVERTER_VERSION,
  DOCUMENT_SCHEMA_VERSION,
  ENVELOPE_FORMAT,
} from './types'
import { ContentEnvelopeError } from './whitelist'
import { EnvelopeSchema, normalizeDocument, toCanonicalJson } from './schema'
import { markdownToDocument } from './markdown'
import { renderHtml as renderHtmlImpl } from './renderer'
import { serializeMarkdown as serializeMarkdownImpl } from './serializer'
import {
  plainText as plainTextImpl,
  searchProjection as searchProjectionImpl,
} from './plaintext'

/** The most recent document schema version this converter understands. */
export const LATEST_SCHEMA_VERSION = DOCUMENT_SCHEMA_VERSION

function provenanceFor(schemaVersion = DOCUMENT_SCHEMA_VERSION) {
  return { converter: CONVERTER_VERSION, schemaVersion }
}

/**
 * Build an envelope from an already-normalized document.
 * Package-internal; external callers should use `normalize` or `parse`.
 */
export function envelopeFromDocument(doc: TiptapJSONDocument): ContentEnvelope {
  return {
    format: ENVELOPE_FORMAT,
    tiptap_json_schema: DOCUMENT_SCHEMA_VERSION,
    normalized: doc,
    provenance: provenanceFor(),
  }
}

/**
 * Normalize raw Tiptap JSON into a canonical envelope.
 */
export function normalize(input: TiptapJSONDocument): ContentEnvelope {
  if (!input || typeof input !== 'object' || input.type !== 'doc') {
    throw new ContentEnvelopeError('normalize expects a Tiptap JSON doc node')
  }
  const normalized = normalizeDocument(input)
  return envelopeFromDocument(normalized)
}

function normalizeFromMarkdown(markdown: string): ContentEnvelope {
  if (typeof markdown !== 'string') {
    throw new ContentEnvelopeError('markdown source must be a string')
  }
  const rawDoc = markdownToDocument(markdown)
  const normalized = normalizeDocument(rawDoc as TiptapJSONDocument)
  return envelopeFromDocument(normalized)
}

/**
 * Parse a source input (markdown or tiptap) into a canonical envelope.
 */
export function parse(input: EnvelopeSource): ContentEnvelope {
  if ('markdown' in input && input.markdown !== undefined) {
    return normalizeFromMarkdown(input.markdown)
  }
  if ('tiptap' in input && input.tiptap !== undefined) {
    return normalize(input.tiptap)
  }
  throw new ContentEnvelopeError('parse requires either { markdown } or { tiptap }')
}

/**
 * Interpret an envelope's payload, honoring its recorded schema version.
 * Currently supports schema version 1 and rejects unknown (newer) versions
 * fail-closed, providing the forward-compatibility hook called out in #24.
 */
export function interpret(envelope: ContentEnvelope): TiptapJSONDocument {
  const parsed = EnvelopeSchema.safeParse(envelope)
  if (!parsed.success) {
    throw new ContentEnvelopeError(
      `invalid envelope: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  const schemaVersion = envelope.tiptap_json_schema
  if (schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new ContentEnvelopeError(
      `envelope uses schema version ${schemaVersion}, but this converter supports up to ${LATEST_SCHEMA_VERSION}`,
    )
  }
  // v1: payload is already canonical — return as-is.
  if (schemaVersion === 1) {
    return envelope.normalized
  }
  // v0 (legacy, pre-versioning): payload may not be canonicalized yet.
  // The forward-compat hook re-normalizes so downstream projections are safe.
  if (schemaVersion === 0) {
    return normalizeDocument(envelope.normalized)
  }
  throw new ContentEnvelopeError(`unsupported schema version ${schemaVersion}`)
}

function assertEnvelope(envelope: ContentEnvelope): TiptapJSONDocument {
  return interpret(envelope)
}

/** Render the envelope's payload to HTML. */
export function renderHtml(envelope: ContentEnvelope): string {
  return renderHtmlImpl(assertEnvelope(envelope))
}

/** Serialize the envelope's payload to Markdown (lossy for media nodes). */
export function serializeMarkdown(envelope: ContentEnvelope): string {
  return serializeMarkdownImpl(assertEnvelope(envelope))
}

/** Plain-text projection of the envelope's payload. */
export function plainText(envelope: ContentEnvelope): string {
  return plainTextImpl(assertEnvelope(envelope))
}

/** Search projection (text + tokens + media URLs + headings). */
export function searchProjection(envelope: ContentEnvelope) {
  return searchProjectionImpl(assertEnvelope(envelope))
}

export { toCanonicalJson }
