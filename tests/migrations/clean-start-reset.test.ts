import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const migrationRunnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
const resetSqlPath = join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')
const stateDirectories: string[] = []

function createState(): string {
  const state = mkdtempSync(join(tmpdir(), 'blogman-clean-start-reset-'))
  stateDirectories.push(state)
  return state
}

function runMigration(state: string, action: 'apply' | 'plan') {
  return spawnSync(process.execPath, [
    migrationRunnerPath,
    action,
    '--database', 'DB',
    '--local',
    '--persist-to', state,
    '--config', join(repoRoot, 'wrangler.toml'),
    ...(action === 'apply' ? ['--candidate', 'a'.repeat(40)] : []),
  ], { cwd: repoRoot, encoding: 'utf8' })
}

function executeSql(state: string, args: ['--file', string] | ['--command', string]) {
  return spawnSync(wranglerPath, [
    'd1', 'execute', 'DB',
    '--local',
    '--persist-to', state,
    '--config', join(repoRoot, 'wrangler.toml'),
    ...args,
    '--json',
  ], { cwd: repoRoot, encoding: 'utf8' })
}

function applicationObjects(state: string): Array<{ name: string; type: string }> {
  const result = executeSql(state, ['--command', `
    SELECT name, type FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
      AND NOT (
        type = 'table'
        AND (name, tbl_name) IN (('_cf_KV', '_cf_KV'), ('_cf_METADATA', '_cf_METADATA'))
      )
    ORDER BY type, name
  `])
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)[0].results
}

function internalAllowlistProbe(state: string): Array<{ name: string; type: string }> {
  const result = executeSql(state, ['--command', `
    WITH objects(type, name, tbl_name) AS (VALUES
      ('table', '_cf_KV', '_cf_KV'),
      ('table', '_cf_METADATA', '_cf_METADATA'),
      ('table', '_cf_unknown', '_cf_unknown')
    )
    SELECT name, type FROM objects
    WHERE NOT (
      type = 'table'
      AND (name, tbl_name) IN (('_cf_KV', '_cf_KV'), ('_cf_METADATA', '_cf_METADATA'))
    )
    ORDER BY type, name
  `])
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)[0].results
}

afterEach(() => {
  for (const state of stateDirectories.splice(0)) rmSync(state, { recursive: true, force: true })
})

describe('Issue #23 clean-start reset', () => {
  it('removes only the canonical Blogman schema and returns plan 001-006 as empty-database apply', () => {
    const state = createState()
    const applied = runMigration(state, 'apply')
    expect(applied.status, applied.stderr).toBe(0)
    expect(applicationObjects(state).length).toBeGreaterThan(0)

    const mutatedReset = join(state, 'reset-without-posts.sql')
    writeFileSync(
      mutatedReset,
      readFileSync(resetSqlPath, 'utf8').replace('DROP TABLE IF EXISTS posts;\n', ''),
    )
    expect(executeSql(state, ['--file', mutatedReset]).status).toBe(0)
    expect(applicationObjects(state)).toContainEqual({ name: 'posts', type: 'table' })

    const reset = executeSql(state, ['--file', resetSqlPath])
    expect(reset.status, reset.stderr).toBe(0)
    expect(applicationObjects(state)).toEqual([])

    const plan = runMigration(state, 'plan')
    expect(plan.status, plan.stderr).toBe(0)
    expect(JSON.parse(plan.stdout)).toMatchObject({
      state: 'pending',
      applied: [],
      pending: [
        { number: 1, action: 'apply' },
        { number: 2, action: 'apply' },
        { number: 3, action: 'apply' },
        { number: 4, action: 'apply' },
        { number: 5, action: 'apply' },
        { number: 6, action: 'apply' },
      ],
    })

    expect(executeSql(state, ['--command', 'CREATE TABLE foreign_owner_data (id INTEGER PRIMARY KEY);']).status).toBe(0)
    expect(executeSql(state, ['--file', resetSqlPath]).status).toBe(0)
    expect(applicationObjects(state)).toEqual([{ name: 'foreign_owner_data', type: 'table' }])
    expect(internalAllowlistProbe(state)).toEqual([{ name: '_cf_unknown', type: 'table' }])
  }, 180_000)
})
