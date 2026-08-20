/**
 * B5-01 — WeChat-adapted projection (issue #46).
 *
 * Pure, framework-free projection that turns ONE frozen formal-version
 * snapshot (`ArticleIdentitySnapshot` parsed from the immutable
 * `article_versions` row) into the WeChat public-account draft body:
 *
 *   - HTML      — canonical envelope HTML, passed through the same WeChat
 *                 export normalization used by the in-site clipboard export
 *                 (editor-only breaks stripped, empty paragraphs canonical),
 *                 then wrapped in the shared `wechat-export` fragment,
 *   - plaintext — the envelope's plain-text projection (what the WeChat
 *                 digest editor receives when the富文本 is unavailable),
 *   - cover     — the frozen snapshot's cover, resolved to an absolute URL;
 *                 missing cover falls back to the deterministic default cover,
 *   - digest    — the frozen description, or the leading plaintext, capped at
 *                 the WeChat digest limit,
 *   - sourceUrl — the formal public URL bound to the frozen version.
 *
 * Deterministic: identical frozen snapshot + site URL ⇒ identical bytes, so
 * the projection digest is a stable tamper-evident identity for the task row.
 */

import { renderHtml, plainText } from '@/lib/content-envelope'
import { normalizeWechatExportHtml } from '@/lib/wechat-export-style'
import { trimWechatDigest } from '@/lib/wechat-publish-defaults'
import { resolvePostCoverImage } from '@/lib/default-cover-images'
import type { ArticleIdentitySnapshot } from '@/lib/article-identity'
import type { WechatDraftProjection } from './types'

const FALLBACK_TITLE = '无标题'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Best-effort plain text from raw stored HTML when no canonical envelope exists. */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * WeChat export fragment wrapper — the same structural shell the in-site
 * clipboard export uses, so a derived draft pastes into the WeChat editor
 * exactly like a manually exported article.
 */
export function wrapWechatExportFragment(title: string, contentHtml: string): string {
  const normalizedTitle = title.trim() || FALLBACK_TITLE
  return [
    '<section class="wechat-export-root">',
    '<article class="wechat-export-article">',
    `<p class="wechat-export-title">${escapeHtml(normalizedTitle)}</p>`,
    `<div class="wechat-export-content">${contentHtml}</div>`,
    '</article>',
    '</section>',
  ].join('')
}

export interface WechatProjectionSettings {
  /** 交付前设置覆盖标题（为空/未传 → 使用冻结快照标题）。 */
  title?: string
  /** 交付前设置覆盖摘要（为空/未传 → 使用快照 description / 正文首段）。 */
  digest?: string
  /** 交付前设置覆盖封面（为空/未传 → 使用快照封面或默认封面）。 */
  coverImageUrl?: string
}

export interface ProjectWechatDraftOptions {
  sourceUrl: string
  siteUrl?: string
  /** B5-03 — 交付前设置修订（与正文版本/代次分离）。 */
  settings?: WechatProjectionSettings
}

/** Build the WeChat-adapted projection from a frozen version snapshot. */
export function projectWechatDraft(
  snapshot: ArticleIdentitySnapshot,
  options: ProjectWechatDraftOptions,
): WechatDraftProjection {
  const title = (options.settings?.title ?? snapshot.fields.title ?? '').trim() || FALLBACK_TITLE

  let bodyHtml: string
  let plain: string
  if (snapshot.envelope) {
    bodyHtml = normalizeWechatExportHtml(renderHtml(snapshot.envelope))
    plain = plainText(snapshot.envelope)
  } else {
    // Fidelity-error fallback: project the verbatim stored bodies as-is.
    bodyHtml = normalizeWechatExportHtml(snapshot.original_html || '')
    plain = (snapshot.original_content || '').trim() || stripHtmlToText(snapshot.original_html || '')
  }

  const description = (snapshot.fields.description ?? '').trim()
  const digest = (options.settings?.digest || '').trim()
    ? (options.settings?.digest || '').trim()
    : description || plain.trim() || title
  const coverImageUrl = (options.settings?.coverImageUrl || '').trim()
    ? (options.settings?.coverImageUrl || '').trim()
    : resolvePostCoverImage(
        {
          slug: snapshot.fields.slug,
          title: snapshot.fields.title,
          cover_image: snapshot.fields.cover_image,
        },
        { baseUrl: options.siteUrl },
      )

  return {
    title,
    html: wrapWechatExportFragment(title, bodyHtml),
    plaintext: plain,
    coverImageUrl,
    digest: trimWechatDigest(digest),
    sourceUrl: options.sourceUrl,
  }
}