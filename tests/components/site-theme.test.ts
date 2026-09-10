import React, { act, createElement as h, lazy, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeClient, type HomeProps } from '@/components/HomeClient'
import { SiteHeader } from '@/components/SiteHeader'
import { ThemeManager } from '@/app/admin/(protected)/settings/ThemeManager'
import { THEME_OPTIONS } from '@/lib/appearance'

vi.mock('next/dynamic', () => ({
  default: (load: () => Promise<React.ComponentType<HomeProps>>) =>
    lazy(async () => ({ default: await load() })),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.PropsWithChildren<{ href: string }>) => h('a', props, children) }))
vi.mock('@/components/SearchEntry', () => ({ SearchEntry: () => h('button', null, '搜索') }))
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => h('footer') }))

let dom: JSDOM
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', runScripts: 'outside-only' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value)
  window.localStorage.setItem('blogman_site_theme', 'terminal')
  document.documentElement.setAttribute('data-theme', 'terminal')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

const props: HomeProps = { initialTheme: 'default', posts: [], categories: [], navLinks: [], currentPage: 1, totalPages: 1, categorySlugMap: {} }
async function render(node: React.ReactNode) {
  await act(async () => { root.render(h(Suspense, { fallback: 'loading' }, node)) })
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(host.textContent).not.toBe('loading')
  })
}
function expectNoThemeControl() {
  expect([...host.querySelectorAll('button')].some(button => button.textContent?.includes('主题'))).toBe(false)
  expect(host.textContent).toContain('搜索')
}

describe('#247 owner-controlled site theme', () => {
  it.each(THEME_OPTIONS)('renders $id without visitor controls or stored overrides', async ({ id }) => {
    await render(h(HomeClient, { ...props, initialTheme: id }))
    expectNoThemeControl()
    expect(Boolean(host.querySelector('.theme-home-editorial'))).toBe(id === 'editorial')
    expect(Boolean(host.querySelector('.theme-home-terminal'))).toBe(id === 'terminal')
    const before = host.innerHTML
    await act(async () => window.dispatchEvent(new dom.window.CustomEvent('blogman-theme-change', { detail: { theme: 'editorial' } })))
    expect(host.innerHTML).toBe(before)
  })

  it.each(THEME_OPTIONS)('keeps $id desktop and mobile navigation without a theme picker', async ({ id }) => {
    await render(h(SiteHeader, { initialTheme: id }))
    expectNoThemeControl()
    expect(host.textContent?.includes('namoo@blog:~$')).toBe(id === 'terminal')
    await act(async () => { (host.querySelector('[aria-label="打开菜单"]') as HTMLButtonElement).click() })
    expect(host.querySelector('[aria-label="关闭菜单"]')).not.toBeNull()
    expectNoThemeControl()
    expect(host.querySelector('a[href="/feed.xml"]')).not.toBeNull()
  })

  it('updates the homepage when server-provided theme changes', async () => {
    await render(h(HomeClient, { ...props, initialTheme: 'editorial' }))
    expect(host.querySelector('.theme-home-editorial')).not.toBeNull()
    await render(h(HomeClient, { ...props, initialTheme: 'default' }))
    expect(host.querySelector('.theme-home-editorial')).toBeNull()
    expect(host.querySelector('.theme-home-terminal')).toBeNull()
  })

  it('bootstrap leaves the server theme intact despite old local storage', () => {
    const layout = readFileSync('app/layout.tsx', 'utf8')
    expect(layout).toContain("data-theme={defaultTheme !== 'default' ? defaultTheme : undefined}")
    const script = layout.match(/const appearanceApplyScript = `([\s\S]*?)`/)![1]
      .replace('${JSON.stringify(FONT_CONFIG)}', '{}')
      .replace("${bodyFont || ''}", '')
    for (const { id } of THEME_OPTIONS) {
      if (id === 'default') document.documentElement.removeAttribute('data-theme')
      else document.documentElement.setAttribute('data-theme', id)
      dom.window.eval(script)
      expect(document.documentElement.getAttribute('data-theme')).toBe(id === 'default' ? null : id)
    }
  })

  it('retains all admin choices and saves the selected theme', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await render(h(ThemeManager, { initialTheme: 'default', initialFont: 'default', onSave }))
    expect(host.querySelectorAll('input[name="default-theme"]')).toHaveLength(THEME_OPTIONS.length)
    await act(async () => { (host.querySelector('input[value="editorial"]') as HTMLInputElement).click() })
    expect(onSave).toHaveBeenCalledWith({ theme: 'editorial', font: 'default' }, expect.objectContaining({ undoValues: { theme: 'default', font: 'default' } }))
  })
})
