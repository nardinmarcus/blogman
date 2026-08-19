import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyArticleIdentityDdl,
  applyLedger,
  backfillPath,
  cleanupStates,
  createState,
  query,
  repoRoot,
  seedPosts,
} from '@/tests/helpers/article-identity-state'
import { parse, renderHtml } from '@/lib/content-envelope'

const kernel = { parse, renderHtml }

function runBackfill(state: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', backfillPath, '--local', '--persist-to', state,
    '--database', 'DB', '--config', `${repoRoot}/wrangler.toml`,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

afterEach(() => cleanupStates())

describe('backfill-article-identity', () => {
  it('creates one identity + version per post (9 published / 5 drafts), is idempotent, and never gives drafts a fake first-published time', { timeout: 600_000 }, () => {
    const state = createState()
    applyLedger(state)
    applyArticleIdentityDdl(state)
    void seedPosts(state, kernel)

    const first = runBackfill(state)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('posts=14')
    expect(first.stdout).toContain('identities_created=14')
    expect(first.stdout).toContain('versions_created=14')

    // One-to-one identity mapping.
    expect(query<{ n: number }>(state, 'SELECT COUNT(*) AS n FROM articles')[0].n).toBe(14)
    expect(query<{ n: number }>(state, 'SELECT COUNT(*) AS n FROM article_versions')[0].n).toBe(14)
    // Every identity row has a distinct post_ref.
    expect(query<{ n: number }>(state, 'SELECT COUNT(*) AS n FROM (SELECT post_ref FROM articles GROUP BY post_ref)')[0].n).toBe(14)
    // Identity columns we must NOT guess stay NULL.
    const nullish = query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM articles WHERE slug IS NOT NULL OR draft_ref IS NOT NULL OR source_page_identity IS NOT NULL")[0].n
    expect(nullish).toBe(0)

    // Drafts must NOT inherit the legacy published_at.
    expect(query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM article_versions v JOIN articles a ON a.id = v.article_id JOIN posts p ON p.id = a.post_ref WHERE p.status = 'draft' AND v.published_at IS NOT NULL")[0].n).toBe(0)
    // Published rows keep a first-published time.
    expect(query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM article_versions v JOIN articles a ON a.id = v.article_id JOIN posts p ON p.id = a.post_ref WHERE p.status = 'published' AND v.published_at IS NULL")[0].n).toBe(0)

    // Audit trail: snapshot_json keeps original_content/original_html + envelope hash.
    const snap = query<{ snapshot_json: string; content_snapshot_sha256: string }>(
      state,
      "SELECT v.snapshot_json, v.content_snapshot_sha256 FROM article_versions v JOIN articles a ON a.id = v.article_id WHERE a.post_ref = (SELECT id FROM posts WHERE slug = 'pub-5')",
    )[0]
    const parsed = JSON.parse(snap.snapshot_json)
    expect(parsed.format).toBe('blogman-article-identity/v1')
    expect(parsed.version).toBe(1)
    expect(parsed.original_html).toContain('<img')
    expect(parsed.fidelity).toBe('equivalent')

    // ----- Idempotency: a second run creates zero new identities/versions. -----
    const second = runBackfill(state)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('identities_created=0')
    expect(second.stdout).toContain('versions_created=0')
    expect(query<{ n: number }>(state, 'SELECT COUNT(*) AS n FROM articles')[0].n).toBe(14)
    expect(query<{ n: number }>(state, 'SELECT COUNT(*) AS n FROM article_versions')[0].n).toBe(14)
    // posts table untouched by backfill.
    expect(query<{ n: number }>(state, 'SELECT COUNT(*) AS n FROM posts')[0].n).toBe(14)
  })
})
