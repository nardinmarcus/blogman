import { describe, expect, it } from 'vitest'
import {
  buildAutoDescription,
  extractMarkdownDescription,
  isAutoDescription,
  stripMarkdownFrontmatter,
} from '@/lib/post-utils'

describe('post-utils', () => {
  it('extracts explicit summaries from markdown frontmatter', () => {
    const description = extractMarkdownDescription(`---
title: Claude design analysis
summary: "A concise guide to the visual system behind Claude.com."
---

# Claude design analysis

Body text.`)

    expect(description).toBe('A concise guide to the visual system behind Claude.com.')
  })

  it('falls through empty frontmatter description aliases', () => {
    const description = extractMarkdownDescription(`---
description:
excerpt: A concise fallback excerpt.
---

Body text.`)

    expect(description).toBe('A concise fallback excerpt.')
  })

  it('reads folded and indented YAML description values', () => {
    const folded = extractMarkdownDescription(`---
summary: >-
  A concise guide to
  folded frontmatter values.
---

Body text.`)
    const indented = extractMarkdownDescription(`---
description:
  A concise guide to indented frontmatter values.
---

Body text.`)

    expect(folded).toBe('A concise guide to folded frontmatter values.')
    expect(indented).toBe('A concise guide to indented frontmatter values.')
  })

  it('strips frontmatter before storing markdown content', () => {
    const content = stripMarkdownFrontmatter(`---
title: Claude design analysis
description: A concise summary.
---

# Claude design analysis`)

    expect(content.trim()).toBe('# Claude design analysis')
  })

  it('builds clean fallback descriptions from markdown instead of raw syntax', () => {
    const description = buildAutoDescription(`## Overview Claude.com is the warmest, most editorial interface in the AI-product category.

The base atmosphere is a **tinted cream canvas** (\`colors.canvas\`) with [subtle borders](https://example.com).`)

    expect(description).toBe(
      'Overview Claude.com is the warmest, most editorial interface in the AI-product category.',
    )
    expect(description).not.toContain('##')
    expect(description).not.toContain('**')
    expect(description).not.toContain('`')
    expect(description).not.toContain('https://example.com')
  })

  it('skips short structural headings when selecting fallback text', () => {
    const description = buildAutoDescription(`# Claude design analysis

## Overview

Claude.com uses warm editorial spacing and a restrained product palette.`)

    expect(description).toBe('Claude.com uses warm editorial spacing and a restrained product palette.')
  })

  it('skips plain title and metadata blocks when selecting fallback text', () => {
    const description = buildAutoDescription(`巨量千川横纵分析报告

研究时间：2026年5月 | 所属领域：短视频电商投流 | 研究对象类型：产品

一、一句话定义

巨量千川是字节跳动旗下的一体化电商广告投放平台，为抖音电商商家提供从流量获取到转化复购的全链路营销解决方案。`)

    expect(description).toBe(
      '巨量千川是字节跳动旗下的一体化电商广告投放平台，为抖音电商商家提供从流量获取到转化复购的全链路营销解决方案。',
    )
  })

  it('recognizes both current and legacy automatic descriptions', () => {
    const source = `## Overview

Claude.com uses **warm** editorial spacing.`
    const legacy = '## Overview Claude.com uses **warm** editorial spacing.'
    const current = 'Claude.com uses warm editorial spacing.'

    expect(isAutoDescription(current, source)).toBe(true)
    expect(isAutoDescription(legacy, source)).toBe(true)
    expect(isAutoDescription('Author written summary.', source)).toBe(false)
  })
})
