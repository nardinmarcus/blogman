/**
 * B4-04 — "today" workbench public entry (issue #43).
 *
 * A READ ONLY, rebuildable today-projection grouped by responsible party.
 * Rebuilding is re-querying authoritative facts; disabling the projection only
 * flips a control flag and never touches a source draft, schedule or publish
 * fact — the projection is never a recovery source.
 */

export {
  buildTodayWorkbench,
  setWorkbenchEnabled,
} from './kernel'
export type {
  ResponsibleParty,
  SetWorkbenchEnabledResult,
  TodayWorkbench,
  WorkbenchBuildInput,
  WorkbenchGroup,
  WorkbenchGroupView,
  WorkbenchEntry,
} from './types'
export { ensureWorkbenchTables, WORKBENCH_DDL_STATEMENTS } from './ddl'
