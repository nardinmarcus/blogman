/**
 * #245 — public date rendering, pinned to the site display time zone.
 *
 * Production workerd renders in UTC while browsers run in the reader's
 * zone: without an explicit timeZone the two disagree for any timestamp
 * crossing local midnight, which surfaced as React hydration error #418
 * (server "9月9日" vs hydrated "9月10日"). All public formatters format in
 * Asia/Shanghai (the authoring convention) so SSR and client agree, and
 * parts are taken via formatToParts — never local getters or locale-string
 * splitting.
 */

const SITE_TIME_ZONE = 'Asia/Shanghai'

interface DateParts {
  year: string
  month: string
  day: string
}

function dateParts(ts: number): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts * 1000))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** zh-CN short — home cards, search results, article meta, related cards. */
export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** zh-CN long — VariantB article dates. */
export function formatDateLong(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** "MM.DD" — VariantA sidebar dates. */
export function formatDateShort(ts: number): string {
  const { month, day } = dateParts(ts)
  return `${month}.${day}`
}

/** Year number — VariantA dates. */
export function formatYear(ts: number): number {
  return Number(dateParts(ts).year)
}

/** "YYYY-MM-DD" — VariantC compact dates. */
export function formatDateCompact(ts: number): string {
  const { year, month, day } = dateParts(ts)
  return `${year}-${month}-${day}`
}
