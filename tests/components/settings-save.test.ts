import React, { act, createElement as h, StrictMode, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsManager } from '@/app/admin/(protected)/settings/SettingsManager'
import { ToastProvider } from '@/components/Toast'
import { detectRuntimeCapabilities } from '@/lib/runtime-capabilities'

// Keep the actual four editors, tab unmounting, and toast action lifetime.
vi.mock('@/app/admin/(protected)/settings/RuntimeStatusStrip', () => ({ RuntimeStatusStrip: () => null }))
vi.mock('@/app/admin/(protected)/settings/ThirdPartyPublishingManager', () => ({ ThirdPartyPublishingManager: () => null }))
vi.mock('@/app/admin/(protected)/settings/ModelsSettings', () => ({ ModelsSettings: () => null }))
vi.mock('@/app/admin/(protected)/settings/PromptsSettings', () => ({ PromptsSettings: () => null }))

const seed = JSON.stringify([{ label: 'Seed', url: '/seed', openInNewTab: false }])
let dom: JSDOM
let root: Root
let host: HTMLDivElement
let calls: { key: string; value: string; finish: (ok?: boolean) => void }[]
let stored: Record<string, string>
let effectLifecycle: string[]
function EffectProbe() {
  useEffect(() => {
    effectLifecycle.push('setup')
    return () => { effectLifecycle.push('cleanup') }
  }, [])
  return null
}
beforeEach(async () => {
  vi.useFakeTimers()
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, history: dom.window.history, React, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value)
  host = document.createElement('div')
  document.body.append(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host)
  calls = []
  effectLifecycle = []
  stored = { nav_links: seed, custom_js: '', default_theme: 'default', body_font: 'default' }
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise(resolve => {
    const { key, value } = JSON.parse(init.body)
    calls.push({ key, value, finish: (ok = true) => {
      if (ok) stored[key] = value
      resolve({ ok })
    } })
  })))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllTimers()
  vi.useRealTimers()
  dom.window.close()
  vi.unstubAllGlobals()
})
async function mount(overrides = {}, strict = false) {
  const page = h(SettingsManager, { initialNavLinks: seed, initialCustomJs: '', initialBodyFont: 'default', initialDefaultTheme: 'default', initialRuntimeCapabilities: detectRuntimeCapabilities(), ...overrides })
  const tree = h(ToastProvider, null, page, strict ? h(EffectProbe) : null)
  await act(async () => root.render(strict ? h(StrictMode, null, tree) : tree))
}
const buttons = (label: string) => [...host.querySelectorAll('button')].filter(b => b.textContent === label)
async function click(el: HTMLElement) { expect(el).toBeDefined(); await act(async () => el.click()) }
const tab = (label: string) => click(buttons(label)[0])
const select = (value: string) => click(host.querySelector(`input[name="default-theme"][value="${value}"]`)!)
async function input(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  const prototype = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function advance(ms = 1000) { await act(async () => vi.advanceTimersByTime(ms)) }
const code = () => host.querySelector<HTMLTextAreaElement>('textarea')!.value
const selected = () => host.querySelector<HTMLInputElement>('input[name="default-theme"]:checked')?.value
async function finish(index: number, ok = true) { expect(calls[index]).toBeDefined(); await act(async () => calls[index].finish(ok)) }

describe('#254 real settings page coordination', () => {
  it('keeps undo success-confirmed and retains the acknowledged baseline after failure', async () => {
    await mount(); await tab('外观'); await select('editorial'); await finish(0)
    await click(buttons('撤销')[0])
    expect(selected()).toBe('editorial')
    await finish(1, false)
    expect(selected()).toBe('editorial')
    expect(stored.default_theme).toBe('editorial')
    expect(buttons('重试')).toHaveLength(1)
    await select('terminal'); await finish(2)
    await click(buttons('撤销').at(-1)!)
    expect(calls[3].value).toBe('editorial')
  })

  it('makes an old undo inert after a newer successful selection', async () => {
    await mount(); await tab('外观'); await select('editorial'); await finish(0)
    await select('terminal'); await finish(1)
    await click(buttons('撤销')[0])
    expect(calls).toHaveLength(2)
    expect(selected()).toBe('terminal')
  })

  it('serializes navigation writes and coalesces the latest unsent structure', async () => {
    await mount()
    await click(buttons('+ 添加链接')[0]); await click(buttons('+ 添加链接')[0]); await click(buttons('+ 添加链接')[0])
    expect(calls).toHaveLength(1)
    expect(host.querySelectorAll('[aria-label="链接名称"]')).toHaveLength(4)
    await finish(0)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1].value)).toHaveLength(4)
    await finish(1)
    expect(JSON.parse(stored.nav_links)).toHaveLength(4)
  })

  it('preserves acknowledged appearance across internal tab remounts', async () => {
    await mount(); await tab('外观'); await select('editorial'); await finish(0)
    await tab('站点'); await tab('外观')
    expect(selected()).toBe('editorial')
  })

  it('retries failed undo once and updates the visible selection only on success', async () => {
    await mount(); await tab('外观'); await select('editorial'); await finish(0)
    await click(buttons('撤销')[0]); await finish(1, false)
    const retry = buttons('重试')[0]
    await click(retry); await click(retry)
    expect(calls).toHaveLength(3)
    expect(selected()).toBe('editorial')
    expect(host.querySelector<HTMLInputElement>('input[value="terminal"]')!.disabled).toBe(true)
    await finish(2)
    expect(selected()).toBe('default')
    expect(stored.default_theme).toBe('default')
  })

  it.each(['', '{broken', '{}'])('presents nav defaults but restores raw %j on undo', async raw => {
    await mount({ initialNavLinks: raw })
    expect(host.querySelectorAll('[aria-label="链接名称"]')).toHaveLength(4)
    await click(buttons('+ 添加链接')[0]); await finish(0)
    await tab('外观'); await click(buttons('撤销')[0])
    expect(calls[1].value).toBe(raw)
    await finish(1); await tab('站点')
    expect(host.querySelectorAll('[aria-label="链接名称"]')).toHaveLength(4)
  })

  it('keeps in-flight appearance disabling across tabs and allows the other key', async () => {
    await mount(); await tab('外观'); await select('editorial')
    await tab('站点'); await tab('外观')
    expect(selected()).toBe('editorial')
    expect(host.querySelector<HTMLInputElement>('input[value="terminal"]')!.disabled).toBe(true)
    await click(host.querySelector('input[value="serif"]')!)
    expect(calls.map(c => c.key)).toEqual(['default_theme', 'body_font'])
    await finish(1); await finish(0, false)
    expect(selected()).toBe('default')
    expect(host.querySelector<HTMLInputElement>('input[value="serif"]')!.checked).toBe(true)
  })

  it('preserves draft and debounce across tabs without saving early', async () => {
    await mount()
    await input('textarea', 'draft')
    await input('[aria-label="链接名称"]', 'Renamed')
    await advance(500); await tab('外观'); await advance(499)
    expect(calls).toHaveLength(0)
    await tab('站点')
    expect(code()).toBe('draft')
    expect(host.querySelector<HTMLInputElement>('[aria-label="链接名称"]')!.value).toBe('Renamed')
    await advance(1)
    expect(calls.map(c => c.key)).toEqual(['custom_js', 'nav_links'])
    expect(JSON.parse(calls[1].value)[0].label).toBe('Renamed')
  })

  it('preserves newer text drafts through save and undo completions, including hidden panels', async () => {
    await mount({ initialCustomJs: 'original' })
    await input('textarea', 'first'); await advance(); await finish(0)
    await click(buttons('撤销')[0])
    expect(code()).toBe('first')
    await input('textarea', 'newer'); await tab('外观'); await finish(1)
    expect(host.textContent).not.toContain('已撤销')
    await tab('站点'); expect(code()).toBe('newer')
    await advance(); expect(calls[2].value).toBe('newer')
    await input('textarea', 'newest'); await finish(2)
    expect(code()).toBe('newest')
    expect(buttons('撤销')).toHaveLength(0)
    await advance(); await finish(3)
    await click(buttons('撤销')[0]); expect(calls[4].value).toBe('newer')
  })

  it('keeps failed text editable and invalidates its retry on the next keystroke', async () => {
    await mount(); await input('textarea', 'first'); await advance(); await finish(0, false)
    expect(code()).toBe('first')
    const retry = buttons('重试')[0]
    await input('textarea', 'next'); await click(retry)
    expect(calls).toHaveLength(1)
    await advance(); await finish(1, false)
    await click(buttons('重试')[0]); expect(calls[2].value).toBe('next')
    await finish(2)
    expect(stored.custom_js).toBe('next')
  })

  it('invalidates retained toast actions and cancels unsent work when the page leaves', async () => {
    await mount(); await tab('外观'); await select('editorial'); await finish(0)
    await tab('站点'); await input('textarea', 'unsent')
    // ToastProvider deliberately outlives SettingsManager, as in the root layout.
    await act(async () => root.render(h(ToastProvider, null, h('div', null, 'another page'))))
    await click(buttons('撤销')[0]); await advance()
    expect(calls).toHaveLength(1)
  })

  it.each([true, false])('suppresses late completion notices after leaving (success=%s)', async ok => {
    await mount(); await click(buttons('+ 添加链接')[0]); await click(buttons('+ 添加链接')[0])
    await act(async () => root.render(h(ToastProvider, null, h('div', null, 'another page'))))
    await finish(0, ok); await advance()
    expect(calls).toHaveLength(1)
    expect(host.querySelector('[aria-live]')!.textContent).toBe('')
  })

  it('survives StrictMode effect replay and still disposes the real page', async () => {
    await mount({}, true)
    expect(effectLifecycle).toEqual(['setup', 'cleanup', 'setup'])
    await input('textarea', 'strict draft'); await advance(); await finish(0)
    await tab('外观'); await tab('站点'); expect(code()).toBe('strict draft')
    await input('textarea', 'must not send')
    await act(async () => root.render(h(ToastProvider, null, h('div', null, 'gone'))))
    await advance(); expect(calls).toHaveLength(1)
  })


  it('writes A after in-flight B even when A was the original acknowledged value', async () => {
    await mount({ initialCustomJs: 'A' })
    await input('textarea', 'B'); await advance()
    await input('textarea', 'A'); await advance()
    expect(calls).toHaveLength(1)
    await finish(0)
    expect(code()).toBe('A')
    expect(calls[1].value).toBe('A')
    expect(buttons('撤销')).toHaveLength(0)
    await finish(1); await click(buttons('撤销')[0])
    expect(calls[2].value).toBe('B')
  })

  it.each(['', 'unrecognized-theme'])('preserves raw theme %j behind the normalized presentation', async raw => {
    await mount({ initialDefaultTheme: raw }); await tab('外观')
    expect(selected()).toBe('default')
    await select('editorial'); await finish(0)
    await click(buttons('撤销')[0]); expect(calls[1].value).toBe(raw)
    await finish(1); expect(selected()).toBe('default')
    await select('terminal'); await finish(2)
    await click(buttons('撤销')[0]); expect(calls[3].value).toBe(raw)
  })

  it.each(['', 'unrecognized-font'])('preserves raw font %j while keeping the existing fallback display', async raw => {
    await mount({ initialBodyFont: raw }); await tab('外观')
    const selectedFont = () => host.querySelector<HTMLInputElement>('input[name="body-font"]:checked')?.value
    expect(selectedFont()).toBe(raw ? undefined : 'default')
    await click(host.querySelector('input[value="serif"]')!); await finish(0)
    await click(buttons('撤销')[0]); expect(calls[1].value).toBe(raw)
    expect(selectedFont()).toBe('serif')
    await finish(1); expect(selectedFont()).toBe(raw ? undefined : 'default')
  })


  it('folds pending navigation text into an immediate structural save and cancels its timer', async () => {
    await mount(); await input('[aria-label="链接名称"]', 'Renamed'); await advance(500)
    await click(buttons('+ 添加链接')[0])
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].value)).toEqual([
      { label: 'Renamed', url: '/seed', openInNewTab: false },
      { label: '', url: '', openInNewTab: false },
    ])
    await finish(0); await advance()
    expect(calls).toHaveLength(1)
  })

})
