'use client'

import Link from 'next/link'
import { useState, useRef, useEffect } from 'react'
import { Menu, X, ChevronDown, Rss } from 'lucide-react'
import { SearchEntry } from './SearchEntry'
import { useAdminSession } from '@/lib/admin-session-client'
import type { Theme } from '@/lib/appearance'
import { getThemeDefinition } from '@/lib/themes'
import type { SiteCategoryLink, SiteNavLink } from '@/lib/site'

export type NavLink = SiteNavLink

interface SiteHeaderProps {
  navLinks?: NavLink[]
  categories?: SiteCategoryLink[]
  activeCategorySlug?: string | null
  stickyOnMobile?: boolean
  initialTheme?: Theme
}

const defaultNavLinks: NavLink[] = [
  { label: 'GitHub', url: 'https://github.com/nardinmarcus/', openInNewTab: true },
  { label: 'RSS', url: '/feed.xml', openInNewTab: false },
]

// 头部导航统一容器：图标按钮 36px 热区 + hover 底色 + focus 环
const iconBtnClass =
  'inline-flex size-9 items-center justify-center rounded-md text-[var(--editor-muted)] transition-colors duration-150 hover:bg-[var(--editor-panel)] hover:text-[var(--editor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]/60'
const textBtnClass =
  'inline-flex h-9 items-center rounded-md px-2.5 text-[var(--editor-muted)] transition-colors duration-150 hover:bg-[var(--editor-panel)] hover:text-[var(--editor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]/60'

// lucide 1.43 已移除品牌图标：GitHub 用 lucide 旧版描边 octocat，RSS 直接用 lucide Rss；
// X 无官方描边版，用官方字形不加粗，三者同为轻量级
type LinkIconComponent = (props: { className?: string }) => React.ReactNode

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}

function XLogoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  )
}

