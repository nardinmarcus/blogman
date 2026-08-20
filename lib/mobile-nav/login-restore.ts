/**
 * B8-01 — deep-link post-login restoration (issue #60).
 *
 * A deep link is just an identity carried in the URL (e.g. `/admin/today?focus=…`).
 * When an unauthenticated user opens one, the protected layout forwards them to
 * login with a `redirect_to` computed from the ORIGINAL path+query so the target
 * is restored after auth. `safeRedirectTarget` is the shared guard: it only ever
 * accepts a same-origin absolute path, preserving the deep-link query string, and
 * falls back to the today workbench when presented with an external / protocol-
 * relative / otherwise unsafe target. Pure and unit-testable.
 */

export const LOGIN_FALLBACK_TARGET = '/admin/today'

/**
 * Sanitize a redirect target for the post-login hop. Accepts only same-origin
 * absolute paths (so `/admin/today?focus=article:5` is preserved) and rejects
 * external URLs, protocol-relative `//`, and backslash tricks.
 */
export function safeRedirectTarget(
  raw: string | null | undefined,
  fallback: string = LOGIN_FALLBACK_TARGET,
): string {
  if (!raw) return fallback
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  return raw
}
