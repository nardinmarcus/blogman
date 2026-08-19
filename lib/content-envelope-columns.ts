/**
 * B2-01b write-path envelope columns — column guard + dual-write envelope fields.
 *
 * The envelope columns are delivered through an independent, idempotent DDL
 * script (scripts/apply-content-envelope-ddl.mjs) instead of a numbered
 * ledger migration, so the issue-23 delivery canonical migration freeze stays
 * untouched. The routes call `missingContentEnvelopeColumns` before writing so
 * a not-yet-migrated database fails loudly (tell the operator to run the DDL
 * script) instead of silently dropping the envelope.
 */

import type { Database } from '@/lib/repositories/schema'
import {
  contentSnapshotHash,
  parse,
  sourceSyncHash,
} from '@/lib/content-envelope'

export const CONTENT_ENVELOPE_COLUMNS = [
  'content_envelope',
  'content_snapshot_sha256',
  'source_sync_sha256',
] as const

export type ContentEnvelopeColumn = (typeof CONTENT_ENVELOPE_COLUMNS)[number]

/**
 * Return the envelope columns absent from the `posts` table. Runs a cheap
 * PRAGMA so the caller can decide whether the envelope DDL has been applied.
 */
export async function missingContentEnvelopeColumns(
  db: Database,
): Promise<ContentEnvelopeColumn[]> {
  const { results } = await db
    .prepare('PRAGMA table_info(posts)')
    .all<{ name: string }>()
  const existing = new Set(results.map((row) => row.name))
  return CONTENT_ENVELOPE_COLUMNS.filter((column) => !existing.has(column))
}

export interface ContentEnvelopeFields {
  content_envelope: string | null
  content_snapshot_sha256: string | null
  source_sync_sha256: string | null
}

/**
 * Build the dual-write envelope fields from a Markdown source. Conversion is
 * additive and non-authoritative: the legacy content/html columns remain the
 * read fallback, so a conversion failure must not block the existing write
 * path. Returns null columns on failure and logs a warning.
 */
export function buildContentEnvelopeFields(content: string): ContentEnvelopeFields {
  try {
    const envelope = parse({ markdown: content })
    return {
      content_envelope: JSON.stringify(envelope),
      content_snapshot_sha256: contentSnapshotHash(envelope),
      source_sync_sha256: sourceSyncHash(content),
    }
  } catch (error) {
    console.warn('B2-01b: content envelope conversion skipped:', error)
    return {
      content_envelope: null,
      content_snapshot_sha256: null,
      source_sync_sha256: null,
    }
  }
}
