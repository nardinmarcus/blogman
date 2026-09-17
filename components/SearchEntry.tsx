'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Search } from 'lucide-react'

const SearchBar = dynamic(
  () => import('@/components/SearchBar').then((module) => module.SearchBar),
  {
    ssr: false,
    loading: () => (
      <Link
        href="/search"
        className="inline-flex size-9 items-center justify-center rounded-md text-[var(--editor-muted)] transition-colors duration-150 hover:bg-[var(--editor-panel)] hover:text-[var(--editor-ink)]"
        aria-label="搜索"
        title="搜索"
      >
        <Search className="w-[18px] h-[18px]" />
      </Link>
    ),
  },
)

export function SearchEntry() {
  return <SearchBar />
}
