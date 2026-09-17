export const THEME_FONT_RESOURCES = {
  jetBrainsMono: {
    id: 'nm-jetbrains-mono',
    href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
  },
  notoSerifSc: {
    id: 'nm-noto-serif-sc',
    href: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700;900&display=swap',
  },
} as const

export type ThemeFontResource = (typeof THEME_FONT_RESOURCES)[keyof typeof THEME_FONT_RESOURCES]

export const THEME_DEFINITIONS = [
  {
    id: 'default',
    label: '默认',
    description: '温暖、克制的阅读首页',
    home: 'default',
    header: 'standard',
    colorScheme: 'system',
    scope: 'public',
    fontResources: [],
  },
  {
    id: 'refined',
    label: '精致极简',
    description: '更轻、更专注的杂志式列表',
    home: 'refined',
    header: 'standard',
    colorScheme: 'system',
    scope: 'public',
    fontResources: [THEME_FONT_RESOURCES.jetBrainsMono],
  },
  {
    id: 'porcelain',
    label: '米白阅读',
    description: '低黄度的干净纸面与安静阅读层次',
    home: 'refined',
    header: 'standard',
    colorScheme: 'system',
    scope: 'public',
    fontResources: [THEME_FONT_RESOURCES.jetBrainsMono],
  },
  {
    id: 'mist',
    label: '淡青阅读',
    description: '低饱和淡青底色与清爽阅读层次',
    home: 'refined',
    header: 'standard',
    colorScheme: 'system',
    scope: 'public',
    fontResources: [THEME_FONT_RESOURCES.jetBrainsMono],
  },
  {
    id: 'editorial',
    label: '杂志编辑',
    description: '更强视觉层次的刊物风格',
    home: 'editorial',
    header: 'editorial',
    colorScheme: 'light',
    scope: 'public',
    fontResources: [THEME_FONT_RESOURCES.jetBrainsMono, THEME_FONT_RESOURCES.notoSerifSc],
  },
  {
    id: 'terminal',
    label: 'AI 终端',
    description: '偏技术感的深色终端界面',
    home: 'terminal',
    header: 'terminal',
    colorScheme: 'dark',
    scope: 'public',
    fontResources: [THEME_FONT_RESOURCES.jetBrainsMono],
  },
] as const

export type Theme = (typeof THEME_DEFINITIONS)[number]['id']
export type ThemeDefinition = (typeof THEME_DEFINITIONS)[number]

export const THEME_OPTIONS = THEME_DEFINITIONS.map(({ id, label, description }) => ({
  id,
  label,
  description,
}))

export function getThemeDefinition(id: Theme): ThemeDefinition {
  return THEME_DEFINITIONS.find((theme) => theme.id === id) ?? THEME_DEFINITIONS[0]
}

export function isTheme(value: string | null | undefined): value is Theme {
  return THEME_DEFINITIONS.some((theme) => theme.id === value)
}

export function normalizeTheme(value: string | null | undefined, fallback: Theme = 'default'): Theme {
  return isTheme(value) ? value : fallback
}
