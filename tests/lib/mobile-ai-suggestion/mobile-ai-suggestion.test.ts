/**
 * B8-03 — mobile local-AI suggestion isolated-D1 fixture (issue #62).
 *
 * One shared in-process Miniflare instance (real D1 binding, zero wrangler CLI
 * spawns) layered on the #38 publication suggestion schema + fixtures. This
 * suite proves the mobile "局部 AI" surface reuses the shared version-bound
 * suggestion protocol:
 *
 *   - 建议生命周期  request records a version-bound `content` suggestion; it
 *     previews pending, applies through the shared write kernel, revokes back,
 *     and ignores without applying;
 *   - 版本漂移过期  when the body moves past the anchored basis the suggestion
 *     becomes `stale` and is never silently applied;
 *   - 冲突不静默重试 the stale/conflict outcome is returned (surfaced), never
 *     retried or auto-applied;
 *   - 应用走内核    apply carries the real expected version into the shared
 *     article-write kernel and increments the revision;
 *   - AI 故障不阻止保存发布 a failed request never touches the article/save path.
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
} from '@/tests/lib/publish-suggestions/helpers'
import {
  requestMobileSuggestion,
  readSuggestionState,
  applySuggestion,
  revokeSuggestion,
  ignoreSuggestion,
  MOBILE_AI_SOURCE_PREFIX,
} from '@/lib/mobile-ai-suggestion'
import { save } from '@/lib/article-commands'
import type { ArticleCommandSnapshot } from '@/lib/article-commands/types'

let state: string
const cleanup: string[] = []

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'blogman-b803-mobile-ai-'))
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
    slug: freshSlug('mobai'),
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

/** Create a formally published article under an ACTIVE revision (rev 1). */
async function formalWithRevision(): Promise<{
  articleId: number
  postRef: number
  slug: string
  revisionId: string
  content: string
  contentSha256: string
}> {
  const formal = await createFormalArticle(freshSlug('r'), '上线文章', '# 正式正文\n\n正文。')
  const content = '# 正式正文\n\n修订后的正文  内容。'
  const res = await save(createDatabase(), {
    articleId: formal.articleId,
    expectedVersion: 1,
    operationId: freshOp('save'),
    snapshot: snapshot({ slug: formal.slug, title: '修订标题', content, html: `<p>${content}</p>`, status: 'published' }),
  })
  if (res.outcome !== 'applied') throw new Error(`save failed: ${JSON.stringify(res)}`)
  const rev = (await query<{ revision_id: string; content_sha256: string }>(
    `SELECT revision_id, content_sha256 FROM publish_revisions
     WHERE article_id = ${formal.articleId} AND status = 'active'`,
  ))[0]
  if (!rev) throw new Error('no active revision')
  return {
    articleId: formal.articleId,
    postRef: formal.postRef,
    slug: formal.slug,
    revisionId: rev.revision_id,
    content,
    contentSha256: rev.content_sha256,
  }
}

async function activeRevisionContent(articleId: number): Promise<string | null> {
  const [row] = await query<{ content: string }>(
    `SELECT content FROM publish_revisions WHERE article_id = ${articleId} AND status = 'active'`,
  )
  return row?.content ?? null
}

