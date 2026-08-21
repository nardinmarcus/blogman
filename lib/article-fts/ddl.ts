/**
 * #234 Phase A — canonical article search index DDL.
 *
 * The legacy `posts_fts` surface is fed by triggers on the retiring `posts`
 * projection and is dropped together with it in Phase C. Search therefore
 * needs its own rebuildable index anchored on canonical facts:
 *
 *   - `article_fts` — an fts5 index whose rowid IS the article id; each
 *     article has exactly one row carrying the LATEST frozen version's
 *     observable title + body,
 *   - a feed trigger on `article_versions`: every newly appended version
 *     reindexes its article (latest wins), so the index is rebuildable from
 *     canonical facts at any time and never depends on the projection.
 *
 * Delivered through the same independent DDL channel as every other
 * post-issue-23 fact surface, so the issue-23 canonical migration freeze
 * (exactly 001..007) stays untouched. Safe to run repeatedly; never drops or
 * alters existing rows. Production application is an explicitly authorized
 * operator step (Phase B/C) — this module only owns the DDL definition and
 * the idempotent ensure helper used by tests.
 */

import type { Database } from '@/lib/repositories/schema'

export const ARTICLE_FTS_DDL_STATEMENTS: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(title, content)`,
  `CREATE TRIGGER IF NOT EXISTS article_fts_version_indexed
     AFTER INSERT ON article_versions
   BEGIN
     DELETE FROM article_fts WHERE rowid = new.article_id;
     INSERT INTO article_fts(rowid, title, content)
     VALUES (
       new.article_id,
       COALESCE(json_extract(new.snapshot_json, '$.fields.title'), ''),
       COALESCE(json_extract(new.snapshot_json, '$.original_content'), '')
     );
   END`,
]

/** Idempotently create the canonical search index if absent. Never drops. */
export async function ensureArticleFts(db: Database): Promise<void> {
  for (const statement of ARTICLE_FTS_DDL_STATEMENTS) {
    await db.prepare(statement).run()
  }
}
