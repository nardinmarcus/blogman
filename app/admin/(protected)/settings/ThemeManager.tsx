'use client'

import { FONT_PRESETS, THEME_OPTIONS, type BodyFont, type Theme } from '@/lib/appearance'

interface Props {
  selectedTheme: Theme
  selectedFont: BodyFont
  themeSaving: boolean
  fontSaving: boolean
  onSelectTheme: (theme: Theme) => void
  onSelectFont: (font: BodyFont) => void
}

export function ThemeManager({ selectedTheme, selectedFont, themeSaving, fontSaving, onSelectTheme, onSelectFont }: Props) {
  const selectTheme = (value: Theme) => {
    if (!themeSaving && value !== selectedTheme) onSelectTheme(value)
  }
  const selectFont = (value: BodyFont) => {
    if (!fontSaving && value !== selectedFont) onSelectFont(value)
  }

  const currentFont = FONT_PRESETS.find((preset) => preset.id === selectedFont) || FONT_PRESETS[0]

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-base font-medium text-[var(--editor-ink)]">站点主题</h3>
        <p className="text-sm text-[var(--editor-muted)]">
          主题由站长统一控制，决定公开页面的布局、配色、字体资源和阅读氛围。访客没有单独的主题切换器。选择即生效。
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
                disabled={themeSaving}
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
          设置前台文章正文的阅读字体。它与站点主题相互独立，可作为站长指定的阅读偏好覆盖。选择即生效。
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
                disabled={fontSaving}
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