describe('request — 建议生命周期 (record → preview → apply → revoke → ignore)', () => {
  it('records a version-bound content suggestion and previews it pending', async () => {
    const art = await formalWithRevision()
    const op = freshOp('req')
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '正文  内容',
      operationId: op,
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('recorded')
    if (req.outcome !== 'recorded') return
    expect(req.field).toBe('content')
    expect(req.boundVersion).toBe(1)
    expect(req.value).toContain('正文 内容')
    expect(req.value).not.toBe(req.before) // a local rewrite, not the unchanged body

    // The shared source marks the mobile origin.
    const [prep] = await query<{ source: string }>(
      `SELECT source FROM publish_preparations WHERE article_id = ${art.articleId}`,
    )
    expect(prep?.source).toBe(`${MOBILE_AI_SOURCE_PREFIX}:${op}`)

    // Preview via the SHARED read model — pending, bound to version 1.
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const contentSug = state.preparations[0].suggestions.find((s) => s.field === 'content')
    expect(contentSug?.status).toBe('pending')
    expect(contentSug?.boundVersion).toBe(1)
  })

  it('replays idempotently on the same operationId (no duplicate record)', async () => {
    const art = await formalWithRevision()
    const op = freshOp('req2')
    const r1 = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId, selectedText: '正文  内容', operationId: op, actor: 'b803-test',
    })
    const r2 = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId, selectedText: '正文  内容', operationId: op, actor: 'b803-test',
    })
    expect(r1.outcome).toBe('recorded')
    expect(r2.outcome).toBe('recorded')
    if (r1.outcome !== 'recorded' || r2.outcome !== 'recorded') return
    expect(r2.preparationId).toBe(r1.preparationId)
    expect(r2.suggestionId).toBe(r1.suggestionId)
    const [n] = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM publish_preparations WHERE article_id = ${art.articleId}`,
    )
    expect(n?.n).toBe(1)
  })

  it('requests nothing when the selected text is not in the current body (unconfirmed edit)', async () => {
    const art = await formalWithRevision()
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '这段文字还没保存到正文',
      operationId: freshOp('req3'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('not-found')
  })

  it('applies the content suggestion through the shared write kernel (应用走内核)', async () => {
    const art = await formalWithRevision()
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '正文  内容',
      operationId: freshOp('req-app'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('recorded')
    if (req.outcome !== 'recorded') return

    const applied = await applySuggestion(createDatabase(), {
      suggestionId: req.suggestionId,
      actor: 'b803-test',
      operationId: freshOp('apply'),
    })
    expect(applied.outcome).toBe('applied')
    if (applied.outcome !== 'applied') return
    expect(applied.field).toBe('content')
    expect(applied.version).toBeGreaterThanOrEqual(2) // expected-version save advanced the revision

    const content = await activeRevisionContent(art.articleId)
    expect(content).toContain('正文 内容') // suggested rewrite landed through the kernel
    expect(content).not.toContain('正文  内容') // the old span is gone

    const after = await readSuggestionState(createDatabase(), art.articleId)
    expect(after.preparations[0].suggestions.find((s) => s.field === 'content')?.status).toBe('applied')
  })

  it('revokes an applied content suggestion back to the anchored body (撤销)', async () => {
    const art = await formalWithRevision()
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '正文  内容',
      operationId: freshOp('req-rev'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('recorded')
    if (req.outcome !== 'recorded') return
    await applySuggestion(createDatabase(), {
      suggestionId: req.suggestionId, actor: 'b803-test', operationId: freshOp('apply-rev'),
    })
    const revoked = await revokeSuggestion(createDatabase(), {
      suggestionId: req.suggestionId, actor: 'b803-test', operationId: freshOp('revoke'),
    })
    expect(revoked.outcome).toBe('revoked')
    const content = await activeRevisionContent(art.articleId)
    expect(content).toBe(art.content) // reverted to the exact anchored body
  })

  it('ignores a pending content suggestion and cannot apply it afterwards (忽略)', async () => {
    const art = await formalWithRevision()
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '正文  内容',
      operationId: freshOp('req-ign'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('recorded')
    if (req.outcome !== 'recorded') return
    const ignored = await ignoreSuggestion(createDatabase(), {
      suggestionId: req.suggestionId, actor: 'b803-test',
    })
    expect(ignored.outcome).toBe('ignored')
    const later = await applySuggestion(createDatabase(), {
      suggestionId: req.suggestionId, actor: 'b803-test', operationId: freshOp('apply-ign'),
    })
    expect(later.outcome).toBe('ignored') // not applied
    const content = await activeRevisionContent(art.articleId)
    expect(content).toBe(art.content) // untouched
  })
})

describe('版本漂移过期 — body change expires the suggestion (never silently applied)', () => {
  it('marks a content suggestion stale after the body moves past its basis', async () => {
    const art = await formalWithRevision()
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '正文  内容',
      operationId: freshOp('req-stale'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('recorded')
    if (req.outcome !== 'recorded') return

    // Author rewrites the body (advances the revision + changes the hash) —
    // the suggestion anchored to the OLD basis can then never be applied.
    const author = await save(createDatabase(), {
      articleId: art.articleId,
      expectedVersion: 1,
      operationId: freshOp('author'),
      snapshot: snapshot({ slug: art.slug, title: '作者重写', content: '# 全新\n\n完全重写。', html: '<p>完全重写。</p>', status: 'published' }),
    })
    expect(author.outcome).toBe('applied')

    const result = await applySuggestion(createDatabase(), {
      suggestionId: req.suggestionId,
      actor: 'b803-test',
      operationId: freshOp('apply-stale'),
    })
    expect(result.outcome).toBe('stale')
    if (result.outcome !== 'stale') return
    expect(result.reason).toBe('stale-content')

    // Not silently applied — the author's rewrite is intact.
    const content = await activeRevisionContent(art.articleId)
    expect(content).toContain('完全重写')
    expect(content).not.toContain('修订后的正文')
  })

  it('previews a drifted suggestion as stale (read model reports reality)', async () => {
    const art = await formalWithRevision()
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '正文  内容',
      operationId: freshOp('req-drift'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('recorded')
    if (req.outcome !== 'recorded') return
    await save(createDatabase(), {
      articleId: art.articleId,
      expectedVersion: 1,
      operationId: freshOp('author2'),
      snapshot: snapshot({ slug: art.slug, title: '作者重写', content: '# 全新\n\n完全重写。', html: '<p>完全重写。</p>', status: 'published' }),
    })
    const state = await readSuggestionState(createDatabase(), art.articleId)
    const contentSug = state.preparations[0].suggestions.find((s) => s.field === 'content')
    expect(contentSug?.status).toBe('stale')
  })
})

describe('AI 失败不阻止保存发布 — a failed request never touches the article', () => {
  it('returns an invalid outcome for a missing article without throwing or writing', async () => {
    const req = await requestMobileSuggestion(createDatabase(), {
      articleId: 999999,
      selectedText: '任意文本',
      operationId: freshOp('req-fail'),
      actor: 'b803-test',
    })
    expect(req.outcome).toBe('no-current-state')
    // No suggestion state was created for the failed request.
    const [n] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM publish_preparations WHERE article_id = 999999`)
    expect(n?.n).toBe(0)
  })

  it('an article with a failed request can still be saved (save/publish unaffected)', async () => {
    const art = await createDraftArticle(freshSlug('survive'), '幸存', '# 正文\n\n原正文。')
    await requestMobileSuggestion(createDatabase(), {
      articleId: art.articleId,
      selectedText: '本文写坏了请重写',
      operationId: freshOp('req-survive'),
      actor: 'b803-test',
    })
    // The save path still works normally.
    const res = await save(createDatabase(), {
      articleId: art.articleId,
      expectedVersion: 1,
      operationId: freshOp('save-survive'),
      snapshot: snapshot({ slug: art.slug, title: '幸存', content: '# 新正文\n\n可以发布。', html: '<p>可以发布。</p>', status: 'draft' }),
    })
    expect(res.outcome).toBe('applied')
  })
})
