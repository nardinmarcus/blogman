/**
 * B3-G — batch-3 acceptance fixture tests (issue #39).
 *
 * Spoons a complete first-publish + revision-online fact chain into an
 * isolated local D1 (real hashes computed through the same canonical
 * kernels), then runs `scripts/reconcile-b3-facts.mjs` and asserts:
 *
 *   - ALIGNED on the complete fixture bound to the same immutable candidate,
 *   - DRIFT with a single item when the candidate identity mismatches,
 *   - DRIFT with itemized items when each fact surface is corrupted
 *     (tampered event payload, stale revision, missing restore point,
 *     renamed formal slug, stale projection, broken outbox marker, orphaned
 *     intent).
 *
 * Zero production: every D1 access is `--local --persist-to <tmpdir>`; the
 * reconciler itself only issues read-only SELECT statements.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyArticleIdentityDdl,
  applyLedger,
  cleanupStates,
  configPath,
  createState,
  literal,
  repoRoot,
  runD1,
  spawnOk,
} from '@/tests/helpers/article-identity-state'
import { contentSnapshotHash, parse, renderHtml } from '@/lib/content-envelope'
import { snapshotContentHash } from '@/lib/publish-revision/kernel'

const SITE = 'https://blog.namooca.com'
const CANDIDATE = 'a'.repeat(40)

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const hashOf = (markdown: string) => contentSnapshotHash(parse({ markdown }))
const snapHash = (content: string) => snapshotContentHash({ content })

const T1 = 1_700_000_000
const T2 = 1_700_003_600
const T1d = 1_700_000_100
const T1e = 1_700_000_200

function applyDdl(state: string, script: string): void {
  spawnOk(`${script} ddl`, [
    process.execPath,
    join(repoRoot, 'scripts', script),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
}

function runReconcile(state: string, report: string, extra: string[] = []): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts', 'reconcile-b3-facts.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
    '--report', report, ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

const reportDirs: string[] = []
const stateDirs: string[] = []
let seedState: string | null = null

function freshReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b3-facts-report-'))
  reportDirs.push(dir)
  return join(dir, 'report.md')
}

/** Build the full fixture state once (shared by all cases in this file). */
function buildSeedState(): string {
  if (seedState) return seedState
  const state = createState()
  stateDirs.push(state)
  applyLedger(state)
  applyArticleIdentityDdl(state)
  applyDdl(state, 'apply-content-envelope-ddl.mjs')
  applyDdl(state, 'apply-first-publish-ddl.mjs')
  applyDdl(state, 'apply-publish-revision-ddl.mjs')
  applyDdl(state, 'apply-article-lifecycle-ddl.mjs')
  applyDdl(state, 'apply-slug-address-ddl.mjs')
  seedB3Facts(state)
  seedState = state
  return state
}

