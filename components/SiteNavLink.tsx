'use client'

import Link from 'next/link'
import type { AnchorHTMLAttributes } from 'react'
import type { SiteNavLink as ConfiguredLink } from '@/lib/site'

type SiteNavLinkProps = Pick<AnchorHTMLAttributes<HTMLAnchorElement>,
  'children' | 'className' | 'style' | 'aria-label' | 'onClick' | 'onMouseEnter' | 'onMouseLeave'
> & { link: ConfiguredLink }

// Presentation adapters cannot replace the configured destination or tab policy.
export function SiteNavLink({ link, children, className, style, 'aria-label': ariaLabel, onClick, onMouseEnter, onMouseLeave }: SiteNavLinkProps) {
  const presentation = { className, style, 'aria-label': ariaLabel, onClick, onMouseEnter, onMouseLeave }

  if (link.openInNewTab || link.url.startsWith('http')) {
    return (
      <a
        {...presentation}
        href={link.url}
        target={link.openInNewTab ? '_blank' : undefined}
        rel={link.openInNewTab ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    )
  }

  return <Link {...presentation} href={link.url}>{children}</Link>
}
