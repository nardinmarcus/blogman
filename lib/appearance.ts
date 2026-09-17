export { THEME_OPTIONS, isTheme, normalizeTheme } from './themes'
export type { Theme } from './themes'

export const FONT_PRESETS = [
  {
    id: 'default',
    name: '系统默认',
    desc: '本地 Geist + 系统字体',
    family: '',
    needsLoad: false,
  },
  {
    id: 'kaiti',
    name: '楷体（tw93风格）',
    desc: '仓耳今楷02，典雅文艺，自托管分片加载',
    family: 'TsangerJinKai02, STKaiti, KaiTi, serif',
    needsLoad: true,
  },
  {
    id: 'serif',
    name: '衬线体',
    desc: 'Georgia + Noto Serif SC',
    family: 'Georgia, "Noto Serif SC", "Source Han Serif SC", serif',
    needsLoad: false,
  },
  {
    id: 'heiti',
    name: '黑体',
    desc: '苹方 / 微软雅黑',
    family: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    needsLoad: false,
  },
] as const

export type BodyFont = (typeof FONT_PRESETS)[number]['id']

export const FONT_CONFIG: Record<string, { family: string; link?: string }> = {
  kaiti: {
    family: 'TsangerJinKai02, STKaiti, KaiTi, serif',
    link: '/fonts/jinkai/jinkai.css',
  },
  serif: { family: 'Georgia, "Noto Serif SC", "Source Han Serif SC", serif' },
  heiti: { family: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif' },
}
