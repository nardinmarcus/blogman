import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_OPTIONS, normalizeTheme } from '@/lib/appearance'
import { THEME_DEFINITIONS, getThemeDefinition } from '@/lib/themes'

const REQUIRED_THEME_TOKENS = [
  '--background',
  '--foreground',
  '--editor-app-bg',
  '--editor-panel',
  '--editor-soft',
  '--editor-line',
  '--editor-ink',
  '--editor-muted',
  '--editor-accent',
  '--editor-accent-strong',
  '--editor-accent-ink',
  '--editor-secondary-accent',
  '--editor-link',
  '--editor-code-bg',
  '--editor-code-border',
  '--editor-quote-bg',
  '--editor-selection',
  '--stone-gray',
  '--border-warm',
  '--coral',
  '--article-heading',
  '--article-body',
  '--article-quote',
  '--article-quote-border',
  '--article-quote-nested-border',
  '--article-quote-nested-bg',
  '--logo-font',
] as const

const CATEGORY_TOKENS = [
  '--category-ai-tools',
  '--category-ai-tutorials',
  '--category-product',
  '--category-startup',
  '--category-brain-gym',
  '--category-tech',
  '--category-life',
  '--category-default',
] as const

function themeBlocks(id: string): string[] {
  const css = readFileSync('app/globals.css', 'utf8')
  const pattern = new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([^}]*)\\}`, 'g')
  return [...css.matchAll(pattern)].map((match) => match[1])
}

describe('#249 complete theme registry', () => {
  it('exposes every theme option through a complete registry definition', () => {
    expect(THEME_OPTIONS.map((theme) => theme.id)).toEqual(THEME_DEFINITIONS.map((theme) => theme.id))
    expect(new Set(THEME_DEFINITIONS.map((theme) => theme.id)).size).toBe(THEME_DEFINITIONS.length)

    for (const definition of THEME_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0)
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.home).toMatch(/^(default|refined|editorial|terminal)$/)
      expect(definition.header).toMatch(/^(standard|editorial|terminal)$/)
      expect(definition.colorScheme).toMatch(/^(system|light|dark)$/)
      expect(definition.scope).toBe('public')
      expect(getThemeDefinition(definition.id)).toEqual(definition)
    }
  })

  it('registers porcelain and mist as sibling themes with explicit system color schemes', () => {
    expect(THEME_DEFINITIONS.map((theme) => theme.id)).toEqual([
      'default',
      'refined',
      'porcelain',
      'mist',
      'editorial',
      'terminal',
    ])
    expect(getThemeDefinition('porcelain')).toMatchObject({ home: 'refined', header: 'standard', colorScheme: 'system' })
    expect(getThemeDefinition('mist')).toMatchObject({ home: 'refined', header: 'standard', colorScheme: 'system' })
    expect(normalizeTheme('not-a-theme')).toBe('default')
  })

  it('keeps registry color-scheme policies consistent with the CSS dark-mode surface', () => {
    const css = readFileSync('app/globals.css', 'utf8')
    const darkStart = css.indexOf('@media (prefers-color-scheme: dark)')
    const darkEnd = css.indexOf('\nhtml {', darkStart)
    const darkBlock = css.slice(darkStart, darkEnd)

    for (const definition of THEME_DEFINITIONS) {
      const selector = `[data-theme="${definition.id}"]`
      if (definition.colorScheme === 'system') expect(darkBlock).toContain(selector)
      else expect(darkBlock).not.toContain(selector)
    }
  })

  it.each(THEME_DEFINITIONS.filter((theme) => theme.home === 'refined').map((theme) => theme.id))('declares refined category tokens for %s', (id) => {
    const declarations = themeBlocks(id).join('\n')
    for (const token of CATEGORY_TOKENS) expect(declarations).toContain(`${token}:`)
  })

  it('does not let a later root category fallback override theme-owned category tokens', () => {
    const css = readFileSync('app/globals.css', 'utf8')
    const afterThemeBlocks = css.slice(css.indexOf('[data-theme="porcelain"]'))
    expect(afterThemeBlocks).not.toMatch(/\n:root\s*\{[^}]*--category-/)
  })

  it('keeps the admin workbench on a fixed scope instead of inheriting the public theme', () => {
    const adminLayout = readFileSync('app/admin/(protected)/layout.tsx', 'utf8')
    const css = readFileSync('app/globals.css', 'utf8')
    expect(adminLayout).toContain('data-theme-scope="workbench"')
    expect(css).toContain('[data-theme-scope="workbench"]')
    expect(css).toContain('color-scheme: light;')
  })

  it.each(THEME_DEFINITIONS.map((theme) => theme.id))('declares the complete token surface for %s', (id) => {
    const blocks = themeBlocks(id)
    expect(blocks.length).toBeGreaterThan(0)
    const declarations = blocks.join('\n')
    for (const token of REQUIRED_THEME_TOKENS) {
      expect(declarations).toContain(`${token}:`)
    }
  })
})
