'use client'

/**
 * B2-05 — shared command transport + local draft store (issue #28).
 *
 * The wire adapter between the `EditorSaveCoordinator` and the B2-04
 * `/api/article-commands` route. Both the main editor (NovelEditor) and the
 * inline public editor (InlineArticleEditor) consume this same transport so
 * the two share the exact save-confirmation and conflict protocol: save
 * submits the FULL authoring snapshot + expected version + a stable operation
 * id; a conflict returns the current server version + comparison facts and is
 * never auto-merged.
 *
 * The local draft store is parameterized by a namespace so each editor family
 * keeps its own per-article unconfirmed drafts (main editor vs. inline editor
 * never clobber each other's slots).
 */

import type { CommandTransport, LocalDraftRecord, LocalDraftStore } from '@/lib/editor-save-coordinator'

/** Transport over the B2-04 versioned command route. */
export function createCommandTransport(): CommandTransport {
  async function post(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await fetch('/api/article-commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '保存失败')
    return data
  }
  return {
    create({ creationId, snapshot }) {
      return post('create', { creationId, snapshot }) as ReturnType<CommandTransport['create']>
    },
    save(payload) {
      return post('save', payload) as ReturnType<CommandTransport['save']>
    },
    publishTemp(payload) {
      return post('publishTemp', payload) as ReturnType<CommandTransport['publishTemp']>
    },
    async getServerSnapshot({ articleId }) {
      const res = await fetch(`/api/article-commands?articleId=${encodeURIComponent(String(articleId))}`)
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '读取失败')
      return data as never
    },
  }
}

/**
 * localStorage draft store. `namespace` isolates editor families (default
 * keeps the existing main-editor slots byte-for-byte identical).
 */
export function createLocalDraftStore(namespace = 'editor-draft'): LocalDraftStore {
  const ns = (key: string) => `blogman:${namespace}:${key}`
  return {
    load(key) {
      try {
        const raw = window.localStorage.getItem(ns(key))
        return raw ? (JSON.parse(raw) as LocalDraftRecord) : null
      } catch {
        return null
      }
    },
    save(key, record) {
      try {
        window.localStorage.setItem(ns(key), JSON.stringify(record))
      } catch {
        /* storage full / blocked — ignore */
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(ns(key))
      } catch {
        /* ignore */
      }
    },
  }
}
