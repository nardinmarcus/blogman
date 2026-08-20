import type { MetadataRoute } from 'next'
import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { getPublicCategories } from '@/lib/db'
import { listPublicArticles } from '@/lib/public-read'
import { getSiteUrl } from '@/lib/site-config'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getSiteUrl()
  const entries: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'daily', priority: 1 },
  ]

  try {
    const env = await getAppCloudflareEnv()
    if (env?.DB) {
      // Sitemap reads the CANONICAL public surface (live, non-hidden, public)
      // with the canonical first-published time as lastModified.
      const [posts, categories] = await Promise.all([
        listPublicArticles(env.DB, { limit: 1000 }),
        getPublicCategories(env.DB),
      ])
      for (const post of posts) {
        entries.push({
          url: `${baseUrl}/${post.slug}`,
          lastModified: new Date(post.published_at * 1000),
          changeFrequency: 'weekly',
          priority: 0.8,
        })
      }

      for (const category of categories) {
        if (category.slug && category.name !== '未分类') {
          entries.push({
            url: `${baseUrl}/category/${category.slug}`,
            lastModified: new Date(),
            changeFrequency: 'weekly',
            priority: 0.6,
          })
        }
      }
    }
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
  }
  return entries
}
