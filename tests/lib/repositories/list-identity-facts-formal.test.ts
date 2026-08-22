/**
 * fix-publish-button — admin list read model surfaces canonical B3 facts.
 *
 * Proves the分流 input the admin list relies on: `listIdentityFacts` reports
 * `formalPublished` / `lifecycle` from formal_publications (never from the
 * version snapshot status), stays fault-tolerant on a ledger-only DB, and
 * tracks the real first-publish → unpublish lifecycle.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapState,
  createDatabase,
  query,
  teardownState,
  createDraftArticle,
} from '@/tests/lib/first-publish/helpers'
import { ensureFirstPublishTables } from '@/lib/first-publish/ddl'
import { ensureArticleLifecycleTables, unpublish } from '@/lib/article-lifecycle'
import { listIdentityFacts } from '@/lib/repositories/articles'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-fix-publish-facts-'))
  cleanup.push(state)
  await bootstrapState(state)
  const db = createDatabase()
  await ensureFirstPublishTables(db)
  await ensureArticleLifecycleTables(db)
}, 300_000)

afterAll(async () => {
  await teardownState()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function fresh(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

describe('listIdentityFacts — formal publication facts for the admin list', { timeout: 600_000 }, () => {
  it('从未正式发布 → formalPublished=false；first-publish confirm 后 → true/published；unpublish 后 → true/unpublished', async () => {
    const db = createDatabase()
    const article = await createDraftArticle(fresh('facts-slug'), '事实标题', '事实正文')

    // Before any formal publication: snapshot status may say published (B2 temp
    // command) but the canonical fact must stay false — this is the exact
    // production bug surface.
    const before = (await listIdentityFacts(db, [article.postRef])).get(article.postRef)
    expect(before).toMatchObject({ articleId: article.articleId, formalPublished: false, lifecycle: null })

    // Drive a real first publish (prepare → confirm) through the kernel route.
    const hashRow = (
      await query<{ content_snapshot_sha256: string }>(
        `SELECT content_snapshot_sha256 FROM article_versions WHERE article_id = ${article.articleId} AND version = 1`,
      )
    )[0]
    const { preparePublish, confirmPublish } = await import('@/lib/first-publish')
    const prepared = await preparePublish(db, {
      prepareId: fresh('prepare'),
      articleId: article.articleId,
      confirmedVersion: 1,
      slug: article.slug,
      title: '事实标题',
      contentSha256: hashRow.content_snapshot_sha256,
      actor: 'fix-publish-fixture',
      siteUrl: 'https://blog.example.test',
    })
    expect(prepared.outcome).toBe('prepared')
    const confirmed = await confirmPublish(db, {
      intentId: fresh('intent'),
      prepareId: (prepared as { prepareId: string }).prepareId,
      articleId: article.articleId,
      expectedVersion: 1,
      actor: 'fix-publish-fixture',
      siteUrl: 'https://blog.example.test',
      afterCommit: async () => {},
    })
    expect(confirmed.outcome).toBe('delivered')

    const published = (await listIdentityFacts(db, [article.postRef])).get(article.postRef)
    expect(published).toMatchObject({ formalPublished: true, lifecycle: 'published' })

    // Lifecycle command (admin「转为草稿」path) flips lifecycle, keeps formalPublished.
    const up = await unpublish(db, {
      articleId: article.articleId,
      expectedVersion: 1,
      operationId: fresh('op'),
    })
    expect(up.outcome).toBe('applied')
    const after = (await listIdentityFacts(db, [article.postRef])).get(article.postRef)
    expect(after).toMatchObject({ formalPublished: true, lifecycle: 'unpublished' })
  })

  it('ledger-only 库（无身份/发布表）→ 空 Map，不抛错（列表旧直写回退不受影响）', async () => {
    const bare = {
      prepare: () => {
        throw new Error('no such table: articles')
      },
    } as unknown as Parameters<typeof listIdentityFacts>[0]
    const facts = await listIdentityFacts(bare, [1, 2, 3])
    expect(facts.size).toBe(0)
  })
})