afterAll(() => {
  for (const d of reportDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  cleanupStates()
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface SnapshotShape {
  format: string
  post_ref: number
  version: number
  fields: Record<string, unknown>
  original_content: string
  original_html: string
  content_snapshot_sha256: string
  source_sync_sha256: string
}

function snapshotJson(shape: SnapshotShape): string {
  return JSON.stringify(shape)
}

function versionSnapshot(postRef: number, version: number, slug: string, title: string, markdown: string, html: string): string {
  const hash = hashOf(markdown)
  return snapshotJson({
    format: 'blogman-article-snapshot/v1',
    post_ref: postRef,
    version,
    fields: { slug, title, content: markdown, html },
    original_content: markdown,
    original_html: html,
    content_snapshot_sha256: hash,
    source_sync_sha256: hash,
  })
}

const eventPayload = (eventId: string, intentId: string, articleId: number, version: number, slug: string, at: number) =>
  JSON.stringify({ format: 'blogman-first-publish-event/v1', eventId, intentId, articleId, version, slug, firstPublishedAt: at, publishedAt: at, publicUrl: `${SITE}/${slug}` })
const outboxPayload = (outboxId: string, eventId: string, articleId: number, version: number, slug: string) =>
  JSON.stringify({ format: 'blogman-first-publish-outbox/v1', outboxId, eventId, articleId, version, slug, publicUrl: `${SITE}/${slug}` })
const promotionPayload = (promotionId: string, revisionId: string, articleId: number, baseVersion: number, promotedVersion: number, slug: string, at: number) =>
  JSON.stringify({ format: 'blogman-publish-promotion/v1', promotionId, revisionId, articleId, baseVersion, promotedVersion, slug, publicUrl: `${SITE}/${slug}`, createdAt: at })
const lifecyclePayload = (operationId: string, direction: string, articleId: number, version: number, slug: string, at: number) =>
  JSON.stringify({ format: 'blogman-lifecycle/v1', operationId, direction, articleId, version, slug, publicUrl: `${SITE}/${slug}`, createdAt: at })

/**
 * Build the complete B3 fixture:
 *
 *   A — draft article with a two-version fact chain (draft projection),
 *   B — first publish (v1 'pub-b') → pending revision → promotion to v2
 *       'pub-b-v2' → unpublish → relive-formal, with a NEW active revision
 *       reserving candidate address 'pub-b-v3',
 *   D — first publish only, current address backfilled,
 *   E — first publish only, NO address rows (backfill pending — tolerated).
 */
function seedB3Facts(state: string): void {
  const a1 = '# 甲\n\n正文甲。'
  const a2 = '# 甲改\n\n正文甲改。'
  const b1 = '旧版内容乙。'
  const b2 = '# 乙新版\n\n正文乙新版。'
  const b3 = '待审内容乙三版。'
  const d1 = '# 丁\n\n正文丁。'
  const e1 = '# 戊\n\n正文戊。'
  const hA1 = hashOf(a1)
  const hA2 = hashOf(a2)
  const hB1 = hashOf(b1)
  const hB2 = hashOf(b2)
  const hB3 = '3'.repeat(64)
  const hD1 = hashOf(d1)
  const hE1 = hashOf(e1)
  const htmlOf = (md: string) => renderHtml(parse({ markdown: md }))

  // Posts + identity + version facts.
  runD1(state, [
    `INSERT INTO posts (id, slug, title, content, html, status, published_at, content_snapshot_sha256)
     VALUES (1, 'draft-a', '草稿甲', ${literal(a2)}, ${literal(htmlOf(a2))}, 'draft', NULL, ${literal(hA2)})`,
    `INSERT INTO posts (id, slug, title, content, html, status, published_at, content_snapshot_sha256)
     VALUES (2, 'pub-b-v2', '发表乙新版', ${literal(b2)}, ${literal(htmlOf(b2))}, 'published', ${T2}, ${literal(hB2)})`,
    `INSERT INTO posts (id, slug, title, content, html, status, published_at, content_snapshot_sha256)
     VALUES (3, 'pub-d', '发表丁', ${literal(d1)}, ${literal(htmlOf(d1))}, 'published', ${T1d}, ${literal(hD1)})`,
    `INSERT INTO posts (id, slug, title, content, html, status, published_at, content_snapshot_sha256)
     VALUES (4, 'pub-e', '发表戊', ${literal(e1)}, ${literal(htmlOf(e1))}, 'published', ${T1e}, ${literal(hE1)})`,
    `INSERT INTO articles (id, post_ref, slug) VALUES (1, 1, 'draft-a'), (2, 2, 'pub-b-v2'), (3, 3, 'pub-d'), (4, 4, 'pub-e')`,
    `INSERT INTO article_versions (article_id, version, operation_id, snapshot_json, content_snapshot_sha256, published_at) VALUES
      (1, 1, 'op:a:v1', ${literal(versionSnapshot(1, 1, 'draft-a', '草稿甲', a1, htmlOf(a1)))}, ${literal(hA1)}, NULL),
      (1, 2, 'op:a:v2', ${literal(versionSnapshot(1, 2, 'draft-a', '草稿甲', a2, htmlOf(a2)))}, ${literal(hA2)}, NULL),
      (2, 1, 'op:b:v1', ${literal(versionSnapshot(2, 1, 'pub-b', '发表乙', b1, htmlOf(b1)))}, ${literal(hB1)}, ${T1}),
      (2, 2, 'op:b:v2', ${literal(versionSnapshot(2, 2, 'pub-b-v2', '发表乙新版', b2, htmlOf(b2)))}, ${literal(hB2)}, ${T2}),
      (3, 1, 'op:d:v1', ${literal(versionSnapshot(3, 1, 'pub-d', '发表丁', d1, htmlOf(d1)))}, ${literal(hD1)}, ${T1d}),
      (4, 1, 'op:e:v1', ${literal(versionSnapshot(4, 1, 'pub-e', '发表戊', e1, htmlOf(e1)))}, ${literal(hE1)}, ${T1e})`,
  ].join(';\n'))

  // B — first-publish fact chain at v1.
  const eB = 'event:intent:b:1'
  const pB = JSON.stringify({ format: 'blogman-first-publish/v1', note: 'fixture' })
  runD1(state, [
    `INSERT INTO publish_prepares
       (prepare_id, article_id, post_ref, prepared_version, prepared_slug, prepared_title, prepared_content_sha256,
        blocker_saved, blocker_lifecycle, blocker_slug, blocker_content, status, created_at, updated_at)
     VALUES ('prep:b:1', 2, 2, 1, 'pub-b', '发表乙', ${literal(hB1)}, 1, 1, 1, 1, 'committed', ${T1}, ${T1})`,
    `INSERT INTO publish_intents (intent_id, prepare_id, article_id, version, slug, lifecycle, status, created_at)
     VALUES ('intent:b:1', 'prep:b:1', 2, 1, 'pub-b', 'published', 'delivered', ${T1})`,
    `INSERT INTO publish_events
       (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at, evidence_sha256, payload, created_at)
     VALUES ('${eB}', 'intent:b:1', 2, 1, 'pub-b', 'published', ${T1}, ${literal(sha256(eventPayload(eB, 'intent:b:1', 2, 1, 'pub-b', T1)))}, ${literal(eventPayload(eB, 'intent:b:1', 2, 1, 'pub-b', T1))}, ${T1})`,
    `INSERT INTO publish_outbox
       (outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at, delivered_at)
     VALUES ('outbox:${eB}', '${eB}', 2, 1, 'public-receipt', ${literal(outboxPayload(`outbox:${eB}`, eB, 2, 1, 'pub-b'))}, 'delivered', 1, ${T1}, ${T1 + 60})`,
    `INSERT INTO publish_receipts
       (event_id, article_id, version, slug, public_url, receipt_payload, verified, verified_at, created_at)
     VALUES ('${eB}', 2, 1, 'pub-b', '${SITE}/pub-b', ${literal(pB)}, 1, ${T1 + 60}, ${T1 + 60})`,
  ].join(';\n'))

  // B — revision-online chain (promotion to v2) + lifecycle + new pending revision.
  const promoId = 'promote:rev:b:1'
  const promoPayload = promotionPayload(promoId, 'rev:b:1', 2, 1, 2, 'pub-b-v2', T2)
  const unpubOp = 'life:b:unpub'
  const reliveOp = 'life:b:relive'
  runD1(state, [
    // Preliminary formal_publications row (v1) so the promotion had a base to
    // move from — the final row below reflects the v2 promotion result.
    `INSERT INTO formal_publications
       (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id)
     VALUES (2, 1, 'pub-b', 'published', ${T1}, ${T1}, '${SITE}/pub-b', '${eB}')`,
    `INSERT INTO publish_revisions
       (revision_id, article_id, base_version, revision_number, status, slug, title, content, html, description, category, tags, password,
        is_pinned, is_hidden, cover_image, content_sha256, created_at, updated_at)
     VALUES ('rev:b:1', 2, 1, 1, 'promoted', 'pub-b-v2', '发表乙新版', ${literal(b2)}, ${literal(htmlOf(b2))}, NULL, NULL, NULL, NULL,
        0, 0, NULL, ${literal(hB2)}, ${T1 + 100}, ${T2})`,
    `INSERT INTO publish_restore_points
       (restore_point_id, article_id, formal_version, promoted_version, snapshot_json, content_sha256, reason, created_at)
     VALUES ('restore:${promoId}', 2, 1, 2,
       ${literal(snapshotJson({ format: 'blogman-article-snapshot/v1', post_ref: 2, version: 1, fields: { slug: 'pub-b', title: '发表乙', content: b1, html: htmlOf(b1) }, original_content: b1, original_html: htmlOf(b1), content_snapshot_sha256: hB1, source_sync_sha256: hB1 }))},
       ${literal(snapHash(b1))}, 'promote:rev:b:1', ${T2})`,
    `INSERT INTO publish_promotions
       (promotion_id, article_id, revision_id, base_version, promoted_version, slug, public_url, content_sha256, evidence_sha256, payload, actor, created_at)
     VALUES ('${promoId}', 2, 'rev:b:1', 1, 2, 'pub-b-v2', '${SITE}/pub-b-v2', ${literal(hB2)}, ${literal(sha256(promoPayload))}, ${literal(promoPayload)}, 'fixture', ${T2})`,
    // The final formal row: v2 is online, first-published time preserved.
    `UPDATE formal_publications SET
       version = 2, slug = 'pub-b-v2', published_at = ${T2}, public_url = '${SITE}/pub-b-v2', event_id = '${promoId}'
     WHERE article_id = 2 AND version = 1`,
    // Lifecycle: unpublish (posts -> draft) then relive-formal (posts -> published).
    `INSERT INTO article_lifecycles
       (operation_id, article_id, post_ref, version, direction, lifecycle_before, lifecycle_after, source_version, public_url, evidence_sha256, payload, actor, created_at)
     VALUES ('${unpubOp}', 2, 2, 2, 'unpublish', 'published', 'unpublished', 2, '${SITE}/pub-b-v2',
       ${literal(sha256(lifecyclePayload(unpubOp, 'unpublish', 2, 2, 'pub-b-v2', T2 + 60)))}, ${literal(lifecyclePayload(unpubOp, 'unpublish', 2, 2, 'pub-b-v2', T2 + 60))}, 'fixture', ${T2 + 60})`,
    `UPDATE posts SET status = 'draft', updated_at = ${T2 + 60} WHERE id = 2`,
    `UPDATE formal_publications SET lifecycle = 'unpublished' WHERE article_id = 2`,
    `INSERT INTO article_lifecycles
       (operation_id, article_id, post_ref, version, direction, lifecycle_before, lifecycle_after, source_version, public_url, evidence_sha256, payload, actor, created_at)
     VALUES ('${reliveOp}', 2, 2, 2, 'relive-formal', 'unpublished', 'published', 2, '${SITE}/pub-b-v2',
       ${literal(sha256(lifecyclePayload(reliveOp, 'relive-formal', 2, 2, 'pub-b-v2', T2 + 120)))}, ${literal(lifecyclePayload(reliveOp, 'relive-formal', 2, 2, 'pub-b-v2', T2 + 120))}, 'fixture', ${T2 + 120})`,
    `UPDATE posts SET status = 'published', updated_at = ${T2 + 120} WHERE id = 2`,
    `UPDATE formal_publications SET lifecycle = 'published' WHERE article_id = 2`,
    // A new active pending revision reserves candidate address 'pub-b-v3'.
    `INSERT INTO publish_revisions
       (revision_id, article_id, base_version, revision_number, status, slug, title, content, html, description, category, tags, password,
        is_pinned, is_hidden, cover_image, content_sha256, created_at, updated_at)
     VALUES ('rev:b:2', 2, 2, 2, 'active', 'pub-b-v3', '发表乙待审', ${literal(b3)}, ${literal(htmlOf(b3))}, NULL, NULL, NULL, NULL,
        0, 0, NULL, ${literal(hB3)}, ${T2 + 200}, ${T2 + 200})`,
    // Address registry for B: current v2 slug, historical first slug, candidate.
    `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at) VALUES
      ('pub-b-v2', 2, 'current', ${T2}, ${T2}),
      ('pub-b', 2, 'historical', ${T2}, ${T2}),
      ('pub-b-v3', 2, 'candidate', ${T2 + 200}, ${T2 + 200})`,
  ].join(';\n'))

  // D — first publish only, current address backfilled.
  const eD = 'event:intent:d:1'
  const pD = JSON.stringify({ format: 'blogman-first-publish/v1', note: 'fixture-d' })
  runD1(state, [
    `INSERT INTO publish_prepares
       (prepare_id, article_id, post_ref, prepared_version, prepared_slug, prepared_title, prepared_content_sha256,
        blocker_saved, blocker_lifecycle, blocker_slug, blocker_content, status, created_at, updated_at)
     VALUES ('prep:d:1', 3, 3, 1, 'pub-d', '发表丁', ${literal(hD1)}, 1, 1, 1, 1, 'committed', ${T1d}, ${T1d})`,
    `INSERT INTO publish_intents (intent_id, prepare_id, article_id, version, slug, lifecycle, status, created_at)
     VALUES ('intent:d:1', 'prep:d:1', 3, 1, 'pub-d', 'published', 'delivered', ${T1d})`,
    `INSERT INTO publish_events
       (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at, evidence_sha256, payload, created_at)
     VALUES ('${eD}', 'intent:d:1', 3, 1, 'pub-d', 'published', ${T1d}, ${literal(sha256(eventPayload(eD, 'intent:d:1', 3, 1, 'pub-d', T1d)))}, ${literal(eventPayload(eD, 'intent:d:1', 3, 1, 'pub-d', T1d))}, ${T1d})`,
    `INSERT INTO publish_outbox
       (outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at, delivered_at)
     VALUES ('outbox:${eD}', '${eD}', 3, 1, 'public-receipt', ${literal(outboxPayload(`outbox:${eD}`, eD, 3, 1, 'pub-d'))}, 'delivered', 1, ${T1d}, ${T1d + 60})`,
    `INSERT INTO publish_receipts
       (event_id, article_id, version, slug, public_url, receipt_payload, verified, verified_at, created_at)
     VALUES ('${eD}', 3, 1, 'pub-d', '${SITE}/pub-d', ${literal(pD)}, 1, ${T1d + 60}, ${T1d + 60})`,
    `INSERT INTO formal_publications
       (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id)
     VALUES (3, 1, 'pub-d', 'published', ${T1d}, ${T1d}, '${SITE}/pub-d', '${eD}')`,
    `INSERT INTO article_slug_addresses (slug, article_id, kind, created_at, updated_at)
     VALUES ('pub-d', 3, 'current', ${T1d}, ${T1d})`,
  ].join(';\n'))

  // E — first publish only, NO address rows (B3-04 backfill pending — tolerated).
  const eE = 'event:intent:e:1'
  const pE = JSON.stringify({ format: 'blogman-first-publish/v1', note: 'fixture-e' })
  runD1(state, [
    `INSERT INTO publish_prepares
       (prepare_id, article_id, post_ref, prepared_version, prepared_slug, prepared_title, prepared_content_sha256,
        blocker_saved, blocker_lifecycle, blocker_slug, blocker_content, status, created_at, updated_at)
     VALUES ('prep:e:1', 4, 4, 1, 'pub-e', '发表戊', ${literal(hE1)}, 1, 1, 1, 1, 'committed', ${T1e}, ${T1e})`,
    `INSERT INTO publish_intents (intent_id, prepare_id, article_id, version, slug, lifecycle, status, created_at)
     VALUES ('intent:e:1', 'prep:e:1', 4, 1, 'pub-e', 'published', 'delivered', ${T1e})`,
    `INSERT INTO publish_events
       (event_id, intent_id, article_id, version, slug, lifecycle, first_published_at, evidence_sha256, payload, created_at)
     VALUES ('${eE}', 'intent:e:1', 4, 1, 'pub-e', 'published', ${T1e}, ${literal(sha256(eventPayload(eE, 'intent:e:1', 4, 1, 'pub-e', T1e)))}, ${literal(eventPayload(eE, 'intent:e:1', 4, 1, 'pub-e', T1e))}, ${T1e})`,
    `INSERT INTO publish_outbox
       (outbox_id, event_id, article_id, version, kind, payload, status, attempts, created_at, delivered_at)
     VALUES ('outbox:${eE}', '${eE}', 4, 1, 'public-receipt', ${literal(outboxPayload(`outbox:${eE}`, eE, 4, 1, 'pub-e'))}, 'delivered', 1, ${T1e}, ${T1e + 60})`,
    `INSERT INTO publish_receipts
       (event_id, article_id, version, slug, public_url, receipt_payload, verified, verified_at, created_at)
     VALUES ('${eE}', 4, 1, 'pub-e', '${SITE}/pub-e', ${literal(pE)}, 1, ${T1e + 60}, ${T1e + 60})`,
    `INSERT INTO formal_publications
       (article_id, version, slug, lifecycle, first_published_at, published_at, public_url, event_id)
     VALUES (4, 1, 'pub-e', 'published', ${T1e}, ${T1e}, '${SITE}/pub-e', '${eE}')`,
  ].join(';\n'))
}

describe('reconcile-b3-facts', () => {
  it('reports ALIGNED on a complete first-publish + revision-online fixture bound to the same candidate', { timeout: 600_000 }, () => {
    const state = buildSeedState()

    const report = freshReport()
    const aligned = runReconcile(state, report, ['--candidate', CANDIDATE])
    expect(aligned.status, aligned.stdout || aligned.stderr).toBe(0)
    expect(aligned.stdout).toContain('verdict=ALIGNED')
    expect(aligned.stdout).toContain('drift=0')
    expect(aligned.stdout).toContain('formals=3')
    expect(aligned.stdout).toContain('events=3')
    expect(aligned.stdout).toContain('promotions=1')
    expect(aligned.stdout).toContain('lifecycles=2')
    expect(aligned.stdout).toContain('addresses=4')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('ALIGNED')
    expect(text).toContain('八面事实完整')
    expect(existsSync(report)).toBe(true)
  })

  it('reports DRIFT with a single candidate item when the ledger candidate mismatches', { timeout: 300_000 }, () => {
    const state = buildSeedState()

    const report = freshReport()
    const drifted = runReconcile(state, report, ['--candidate', 'b'.repeat(40)])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('候选漂移')
    expect(text).toContain('drift: 1') // report summary line
  })

  it('reports DRIFT with itemized items when each fact surface is corrupted', { timeout: 300_000 }, () => {
    const state = buildSeedState()

    // Corrupt one surface per mutation (each must appear in the report).
    runD1(state, "UPDATE publish_events SET payload = 'tampered' WHERE event_id = 'event:intent:e:1'")
    runD1(state, "UPDATE formal_publications SET slug = 'pub-b-hacked' WHERE article_id = 2")
    runD1(state, "UPDATE publish_revisions SET status = 'discarded' WHERE revision_id = 'rev:b:1'")
    runD1(state, "DELETE FROM publish_restore_points WHERE restore_point_id = 'restore:promote:rev:b:1'")
    runD1(state, "UPDATE posts SET status = 'draft' WHERE id = 3")
    runD1(state, "UPDATE publish_outbox SET status = 'pending' WHERE outbox_id = 'outbox:event:intent:d:1'")
    runD1(state, "DELETE FROM publish_intents WHERE intent_id = 'intent:e:1'")

    const report = freshReport()
    const drifted = runReconcile(state, report, ['--candidate', CANDIDATE])
    expect(drifted.status, drifted.stdout || drifted.stderr).toBe(1)
    expect(drifted.stdout).toContain('verdict=DRIFT')
    const text = readFileSync(report, 'utf8')
    // Event tamper-evidence.
    expect(text).toContain('publish_events(event:intent:e:1) 证据哈希不匹配')
    // Formal slug renamed without the address registry / projection following.
    expect(text).toContain('地址: article #2 current 地址 pub-b-v2 != 正式地址 pub-b-hacked')
    expect(text).toContain('投影: article #2 posts.slug=pub-b-v2 != 正式 slug=pub-b-hacked')
    // Stale promoted revision.
    expect(text).toContain('修订: revision rev:b:1 已被 promotion promote:rev:b:1 上线却仍为 status=\'discarded\'')
    // Missing recovery point for the promotion.
    expect(text).toContain('恢复点: promotion promote:rev:b:1 缺少恢复点')
    // Stale posts projection for a formally published article.
    expect(text).toContain('投影: article #3 正式已发布但 posts.status=\'draft\'')
    // Outbox delivered marker inconsistent with status.
    expect(text).toContain('Outbox: outbox:event:intent:d:1 status=\'pending\' 与 delivered_at 标记不一致')
    // Orphaned intent: event without its intent row + committed prepare without intent.
    expect(text).toContain('意图: event event:intent:e:1 引用不存在的 intent')
    expect(text).toContain('意图: prepare prep:e:1 已 committed 但无意图记录')
  })
})