// 按 label / url 识别常见站点链接，返回对应图标；未识别则返回 null（回退为文字）
function getLinkIcon(link: NavLink): LinkIconComponent | null {
  if (/github/i.test(link.label) || /github\.com/i.test(link.url)) return GithubIcon
  if (/\bx\.com/i.test(link.url) || /twitter\.com/i.test(link.url) || /^x(\s*\(|$)/i.test(link.label)) {
    return XLogoIcon
  }
  if (
    /rss/i.test(link.label) ||
    /feed\.(xml|json|atom)(\?.*)?$/i.test(link.url) ||
    /\/(feed|rss)(\/|$)/i.test(link.url)
  ) {
    return Rss
  }
  return null
}

function getIssueInfo() {
  const now = new Date()
  return { vol: now.getFullYear() - 2023, month: now.getMonth() + 1, year: now.getFullYear() }
}

export function SiteHeader({
  navLinks,
  categories = [],
  activeCategorySlug = null,
  stickyOnMobile = true,
  initialTheme = 'default',
}: SiteHeaderProps) {
  const links = navLinks && navLinks.length > 0 ? navLinks : defaultNavLinks
  const { authenticated: isAdmin } = useAdminSession()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const categoryRef = useRef<HTMLDivElement>(null)
  const headerStyle = getThemeDefinition(initialTheme).header

  // 点击外部关闭分类下拉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setCategoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  const activeCategory = categories.find(c => c.slug === activeCategorySlug)

  const renderLink = (link: NavLink, onClick?: () => void, iconOnly = false) => {
    const Icon = iconOnly ? getLinkIcon(link) : null
    const className = Icon
      ? iconBtnClass
      : 'text-[var(--editor-muted)] hover:text-[var(--editor-ink)] transition-colors duration-150'
    const content = Icon ? (
      <span className="inline-flex items-center" title={link.label}>
        <Icon className="w-[18px] h-[18px]" />
        <span className="sr-only">{link.label}</span>
      </span>
    ) : link.label

    if (link.openInNewTab || link.url.startsWith('http')) {
      return (
        <a
          key={link.label}
          href={link.url}
          target={link.openInNewTab ? '_blank' : undefined}
          rel={link.openInNewTab ? 'noopener noreferrer' : undefined}
          className={className}
          aria-label={link.label}
          onClick={onClick}
        >
          {content}
        </a>
      )
    }

    return (
      <Link
        key={link.label}
        href={link.url}
        className={className}
        aria-label={link.label}
        onClick={onClick}
      >
        {content}
      </Link>
    )
  }

  // 终端主题：logo 区域显示终端提示符
  const renderLogo = () => {
    if (headerStyle === 'terminal') {
      return (
        <Link
          href="/"
          className="flex items-center gap-2 flex-shrink-0 text-[var(--editor-muted)] hover:text-[var(--editor-ink)] transition-colors duration-200"
          style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13 }}
          suppressHydrationWarning
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--editor-accent)', display: 'inline-block', boxShadow: '0 0 8px var(--editor-accent)', flexShrink: 0 }} />
          <span style={{ color: 'var(--editor-muted)' }}>namoo@blog:~$</span>
          <span style={{ color: 'var(--editor-ink)' }}>./home</span>
        </Link>
      )
    }

    if (headerStyle === 'editorial') {
      const { vol, month, year } = getIssueInfo()
      return (
        <div className="flex items-baseline gap-4 flex-shrink-0" suppressHydrationWarning>
          <Link
            href="/"
            className="text-lg tracking-tight text-[var(--editor-ink)] hover:text-[var(--editor-accent)] transition-colors duration-200 font-bold"
            style={{ fontFamily: 'var(--logo-font, "Noto Serif SC", Georgia, serif)' }}
          >
            Namoo
          </Link>
          <span style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 11, letterSpacing: '0.15em', color: 'var(--editor-muted)' }}>
            VOL.{vol} · {year}年{month}月
          </span>
        </div>
      )
    }

    return (
      <Link
        href="/"
        className="text-lg tracking-tight text-[var(--editor-ink)] hover:text-[var(--editor-accent)] transition-colors duration-200 flex-shrink-0 font-bold"
        style={{ fontFamily: 'var(--logo-font, Georgia, "Noto Serif SC", serif)' }}
      >
        Namoo
      </Link>
    )
  }

  return (
    <header className={`site-header ${stickyOnMobile ? 'sticky' : 'sm:sticky'} top-0 z-40 border-b border-[var(--editor-line)] bg-[var(--background)]/95 backdrop-blur-sm`}>
      <div className="site-header-inner mx-auto max-w-3xl px-4 sm:px-6">
        <div className="h-14 flex items-center justify-between gap-4">
          {renderLogo()}

          {/* Desktop nav：三组语义分组 —— 站内导航 │ 站外链接 │ 全局功能+管理 */}
          <nav className="hidden sm:flex items-center gap-1.5 text-sm flex-shrink-0">
            {/* Category dropdown */}
            {categories.length > 0 && (
              <div ref={categoryRef} className="relative">
                <button
                  onClick={() => setCategoryOpen(!categoryOpen)}
                  aria-expanded={categoryOpen}
                  className={`inline-flex h-9 items-center gap-1 rounded-md px-2.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]/60 ${
                    activeCategorySlug
                      ? 'bg-[var(--editor-accent)]/5 text-[var(--editor-accent)]'
                      : categoryOpen
                        ? 'bg-[var(--editor-panel)] text-[var(--editor-ink)]'
                        : 'text-[var(--editor-muted)] hover:bg-[var(--editor-panel)] hover:text-[var(--editor-ink)]'
                  }`}
                >
                  {activeCategory?.name || '分类'}
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-150 ${categoryOpen ? 'rotate-180' : ''}`} />
                </button>

                {categoryOpen && (
                  <div className="absolute top-full left-0 mt-2 min-w-[140px] rounded-lg border border-[var(--editor-line)] bg-[var(--background)] shadow-lg py-1 z-50">
                    <Link
                      href="/"
                      onClick={() => setCategoryOpen(false)}
                      className={`block px-3 py-2 text-sm transition-colors ${
                        activeCategorySlug === null
                          ? 'text-[var(--editor-accent)] bg-[var(--editor-accent)]/5 font-medium'
                          : 'text-[var(--editor-muted)] hover:text-[var(--editor-ink)] hover:bg-[var(--editor-panel)]'
                      }`}
                    >
                      全部文章
                    </Link>
                    {categories.map(cat => (
                      <Link
                        key={cat.slug}
                        href={`/category/${cat.slug}`}
                        onClick={() => setCategoryOpen(false)}
                        className={`block px-3 py-2 text-sm transition-colors ${
                          activeCategorySlug === cat.slug
                            ? 'text-[var(--editor-accent)] bg-[var(--editor-accent)]/5 font-medium'
                            : 'text-[var(--editor-muted)] hover:text-[var(--editor-ink)] hover:bg-[var(--editor-panel)]'
                        }`}
                      >
                        {cat.name}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}

            {categories.length > 0 && links.length > 0 && (
              <span aria-hidden="true" className="h-3.5 w-px bg-[var(--editor-muted)] opacity-30" />
            )}
            {links.map(link => renderLink(link, undefined, true))}
            {links.length > 0 && (
              <span aria-hidden="true" className="h-3.5 w-px bg-[var(--editor-muted)] opacity-30" />
            )}
            <SearchEntry />
            {isAdmin && (
              <Link href="/admin" className={textBtnClass}>
                管理
              </Link>
            )}
          </nav>

          {/* Mobile: search icon + hamburger */}
          <div className="sm:hidden flex items-center gap-1">
            <SearchEntry />
            <button
              className="inline-flex size-9 items-center justify-center rounded-md text-[var(--editor-muted)] transition-colors hover:bg-[var(--editor-panel)] hover:text-[var(--editor-ink)]"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'}
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile dropdown menu */}
      <div
        className={`
          sm:hidden transition-all duration-300 ease-in-out
          ${mobileMenuOpen ? 'max-h-[70vh] overflow-visible border-t border-[var(--editor-line)]' : 'max-h-0 overflow-hidden'}
        `}
      >
        <div className="bg-[var(--background)]">
          {/* Mobile categories as horizontal pills */}
          {categories.length > 0 && (
            <div className="px-4 py-3 border-b border-[var(--editor-line)]">
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/"
                  onClick={() => setMobileMenuOpen(false)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeCategorySlug === null
                      ? 'bg-[var(--editor-accent)] text-[var(--editor-accent-ink)]'
                      : 'bg-[var(--editor-panel)] text-[var(--editor-muted)]'
                  }`}
                >
                  全部
                </Link>
                {categories.map((category) => (
                  <Link
                    key={category.slug}
                    href={`/category/${category.slug}`}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeCategorySlug === category.slug
                        ? 'bg-[var(--editor-accent)] text-[var(--editor-accent-ink)]'
                        : 'bg-[var(--editor-panel)] text-[var(--editor-muted)]'
                    }`}
                  >
                    {category.name}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <nav className="flex flex-col text-sm">
            {links.map(link => (
              <div key={link.label} className="px-4 py-3 border-b border-[var(--editor-line)]">
                {renderLink(link, () => setMobileMenuOpen(false))}
              </div>
            ))}
            {isAdmin && (
              <div className="px-4 py-3 border-b border-[var(--editor-line)]">
                <Link
                  href="/admin"
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[var(--editor-muted)] hover:text-[var(--editor-ink)] transition-colors duration-150"
                >
                  管理
                </Link>
              </div>
            )}
          </nav>
        </div>
      </div>
    </header>
  )
}
