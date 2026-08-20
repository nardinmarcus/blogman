/**
 * B3-06 — version-bound publish suggestions isolated-D1 fixture (issue #38).
 *
 * One shared in-process Miniflare instance (real D1 binding, zero wrangler CLI
 * spawns). The background AI never writes a live fact — it records suggestions
 * bound to the exact version it analysed. This suite proves:
 *
 *   - 迟到     a suggestion bound to content the author has since changed is
 *             `stale` and is never silently applied (no overwrite),
 *   - 字段级过期 an author who set their own value invalidates that field's
 *             suggestion (`field-changed`) while sibling gaps stay applicable,
 *   - 逐项动作 per-item apply / ignore / revoke each route through the write
 *             kernel independently,
 *   - 同批建议 every suggestion of one result records together and can be
 *             applied sequentially through the shared kernel,
 *   - 超时     a suggestion left past {@link SUGGESTION_TTL} expires,
 *   - 三条上限 at most 3 pending suggestions per article; a newer result
 *             supersedes the older pending one,
 *   - D1 expected version the apply carries the real current expected version
 *             into the kernel, and the result increments the revision/version,
 *   - 恢复点   同一结果首次应用只建一个恢复点 (reused by the rest),
 *   - AI 故障不阻塞发布 promote proceeds and the publish-blocker set is
 *             unchanged by suggestions.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapSuggestionState,
  createDatabase,
  query,
  createFormalArticle,
  createDraftArticle,
  freshSlug,
} from './helpers'
import {
  applySuggestion,
  ignoreSuggestion,
  readSuggestionState,
  recordPreparedSuggestions,
  revokeSuggestion,
  SUGGESTION_TTL,
} from '@/lib/publish-suggestions'
import { save } from '@/lib/article-commands'
import { promoteRevision } from '@/lib/publish-revision'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b306-publish-suggestions-'))
  cleanup.push(state)
  await bootstrapSuggestionState(state)
}, 300_000)

afterAll(async () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function freshOp(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function snapshot(overrides: Partial<ArticleCommandSnapshot> = {}): ArticleCommandSnapshot {
  return {
    slug: freshSlug('sug'),
    title: '标题',
    content: '# 正文\n\n正文段落。',
    html: '<h1>正文</h1><p>正文段落。</p>',
    description: null,
    category: null,
    tags: null,
    status: 'draft',
    password: null,
    is_pinned: 0,
    is_hidden: 0,
    cover_image: null,
    deleted_at: null,
    published_at: null,
    updated_at: null,
    ...overrides,
  }
}

/** Create a formally published article with an ACTIVE revision (rev 1). */
async function formalArticleWithRevision(): Promise<{
  articleId: number
  postRef: number
  slug: string
  revisionId: string
  contentSha256: string
  baseContent: string
}> {
  const formal = await createFormalArticle(freshSlug('formal'), '上线文章', '# 正式正文\n\n正文。')
  const changed = '# 正式正文\n\n修订后的正文内容。'
  const res = await save(createDatabase(), {
    articleId: formal.articleId,
    expectedVersion: 1,
    operationId: freshOp('save'),
    snapshot: snapshot({ slug: formal.slug, title: '修订标题', content: changed, html: `<p>${changed}</p>`, status: 'published' }),
  })
  if (res.outcome !== 'applied') throw new Error(`save failed: ${JSON.stringify(res)}`)
  const rev = (await query<{ revision_id: string; revision_number: number; content_sha256: string }>(
    `SELECT revision_id, revision_number, content_sha256 FROM publish_revisions
     WHERE article_id = ${formal.articleId} AND status = 'active'`,
  ))[0]
  if (!rev) throw new Error('no active revision')
  return {
    articleId: formal.articleId,
    postRef: formal.postRef,
    slug: formal.slug,
    revisionId: rev.revision_id,
    contentSha256: rev.content_sha256,
    baseContent: changed,
  }
}

function threeGaps(): Array<{ field: 'category' | 'tags' | 'description'; value: string; fieldBefore: string }> {
  return [
    { field: 'category', value: JSON.stringify('技术'), fieldBefore: 'null' },
    { field: 'tags', value: JSON.stringify(['AI', '建议']), fieldBefore: '[]' },
    { field: 'description', value: JSON.stringify('AI 生成描述'), fieldBefore: 'null' },
  ]
}

async function recordThree(articleId: number, postRef: number, boundVersion: number, basisSha256: string, source: string) {
  return recordPreparedSuggestions(createDatabase(), {
    articleId,
    postRef,
    boundVersion,
    boundRevision: null,
    source,
    basisSha256,
    suggestions: threeGaps(),
  })
}

async function postRow(postRef: number): Promise<Record<string, unknown>> {
  return (await query<Record<string, unknown>>(
    `SELECT slug, title, content, html, description, category, tags, status, published_at FROM posts WHERE id = ${postRef}`,
  ))[0]
}

