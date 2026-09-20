/** Page-local coordination for the four automatically saved settings. Values stay raw. */
export type SettingsKey = 'nav_links' | 'custom_js' | 'default_theme' | 'body_font'
export type SettingsValues = Record<SettingsKey, string>
export interface SettingsNotice {
  type: 'success' | 'error'
  message: string
  action?: { label: string; onClick: () => void }
}
interface KeySnapshot {
  draft: string
  acknowledged: string
  busy: boolean
}
export type SettingsSnapshot = Record<SettingsKey, KeySnapshot>
interface EditOptions {
  debounce?: boolean
  label?: string
}
interface Intent {
  value: string
  revision: number
  kind: 'save' | 'undo'
  label: string
}
interface KeyState {
  revision: number
  pending?: Intent
  inFlight?: Intent
  timer?: ReturnType<typeof setTimeout>
  action?: object
}
const keys: SettingsKey[] = ['nav_links', 'custom_js', 'default_theme', 'body_font']

export function createSettingsSaveCoordinator(
  initial: SettingsValues,
  persist: (key: SettingsKey, value: string) => Promise<void>,
  notify: (notice: SettingsNotice) => void,
) {
  let snapshot = Object.fromEntries(keys.map(key => [key, {
    draft: initial[key], acknowledged: initial[key], busy: false,
  }])) as SettingsSnapshot
  const states = Object.fromEntries(keys.map(key => [key, { revision: 0 }])) as Record<SettingsKey, KeyState>
  const listeners = new Set<() => void>()
  let active = false
  let lifetime = 0

  function update(key: SettingsKey, patch: Partial<KeySnapshot>) {
    snapshot = { ...snapshot, [key]: { ...snapshot[key], ...patch } }
    listeners.forEach(listener => listener())
  }

  // Actions are one-use receipts. Editing, retrying or leaving the page revokes them.
  function action(key: SettingsKey, intent: Intent, label: string) {
    const state = states[key]
    const token = {}
    const issuedLifetime = lifetime
    state.action = token
    return { label, onClick: () => {
      if (!active || lifetime !== issuedLifetime || state.action !== token || state.revision !== intent.revision) return
      state.action = undefined
      state.pending = intent
      pump(key)
    } }
  }

  function pump(key: SettingsKey) {
    const state = states[key]
    if (!active || state.inFlight || state.timer !== undefined || !state.pending) return
    const intent = state.pending
    state.pending = undefined
    const before = snapshot[key].acknowledged
    if (intent.value === before) return
    state.inFlight = intent
    const startedLifetime = lifetime
    update(key, { busy: true })
    // Capture sync transport errors too; no fire-and-forget rejection escapes.
    void (async () => {
      let succeeded = false
      try {
        await persist(key, intent.value)
        succeeded = true
      } catch {
        // The failure policy below depends on key, intent and current revision.
      }
      if (!active || lifetime !== startedLifetime) return
      state.inFlight = undefined
      const current = state.revision === intent.revision
      if (succeeded) {
        update(key, {
          acknowledged: intent.value,
          busy: false,
          ...(current && intent.kind === 'undo' ? { draft: intent.value } : {}),
        })
        if (current) {
          notify(intent.kind === 'undo'
            ? { type: 'success', message: '已撤销' }
            : { type: 'success', message: intent.label, action: action(key, { ...intent, kind: 'undo', value: before }, '撤销') })
        }
      } else {
        const restore = current && intent.kind === 'save' && (key === 'default_theme' || key === 'body_font')
        update(key, { busy: false, ...(restore ? { draft: before } : {}) })
        if (current) {
          notify({
            type: 'error', message: intent.kind === 'undo' ? '撤销失败，请重试' : '保存失败',
            ...(!restore ? { action: action(key, intent, '重试') } : {}),
          })
        }
      }
      pump(key)
    })()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    activate: () => { active = true },
    edit: (key: SettingsKey, value: string, options: EditOptions = {}) => {
      if (!active || value === snapshot[key].draft) return
      const state = states[key]
      state.revision++
      state.action = undefined
      clearTimeout(state.timer)
      state.timer = undefined
      state.pending = { value, revision: state.revision, kind: 'save', label: options.label ?? '已自动保存' }
      update(key, { draft: value })
      if (options.debounce) {
        state.timer = setTimeout(() => {
          state.timer = undefined
          pump(key)
        }, 1000)
      } else pump(key)
    },
    dispose: () => {
      active = false
      lifetime++
      for (const key of keys) {
        const state = states[key]
        clearTimeout(state.timer)
        state.timer = undefined
        state.pending = undefined
        state.action = undefined
        // Already-issued writes may still reach storage. Their completions are detached.
      }
    },
  }
}
