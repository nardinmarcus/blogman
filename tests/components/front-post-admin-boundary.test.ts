import React, { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrontPostAdminBoundary, FrontPostEditButton } from '@/components/FrontPostAdminBoundary'

const session = vi.hoisted(() => ({ authenticated: true }))
vi.mock('@/lib/admin-session-client', () => ({ useAdminSession: () => session }))
vi.mock('@/components/InlineArticleEditorClient', () => ({
  InlineArticleEditorClient: ({ onExitReading }: { onExitReading: () => void }) =>
    h('section', { 'data-testid': 'editor' }, h('button', { onClick: onExitReading }, '返回阅读')),
}))

let dom: JSDOM
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // Keep Vitest's node environment: the shared authority-isolation setup uses
  // Node's URL implementation. Install a DOM only after that setup has run.
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/article' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
  })) vi.stubGlobal(name, value)
  session.authenticated = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderArticle() {
  await act(async () => root.render(h(FrontPostAdminBoundary, {
    slug: 'article', title: '文章标题', html: '<p>文章正文</p>',
    children: h('article', null,
      // Retain the old markers as a regression fixture: the boundary must not
      // turn arbitrary reading content into a hidden entry, even with markers.
      h('h1', { 'data-admin-edit-trigger': true }, '文章标题'),
      h('div', { 'data-testid': 'actions' }, h(FrontPostEditButton)),
      h('div', { 'data-admin-edit-trigger': true },
        h('p', null, '文章正文，可以选择复制。'),
        h('a', { href: '#target' }, '正文链接'),
        h('button', { type: 'button', 'data-native': true }, '正文按钮'),
      ),
    ),
  })))
}

async function click(selector: string, detail = 1) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail })
  await act(async () => host.querySelector(selector)!.dispatchEvent(event))
  return event
}

function expectReading() {
  expect(host.querySelector('article')).not.toBeNull()
  expect(host.querySelector('[data-testid="editor"]')).toBeNull()
}

describe('#246 explicit article editing', () => {
  it.each(['h1', 'p'])('admin single click on %s stays in reading mode', async (selector) => {
    await renderArticle()
    expect((await click(selector)).defaultPrevented).toBe(false)
    expectReading()
  })

  it('double-click sequence leaves reading and text selection intact', async () => {
    await renderArticle()
    await click('p', 1)
    expectReading()
    const range = document.createRange()
    range.selectNodeContents(host.querySelector('p')!)
    window.getSelection()!.addRange(range)
    await click('p', 2)
    await act(async () => host.querySelector('p')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expectReading()
    expect(window.getSelection()!.toString()).toBe('文章正文，可以选择复制。')
  })

  it('click after selecting text does not replace the article', async () => {
    await renderArticle()
    const range = document.createRange()
    range.selectNodeContents(host.querySelector('p')!)
    window.getSelection()!.addRange(range)
    await click('p')
    expectReading()
    expect(window.getSelection()!.toString()).toBe('文章正文，可以选择复制。')
  })

  it.each(['a', 'button[data-native]'])('native %s click is not intercepted', async (selector) => {
    await renderArticle()
    expect((await click(selector)).defaultPrevented).toBe(false)
    expectReading()
  })

  it('visitor clicks never mount the editor', async () => {
    session.authenticated = false
    await renderArticle()
    expect(host.querySelector('[data-testid="actions"] button')).toBeNull()
    await click('p')
    expectReading()
  })

  it('only the explicit native button mounts the editor', async () => {
    await renderArticle()
    expectReading()
    const button = host.querySelector<HTMLButtonElement>('[data-testid="actions"] button')!
    expect(button.textContent).toContain('编辑本文')
    expect(button.type).toBe('button')
    expect(button.disabled).toBe(false)
    button.focus()
    expect(document.activeElement).toBe(button)
    // Keyboard activation of a native button generates a click with detail=0.
    await click('[data-testid="actions"] button', 0)
    expect(host.querySelector('[data-testid="editor"]')).not.toBeNull()
    expect(host.querySelector('article')).toBeNull()
  })

  it('restores position after reading DOM remounts, including repeat visits', async () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      expectReading()
    })
    await renderArticle()
    expect(scroll).not.toHaveBeenCalled()

    for (const top of [640, 1200]) {
      Object.defineProperty(window, 'scrollX', { configurable: true, value: 12 })
      Object.defineProperty(window, 'scrollY', { configurable: true, value: top })
      await click('[data-testid="actions"] button')
      expect(host.querySelector('[data-testid="editor"]')).not.toBeNull()
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 90 })
      await click('[data-testid="editor"] button')
      expectReading()
      expect(scroll).toHaveBeenLastCalledWith({ left: 12, top, behavior: 'instant' })
      expect(document.activeElement).toBe(host.querySelector('[data-testid="actions"] button'))
    }
    expect(scroll).toHaveBeenCalledTimes(2)
    await click('p')
    expect(scroll).toHaveBeenCalledTimes(2)
  })

  it('does not expose an entry outside its article boundary', async () => {
    await act(async () => root.render(h(FrontPostEditButton)))
    expect(host.querySelector('button')).toBeNull()
  })
})