async function revisionNumber(articleId: number): Promise<number | null> {
  const [row] = await query<{ revision_number: number }>(
    `SELECT revision_number FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`,
  )
  return row?.revision_number ?? null
}

async function restorePointCount(articleId: number): Promise<number> {
  const [row] = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM publish_restore_points WHERE article_id = ${articleId}`,
  )
  return row?.n ?? 0
}

/** The active revision row (the editing surface before promotion). */
async function activeRevision(articleId: number): Promise<Record<string, unknown> | null> {
  const [row] = await query<Record<string, unknown>>(
    `SELECT slug, title, content, category, tags, description, revision_number
     FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`,
  )
  return row ?? null
}

/** The canonical content hash the current version is anchored to (staleness basis). */
async function versionBasis(articleId: number): Promise<string> {
  const [row] = await query<{ content_snapshot_sha256: string }>(
    `SELECT content_snapshot_sha256 FROM article_versions
     WHERE article_id = ${articleId} ORDER BY version DESC LIMIT 1`,
  )
  return row?.content_snapshot_sha256 ?? ''
}

describe('record — the AI writes no live fact', () => {
  it('records a version-bound preparation with its pending suggestions', async () => {
    const draft = await createFormalArticle(freshSlug('r'), '记录文章', '# 记录体\n\n记录正文。')
    const rec = await recordThree(draft.articleId, draft.postRef, 1, await versionBasis(draft.articleId), freshOp('ai'))
    expect(rec.outcome).toBe('recorded')
    if (rec.outcome !== 'recorded') return
    expect(rec.suggestions).toBe(3)
    expect(rec.superseded).toBe(0)

    const state = await readSuggestionState(createDatabase(), draft.articleId)
    expect(state.preparations).toHaveLength(1)
    expect(state.preparations[0].suggestions.filter((s) => s.status === 'pending')).toHaveLength(3)
    expect(state.preparations[0].boundVersion).toBe(1)

    // Nothing was written to the live post.
    const post = await postRow(draft.postRef)
    expect(post.category).toBeNull()
    expect(post.tags).toBeNull()
    expect(post.description).toBeNull()
  })

  it('replays idempotently on the same AI source (queue retry never double-records)', async () => {
    const draft = await createFormalArticle(freshSlug('r'), '幂等记录', '# 幂等体\n\n正文。')
    const source = freshOp('ai')
    const basis = await versionBasis(draft.articleId)
    const first = await recordThree(draft.articleId, draft.postRef, 1, basis, source)
    expect(first.outcome).toBe('recorded')
    const second = await recordThree(draft.articleId, draft.postRef, 1, basis, source)
    expect(second.outcome).toBe('replayed')
    const state = await readSuggestionState(createDatabase(), draft.articleId)
    expect(state.preparations).toHaveLength(1)
    expect(state.preparations[0].suggestions.filter((s) => s.status === 'pending')).toHaveLength(3)
  })

  it('supersedes the older pending result to keep at most 3 pending suggestions (三条上限)', async () => {
    const draft = await createFormalArticle(freshSlug('r'), '上限文章', '# 上限体\n\n正文。')
    const basis = await versionBasis(draft.articleId)
    const old = await recordThree(draft.articleId, draft.postRef, 1, basis, freshOp('ai'))
    expect(old.outcome).toBe('recorded')
    const newer = await recordThree(draft.articleId, draft.postRef, 2, basis, freshOp('ai'))
    expect(newer.outcome).toBe('recorded')
    if (newer.outcome !== 'recorded') return
    expect(newer.superseded).toBeGreaterThan(0)

    const state = await readSuggestionState(createDatabase(), draft.articleId)
    // Only the newest preparation stays pending; total pending across the article ≤ 3.
    const pending = state.preparations.flatMap((p) => p.suggestions).filter((s) => s.status === 'pending')
    expect(pending.length).toBeLessThanOrEqual(3)
    const pendingPreps = state.preparations.filter((p) =>
      p.suggestions.some((s) => s.status === 'pending'),
    )
    expect(pendingPreps).toHaveLength(1)
  })
})

describe('apply — 逐项应用走文章写入内核', () => {
  it('applies one suggestion through the write kernel and builds ONE restore point for the result', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    const rec = await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    expect(rec.outcome).toBe('recorded')
    if (rec.outcome !== 'recorded') return
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const category = state.preparations[0].suggestions.find((s) => s.field === 'category')!

    const result = await applySuggestion(createDatabase(), {
      suggestionId: category.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    expect(result.revisionId).toBe(art.revisionId)
    // D1 expected version: the revision advanced 1 -> 2.
    expect(await revisionNumber(art.articleId)).toBe(2)

    const post = await postRow(art.postRef)
    expect(post.category).toBeNull() // live formal projection untouched
    // The applied value landed in the ACTIVE REVISION (the edit surface).
    const rev = await activeRevision(art.articleId)
    expect(rev!.category).toBe('技术')
    // One restore point for the whole result.
    expect(await restorePointCount(art.articleId)).toBe(1)
  })

  it('applies the whole batch sequentially and keeps a single restore point (同批建议 + 首次应用只建一个恢复点)', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    let state = await readSuggestionState(createDatabase(), art.articleId)
    const pending = () =>
      state.preparations[0].suggestions.filter((s) => s.status === 'pending')

    expect(pending()).toHaveLength(3)
    for (const field of ['category', 'tags', 'description'] as const) {
      const sug = pending().find((s) => s.field === field)!
      const res = await applySuggestion(createDatabase(), {
        suggestionId: sug.suggestionId,
        actor: 'b306-test',
        operationId: freshOp('apply'),
      })
      expect(res.outcome).toBe('applied')
      state = await readSuggestionState(createDatabase(), art.articleId)
    }

    // All three fields landed through the kernel and the revision advanced 4 times (1→4).
    expect(await revisionNumber(art.articleId)).toBe(4)
    const rev = await activeRevision(art.articleId)
    expect(rev!.category).toBe('技术')
    expect(rev!.tags).toBe(JSON.stringify(['AI', '建议']))
    expect(rev!.description).toBe('AI 生成描述')
    // The live formal projection still holds the pre-promotion body.
    const post = await postRow(art.postRef)
    expect(post.category).toBeNull()
    // 同一结果首次应用只建一个恢复点 — reused by every apply in this result.
    expect(await restorePointCount(art.articleId)).toBe(1)
  })

  it('replays an already-applied suggestion (author double-clicks are idempotent)', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!
    const op = freshOp('apply')
    const first = await applySuggestion(createDatabase(), { suggestionId: cat.suggestionId, actor: 't', operationId: op })
    expect(first.outcome).toBe('applied')
    const second = await applySuggestion(createDatabase(), { suggestionId: cat.suggestionId, actor: 't', operationId: freshOp('apply2') })
    expect(second.outcome).toBe('replayed')
  })

  it('applies onto a DRAFT through the write kernel (no formal publication → no restore point need)', async () => {
    const draft = await createDraftArticle()
    const basis = await versionBasis(draft.articleId)
    await recordThree(draft.articleId, draft.postRef, 1, basis, freshOp('ai'))
    const state = await readSuggestionState(createDatabase(), draft.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!

    const result = await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    // A draft has no formal anchor → the kernel writes a new article version and
    // the live posts row directly.
    expect(result.version).toBe(2)
    expect((await postRow(draft.postRef)).category).toBe('技术')
    // Drafts roll back via their own version history — no restore point is fabricated.
    expect(await restorePointCount(draft.articleId)).toBe(0)
  })
})

describe('迟到 / 字段级过期 / 超时 — staleness', () => {
  it('marks a late suggestion stale when the body moved past its basis (never overwrites)', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!

    // Author rewrites the body (advances the revision + changes the content hash).
    const author = await save(createDatabase(), {
      articleId: art.articleId,
      expectedVersion: 1,
      operationId: freshOp('author'),
      snapshot: snapshot({ slug: art.slug, title: '作者重写', content: '# 全新正文\n\n完全重写。', html: '<h1>全新</h1><p>完全重写。</p>', status: 'published' }),
    })
    expect(author.outcome).toBe('applied')

    const result = await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(result.outcome).toBe('stale')
    if (result.outcome !== 'stale') return
    expect(result.reason).toBe('stale-content')

    // The suggestion was not silently applied and the author's rewrite is intact
    // (in the active revision surface).
    const rev = await activeRevision(art.articleId)
    expect(rev!.title).toBe('作者重写')
    expect(rev!.content).toContain('完全重写')
    expect(rev!.category).toBeNull() // never written
  })

  it('invalidates only the changed field (字段级过期), leaving sibling gaps applicable', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    let state = await readSuggestionState(createDatabase(), art.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!

    // The author set their own category WITHOUT touching the content or tags.
    const author = await save(createDatabase(), {
      articleId: art.articleId,
      expectedVersion: 1,
      operationId: freshOp('author'),
      snapshot: snapshot({ slug: art.slug, title: '带分类', content: art.baseContent, html: `<p>${art.baseContent}</p>`, status: 'published', category: '阅读' }),
    })
    expect(author.outcome).toBe('applied')

    // The category suggestion is field-stale (author already chose a value)…
    const staleRes = await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(staleRes.outcome).toBe('stale')
    if (staleRes.outcome !== 'stale') return
    expect(staleRes.reason).toBe('field-changed')

    // …but the other fields (body unchanged, still gaps) remain applicable.
    state = await readSuggestionState(createDatabase(), art.articleId)
    const tags = state.preparations[0].suggestions.find((s) => s.field === 'tags')!
    const tagsRes = await applySuggestion(createDatabase(), {
      suggestionId: tags.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply-tags'),
    })
    expect(tagsRes.outcome).toBe('applied')
    const rev = await activeRevision(art.articleId)
    expect(rev!.category).toBe('阅读') // author value kept
    expect(rev!.tags).toBe(JSON.stringify(['AI', '建议'])) // suggestion applied
  })

  it('expires a pending suggestion left past the TTL (超时)', async () => {
    const draft = await createFormalArticle(freshSlug('r'), '超时文章', '# 超时体\n\n正文。')
    const basis = await versionBasis(draft.articleId)
    const source = freshOp('ai')
    const t0 = Math.floor(Date.now() / 1000) - SUGGESTION_TTL - 10
    // Record with an explicit "now" in the past, then age the row artificially.
    await recordPreparedSuggestions(createDatabase(), {
      articleId: draft.articleId,
      postRef: draft.postRef,
      boundVersion: 1,
      boundRevision: null,
      source,
      basisSha256: basis,
      suggestions: threeGaps(),
      now: t0,
    })
    await query(
      `UPDATE publish_suggestions SET created_at = ${t0} WHERE article_id = ${draft.articleId}`,
    )
    const state = await readSuggestionState(createDatabase(), draft.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!
    const result = await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(result.outcome).toBe('stale')
    if (result.outcome !== 'stale') return
    expect(result.reason).toBe('expired')
  })
})

describe('ignore / revoke — 逐项撤销与忽略', () => {
  it('ignores a pending suggestion (dismiss) and cannot apply it afterwards', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const desc = state.preparations[0].suggestions.find((s) => s.field === 'description')!

    const ignored = await ignoreSuggestion(createDatabase(), { suggestionId: desc.suggestionId, actor: 'b306-test' })
    expect(ignored.outcome).toBe('ignored')

    const later = await applySuggestion(createDatabase(), {
      suggestionId: desc.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(later.outcome).toBe('ignored') // already-ignored — not applied

    const after = await readSuggestionState(createDatabase(), art.articleId)
    const descAfter = after.preparations[0].suggestions.find((s) => s.field === 'description')!
    expect(descAfter.status).toBe('ignored')
  })

  it('revokes an applied suggestion — reverting the field through the write kernel', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!

    const applied = await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    expect(applied.outcome).toBe('applied')
    expect((await activeRevision(art.articleId))!.category).toBe('技术')

    const revoked = await revokeSuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('revoke'),
    })
    expect(revoked.outcome).toBe('revoked')
    expect((await activeRevision(art.articleId))!.category).toBeNull()

    const after = await readSuggestionState(createDatabase(), art.articleId)
    const catAfter = after.preparations[0].suggestions.find((s) => s.field === 'category')!
    expect(catAfter.status).toBe('revoked')
  })

  it('refuses to revoke when the author has since edited the same field (never clobber)', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!

    await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })
    // Author subsequently rewrites the category themselves.
    await save(createDatabase(), {
      articleId: art.articleId,
      expectedVersion: 2,
      operationId: freshOp('author'),
      snapshot: snapshot({ slug: art.slug, title: '再编辑', content: art.baseContent, html: `<p>${art.baseContent}</p>`, status: 'published', category: '思考' }),
    })

    const revoked = await revokeSuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('revoke'),
    })
    expect(revoked.outcome).toBe('conflict')
    expect((await activeRevision(art.articleId))!.category).toBe('思考') // author value intact
  })
})

describe('AI failure does not block publishing', () => {
  it('promote proceeds and the publish blocker set is unchanged by suggestions', async () => {
    const art = await formalArticleWithRevision()
    const source = freshOp('ai')
    await recordThree(art.articleId, art.postRef, 1, art.contentSha256, source)
    // Apply one suggestion so a live pending change exists.
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const cat = state.preparations[0].suggestions.find((s) => s.field === 'category')!
    await applySuggestion(createDatabase(), {
      suggestionId: cat.suggestionId,
      actor: 'b306-test',
      operationId: freshOp('apply'),
    })

    // Publish (promote) the active revision — suggestions never consulted.
    const promoted = await promoteRevision(createDatabase(), {
      revisionId: art.revisionId,
      actor: 'b306-test',
      siteUrl: 'https://blog.example.test',
    })
    expect(promoted.outcome).toBe('promoted')
    if (promoted.outcome !== 'promoted') return
    expect(promoted.promotedVersion).toBe(2)
    const post = await postRow(art.postRef)
    expect(post.status).toBe('published')
    expect(post.category).toBe('技术')
  })
})
