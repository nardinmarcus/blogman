/**
 * B6-05 — 保留关系地报告主要源稿不可用 (issue #54).
 *
 * Public surface for availability observation of a writable primary source:
 * durable, idempotent read observations kept separate from sync facts, a
 * gated report that only exposes the four sync conclusions on a reliable
 * readable read, and guards that unavailability never advances the
 * version/baseline, never unlinks, never deletes relationship media, and
 * never blocks publishing.
 */

export * from './types'
export * from './ddl'
export * from './kernel'
