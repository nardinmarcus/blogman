'use client'

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { RuntimeCapabilities } from '@/lib/runtime-capabilities'
import { RuntimeCapabilitiesPanel } from './RuntimeCapabilitiesPanel'

// 与 mockup 一致：Queues / Workers AI / Vectorize 视为可选增强能力
const OPTIONAL_BINDINGS = ['queue', 'workersAI', 'vectorize'] as const

export function RuntimeStatusStrip({ capabilities }: { capabilities: RuntimeCapabilities }) {
  const unboundOptional = OPTIONAL_BINDINGS.filter((key) => !capabilities.bindings[key]).length
  const degradedCount = Object.values(capabilities.features).filter((f) => !f.enabled).length
  // 有降级能力时默认展开，让管理员第一眼看到问题
  const [expanded, setExpanded] = useState(degradedCount > 0)
  const detailId = useId()

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--editor-line)] bg-[var(--editor-panel)] px-4 py-2.5 text-left text-sm text-[var(--editor-muted)] transition-colors hover:text-[var(--editor-ink)]"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${degradedCount > 0 ? 'bg-amber-500' : 'bg-emerald-600'}`}
          aria-hidden="true"
        />
        {degradedCount > 0
          ? `${degradedCount} 项能力已降级`
          : `运行环境正常 · ${unboundOptional} 项可选能力未绑定`}
        <ChevronRight
          className={`ml-auto h-4 w-4 shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>
      <div id={detailId} hidden={!expanded} className="mt-3">
        <RuntimeCapabilitiesPanel capabilities={capabilities} />
      </div>
    </div>
  )
}
