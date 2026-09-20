'use client'

import { Tabs } from '@/components/Tabs'
import type { RuntimeCapabilities } from '@/lib/runtime-capabilities'
import { normalizeTheme, FONT_PRESETS, THEME_OPTIONS, type BodyFont } from '@/lib/appearance'
import { SettingsSection } from './SettingsSection'
import { RuntimeStatusStrip } from './RuntimeStatusStrip'
import { NavLinksEditor } from './NavLinksEditor'
import { CustomJsEditor } from './CustomJsEditor'
import { ThemeManager } from './ThemeManager'
import { ThirdPartyPublishingManager } from './ThirdPartyPublishingManager'
import { ModelsSettings } from './ModelsSettings'
import { PromptsSettings } from './PromptsSettings'
import { useSettingsSaveCoordinator } from './useSettingsSaveCoordinator'

interface Props {
  initialNavLinks: string
  initialCustomJs: string
  initialBodyFont: string
  initialDefaultTheme: string
  initialRuntimeCapabilities: RuntimeCapabilities
}

export function SettingsManager({
  initialNavLinks,
  initialCustomJs,
  initialBodyFont,
  initialDefaultTheme,
  initialRuntimeCapabilities,
}: Props) {
  const { state, edit } = useSettingsSaveCoordinator({
    nav_links: initialNavLinks,
    custom_js: initialCustomJs,
    default_theme: initialDefaultTheme,
    body_font: initialBodyFont,
  })

  const tabs = [
    {
      id: 'site',
      label: '站点',
      content: (
        <div className="space-y-5">
          <RuntimeStatusStrip capabilities={initialRuntimeCapabilities} />
          <SettingsSection title="导航设置" description="站点顶部导航的自定义链接。">
            <NavLinksEditor
              value={state.nav_links.draft}
              onChange={(value, debounce) => edit('nav_links', value, { debounce })}
            />
          </SettingsSection>
          <SettingsSection
            title="自定义代码"
            description="注入到所有页面的 <head>，适合统计代码（Google Analytics、百度统计等）。输入停止后自动保存。"
          >
            <CustomJsEditor
              value={state.custom_js.draft}
              onChange={(value) => edit('custom_js', value, { debounce: true })}
            />
          </SettingsSection>
        </div>
      ),
    },
    {
      id: 'appearance',
      label: '外观',
      content: (
        <ThemeManager
          selectedTheme={normalizeTheme(state.default_theme.draft)}
          selectedFont={(state.body_font.draft || 'default') as BodyFont}
          themeSaving={state.default_theme.busy}
          fontSaving={state.body_font.busy}
          onSelectTheme={(value) => edit('default_theme', value, {
            label: `已切换主题为「${THEME_OPTIONS.find(t => t.id === value)?.label ?? value}」`,
          })}
          onSelectFont={(value) => edit('body_font', value, {
            label: `已切换正文字体为「${FONT_PRESETS.find(f => f.id === value)?.name ?? value}」`,
          })}
        />
      ),
    },
    {
      id: 'publish',
      label: '发布',
      content: <ThirdPartyPublishingManager />,
    },
    {
      id: 'models',
      label: '模型',
      content: <ModelsSettings />,
    },
    {
      id: 'prompts',
      label: '提示词',
      content: <PromptsSettings />,
    },
  ]

  return <Tabs tabs={tabs} defaultTab="site" ariaLabel="设置分类" />
}
