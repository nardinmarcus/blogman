/**
 * #244 P1 — related recommendations as an independent async server component.
 *
 * Rendered inside a Suspense boundary by the article route so a slow (or
 * hung) recommendation read can never hold the article title/body. The read
 * happens INSIDE this component — never pre-read before the boundary.
 * Password-protected posts render nothing (no body/related leakage on the
 * unauthenticated path).
 */

import Link from 'next/link'
import { formatDate } from '@/lib/public-date'
import type { Database } from '@/lib/db'
import { getRelatedPosts } from '@/lib/related-content'
import type { SiteCategoryLink } from '@/lib/site'

interface RelatedPostsProps {
  db: Database
  env: Partial<CloudflareEnv> | null | undefined
  post: Parameters<typeof getRelatedPosts>[2]
  categories: SiteCategoryLink[]
}

const EMPTY = { strategy: 'fts' as const, source: 'rules' as const, results: [] }

export async function RelatedPosts({ db, env, post, categories }: RelatedPostsProps) {
  if (post.password) return null

  const related = await getRelatedPosts(db, env, post, 3).catch(() => EMPTY)
  if (related.results.length === 0) return null

  const categorySlugMap = new Map(categories.map((category) => [category.name, category.slug]))

  return (
    <section className="mt-14 sm:mt-16 border-t border-[var(--editor-line)] pt-8 sm:pt-10">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold text-[var(--editor-ink)]">继续阅读</h2>
          <p className="text-xs text-[var(--stone-gray)] mt-1">
            {related.source === 'vectorize' ? '基于向量召回' : '基于全文检索与主题相似度'}
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {related.results.map((item) => {
          const itemCategorySlug = item.category ? categorySlugMap.get(item.category) : null
          return (
            <Link
              key={item.slug}
              href={`/${item.slug}`}
              className="group rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)]/55 p-4 transition-colors hover:border-[var(--editor-accent)]/35 hover:bg-[var(--editor-panel)]"
            >
              <div className="text-xs text-[var(--stone-gray)] mb-3 flex items-center gap-2 flex-wrap">
                {item.category && (
                  itemCategorySlug ? (
                    <span className="rounded-full border border-[var(--editor-accent)]/15 bg-[var(--editor-accent)]/8 px-2 py-0.5 text-[var(--editor-accent)]">
                      {item.category}
                    </span>
                  ) : (
                    <span>{item.category}</span>
                  )
                )}
                <time>
                  {formatDate(item.published_at)}
                </time>
              </div>
              <h3 className="text-base font-semibold leading-snug text-[var(--editor-ink)] group-hover:text-[var(--editor-accent)] transition-colors">
                {item.title}
              </h3>
              {item.description && (
                <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-[var(--editor-muted)]">
                  {item.description}
                </p>
              )}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
