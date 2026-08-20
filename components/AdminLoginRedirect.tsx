'use client'

import { useEffect } from 'react'
import { safeRedirectTarget } from '@/lib/mobile-nav/login-restore'

/**
 * B8-01 — unauthenticated deep-link forwarder (issue #60).
 *
 * Rendered by the admin protected layout in place of the page subtree when no
 * valid session exists. It preserves the ORIGINAL path + query (the deep-link
 * identity) into `redirect_to` so that, after login, the user is restored to
 * the exact target and that page RE-READS current state. The page subtree is
 * NEVER executed in the unauthenticated case, so nothing is fetched and no
 * command can run.
 */
export function AdminLoginRedirect() {
  useEffect(() => {
    const current = window.location.pathname + window.location.search
    const target = safeRedirectTarget(current)
    window.location.replace(`/admin/login?redirect_to=${encodeURIComponent(target)}`)
  }, [])

  return null
}
