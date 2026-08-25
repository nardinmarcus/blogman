'use client'

import { Tabs } from '@/components/Tabs'
import { useToast } from '@/components/Toast'
import type { RuntimeCapabilities } from '@/lib/runtime-capabilities'
import { normalizeTheme, type BodyFont, type Theme } from '@/lib/appearance'
import { SettingsSection } from './SettingsSection'
import { RuntimeStatusStrip } from './RuntimeStatusStrip'
import { NavLinksEditor, type AutosaveOptions } from './NavLinksEditor'
import { CustomJsEditor } from './CustomJsEditor'
import { ThemeManager, type ThemeSaveOptions } from './ThemeManager'
import { ThirdPartyPublishingManager } from './ThirdPartyPublishingManager'
import { ModelsSettings } from './ModelsSettings'
import { PromptsSettings } from './PromptsSettings'

interface Props {
  initialNavLinks: string
  initialCustomJs: string
  initialBodyFont: string
  initialDefaultTheme: string
  initialRuntimeCapabilities: RuntimeCapabilities
}

/** 带撤销的 toast 停留更久，给用户反应时间 */
const UNDO_TOAST_DURATION = 5000

export function SettingsManager({
  initialNavLinks,
  initialCustomJs,
  initialBodyFont,
  initialDefaultTheme,
  initialRuntimeCapabilities,
}: Props) {
  const toast = useToast()

  const persistSetting = async (key: string, value: string) => {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    if (!res.ok) throw new Error('保存失败')
  }

  const rollback = async (persist: () => Promise<unknown>) => {
    try {
      await persist()
      toast.success('已撤销')
    } catch {
      toast.error('撤销失败，请重试')
    }
  }

  const save = async (key: string, value: string, opts: AutosaveOptions) => {
    try {
      await persistSetting(key, value)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
      throw e
    }
    toast.success('已自动保存', UNDO_TOAST_DURATION, {
      label: '撤销',
      onClick: () => {
        opts.onUndo()
        void rollback(() => persistSetting(key, opts.undoValue))
      },
    })
  }

  const saveThemeSettings = async (
    values: { theme: Theme; font: BodyFont },
    opts: ThemeSaveOptions,
  ) => {
    try {
      await Promise.all([
        persistSetting('default_theme', values.theme),
        persistSetting('body_font', values.font),
      ])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
      throw e
    }
    toast.success(opts.label, UNDO_TOAST_DURATION, {
      label: '撤销',
      onClick: () => {
        opts.onUndo()
        void rollback(async () => {
          await Promise.all([
            persistSetting('default_theme', opts.undoValues.theme),
            persistSetting('body_font', opts.undoValues.font),
          ])
        })
      },
    })
  }

  const tabs = [
    {
      id: 'site',
      label: '站点',
      content: (
        <div className="space-y-5">
          <RuntimeStatusStrip capabilities={initialRuntimeCapabilities} />
          <SettingsSection title="导航设置" description="站点顶部导航的自定义链接。">
            <NavLinksEditor
              initialValue={initialNavLinks}
              onSave={(val, opts) => save('nav_links', val, opts)}
            />
          </SettingsSection>
          <SettingsSection
            title="自定义代码"
            description="注入到所有页面的 <head>，适合统计代码（Google Analytics、百度统计等）。输入停止后自动保存。"
          >
            <CustomJsEditor
              initialValue={initialCustomJs}
              onSave={(val, opts) => save('custom_js', val, opts)}
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
          initialTheme={normalizeTheme(initialDefaultTheme)}
          initialFont={(initialBodyFont || 'default') as BodyFont}
          onSave={saveThemeSettings}
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
