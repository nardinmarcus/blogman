/**
 * B4-04 — "today" workbench read-model types (issue #43).
 *
 * The today workbench is a REBUILDABLE READ ONLY projection grouped by
 * responsible party (author vs system). It is derived fresh from the
 * authoritative fact tables (`articles`, `article_versions`, `publish_schedules`,
 * `formal_publications`) on every read — it never writes to a source table
 * and is never a recovery source. Rebuilding just re-queries; disabling the
 * projection (a single control flag) stops presenting it without touching any
 * source task or schedule fact.
 *
 * Grouping contract (责任方 → 组):
 *
 *   - author · drafts        — draft articles (latest canonical version snapshot
 *                              fields.status = 'draft')
 *   - author · schedules     — future version-bound publish intents the author
 *                              armed (`publish_schedules.status = 'pending'`)
 *   - system · in-progress   — intents the system is currently processing
 *                              (claimed / leased rows)
 *   - author · todos         — intents that need the author to act (stale
 *                              version drift / paused), never auto-fired
 */

export type ResponsibleParty = 'author' | 'system'
export type WorkbenchGroup =
  | 'drafts'
  | 'schedules'
  | 'system-in-progress'
  | 'author-todos'

/** One entry of the workbench — always traceable to an authoritative source. */
export interface WorkbenchEntry {
  /** Stable local key: `<group>:<sourceType>:<sourceId>`. */
  key: string
  group: WorkbenchGroup
  responsible: ResponsibleParty
  /** Authoritative source kind this entry points at. */
  sourceType: 'article' | 'schedule'
  /** Authoritative source id (article id / schedule id). */
  sourceId: string
  title: string
  /** Extra current-state facts (never stale parameters). */
  meta: Record<string, unknown>
  updatedAt: number
}

export interface WorkbenchGroupView {
  group: WorkbenchGroup
  responsible: ResponsibleParty
  label: string
  items: WorkbenchEntry[]
}

export interface TodayWorkbench {
  projectionEnabled: boolean
  generatedAt: number
  groups: WorkbenchGroupView[]
  /** For internal recompute-testing: what was this built from. */
  _facts?: { articles: number; schedules: number }
}

export interface WorkbenchBuildInput {
  now?: number
}

/** Single-row control toggle for the workbench projection (additive only). */
export interface WorkbenchControlRow {
  id: number
  key: string
  enabled: number
  updated_at: number
}

export type SetWorkbenchEnabledResult =
  | { outcome: 'enabled'; key: 'workbench'; enabled: true; updatedAt: number }
  | { outcome: 'disabled'; key: 'workbench'; enabled: false; updatedAt: number }
