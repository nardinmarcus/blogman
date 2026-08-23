import { getAppCloudflareEnv } from '@/lib/cloudflare'
import { getSetting } from '@/lib/db'
import { detectRuntimeCapabilities } from '@/lib/runtime-capabilities'
import { rethrowIfDatabaseMigrationRequired } from '@/lib/database-errors'
import { SettingsManager } from './SettingsManager'

export const metadata = { title: '站点设置' }

export default async function SettingsPage() {
  let navLinks = ''
  let customJs = ''
  let bodyFont = ''
  let defaultTheme = ''
  let runtimeCapabilities = detectRuntimeCapabilities()

  try {
    const env = await getAppCloudflareEnv()
    runtimeCapabilities = detectRuntimeCapabilities(env)
    if (env?.DB) {
      navLinks = (await getSetting(env.DB, 'nav_links')) || ''
      customJs = (await getSetting(env.DB, 'custom_js')) || ''
      bodyFont = (await getSetting(env.DB, 'body_font')) || ''
      defaultTheme = (await getSetting(env.DB, 'default_theme')) || ''
    }
  } catch (error) {
    rethrowIfDatabaseMigrationRequired(error)
  }

  return (
    <div className="space-y-6">
      <h1
        className="text-2xl font-medium text-[var(--editor-ink)]"
        style={{ fontFamily: 'Georgia, serif' }}
      >
        站点设置
      </h1>
      <SettingsManager
        initialNavLinks={navLinks}
        initialCustomJs={customJs}
        initialBodyFont={bodyFont}
        initialDefaultTheme={defaultTheme}
        initialRuntimeCapabilities={runtimeCapabilities}
      />
    </div>
  )
}
