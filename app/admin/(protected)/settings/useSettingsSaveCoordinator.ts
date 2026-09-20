'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useToast } from '@/components/Toast'
import { createSettingsSaveCoordinator, type SettingsValues } from '@/lib/settings-save-coordinator'

export function useSettingsSaveCoordinator(initial: SettingsValues) {
  const toast = useToast()
  // Construction is inert. The page effect owns activation, including StrictMode replay.
  const [coordinator] = useState(() => createSettingsSaveCoordinator(initial, async (key, value) => {
    const response = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    if (!response.ok) throw new Error('保存失败')
  }, notice => toast[notice.type](notice.message, notice.action ? 5000 : undefined, notice.action)))
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  useEffect(() => {
    coordinator.activate()
    return () => coordinator.dispose()
  }, [coordinator])
  return { state, edit: coordinator.edit }
}
