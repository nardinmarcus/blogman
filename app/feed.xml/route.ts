import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { listPublicArticles } from '@/lib/public-read'
import { getSiteUrl } from '@/lib/site-config'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'

const SITE_URL = getSiteUrl()
const SITE_TITLE = 'Namoo'
const SITE_DESCRIPTION = 'Namoo 的数字花园 — 记录思考，分享所学。'

interface RssPost {
  slug: string
  title: string
  description: string | null
  html: string | null
  category: string | null
  published_at: number
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function GET() {
  let posts: RssPost[] = []

  try {
    const env = await getAppCloudflareEnv()
    if (env?.DB) {
      // RSS reads the CANONICAL public surface (lifecycle published, public,
      // non-hidden) and the frozen version body — not the legacy posts row.
      const canonical = await listPublicArticles(env.DB, { limit: 50 })
      posts = canonical.map((p) => ({
        slug: p.slug,
        title: p.title,
        description: p.description,
        html: p.html,
        category: p.category,
        published_at: p.published_at,
      }))
    }
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
    // ignore
  }

  const items = posts
    .map((p) => {
      const pubDate = new Date(p.published_at * 1000).toUTCString()
      return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${SITE_URL}/${p.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/${p.slug}</guid>
      <description>${escapeXml(p.description || '')}</description>
      <content:encoded><![CDATA[${p.html || ''}]]></content:encoded>
      <category>${escapeXml(p.category || '未分类')}</category>
      <pubDate>${pubDate}</pubDate>
    </item>`
    })
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${SITE_TITLE}</title>
    <link>${SITE_URL}</link>
    <description>${SITE_DESCRIPTION}</description>
    <language>zh-CN</language>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
