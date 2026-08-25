import { ReactNode } from 'react'

interface SettingsSectionProps {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}

export function SettingsSection({ title, description, action, children }: SettingsSectionProps) {
  return (
    <section className="rounded-2xl border border-[var(--editor-line)] bg-[var(--editor-panel)] p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--editor-ink)]">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-[var(--editor-muted)]">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
