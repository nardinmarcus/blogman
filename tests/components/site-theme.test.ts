import React, { act, createElement as h, lazy, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeClient, type HomeProps } from '@/components/HomeClient'
import { SiteHeader } from '@/components/SiteHeader'
import { ThemeManager } from '@/app/admin/(protected)/settings/ThemeManager'
import { SettingsManager } from '@/app/admin/(protected)/settings/SettingsManager'
import { detectRuntimeCapabilities } from '@/lib/runtime-capabilities'
import { THEME_OPTIONS } from '@/lib/appearance'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('next/dynamic', () => ({
  default: (load: () => Promise<React.ComponentType<HomeProps>>) =>
    lazy(async () => ({ default: await load() })),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.PropsWithChildren<{ href: string }>) => h('a', props, children) }))
vi.mock('@/components/SearchEntry', () => ({ SearchEntry: () => h('button', null, '搜索') }))
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => h('footer') }))
vi.mock('@/components/Toast', () => ({ useToast: () => toast }))
vi.mock('@/app/admin/(protected)/settings/RuntimeStatusStrip', () => ({ RuntimeStatusStrip: () => null }))
vi.mock('@/app/admin/(protected)/settings/NavLinksEditor', () => ({ NavLinksEditor: () => null }))
vi.mock('@/app/admin/(protected)/settings/CustomJsEditor', () => ({ CustomJsEditor: () => null }))
vi.mock('@/app/admin/(protected)/settings/ThirdPartyPublishingManager', () => ({ ThirdPartyPublishingManager: () => null }))
vi.mock('@/app/admin/(protected)/settings/ModelsSettings', () => ({ ModelsSettings: () => null }))
vi.mock('@/app/admin/(protected)/settings/PromptsSettings', () => ({ PromptsSettings: () => null }))

let dom: JSDOM
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', runScripts: 'outside-only' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value)
  window.localStorage.setItem('blogman_site_theme', 'terminal')
  document.documentElement.setAttribute('data-theme', 'terminal')
  toast.success.mockClear()
  toast.error.mockClear()
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
    expect(Boolean(host.querySelector('.theme-home-refined'))).toBe(id === 'refined' || id === 'porcelain' || id === 'mist')
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
    expect(layout).toContain("data-theme={defaultTheme}")
    const script = layout.match(/const appearanceApplyScript = `([\s\S]*?)`/)![1]
      .replace('${JSON.stringify(FONT_CONFIG)}', '{}')
      .replace("${bodyFont || ''}", '')
    for (const { id } of THEME_OPTIONS) {
      document.documentElement.setAttribute('data-theme', id)
      dom.window.eval(script)
      expect(document.documentElement.getAttribute('data-theme')).toBe(id)
    }
  })

  it('retains all admin choices and saves theme and body font independently', async () => {
    const onSaveTheme = vi.fn().mockResolvedValue(undefined)
    const onSaveFont = vi.fn().mockResolvedValue(undefined)
    await render(h(ThemeManager, { initialTheme: 'default', initialFont: 'default', onSaveTheme, onSaveFont }))
    expect(host.querySelectorAll('input[name="default-theme"]')).toHaveLength(THEME_OPTIONS.length)

    await act(async () => { (host.querySelector('input[value="editorial"]') as HTMLInputElement).click() })
    expect(onSaveTheme).toHaveBeenCalledWith('editorial', expect.objectContaining({ undoValue: 'default' }))
    expect(onSaveFont).not.toHaveBeenCalled()

    await vi.waitFor(() => expect((host.querySelector('input[value="editorial"]') as HTMLInputElement).disabled).toBe(false))
    await act(async () => { (host.querySelector('input[value="serif"]') as HTMLInputElement).click() })
    expect(onSaveFont).toHaveBeenCalledWith('serif', expect.objectContaining({ undoValue: 'default' }))
    expect(onSaveTheme).toHaveBeenCalledTimes(1)
  })

  it('restores the selected theme when persistence fails', async () => {
    const onSaveTheme = vi.fn().mockRejectedValue(new Error('save failed'))
    await render(h(ThemeManager, { initialTheme: 'default', initialFont: 'default', onSaveTheme, onSaveFont: vi.fn() }))

    await act(async () => { (host.querySelector('input[value="editorial"]') as HTMLInputElement).click() })
    await vi.waitFor(() => {
      expect((host.querySelector('input[value="default"]') as HTMLInputElement).checked).toBe(true)
    })
  })

  it('persists and rolls back the theme independently from the body font', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await render(h(SettingsManager, {
      initialNavLinks: '',
      initialCustomJs: '',
      initialBodyFont: 'default',
      initialDefaultTheme: 'default',
      initialRuntimeCapabilities: detectRuntimeCapabilities(),
    }))

    await act(async () => { ([...host.querySelectorAll('button')] as HTMLButtonElement[]).find((button) => button.textContent === '外观')!.click() })
    await act(async () => { (host.querySelector('input[value="porcelain"]') as HTMLInputElement).click() })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/settings', expect.objectContaining({
      body: JSON.stringify({ key: 'default_theme', value: 'porcelain' }),
    }))
    expect(fetchMock.mock.calls.some(([, init]) => String((init as RequestInit).body).includes('body_font'))).toBe(false)

    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    const successOptions = toast.success.mock.calls[0][2]
    await act(async () => { successOptions.onClick() })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/settings', expect.objectContaining({
      body: JSON.stringify({ key: 'default_theme', value: 'default' }),
    }))
  })
})
