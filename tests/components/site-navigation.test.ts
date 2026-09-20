import React, { act, createElement as h, lazy, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { HomeVariantB } from '@/components/themes/HomeVariantB'
import { HomeVariantC } from '@/components/themes/HomeVariantC'
import { HomeClient, type HomeProps } from '@/components/HomeClient'
import { SiteHeader } from '@/components/SiteHeader'
import { SiteNavLink } from '@/components/SiteNavLink'
import { THEME_OPTIONS } from '@/lib/appearance'
import type { SiteNavLink as ConfiguredLink } from '@/lib/site'

const session = vi.hoisted(() => ({ authenticated: false }))
vi.mock('@/lib/admin-session-client', () => ({ useAdminSession: () => session }))
vi.mock('next/dynamic', () => ({
  default: (load: () => Promise<React.ComponentType<HomeProps>>) => lazy(async () => ({ default: await load() })),
}))
// Distinguish the framework adapter without reproducing configured-link policy.
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    h('a', { ...props, 'data-next-link': '' }, children),
}))
vi.mock('@/components/SearchEntry', () => ({ SearchEntry: () => h('button', null, '搜索') }))

let dom: JSDOM
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value)
  session.authenticated = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

const homeProps: HomeProps = { initialTheme: 'default', posts: [], categories: [], navLinks: [], currentPage: 1, totalPages: 1, categorySlugMap: {} }
async function render(node: React.ReactNode) {
  await act(async () => { root.render(h(Suspense, { fallback: 'loading' }, node)) })
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).not.toBe('loading')
  })
}

const cases = [
  { label: 'Archive', url: '/archive?view=all#year', openInNewTab: false, next: true },
  { label: 'Notes', url: '/notes#today', openInNewTab: true, next: false },
  { label: 'GitHub', url: 'https://github.com/example/?tab=repos#top', openInNewTab: false, next: false },
  { label: 'RSS', url: 'http://example.com/feed.xml', openInNewTab: true, next: false },
]
function expectPolicy(anchor: Element, link: ConfiguredLink, next: boolean) {
  expect(anchor.tagName).toBe('A')
  expect(anchor.getAttribute('href')).toBe(link.url)
  expect(anchor.getAttribute('target')).toBe(link.openInNewTab ? '_blank' : null)
  expect(anchor.getAttribute('rel')).toBe(link.openInNewTab ? 'noopener noreferrer' : null)
  expect(anchor.hasAttribute('data-next-link')).toBe(next)
}
async function click(element: Element) {
  // Run React callbacks while keeping jsdom from attempting navigation.
  element.addEventListener('click', event => event.preventDefault(), { once: true })
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
}
function anchors(scope: ParentNode) { return [...scope.querySelectorAll('a')] }

