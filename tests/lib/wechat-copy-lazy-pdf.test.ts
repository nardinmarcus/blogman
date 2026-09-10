/**
 * #244 perf convergence — lazy PDF chunk contract.
 *
 * `html2pdf.js` (with html2canvas, ~270 KB transferred) used to be in the
 * STATIC client import graph of every article page via
 * `lib/wechat-copy.ts` → `DownloadMarkdown.tsx`, delaying article-navigation
 * chunks (production ResourceTiming: +817 ms before route chunks complete).
 * The PDF export is a rarely-used action, so it must be dynamically imported
 * on the actual download path only — while the clipboard/wechat-copy sync
 * path stays synchronous (Clipboard user activation must not be lost).
 *
 * Contract under test (source-level, the exact regression that occurred):
 *   1. no static `import … from 'html2pdf.js'` anywhere in the client graph,
 *   2. `downloadArticleAsPdf` loads it via `import('html2pdf.js')`,
 *   3. `copyAsWechatArticleFormat` (juice path) is NOT lazified.
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8')

const { pdfModuleLoaded } = vi.hoisted(() => ({ pdfModuleLoaded: vi.fn() }))

vi.mock('html2pdf.js', () => {
  pdfModuleLoaded()
  return { default: vi.fn() }
})

describe('#244 lazy PDF import contract', () => {
  const wechatCopy = read('lib/wechat-copy.ts')
  const downloadMarkdown = read('components/DownloadMarkdown.tsx')
  const clientGraphEntry = downloadMarkdown + '\n' + wechatCopy

  it('运行时：评估 wechat-copy 模块不加载 html2pdf.js（真实 module evaluation）', async () => {
    vi.resetModules()
    await import('@/lib/wechat-copy')
    expect(pdfModuleLoaded).not.toHaveBeenCalled()
  })

  it('源码辅助断言：这两个文件无静态 html2pdf import（仅检查这两个文件，非全图扫描）', () => {
    expect(clientGraphEntry).not.toMatch(/(^|\n)\s*import\s+[^;]*from\s+['"]html2pdf\.js['"]/)
    expect(clientGraphEntry).not.toMatch(/(^|\n)\s*import\s+['"]html2pdf\.js['"]/)
  })

  it('downloadArticleAsPdf 通过动态 import(html2pdf.js) 加载', () => {
    expect(wechatCopy).toMatch(/import\(\s*['"]html2pdf\.js['"]\s*\)/)
  })

  it('juice（公众号 copy 同步路径）保持静态 import，不被懒化', () => {
    expect(wechatCopy).toMatch(/(^|\n)\s*import\s+juice\s+from\s+['"]juice['"]/)
  })

  it('DownloadMarkdown 的 PDF 入口仍走 downloadArticleAsPdf（不绕过封装）', () => {
    expect(downloadMarkdown).toMatch(/downloadArticleAsPdf/)
  })
})
