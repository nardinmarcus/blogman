'use client'

import { useRef, useState } from 'react'
import { FONT_PRESETS, THEME_OPTIONS, type BodyFont, type Theme } from '@/lib/appearance'

export interface ThemeSaveOptions {
  /** 本次保存前已持久化的主题/字体，用于撤销回滚 */
  undoValues: { theme: Theme; font: BodyFont }
  /** 保存成功 toast 文案 */
  label: string
  /** 撤销时恢复组件本地状态 */
  onUndo: () => void
}

interface Props {
  initialTheme: Theme
  initialFont: BodyFont
  onSave: (values: { theme: Theme; font: BodyFont }, opts: ThemeSaveOptions) => Promise<void>
}

export function ThemeManager({ initialTheme, initialFont, onSave }: Props) {
  const [selectedTheme, setSelectedTheme] = useState<Theme>(initialTheme)
  const [selectedFont, setSelectedFont] = useState<BodyFont>(initialFont)
  // 最近一次成功持久化的主题/字体；撤销以此为准
  const persistedRef = useRef({ theme: initialTheme, font: initialFont })

  const currentFont = FONT_PRESETS.find((preset) => preset.id === selectedFont) || FONT_PRESETS[0]

  const persist = (values: { theme: Theme; font: BodyFont }, label: string) => {
    const undoValues = persistedRef.current
    if (values.theme === undoValues.theme && values.font === undoValues.font) return
    void onSave(values, {
      undoValues,
      label,
      onUndo: () => {
        persistedRef.current = undoValues
        setSelectedTheme(undoValues.theme)
        setSelectedFont(undoValues.font)
      },
    })
      .then(() => {
        persistedRef.current = values
      })
      .catch(() => {
        // 失败 toast 由父级 save 负责
      })
  }

  const selectTheme = (theme: Theme) => {
    if (theme === selectedTheme) return
    setSelectedTheme(theme)
    const name = THEME_OPTIONS.find((t) => t.id === theme)?.label ?? theme
    persist({ theme, font: selectedFont }, `已切换主题为「${name}」`)
  }

  const selectFont = (font: BodyFont) => {
    if (font === selectedFont) return
    setSelectedFont(font)
    const name = FONT_PRESETS.find((f) => f.id === font)?.name ?? font
    persist({ theme: selectedTheme, font }, `已切换正文字体为「${name}」`)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-base font-medium text-[var(--editor-ink)]">默认主题</h3>
        <p className="text-sm text-[var(--editor-muted)]">
          这里设置的是网站首次访问时的默认主题。访客后续如果自己切换主题，会优先使用本地保存的偏好。选择即生效。
        </p>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="站点主题">
          {THEME_OPTIONS.map((theme) => (
            <label
              key={theme.id}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
                selectedTheme === theme.id
                  ? 'border-[var(--editor-accent-strong)] bg-[var(--editor-accent)]/5'
                  : 'border-[var(--editor-line)] bg-[var(--editor-panel)] hover:border-[var(--editor-soft)]'
              }`}
            >
              <input
                type="radio"
                name="default-theme"
                value={theme.id}
                checked={selectedTheme === theme.id}
                onChange={() => selectTheme(theme.id)}
                className="mt-1 accent-[var(--editor-accent)]"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--editor-ink)]">{theme.label}</div>
                <p className="mt-1 text-sm leading-relaxed text-[var(--editor-muted)]">{theme.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-base font-medium text-[var(--editor-ink)]">正文字体</h3>
        <p className="text-sm text-[var(--editor-muted)]">
          设置前台文章正文的字体。主题控制首页风格，字体控制阅读正文体验。选择即生效。
        </p>
        <div className="grid gap-3" role="radiogroup" aria-label="正文字体">
          {FONT_PRESETS.map((preset) => (
            <label
              key={preset.id}
              className={`flex items-start gap-3 rounded-lg border p-4 transition-colors ${
                selectedFont === preset.id
                  ? 'border-[var(--editor-accent-strong)] bg-[var(--editor-accent)]/5'
                  : 'border-[var(--editor-line)] bg-[var(--editor-panel)] hover:border-[var(--editor-soft)]'
              }`}
            >
              <input
                type="radio"
                name="body-font"
                value={preset.id}
                checked={selectedFont === preset.id}
                onChange={() => selectFont(preset.id)}
                className="mt-1 accent-[var(--editor-accent)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--editor-ink)]">{preset.name}</span>
                  <span className="text-xs text-[var(--editor-muted)]">{preset.desc}</span>
                </div>
                <p
                  className="mt-1 text-sm leading-relaxed text-[var(--editor-muted)]"
                  style={{ fontFamily: preset.family || 'inherit' }}
                >
                  白日依山尽，黄河入海流。The quick brown fox jumps over the lazy dog.
                </p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {currentFont.needsLoad && (
        <p className="text-xs text-[var(--editor-muted)]">
          当前字体需要从 CDN 加载（约 4MB），首次加载后会被浏览器缓存。
        </p>
      )}
    </div>
  )
}
