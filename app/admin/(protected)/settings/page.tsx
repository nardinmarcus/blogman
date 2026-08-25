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
      <div className="space-y-1.5">
        <h1
          className="text-2xl font-medium text-[var(--editor-ink)]"
          style={{ fontFamily: 'Georgia, serif' }}
        >
          站点设置
        </h1>
        <p className="flex items-center gap-2 text-sm text-[var(--editor-muted)]">
          <span className="h-2 w-2 rounded-full bg-emerald-600" aria-hidden="true" />
          所有更改自动保存，可撤销
        </p>
      </div>
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