describe('#253 configured navigation', () => {
  it.each([
    ['editorial', HomeVariantB],
    ['terminal', HomeVariantC],
  ] as const)('%s honors internal configured new-tab intent through its real adapter', async (_, Home) => {
    await render(h(Home, { ...homeProps, navLinks: [{ label: 'Archive', url: '/archive?view=all#year', openInNewTab: true }] }))
    const link = host.querySelector('a[href="/archive?view=all#year"]')!
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.hasAttribute('data-next-link')).toBe(false)
  })

  it.each([
    ...cases,
    { label: 'Mail', url: 'mailto:hello@example.com', openInNewTab: false, next: true },
    { label: 'Protocol relative', url: '//example.com/page', openInNewTab: false, next: true },
    { label: 'Uppercase', url: 'HTTPS://example.com/page', openInNewTab: false, next: true },
    { label: 'Existing prefix rule', url: 'http-custom:page', openInNewTab: false, next: false },
  ])('shared interface preserves exact policy for $label', async link => {
    const onClick = vi.fn()
    const onMouseEnter = vi.fn()
    const onMouseLeave = vi.fn()
    await render(h(SiteNavLink, { link, className: 'configured', style: { color: 'red' }, 'aria-label': 'Accessible label', onClick, onMouseEnter, onMouseLeave }, h('span', null, link.label)))
    const anchor = host.firstElementChild as HTMLAnchorElement
    expectPolicy(anchor, link, link.next)
    expect(host.childElementCount).toBe(1)
    expect(anchor.className).toBe('configured')
    expect(anchor.style.color).toBe('red')
    expect(anchor.getAttribute('aria-label')).toBe('Accessible label')
    expect(anchor.firstElementChild?.textContent).toBe(link.label)
    await click(anchor)
    await act(async () => {
      anchor.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
      anchor.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }))
    })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onMouseEnter).toHaveBeenCalledTimes(1)
    expect(onMouseLeave).toHaveBeenCalledTimes(1)
  })

  it.each(cases)('does not accept or forward routing overrides for $label', async link => {
    type Props = React.ComponentProps<typeof SiteNavLink>
    expectTypeOf<Extract<keyof Props, 'href' | 'target' | 'rel'>>().toEqualTypeOf<never>()
    // Also exercise untyped callers: unknown attributes must never reach either adapter.
    const untypedProps = { link, href: '/wrong', target: '_parent', rel: 'opener' }
    await render(h(SiteNavLink, untypedProps, link.label))
    expectPolicy(host.firstElementChild!, link, link.next)
  })

  it.each(THEME_OPTIONS)('$id homepage preserves configured order, labels and policy', async ({ id }) => {
    await render(h(HomeClient, { ...homeProps, initialTheme: id, navLinks: cases }))
    const scopes = id === 'editorial' ? host.querySelectorAll('.editorial-nav-links')
      : id === 'terminal' ? host.querySelectorAll('.terminal-home-nav') : host.querySelectorAll('header nav')
    expect(scopes).toHaveLength(id === 'editorial' || id === 'terminal' ? 1 : 2)
    for (const scope of scopes) {
      const configured = anchors(scope).filter(anchor => cases.some(link => anchor.getAttribute('href') === link.url))
      expect(configured).toHaveLength(cases.length)
      configured.forEach((anchor, i) => {
        expectPolicy(anchor, cases[i], cases[i].next)
        expect(anchor.textContent).toBe(id === 'terminal' ? `~/${cases[i].label.toLowerCase()}` : cases[i].label)
      })
    }
    expect([...host.querySelectorAll('button')].some(button => button.textContent === '搜索')).toBe(true)
  })

  it.each(THEME_OPTIONS)('$id SiteHeader keeps desktop icons, mobile text and close callbacks', async ({ id }) => {
    await render(h(SiteHeader, { initialTheme: id, navLinks: cases }))
    const [desktop, mobile] = host.querySelectorAll('nav')
    for (const scope of [desktop, mobile]) {
      anchors(scope).forEach((anchor, i) => {
        expectPolicy(anchor, cases[i], cases[i].next)
        expect(anchor.getAttribute('aria-label')).toBe(cases[i].label)
        expect(anchor.textContent).toBe(cases[i].label)
      })
      expect(anchors(scope)).toHaveLength(cases.length)
    }
    expect(desktop.querySelectorAll('svg')).toHaveLength(2)
    expect(mobile.querySelector('svg')).toBeNull()
    for (const anchor of anchors(mobile)) {
      await click(host.querySelector('[aria-label="打开菜单"]')!)
      expect(host.querySelector('[aria-label="关闭菜单"]')).not.toBeNull()
      await click(anchor)
      expect(host.querySelector('[aria-label="打开菜单"]')).not.toBeNull()
    }
  })

  it.each(THEME_OPTIONS)('$id keeps its empty-array defaults and ordering', async ({ id }) => {
    await render(h(HomeClient, { ...homeProps, initialTheme: id }))
    const scope = host.querySelector('.editorial-nav-links, .terminal-home-nav, header nav')!
    const expected = id === 'editorial' ? ['首页', 'GitHub', 'Twitter', 'RSS']
      : id === 'terminal' ? ['~/github', '~/twitter', '~/rss'] : ['GitHub', 'RSS']
    expect(anchors(scope).map(anchor => anchor.textContent)).toEqual(expected)
    const defaults = anchors(scope).filter(anchor => anchor.getAttribute('href') !== '/')
    expect(defaults.map(anchor => anchor.getAttribute('href'))).toEqual(
      id === 'editorial' || id === 'terminal'
        ? ['https://github.com/nardinmarcus/', 'https://x.com/nardinmarcus/', '/feed.xml']
        : ['https://github.com/nardinmarcus/', '/feed.xml'],
    )
    defaults.forEach(anchor => {
      const rss = anchor.getAttribute('href') === '/feed.xml'
      expectPolicy(anchor, { label: '', url: anchor.getAttribute('href')!, openInNewTab: !rss }, rss)
    })
  })

  it('SiteHeader uses the same defaults when configuration is absent or empty', async () => {
    await render(h(SiteHeader))
    const before = host.innerHTML
    await render(h(SiteHeader, { navLinks: [] }))
    expect(host.innerHTML).toBe(before)
  })

  it.each(THEME_OPTIONS)('$id keeps authenticated admin entry placement', async ({ id }) => {
    await render(h(HomeClient, { ...homeProps, initialTheme: id, navLinks: cases }))
    expect(host.querySelector('a[href="/admin"]')).toBeNull()
    session.authenticated = true
    await render(h(HomeClient, { ...homeProps, initialTheme: id, navLinks: cases }))
    expect(host.querySelector('footer a[href="/admin"]')).not.toBeNull()
    const header = host.querySelector('header')
    if (id === 'editorial' || id === 'terminal') {
      expect(header).toBeNull()
      expect(host.querySelectorAll('a[href="/admin"]')).toHaveLength(1)
    } else {
      const [desktop, mobile] = header!.querySelectorAll('nav')
      expect(anchors(desktop).at(-1)?.getAttribute('href')).toBe('/admin')
      expect(desktop.lastElementChild?.previousElementSibling?.textContent).toBe('搜索')
      expect(anchors(mobile).at(-1)?.getAttribute('href')).toBe('/admin')
      await click(host.querySelector('[aria-label="打开菜单"]')!)
      await click(mobile.querySelector('a[href="/admin"]')!)
      expect(host.querySelector('[aria-label="打开菜单"]')).not.toBeNull()
    }
  })

  it('keeps category selection and local dropdown/mobile close behavior', async () => {
    await render(h(SiteHeader, { navLinks: cases, categories: [{ name: '技术', slug: 'tech' }], activeCategorySlug: 'tech' }))
    const categoryButton = host.querySelector('button[aria-expanded]')!
    expect(categoryButton.textContent).toBe('技术')
    await click(categoryButton)
    expect(categoryButton.getAttribute('aria-expanded')).toBe('true')
    const [desktop, mobile] = host.querySelectorAll('nav')
    expect(anchors(desktop).slice(0, 2).map(anchor => anchor.textContent)).toEqual(['全部文章', '技术'])
    await click(desktop.querySelector('a[href="/category/tech"]')!)
    expect(categoryButton.getAttribute('aria-expanded')).toBe('false')
    await click(categoryButton)
    await act(async () => { document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })) })
    expect(categoryButton.getAttribute('aria-expanded')).toBe('false')
    await click(host.querySelector('[aria-label="打开菜单"]')!)
    const mobileCategory = host.querySelector('a[href="/category/tech"]')!
    expect(mobile.contains(mobileCategory)).toBe(false)
    await click(mobileCategory)
    expect(host.querySelector('[aria-label="打开菜单"]')).not.toBeNull()
  })

  it('terminal keeps HTTP-only hover even for an internal native new-tab anchor', async () => {
    await render(h(HomeVariantC, { ...homeProps, navLinks: cases }))
    const links = anchors(host.querySelector('.terminal-home-nav')!) as HTMLAnchorElement[]
    for (const [i, anchor] of links.entries()) {
      const http = i >= 2
      expect(anchor.style.transition).toBe(http ? 'color .15s' : '')
      expect(anchor.style.color).toBe('var(--editor-muted)')
      await act(async () => { anchor.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })) })
      expect(anchor.style.color).toBe(http ? 'var(--editor-accent)' : 'var(--editor-muted)')
      await act(async () => { anchor.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true })) })
      expect(anchor.style.color).toBe('var(--editor-muted)')
    }
  })
})
