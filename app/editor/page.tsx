import { getPostBySlug } from '@/lib/db'
import { getByPostRef, listVersions } from '@/lib/repositories/articles'
import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { isAdminAuthenticated, COOKIE_NAME } from '@/lib/admin-auth'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { NovelEditorClient } from '@/components/NovelEditorClient'
import { MobileEditorClientEntry } from '@/components/MobileEditorClientEntry'
import { isMobileUserAgent, wantsDesktop } from '@/lib/mobile-edit/is-mobile'

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; slug?: string; new?: string; desktop?: string }>
}) {
  // 鉴权：只有登录的管理员才能访问编辑器
  const cookieStore = await cookies()
  const cookieValue = cookieStore.get(COOKIE_NAME)?.value
  const isAuthenticated = await isAdminAuthenticated(cookieValue)

  if (!isAuthenticated) {
    const params = await searchParams
    const editSlug = params.edit ?? params.slug
    const editParam = editSlug ? `?edit=${editSlug}` : params.new === '1' ? '?new=1' : ''
    redirect(`/admin/login?redirect_to=${encodeURIComponent(`/editor${editParam}`)}`)
  }

  const params = await searchParams
  const edit = params.edit ?? params.slug
  const isNew = params.new === '1'

  // B8-02 — mobile small-edit surface. A mobile UA gets the lightweight
  // editor (title/paragraph/inline marks; complex blocks read-only + desktop
  // handoff). `?desktop=1` forces the full editor for the desktop handoff link.
  const headerList = await headers()
  const isMobile = isMobileUserAgent(headerList.get('user-agent')) && !wantsDesktop(params.desktop)

  let initialData: {
    slug: string
    title: string
    html: string
    category?: string
    status?: 'draft' | 'published' | 'deleted'
    password?: string | null
    is_hidden?: number
    tags?: string[]
    description?: string | null
    cover_image?: string | null
    published_at?: number | null
    /** B2-02 article identity — null for pre-backfill legacy posts (legacy write path). */
    articleId?: number | null
    /** Latest server-confirmed version — null when no identity exists yet. */
    version?: number | null
  } | undefined

  if (edit) {
    const env = await getAppCloudflareEnv()
    if (env?.DB) {
      const post = await getPostBySlug(env.DB, edit)
      if (post) {
        initialData = {
          slug: post.slug,
          title: post.title,
          html: post.html,
          category: post.category || undefined,
          status: post.status,
          password: post.password,
          is_hidden: post.is_hidden,
          tags: post.tags,
          description: post.description,
          cover_image: post.cover_image,
          published_at: post.published_at,
        }
        // B2-02: resolve the article identity + latest version so the editor can
        // drive versioned save (expected version + operation id) against the kernel.
        const identity = await getByPostRef(env.DB, post.id)
        if (identity) {
          const versions = await listVersions(env.DB, identity.id)
          const latest = versions[0] // newest first
          initialData.articleId = identity.id
          initialData.version = latest?.version ?? null
        }
        // B3-02 (issue #34): when a pending revision is ACTIVE the editor edits
        // THAT snapshot (never the live formal projection) and its revision number
        // is the version token; the live article stays online until promotion.
        // Skipped when the revision table is absent (pre-B3-02 DB).
        let activeRevision: {
          revision_id: string
          base_version: number
          revision_number: number
          slug: string
          title: string
          content: string
          html: string
          description: string | null
          category: string | null
          tags: string | null
          password: string | null
          is_pinned: number
          is_hidden: number
          cover_image: string | null
        } | null = null
        try {
          activeRevision = await env.DB
            .prepare(
              `SELECT revision_id, base_version, revision_number, slug, title, content,
                      html, description, category, tags, password, is_pinned, is_hidden, cover_image
               FROM publish_revisions WHERE article_id = ? AND status = 'active'
               ORDER BY id DESC LIMIT 1`,
            )
            .bind(identity?.id ?? 0)
            .first<{
              revision_id: string
              base_version: number
              revision_number: number
              slug: string
              title: string
              content: string
              html: string
              description: string | null
              category: string | null
              tags: string | null
              password: string | null
              is_pinned: number
              is_hidden: number
              cover_image: string | null
            }>()
        } catch {
          activeRevision = null
        }
        if (activeRevision) {
          let tags: string[] = []
          try {
            const parsed = JSON.parse(activeRevision.tags ?? '[]')
            tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
          } catch {
            tags = []
          }
          initialData = {
            slug: activeRevision.slug,
            title: activeRevision.title,
            html: activeRevision.html,
            category: activeRevision.category ?? undefined,
            status: 'published',
            password: activeRevision.password,
            is_hidden: activeRevision.is_hidden,
            tags,
            description: activeRevision.description,
            cover_image: activeRevision.cover_image,
            published_at: null,
            articleId: identity?.id ?? null,
            version: activeRevision.revision_number,
          }
        }
      }
    }
  }

  if (isMobile) {
    return <MobileEditorClientEntry initialData={initialData} skipDraftRestore={isNew} />
  }

  return <NovelEditorClient initialData={initialData} skipDraftRestore={isNew} />
}
