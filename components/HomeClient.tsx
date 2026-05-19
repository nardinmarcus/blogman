'use client'

import dynamic from 'next/dynamic'
import { useEffect, useSyncExternalStore } from 'react'
import { getClientThemePreference, subscribeToThemeChange, type Theme } from '@/lib/appearance'
import type { PostWithTags } from '@/lib/db'
import type { SiteCategoryLink, SiteNavLink } from '@/lib/site'
import { HomeDefault } from '@/components/themes/HomeDefault'

export type { Theme }

export interface HomeProps {
  initialTheme: Theme
  posts: PostWithTags[]
  categories: SiteCategoryLink[]
  navLinks: SiteNavLink[]
  currentPage: number
  totalPages: number
  categorySlugMap: Record<string, string>
}

const HomeVariantA = dynamic<HomeProps>(() =>
  import('@/components/themes/HomeVariantA').then((module) => module.HomeVariantA)
)

const HomeVariantB = dynamic<HomeProps>(() =>
  import('@/components/themes/HomeVariantB').then((module) => module.HomeVariantB)
)

const HomeVariantC = dynamic<HomeProps>(() =>
  import('@/components/themes/HomeVariantC').then((module) => module.HomeVariantC)
)

function injectFont(id: string, href: string) {
  if (typeof document === 'undefined') return
  if (!document.getElementById(id)) {
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = href
    document.head.appendChild(link)
  }
}

export function HomeClient(props: HomeProps) {
  const theme = useSyncExternalStore(
    subscribeToThemeChange,
    () => getClientThemePreference(props.initialTheme),
    () => props.initialTheme,
  )

  // Inject fonts on demand
  useEffect(() => {
    if (theme === 'refined' || theme === 'terminal' || theme === 'editorial') {
      injectFont(
        'nm-jetbrains-mono',
        'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
      )
    }
    if (theme === 'editorial') {
      injectFont(
        'nm-noto-serif-sc',
        'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700;900&display=swap',
      )
    }
  }, [theme])

  const ThemeComponent =
    theme === 'refined'
      ? HomeVariantA
      : theme === 'editorial'
        ? HomeVariantB
        : theme === 'terminal'
          ? HomeVariantC
          : HomeDefault

  return <ThemeComponent {...props} />
}
