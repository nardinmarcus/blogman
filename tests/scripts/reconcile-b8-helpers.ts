/**
 * B8-G — shared state helpers for the batch-8 acceptance fixture tests
 * (issue #65).
 *
 * Every fixture state is built purely through `wrangler d1 execute --local
 * --persist-to <dir>` — the exact same channel `scripts/reconcile-b8-facts.mjs`
 * reads. Zero production: everything is local / tmpdir; the reconciler only
 * ever issues SELECT statements.
 *
 * `applyB8Schema(state)` brings up the six mobile-matrix surfaces the
 * reconciler reads — article identity (本机稿), first-publish (发布回据),
 * publish-suggestions (建议生命周期), scheduled-publish + schedule-control
 * (排期命令), activity-notifications (导航/深链), and source-conflict
 * (三向冲突选边) — through the same DDL the deployment channels ship.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configPath,
  repoRoot,
  runD1,
  spawnOk,
  wranglerPath,
} from '@/tests/helpers/article-identity-state'

export { configPath, repoRoot, runD1, wranglerPath, spawnOk }

export const CANDIDATE = 'b8'.padEnd(40, '8')

export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** A 64-hex fake hash for fields that must merely be well-formed. */
export function h64(seed: string): string {
  return sha256(seed).padEnd(64, seed[0] ?? '0')
}

/**
 * Bring up the full batch-8 schema on a wrangler-persisted state via the DDL
 * channels the deployment scripts ship. `publish_schedules` / `publish_attempts`
 * / `schedule_control_ops` / `activity_notifications` are applied through the
 * exact module SQL (the scheduled-publish CLI's PRAGMA probe mis-ALTERs a
 * fresh install and control/notification have no dedicated apply CLI in this
 * fixture), matching the B4-03 approach.
 */
export function applyB8Schema(state: string): void {
  spawnOk('ledger apply', [
    process.execPath, join(repoRoot, 'scripts', 'migrations.mjs'), 'apply',
    '--candidate', CANDIDATE, '--database', 'DB', '--local', '--persist-to', state, '--config', configPath,
  ])
  spawnOk('article-identity ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-article-identity-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('envelope ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-content-envelope-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('first-publish ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-first-publish-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('publish-suggestions ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-publish-suggestions-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('source-identity ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-source-identity-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  spawnOk('conflict ddl', [
    process.execPath, join(repoRoot, 'scripts', 'apply-conflict-ddl.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
  ])
  // Scheduled tables + control + notifications via the exact module SQL.
  runD1(state, [
    `CREATE TABLE IF NOT EXISTS publish_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL CHECK(length(schedule_id) > 0),
      article_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scheduled_at INTEGER NOT NULL CHECK(scheduled_at > 0),
      timezone TEXT NOT NULL CHECK(length(timezone) > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'paused', 'fired', 'stale', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      lease_token TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      stale_reason TEXT,
      fired_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS idx_publish_schedules_due
      ON publish_schedules(status, scheduled_at)`,
    `CREATE TABLE IF NOT EXISTS publish_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT UNIQUE NOT NULL CHECK(length(attempt_key) > 0),
      schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
      attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
      started_at INTEGER NOT NULL CHECK(started_at > 0),
      finished_at INTEGER,
      outcome TEXT CHECK(outcome IN ('fired', 'stale', 'retried', 'failed', 'abandoned', 'cancelled')),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(schedule_id, attempt_no)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS idx_publish_attempts_schedule
      ON publish_attempts(schedule_id, attempt_no)`,
    `CREATE TABLE IF NOT EXISTS activity_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id TEXT UNIQUE NOT NULL CHECK(length(notification_id) > 0),
      source_type TEXT NOT NULL CHECK(length(source_type) > 0),
      source_id TEXT NOT NULL CHECK(length(source_id) > 0),
      title TEXT NOT NULL CHECK(length(title) > 0),
      detail TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS idx_activity_notifications_source
      ON activity_notifications(source_type, source_id)`,
    `CREATE TABLE IF NOT EXISTS schedule_control_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
      schedule_id TEXT NOT NULL CHECK(length(schedule_id) > 0),
      action TEXT NOT NULL CHECK(action IN ('pause', 'reconfirm', 'reschedule', 'cancel', 'publish_now')),
      result TEXT NOT NULL CHECK(length(result) > 0),
      created_at INTEGER NOT NULL
    ) STRICT`,
  ].join(';\n'))
}

/* ------------------------------------------------------------------ */
/* state dirs + reconcile runner                                       */
/* ------------------------------------------------------------------ */

const stateDirs: string[] = []

/** Create an empty state directory (wrangler `--persist-to` root). */
export function createWranglerState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogman-b8-state-'))
  stateDirs.push(dir)
  return dir
}

export interface ReconcileResult {
  status: number
  stdout: string
  stderr: string
}

export function runReconcileB8(
  state: string,
  report: string,
  extra: string[] = [],
): ReconcileResult {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts', 'reconcile-b8-facts.mjs'),
    '--local', '--persist-to', state, '--database', 'DB', '--config', configPath,
    '--report', report, ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** Tear down every tmpdir created by this file (call in afterAll). */
export function cleanupB8State(): void {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
