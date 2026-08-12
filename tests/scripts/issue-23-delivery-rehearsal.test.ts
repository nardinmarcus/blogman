import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLocalRehearsal } from '../../scripts/issue-23-delivery-rehearsal.mjs'

const repoRoot = process.cwd()

function sha256File(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashDirectory(path: string) {
  const hash = createHash('sha256')
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const metadata = statSync(child)
      if (metadata.isDirectory()) visit(child, relativePath)
      else hash.update(`${relativePath}\0${metadata.size}\0`).update(readFileSync(child)).update('\0')
    }
  }
  visit(path, '')
  return hash.digest('hex')
}

function canonicalD1() {
  const catalog = JSON.parse(execFileSync(process.execPath, [
    join(repoRoot, 'scripts/migrations.mjs'),
    'catalog',
    '--migrations-dir',
    join(repoRoot, 'db/ledger-migrations'),
  ], { encoding: 'utf8' })) as {
    migrations: Array<{ number: number; name: string; checksum: string }>
  }
  const candidateId = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return {
    mode: 'remote' as const,
    database: 'DB',
    config_path: 'wrangler.toml',
    config_sha256: sha256File(join(repoRoot, 'wrangler.toml')),
    wrangler_sha256: sha256File(realpathSync(join(repoRoot, 'node_modules/.bin/wrangler'))),
    account_id: 'local-rehearsal-account',
    d1_database_id: 'local-rehearsal-d1',
    reset_sql_path: 'db/issue-23-clean-start-reset.sql',
    reset_sql_sha256: sha256File(join(repoRoot, 'db/issue-23-clean-start-reset.sql')),
    migration_runner_path: 'scripts/migrations.mjs',
    migration_runner_sha256: sha256File(join(repoRoot, 'scripts/migrations.mjs')),
    migration_catalog_path: 'db/ledger-migrations',
    migration_catalog_sha256: hashDirectory(join(repoRoot, 'db/ledger-migrations')),
    rollout_safety_path: 'scripts/rollout-safety.mjs',
    rollout_safety_sha256: sha256File(join(repoRoot, 'scripts/rollout-safety.mjs')),
    expected_reconciliation_format: 'blogman-d1-reconciliation/v1',
    candidate_id: candidateId,
    evidence_class: 'production' as const,
    migrations: catalog.migrations,
  }
}

describe('Issue #90 local D1 rehearsal', () => {
  it('generates an expected snapshot and separately runs the real local five-stage seam', { timeout: 120_000 }, () => {
    const result = runLocalRehearsal({
      repositoryPath: repoRoot,
      d1: canonicalD1(),
      manifestDraftSha256: 'a'.repeat(64),
    })

    expect(result).toMatchObject({
      network: 'disabled',
      status: 'PASS',
      production_write_adapter_calls: 0,
      d1: {
        outcome: 'PASS',
        production: false,
        promotable: false,
      },
      cleanup: {
        created: true,
        cleaned: true,
        observed_absent: true,
      },
    })
    expect(result.expected_reconciliation).toMatchObject({
      value: {
        format: 'blogman-d1-reconciliation/v1',
        schema: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        migration_ledger: { state: 'present', row_count: 6 },
        posts: { count: 0 },
      },
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(result.d1.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.cleanup).toEqual({ created: true, cleaned: true, observed_absent: true })
  })

  it('fails closed instead of falling back when a D1-aware rehearsal receives a custom runner', () => {
    expect(() => runLocalRehearsal({
      repositoryPath: repoRoot,
      d1: canonicalD1(),
      runnerPath: 'tests/scripts/custom-runner.mjs',
      manifestDraftSha256: 'a'.repeat(64),
    })).toThrow(/runner path is not canonical/u)
  })

  it('fails closed instead of falling back when a D1-aware rehearsal receives a custom catalog', () => {
    expect(() => runLocalRehearsal({
      repositoryPath: repoRoot,
      d1: canonicalD1(),
      migrationCatalogPath: 'tests/scripts/custom-catalog',
      manifestDraftSha256: 'a'.repeat(64),
    })).toThrow(/catalog path is not canonical/u)
  })

  it('fails closed when the D1 binding reset path is non-canonical', () => {
    const d1 = canonicalD1()
    d1.reset_sql_path = 'db/schema.sql'

    expect(() => runLocalRehearsal({
      repositoryPath: repoRoot,
      d1,
      manifestDraftSha256: 'a'.repeat(64),
    })).toThrow(/reset SQL path is not canonical/u)
  })
})
