'use client'

// Variant C: AI 终端 — dark-first, monospace, terminal aesthetic

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { SiteFooter } from '@/components/SiteFooter'
import { SearchEntry } from '@/components/SearchEntry'
import { Pagination } from '@/components/Pagination'
import { ThemeDropdown } from '@/components/ThemeDropdown'
import type { HomeProps } from '@/components/HomeClient'
import type { SiteNavLink } from '@/lib/site'

const BG = '#1a1c2e'
const FG = '#c8d3e8'
const MUTED = '#5a6480'
const BORDER = '#2a2f48'
const ACCENT = '#4ade80'   // terminal green
const ACCENT2 = '#fbbf24'  // amber

function formatDateCompact(ts: number) {
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function TerminalHeader({
  initialTheme,
  navLinks,
}: {
  initialTheme: HomeProps['initialTheme']
  navLinks: SiteNavLink[]
}) {
  const defaultLinks = [
    { label: '~/github', url: 'https://github.com/nardinmarcus/', openInNewTab: true },
    { label: '~/twitter', url: 'https://x.com/nardinmarcus/', openInNewTab: true },
    { label: '~/rss', url: '/feed.xml', openInNewTab: false },
  ]
  const links = navLinks.length > 0
    ? navLinks.map(l => ({ ...l, label: `~/${l.label.toLowerCase()}` }))
    : defaultLinks

  return (
    <div className="terminal-home-header" style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderBottom: `1px dashed ${BORDER}`,
      paddingBottom: 16,
      fontSize: 12,
      color: MUTED,
    }}>
      {/* Left: terminal prompt */}
      <div className="terminal-home-prompt" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: ACCENT, display: 'inline-block', boxShadow: `0 0 10px ${ACCENT}` }} />
        <Link href="/" style={{ color: MUTED, textDecoration: 'none' }}>namoo@blog:~$</Link>
        <span style={{ color: FG }}>./serve --port=443</span>
      </div>

      {/* Right: nav + theme + search */}
      <div className="terminal-home-nav" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        {links.map(link => (
          link.url.startsWith('http') ? (
            <a
              key={link.label}
              href={link.url}
              target={link.openInNewTab ? '_blank' : undefined}
              rel={link.openInNewTab ? 'noopener noreferrer' : undefined}
              style={{ color: MUTED, textDecoration: 'none', transition: 'color .15s' }}
              onMouseEnter={e => (e.currentTarget.style.color = ACCENT)}
              onMouseLeave={e => (e.currentTarget.style.color = MUTED)}
            >
              {link.label}
            </a>
          ) : (
            <Link key={link.label} href={link.url} style={{ color: MUTED, textDecoration: 'none' }}>
              {link.label}
            </Link>
          )
        ))}

        {/* Theme dropdown — terminal style, self-contained */}
        <ThemeDropdown
          initialTheme={initialTheme}
          buttonStyle={{ color: MUTED, fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 12 }}
          dropdownStyle={{
            background: BG,
            border: `1px solid ${BORDER}`,
            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            boxShadow: `0 8px 24px rgba(0,0,0,0.4)`,
          }}
          itemStyle={{ color: FG, fontSize: 12 }}
          activeItemStyle={{ background: ACCENT, color: '#0f1117' }}
        />

        {/* Search */}
        <div style={{ color: MUTED }}>
          <SearchEntry />
        </div>
      </div>
    </div>
  )
}

