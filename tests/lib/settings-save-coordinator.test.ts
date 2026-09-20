import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsSaveCoordinator, type SettingsNotice, type SettingsKey } from '@/lib/settings-save-coordinator'

function fixture(initial = {}) {
  const calls: { key: SettingsKey; value: string; resolve: () => void; reject: () => void }[] = []
  const notices: SettingsNotice[] = []
  const coordinator = createSettingsSaveCoordinator({ nav_links: '', custom_js: '', default_theme: '', body_font: '', ...initial },
    (key, value) => new Promise<void>((resolve, reject) => calls.push({ key, value, resolve, reject: () => reject(new Error('offline')) })),
    notice => notices.push(notice))
  coordinator.activate()
  const finish = async (index: number, ok = true) => {
    if (ok) calls[index].resolve(); else calls[index].reject()
    await Promise.resolve(); await Promise.resolve()
  }
  return { c: coordinator, calls, notices, finish, state: (key: SettingsKey = 'custom_js') => coordinator.getSnapshot()[key] }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('page-owned raw settings coordination', () => {
  it('serializes each key, coalesces unsent intent, and runs other keys independently', async () => {
    const { c, calls, notices, finish, state } = fixture()
    c.edit('custom_js', 'a'); c.edit('custom_js', 'b'); c.edit('custom_js', 'c')
    c.edit('body_font', 'serif')
    expect(calls.map(x => [x.key, x.value])).toEqual([['custom_js', 'a'], ['body_font', 'serif']])
    await finish(0)
    expect(notices).toHaveLength(0)
    expect(state().draft).toBe('c')
    expect(calls[2].value).toBe('c')
    await finish(2)
    expect(state().acknowledged).toBe('c')
    notices[0].action!.onClick()
    expect(calls[3].value).toBe('a')
  })

  it('debounces for one second and lets an immediate action replace the scheduled write', async () => {
    const { c, calls } = fixture()
    c.edit('nav_links', 'a', { debounce: true })
    vi.advanceTimersByTime(999); expect(calls).toHaveLength(0)
    c.edit('nav_links', 'b', { debounce: true })
    vi.advanceTimersByTime(999); expect(calls).toHaveLength(0)
    vi.advanceTimersByTime(1); expect(calls[0].value).toBe('b')
    c.edit('nav_links', 'c', { debounce: true })
    c.edit('nav_links', 'd')
    vi.advanceTimersByTime(1000); expect(calls).toHaveLength(1)
  })

  it('does not flush a newer debounce early when the in-flight write completes', async () => {
    const { c, calls, finish } = fixture()
    c.edit('custom_js', 'a'); c.edit('custom_js', 'b', { debounce: true })
    await finish(0); expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(1000); expect(calls[1].value).toBe('b')
  })

  it.each(['', '{malformed', 'unknown-raw'])('undo restores exact raw baseline %j only after acknowledgement', async raw => {
    const { c, calls, notices, finish, state } = fixture({ nav_links: raw })
    c.edit('nav_links', '[]'); await finish(0)
    const undo = notices[0].action!.onClick
    undo(); undo()
    expect(calls).toHaveLength(2)
    expect(calls[1].value).toBe(raw)
    expect(state('nav_links').draft).toBe('[]')
    await finish(1, false)
    expect(state('nav_links').acknowledged).toBe('[]')
    const retry = notices.at(-1)!.action!.onClick
    retry(); retry(); expect(calls).toHaveLength(3)
    await finish(2)
    expect(state('nav_links').draft).toBe(raw)
    expect(state('nav_links').acknowledged).toBe(raw)
  })

  it('invalidates undo and failed retry as soon as a new draft exists', async () => {
    const { c, calls, notices, finish } = fixture()
    c.edit('custom_js', 'a'); await finish(0)
    const undo = notices[0].action!.onClick
    c.edit('custom_js', 'b', { debounce: true }); undo()
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(1000); await finish(1, false)
    const retry = notices.at(-1)!.action!.onClick
    c.edit('custom_js', 'c', { debounce: true }); retry()
    expect(calls).toHaveLength(2)
    vi.advanceTimersByTime(1000); expect(calls[2].value).toBe('c')
  })

  it.each([true, false])('preserves a newer draft while undo is pending (success=%s)', async ok => {
    const { c, calls, notices, finish, state } = fixture({ custom_js: 'original' })
    c.edit('custom_js', 'a'); await finish(0)
    notices[0].action!.onClick()
    c.edit('custom_js', 'b', { debounce: true })
    await finish(1, ok)
    expect(state().draft).toBe('b')
    expect(state().acknowledged).toBe(ok ? 'original' : 'a')
    expect(notices).toHaveLength(1)
    vi.advanceTimersByTime(1000); expect(calls[2].value).toBe('b')
    await finish(2)
    notices.at(-1)!.action!.onClick()
    expect(calls[3].value).toBe(ok ? 'original' : 'a')
  })

  it('preserves text failures for explicit retry but restores ordinary appearance failures', async () => {
    const { c, notices, calls, finish, state } = fixture({ default_theme: 'raw-theme' })
    c.edit('default_theme', 'editorial'); c.edit('custom_js', 'a')
    await finish(0, false); await finish(1, false)
    expect(state('default_theme').draft).toBe('raw-theme')
    expect(state().draft).toBe('a')
    expect(notices[0].action).toBeUndefined()
    vi.advanceTimersByTime(10000); expect(calls).toHaveLength(2)
    notices[1].action!.onClick(); await finish(2)
    expect(state().acknowledged).toBe('a')
  })

  it('does not restore a failed older appearance write over a newer intent', async () => {
    const { c, calls, notices, finish, state } = fixture()
    c.edit('default_theme', 'editorial'); c.edit('default_theme', 'terminal')
    await finish(0, false)
    expect(state('default_theme').draft).toBe('terminal')
    expect(calls[1].value).toBe('terminal')
    expect(notices).toHaveLength(0)
  })

  it('serializes a return to the initial value behind an unacknowledged write', async () => {
    const { c, calls, finish, state } = fixture()
    c.edit('custom_js', 'a'); c.edit('custom_js', '')
    await finish(0); expect(calls[1].value).toBe('')
    await finish(1); expect(state().acknowledged).toBe('')
  })

  it('disposes timers, unsent intents, notices and action authority without retracting dispatched writes', async () => {
    const { c, calls, notices, finish } = fixture()
    c.edit('body_font', 'serif'); await finish(0)
    const undo = notices[0].action!.onClick
    c.edit('custom_js', 'a'); c.edit('custom_js', 'b')
    c.edit('nav_links', '[]', { debounce: true })
    c.dispose(); undo(); vi.advanceTimersByTime(1000); await finish(1)
    expect(calls).toHaveLength(2)
    expect(notices).toHaveLength(1)
  })

  it('allows effect setup/cleanup/setup before interaction without reviving old actions', async () => {
    const { c, calls, finish, notices } = fixture()
    c.dispose(); c.activate(); c.edit('custom_js', 'a'); await finish(0)
    const undo = notices[0].action!.onClick
    c.dispose(); c.activate(); undo()
    expect(calls).toHaveLength(1)
  })

  it('retains an undo receipt across edits of a different key', async () => {
    const { c, calls, notices, finish } = fixture()
    c.edit('custom_js', 'a'); await finish(0)
    c.edit('nav_links', '[]')
    notices[0].action!.onClick()
    expect(calls.map(x => [x.key, x.value])).toEqual([['custom_js', 'a'], ['nav_links', '[]'], ['custom_js', '']])
  })

  it('does not mutate snapshots or notify subscribers after disposal', async () => {
    const { c, finish } = fixture()
    const subscriber = vi.fn()
    c.subscribe(subscriber)
    c.edit('custom_js', 'a')
    c.dispose()
    const detached = c.getSnapshot()
    subscriber.mockClear()
    await finish(0)
    c.edit('custom_js', 'b')
    expect(c.getSnapshot()).toBe(detached)
    expect(subscriber).not.toHaveBeenCalled()
  })

})
