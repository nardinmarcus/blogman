/**
 * B2-01 canonical content envelope — separated content & source hashes.
 *
 * - `contentSnapshotHash`: hashes the canonical body-of-truth (the normalized
 *   document). Identical normalized documents → identical snapshot hash, so it
 *   is content-addressable and stable across source-format changes.
 * - `sourceSyncHash`: hashes the raw source input (Markdown text or Tiptap
 *   JSON). Two different source representations of the same content produce
 *   different sync hashes, so a source author can detect "the draft changed"
 *   independently of the canonical projection.
 *
 * Both output 64-char lowercase hex (a full SHA-256 digest).
 */

import { createHash } from 'node:crypto'
import type { ContentEnvelope, TiptapJSONDocument } from './types'
import { CONVERTER_VERSION, DOCUMENT_SCHEMA_VERSION } from './types'
import { toCanonicalJson } from './schema'

type Hex64 = string

function sha256Hex(data: string): Hex64 {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Hash covering the canonical document payload plus its schema version.
 * The schema version participates so that a schema migration, absent a real
 * content change, does not silently collide with identical-looking payloads.
 */
export function contentSnapshotHash(envelope: ContentEnvelope): Hex64 {
  const payload = JSON.stringify({
    tiptap_json_schema: envelope.tiptap_json_schema,
    normalized: JSON.parse(toCanonicalJson(envelope.normalized)),
  })
  return sha256Hex(payload)
}

/**
 * Hash of the raw source input. `source` may be a Markdown string or a Tiptap
 * JSON document; each is hashed in its own canonical byte form.
 */
export function sourceSyncHash(
  source: string | TiptapJSONDocument,
  options?: { provenance?: { schemaVersion: number; converter: number } },
): Hex64 {
  const bytes =
    typeof source === 'string' ? source : toCanonicalJson(source)
  const payload = JSON.stringify({
    kind: typeof source === 'string' ? 'markdown' : 'tiptap',
    bytes,
    converter: options?.provenance?.converter ?? CONVERTER_VERSION,
    schemaVersion: options?.provenance?.schemaVersion ?? DOCUMENT_SCHEMA_VERSION,
  })
  return sha256Hex(payload)
}
