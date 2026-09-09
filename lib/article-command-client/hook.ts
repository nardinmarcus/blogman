'use client'

/**
 * Article Command Client — React interface (CONTEXT.md).
 *
 * Thin glue over the pure client: owns loading, toasts, and the refresh
 * strategy so callers declare intent and react to the normalized result
 * only. Refresh semantics (matching the behaviour the list used to inline):
 *
 *  - success: caller-driven — pass `refresh` to toast + refresh in one
 *    step (the password flow uses `'reload'`), or omit it and refresh
 *    yourself after `ok`;
 *  - failure (conflict / server error): always refreshed (default
 *    `'router'`) so stale rows never linger — this fixes the PasswordModal
 *    bug where a conflict left a stale `version` prop and every retry
 *    re-conflicted until a manual reload.
 */

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/Toast'
import { createArticleCommandClient } from './client'
import type {
  ArticleCommandOutcome,
  ArticleCommandRequest,
  ArticleCommandTarget,
  BatchCategoryItem,
  BatchCategoryOutcome,
  RefreshStrategy,
} from './types'

const CONFLICT_TOAST = '版本冲突：这篇文章已被他人修改，未应用改动，请刷新后重试'

export interface UseArticleCommandOptions {
  /** Bind the hook to one row; omit for batch-only usage. */
  target?: ArticleCommandTarget
}

export interface RunOptions {
  successMsg?: string
  refresh?: RefreshStrategy
}

export function useArticleCommand(options: UseArticleCommandOptions = {}) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const toast = useToast()
  const client = useMemo(() => createArticleCommandClient(), [])

  const applyRefresh = useCallback(
    (strategy: RefreshStrategy | undefined) => {
      const s = strategy ?? 'router'
      if (s === 'router') router.refresh()
      else if (s === 'reload') window.location.reload()
      else if (typeof s === 'function') s()
      // 'none' — intentionally nothing
    },
    [router],
  )

  const run = useCallback(
    async (request: ArticleCommandRequest, opts: RunOptions = {}): Promise<ArticleCommandOutcome> => {
      if (!options.target) throw new Error('useArticleCommand: target 未绑定（批量用法请用 runBatch）')
      setLoading(true)
      try {
        const result = await client.execute(options.target, request)
        if (result.kind === 'ok') {
          if (opts.successMsg) toast.success(opts.successMsg)
          if (opts.refresh && opts.refresh !== 'none') applyRefresh(opts.refresh)
          return result
        }
        if (result.kind === 'conflict') toast.error(CONFLICT_TOAST)
        else toast.error(result.message)
        if (opts.refresh !== 'none') applyRefresh(opts.refresh)
        return result
      } finally {
        setLoading(false)
      }
    },
    [client, options.target, toast, applyRefresh],
  )

  const runBatch = useCallback(
    async (items: BatchCategoryItem[]): Promise<BatchCategoryOutcome> => {
      setLoading(true)
      try {
        const result = await client.runBatchCategory(items)
        if (result.ok) {
          const { applied, conflicts, skipped } = result
          if (conflicts > 0 || skipped > 0) {
            toast.error(`部分文章冲突或失败：成功 ${applied}，冲突 ${conflicts}，其他 ${skipped}。冲突的文章未被覆盖，请刷新后重试。`)
          } else {
            toast.success(`已批量更新 ${applied} 篇文章的分类`)
          }
          router.refresh()
        } else {
          toast.error(result.message)
        }
        return result
      } finally {
        setLoading(false)
      }
    },
    [client, toast, router],
  )

  return { run, runBatch, loading }
}
