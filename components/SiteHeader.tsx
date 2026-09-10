'use client'

import Link from 'next/link'
import { useState, useRef, useEffect } from 'react'
import { Menu, X, ChevronDown, Rss } from 'lucide-react'
import { SearchEntry } from './SearchEntry'
import type { Theme } from '@/lib/appearance'
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

// lucide 已移除品牌图标，GitHub 使用官方 mark 的内联 SVG
type LinkIconComponent = (props: { className?: string }) => React.ReactNode

function GithubMarkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

// 按 label / url 识别常见站点链接，返回对应图标；未识别则返回 null（回退为文字）
function getLinkIcon(link: NavLink): LinkIconComponent | null {
  if (/github/i.test(link.label) || /github\.com/i.test(link.url)) return GithubMarkIcon
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const categoryRef = useRef<HTMLDivElement>(null)
  const theme = initialTheme

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
    const className = "text-[var(--editor-muted)] hover:text-[var(--editor-ink)] transition-colors duration-150"
    const Icon = iconOnly ? getLinkIcon(link) : null
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
    if (theme === 'terminal') {
      return (
        <Link
          href="/"
          className="flex items-center gap-2 flex-shrink-0 text-[var(--editor-muted)] hover:text-[var(--editor-ink)] transition-colors duration-200"
          style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13 }}
          suppressHydrationWarning
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80', display: 'inline-block', boxShadow: '0 0 8px #4ade80', flexShrink: 0 }} />
          <span style={{ color: 'var(--editor-muted)' }}>namoo@blog:~$</span>
          <span style={{ color: 'var(--editor-ink)' }}>./home</span>
        </Link>
      )
    }

    if (theme === 'editorial') {
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

          {/* Desktop nav */}
          <nav className="hidden sm:flex items-center gap-3 text-sm flex-shrink-0">
            {/* Category dropdown */}
            {categories.length > 0 && (
              <div ref={categoryRef} className="relative">
                <button
                  onClick={() => setCategoryOpen(!categoryOpen)}
                  className={`inline-flex items-center gap-1 transition-colors duration-150 ${
                    activeCategorySlug
                      ? 'text-[var(--editor-accent)]'
                      : 'text-[var(--editor-muted)] hover:text-[var(--editor-ink)]'
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

            {links.map(link => renderLink(link, undefined, true))}
            <SearchEntry />
          </nav>

          {/* Mobile: search icon + hamburger */}
          <div className="sm:hidden flex items-center gap-1">
            <SearchEntry />
            <button
              className="p-2 text-[var(--editor-muted)] hover:text-[var(--editor-ink)] transition-colors"
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
                      ? 'bg-[var(--editor-accent)] text-white'
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
                        ? 'bg-[var(--editor-accent)] text-white'
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
          </nav>
        </div>
      </div>
    </header>
  )
}