export function HomeVariantC({
  initialTheme,
  posts,
  navLinks,
  currentPage,
  totalPages,
}: HomeProps) {
  const [query, setQuery] = useState('')
  const [cursorOn, setCursorOn] = useState(true)
  const [typed, setTyped] = useState('')
  const [hoverId, setHoverId] = useState<string | null>(null)
  const fullText = '独立 · AI · 产品 · 思考'

  useEffect(() => {
    const iv = setInterval(() => setCursorOn(c => !c), 530)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    let i = 0
    const iv = setInterval(() => {
      i++
      setTyped(fullText.slice(0, i))
      if (i >= fullText.length) clearInterval(iv)
    }, 80)
    return () => clearInterval(iv)
  }, [fullText])

  const filtered = query
    ? posts.filter(p =>
        p.title.includes(query) ||
        (p.category ?? '').includes(query) ||
        (p.description ?? '').includes(query)
      )
    : posts

  const catSet = new Set(posts.map(p => p.category).filter(Boolean))

  return (
    <div className="theme-home-terminal" style={{
      background: BG,
      color: FG,
      minHeight: '100vh',
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, "PingFang SC", monospace',
      backgroundImage: `radial-gradient(circle at 20% 0%, rgba(74,222,128,0.06) 0%, transparent 50%), radial-gradient(circle at 80% 100%, rgba(251,191,36,0.05) 0%, transparent 50%)`,
      position: 'relative',
    }}>
      {/* Scanline overlay */}
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: `repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0, rgba(255,255,255,0.012) 1px, transparent 1px, transparent 3px)`,
        pointerEvents: 'none',
        zIndex: 0,
      }} />

      <div className="terminal-home-shell" style={{ maxWidth: 860, margin: '0 auto', padding: '32px 40px 0', position: 'relative', zIndex: 1 }}>
        <TerminalHeader initialTheme={initialTheme} navLinks={navLinks} />

        {/* ASCII-style banner */}
        <div style={{ marginTop: 36, marginBottom: 28 }}>
          <div style={{
            fontSize: 11,
            lineHeight: 1.2,
            color: ACCENT,
            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            whiteSpace: 'pre',
            overflow: 'hidden',
          }}>
{`  ┌────────────────────────────────────┐
  │  NAMOO BLOG  ·  Namoo Blog          │
  │  ~/posts  —  reading the future     │
  └────────────────────────────────────┘`}
          </div>
          <div className="terminal-banner-meta" style={{ marginTop: 14, fontSize: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: ACCENT2 }}>&gt;</span>
            <span style={{ color: FG }}>Namoo Blog</span>
            <span style={{ color: MUTED }}>{'//'}</span>
            <span style={{ color: MUTED }}>
              {typed}
              <span style={{ opacity: cursorOn ? 1 : 0, color: ACCENT }}>▊</span>
            </span>
          </div>
        </div>

        {/* Stats grid */}
        <div className="terminal-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 28, fontSize: 11 }}>
          {[
            { k: 'POSTS', v: posts.length, c: ACCENT },
            { k: 'CATEGORIES', v: catSet.size, c: ACCENT2 },
            { k: 'UPTIME', v: '99.9%', c: ACCENT },
          ].map(s => (
            <div key={s.k} style={{
              border: `1px solid ${BORDER}`,
              padding: '10px 14px',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div style={{ color: MUTED, fontSize: 10, letterSpacing: '0.1em' }}>[{s.k}]</div>
              <div style={{ color: s.c, fontSize: 20, fontWeight: 600, marginTop: 4 }}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* Grep search */}
        <div className="terminal-grep-bar" style={{
          border: `1px solid ${BORDER}`,
          padding: '10px 14px',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(255,255,255,0.02)',
        }}>
          <span style={{ color: ACCENT, fontSize: 13 }}>$</span>
          <span style={{ color: MUTED, fontSize: 13 }}>grep -r</span>
          <input
            className="terminal-grep-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder='"关键词" ./posts/'
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: FG,
              fontSize: 13,
              fontFamily: 'inherit',
              caretColor: ACCENT,
            }}
          />
          <span style={{ color: MUTED, fontSize: 11 }}>{filtered.length} match</span>
        </div>

        {/* Directory listing header */}
        <div className="terminal-list-header" style={{
          fontSize: 11,
          color: MUTED,
          marginBottom: 6,
          display: 'grid',
          gridTemplateColumns: '110px 90px 1fr',
          gap: 14,
          padding: '0 10px',
        }}>
          <span>DATE</span>
          <span>CATEGORY</span>
          <span>TITLE</span>
        </div>

        {/* Post rows */}
        <div style={{ borderTop: `1px dashed ${BORDER}`, borderBottom: `1px dashed ${BORDER}` }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '32px 10px', color: MUTED, fontSize: 13 }}>
              {'// '}no matches for &quot;{query}&quot;
            </div>
          ) : (
            filtered.map((post, i) => (
              <Link
                key={post.slug}
                href={`/${post.slug}`}
                className="terminal-post-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 90px 1fr',
                  gap: 14,
                  padding: '14px 10px',
                  borderTop: i > 0 ? `1px dotted ${BORDER}` : 'none',
                  alignItems: 'baseline',
                  textDecoration: 'none',
                  transition: 'background .15s',
                  background: hoverId === post.slug ? 'rgba(74,222,128,0.05)' : 'transparent',
                }}
                onMouseEnter={() => setHoverId(post.slug)}
                onMouseLeave={() => setHoverId(null)}
              >
                <span className="terminal-post-date" style={{ color: MUTED, fontSize: 12 }}>
                  {formatDateCompact(post.published_at)}
                </span>
                <span className="terminal-post-category" style={{ color: ACCENT2, fontSize: 11 }}>
                  [{post.category || 'misc'}]
                </span>
                <div className="terminal-post-body">
                  <div className="terminal-post-title" style={{
                    color: hoverId === post.slug ? ACCENT : FG,
                    fontSize: 15,
                    fontWeight: 500,
                    fontFamily: '"PingFang SC", "JetBrains Mono", sans-serif',
                    transition: 'color .15s',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    {post.is_pinned === 1 && (
                      <span style={{ color: ACCENT2, fontSize: 10, letterSpacing: '0.05em' }}>★</span>
                    )}
                    {post.title}
                    {post.password && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: MUTED, flexShrink: 0 }}>
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                      </svg>
                    )}
                  </div>
                  {post.description && (
                    <div style={{
                      color: MUTED,
                      fontSize: 12,
                      marginTop: 4,
                      fontFamily: '"PingFang SC", sans-serif',
                      lineHeight: 1.6,
                      display: '-webkit-box',
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>
                      {'// '}{post.description}
                    </div>
                  )}
                </div>
              </Link>
            ))
          )}
        </div>

        {/* Terminal footer prompt */}
        <div style={{ padding: '24px 0 16px', fontSize: 12, color: MUTED }}>
          <div>{'$ echo "感谢阅读，保持思考。"'}</div>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: ACCENT }}>▊</span>
            <span style={{ color: MUTED }}>exit 0</span>
          </div>
        </div>

        <div style={{ paddingBottom: 80 }}>
          <Pagination currentPage={currentPage} totalPages={totalPages} basePath="/" />
        </div>
      </div>

      {/* Standard footer with admin entry */}
      <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 16 }}>
        <SiteFooter />
      </div>
    </div>
  )
}
