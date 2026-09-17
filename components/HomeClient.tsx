'use client'

import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'
import type { Theme } from '@/lib/appearance'
import { getThemeDefinition, type ThemeDefinition } from '@/lib/themes'
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

const HOME_COMPONENTS: Record<ThemeDefinition['home'], ComponentType<HomeProps>> = {
  default: HomeDefault,
  refined: HomeVariantA,
  editorial: HomeVariantB,
  terminal: HomeVariantC,
}

export function HomeClient(props: HomeProps) {
  const theme = getThemeDefinition(props.initialTheme)
  const ThemeComponent = HOME_COMPONENTS[theme.home]

  return <ThemeComponent {...props} />
}
