import { getPosts, searchPosts, getCategories } from '@/lib/db'
import { listIdentityFacts } from '@/lib/repositories/articles'
import type { PostWithTags } from '@/lib/db'
import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { FileText, PenLine } from 'lucide-react'
import Link from 'next/link'
import { PostListClient } from './PostListClient'
import { FilterBar } from './FilterBar'

export const metadata = { title: '文章管理' }

/** The list read model — a post augmented with its article identity + current version (B2-06). */
export interface AdminListPost extends PostWithTags {
  articleId: number | null
  version: number | null
  /** Canonical B3 fact — true when a formal_publication exists (any lifecycle). */
  formalPublished: boolean | null
  /** Canonical lifecycle ('published' | 'unpublished'), null when never formally published. */
  lifecycle: 'published' | 'unpublished' | null
}

export default async function AdminPostsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; category?: string }>
}) {
  const params = await searchParams
  const { q, status, category } = params

  const env = await getAppCloudflareEnv()
  let sourcePosts: Awaited<ReturnType<typeof getPosts>> = []

  if (env?.DB) {
    try {
      if (q && q.trim()) {
        sourcePosts = await searchPosts(env.DB, q.trim(), 200, true, true, true, true) // includeDrafts, includeEncrypted, includeHidden, includeDeleted
      } else {
        sourcePosts = await getPosts(env.DB, 200, 0, true, true, true, true) // includeDrafts, includeEncrypted, includeHidden, includeDeleted
      }
    } catch (error) {
      rethrowIfDatabaseMigrationRequired(error)
      console.error('Posts fetch error:', error)
    }
  }

  // B2-06 — merge the versioned-authority facts (article id + current version) so
  // every list write action can carry expected version + operation id. Falls back
  // to null facts (legacy direct writes) on a ledger-only DB that lacks identity tables.
  let versionFacts: Map<number, import('@/lib/repositories/articles').PostVersionFact> = new Map()
  if (env?.DB) {
    const facts = await listIdentityFacts(env.DB, sourcePosts.map((p) => p.id))
    versionFacts = facts
  }
  const posts: AdminListPost[] = sourcePosts.map((p) => {
    const fact = versionFacts.get(p.id)
    return {
      ...p,
      articleId: fact?.articleId ?? null,
      version: fact?.version ?? null,
      formalPublished: fact ? fact.formalPublished : null,
      lifecycle: fact?.lifecycle ?? null,
    }
  })

  // 从 categories 表获取正式分类列表（用于 PostRow 下拉菜单）
  let dbCategories: string[] = []
  if (env?.DB) {
    try {
      const cats = await getCategories(env.DB)
      dbCategories = cats.map(c => c.name).filter(n => n !== '未分类')
    } catch (error) {
      rethrowIfDatabaseMigrationRequired(error)
    }
  }

  // 从文章数据提取分类（用于 FilterBar 筛选）
  const postCategories = Array.from(
    new Set(sourcePosts.map((p) => p.category).filter(Boolean))
  ) as string[]

  const stats = {
    // 全部 = 未删除的文章；已删除文章只在「已删除」tab 可见
    all: sourcePosts.filter((p) => p.status !== 'deleted').length,
    published: sourcePosts.filter((p) => p.status === 'published').length,
    draft: sourcePosts.filter((p) => p.status === 'draft').length,
    deleted: sourcePosts.filter((p) => p.status === 'deleted').length,
    encrypted: sourcePosts.filter((p) => !!p.password).length,
    unlisted: sourcePosts.filter((p) => p.is_hidden === 1).length,
    pinned: sourcePosts.filter((p) => p.is_pinned === 1).length,
  }

  let filteredPosts = posts
  if (!status || status === 'all') {
    // 默认视图不展示已删除文章（回收站语义：仅在「已删除」tab 可见）
    filteredPosts = filteredPosts.filter((p) => p.status !== 'deleted')
  } else {
    switch (status) {
      case 'encrypted':
        filteredPosts = filteredPosts.filter((p) => !!p.password)
        break
      case 'unlisted':
        filteredPosts = filteredPosts.filter((p) => p.is_hidden === 1)
        break
      case 'pinned':
        filteredPosts = filteredPosts.filter((p) => p.is_pinned === 1)
        break
      default:
        filteredPosts = filteredPosts.filter((p) => p.status === status)
    }
  }
  if (category && category !== 'all') {
    filteredPosts = filteredPosts.filter((p) => p.category === category)
  }

  return (
    <div>
      <FilterBar
        currentStatus={status}
        currentCategory={category}
        categories={postCategories}
        initialQuery={q}
        counts={stats}
        resultCount={filteredPosts.length}
      />

      {filteredPosts.length === 0 ? (
        <div className="bg-[var(--editor-panel)] rounded-2xl border border-[var(--editor-line)] p-16 text-center">
          <div className="max-w-xs mx-auto">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--editor-soft)] flex items-center justify-center text-[var(--stone-gray)]">
              <FileText className="h-8 w-8" strokeWidth={1.5} />
            </div>
            <p className="text-[var(--editor-muted)] mb-2">
              {q ? '未找到匹配的文章' : '还没有任何文章'}
            </p>
            <p className="text-xs text-[var(--stone-gray)] mb-4">
              {q ? '试试其他关键词' : '开始创作，分享你的思考'}
            </p>
            {!q && (
              <Link
                href="/editor"
                className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--editor-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-105"
              >
                <PenLine className="h-4 w-4" />
                写第一篇文章
              </Link>
            )}
          </div>
        </div>
      ) : (
        <PostListClient posts={filteredPosts} categories={dbCategories} />
      )}
    </div>
  )
}
