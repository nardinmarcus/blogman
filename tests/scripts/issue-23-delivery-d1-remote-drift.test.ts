import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../scripts/issue-23-delivery-d1-child.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../scripts/issue-23-delivery-d1-child.mjs')>(),
  runBoundedChild: child.run,
}))

import {
  createD1Transport,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'
import {
  hashD1ArtifactDirectory,
} from '../../scripts/issue-23-delivery-d1-contracts.mjs'
import { D1_STAGE_TIMEOUT_MS, runD1Stages } from '../../scripts/issue-23-delivery-d1-stages.mjs'

const repoRoot = process.cwd()
const temporaryDirectories: string[] = []
const migrations = [
  ['001_initial_schema', '8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05'],
  ['002_add_ai_image_configuration', '8b4ad57e43a9f0dfcad5908c22b8f2965fa17771154db6d69f40168b8da30c49'],
  ['003_migrate_runtime_ai_configuration', '719883025ac3013b0e435101b5ebd98ad358349b81f32935d7add646146d1bff'],
  ['004_complete_historical_text_ai_schema', '12afd5f8171987b638692a564335165018d198ff8c7e5a706b0738c024c3d2fc'],
  ['005_fix_posts_fts_sync', 'f6fde6db01e2fbaa967580ed707cded98f4eb7e36ab47707fc2ffc3d5e710441'],
  ['006_add_rollout_safety_controls', '8179bc9795619d44b7b01affeb0bb591b95af69c0b4a8399474a8ce4778ac551'],
].map(([name, checksum], index) => ({ number: index + 1, name, checksum }))

function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function remoteBindings() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-d1-remote-drift-')))
  temporaryDirectories.push(root)
  const expected = join(root, 'expected-reconciliation.json')
  writeFileSync(expected, `${JSON.stringify({
    format: 'blogman-d1-reconciliation/v1',
    schema: { sha256: 'a'.repeat(64) },
    migration_ledger: { state: 'present', row_count: 6, sha256: 'b'.repeat(64) },
    posts: { count: 0, status: {}, content_sha256: 'c'.repeat(64) },
  }, null, 2)}\n`, { mode: 0o600 })
  const configPath = join(repoRoot, 'wrangler.toml')
  const resetPath = join(repoRoot, 'db', 'issue-23-clean-start-reset.sql')
  const runnerPath = join(repoRoot, 'scripts', 'migrations.mjs')
  const catalogPath = join(repoRoot, 'db', 'ledger-migrations')
  const rolloutPath = join(repoRoot, 'scripts', 'rollout-safety.mjs')
  const wranglerPath = realpathSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'))
  return {
    mode: 'remote',
    database: 'DB',
    config_path: configPath,
    config_sha256: hash(configPath),
    wrangler_sha256: hash(wranglerPath),
    account_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    d1_database_id: '11111111-2222-4333-8444-555555555555',
    reset_sql_path: resetPath,
    reset_sql_sha256: hash(resetPath),
    migration_runner_path: runnerPath,
    migration_runner_sha256: hash(runnerPath),
    migration_catalog_path: catalogPath,
    migration_catalog_sha256: hashD1ArtifactDirectory(catalogPath),
    rollout_safety_path: rolloutPath,
    rollout_safety_sha256: hash(rolloutPath),
    expected_reconciliation_path: expected,
    expected_reconciliation_sha256: hash(expected),
    manifest_sha256: '1'.repeat(64),
    authorization_sha256: '2'.repeat(64),
    attempt_id: '3'.repeat(64),
    candidate_id: 'd'.repeat(40),
    evidence_class: 'production',
    migrations,
  }
}

afterEach(() => {
  child.run.mockReset()
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Issue #23 remote D1 identity drift', () => {
  it('recomputes the remote whoami suffix deadline and dispatches no stale-clock child', () => {
    const bindings = remoteBindings()
    const info = readFileSync(join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-d1-info.json'), 'utf8')
    const monotonicValues = [0, D1_STAGE_TIMEOUT_MS.d1_identity]
    child.run.mockReturnValueOnce({ status: 0, stdout: info, stderr: '', duration_ms: 1 })
    const transport = createD1Transport(
      bindings,
      Object.assign(Object.create(null), { CLOUDFLARE_API_TOKEN: 'test-only-placeholder' }),
      () => monotonicValues.shift() ?? D1_STAGE_TIMEOUT_MS.d1_identity,
    )

    expect(() => transport.execute({
      operation: 'd1_identity',
      stage: 'd1_identity',
      timeout_ms: D1_STAGE_TIMEOUT_MS.d1_identity,
      elapsed_ms: 0,
      overall_elapsed_ms: 0,
    })).toThrow(expect.objectContaining({ classification: 'timeout' }))
    expect(child.run).toHaveBeenCalledTimes(1)
  })

  it('terminalizes a live database UUID mismatch as Manifest Drift before reset or mutation suffix', () => {
    const bindings = remoteBindings()
    const info = readFileSync(join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-d1-info.json'), 'utf8')
      .replace('"uuid": "11111111-2222-4333-8444-555555555555"', '"uuid": "22222222-3333-4444-8555-666666666666"')
    const whoami = readFileSync(join(repoRoot, 'tests', 'fixtures', 'issue-90', 'wrangler-4.86.0-whoami.json'), 'utf8')
    child.run
      .mockReturnValueOnce({ status: 0, stdout: info, stderr: '', duration_ms: 1 })
      .mockReturnValueOnce({ status: 0, stdout: whoami, stderr: '', duration_ms: 1 })

    const transport = createD1Transport(
      bindings,
      Object.assign(Object.create(null), { CLOUDFLARE_API_TOKEN: 'test-only-placeholder' }),
      () => 0,
    )
    const result = runD1Stages({ bindings, transport, monotonic_ms: () => 0 })

    expect(result.value).toMatchObject({
      outcome: 'NON_PASS',
      first_terminal_stage: 'd1_identity',
      failure: { classification: 'Manifest Drift' },
      stage_counts: {
        d1_identity: 1,
        clean_start_reset: 0,
        empty_d1_proof: 0,
        migrations_001_006: 0,
        reconciliation: 0,
      },
    })
    expect(child.run).toHaveBeenCalledTimes(2)
  })
})
