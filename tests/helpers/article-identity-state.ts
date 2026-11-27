/**
 * Shared D1 state helpers: a real local D1 (wrangler d1 execute --local
 * --persist-to) migrated through the full ledger.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const repoRoot = process.cwd()
export const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
export const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
export const configPath = join(repoRoot, 'wrangler.toml')

const stateDirectories: string[] = []

export function createState(): string {
  const state = mkdtempSync(join(tmpdir(), 'blogman-article-shadow-'))
  stateDirectories.push(state)
  return state
}

export function cleanupStates(): void {
  for (const state of stateDirectories.splice(0)) rmSync(state, { recursive: true, force: true })
}

export function spawnOk(label: string, args: string[], cwd = repoRoot): string {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

export function applyLedger(state: string): void {
  spawnOk('migrations apply', [
    process.execPath, runnerPath, 'apply', '--candidate', 'a'.repeat(40),
    '--database', 'DB', '--local', '--persist-to', state, '--config', configPath,
  ])
}

export function runD1(state: string, sql: string): Array<{ results?: unknown[]; success?: boolean }> {
  const result = spawnSync(wranglerPath, [
    'd1', 'execute', 'DB', '--local', '--persist-to', state,
    '--config', configPath, '--command', sql, '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout || result.stderr)
  return JSON.parse(result.stdout) as Array<{ results?: unknown[]; success?: boolean }>
}

export function query<T>(state: string, sql: string): T[] {
  return (runD1(state, sql).at(-1)?.results || []) as T[]
}

export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}
