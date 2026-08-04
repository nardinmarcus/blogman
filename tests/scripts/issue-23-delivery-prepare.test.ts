import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_MANIFEST_FORMAT,
  DEFAULT_STAGE_POLICY,
  parseCanonicalManifest,
  prepare,
} from '../../scripts/issue-23-delivery-prepare.mjs'

const SHA40 = 'a'.repeat(40)
const SHA40_B = 'b'.repeat(40)

function hash(character: string) {
  return character.repeat(64)
}

function baseConfig() {
  return {
    preparation: {
      prepare_entry: {
        path: 'scripts/issue-23-delivery-prepare.mjs',
        sha256: hash('c'),
      },
      execute_entry: {
        path: 'scripts/issue-23-delivery-execute.mjs',
        sha256: hash('d'),
      },
      manifest_schema: {
        path: 'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
        sha256: hash('e'),
      },
    },
    repository: {
      canonical: 'nardinmarcus/blogman',
      remote: 'https://github.com/nardinmarcus/blogman.git',
      commit: SHA40,
      tree: SHA40_B,
      clean: true,
    },
    ci: {
      provider: 'github-actions',
      workflow: '.github/workflows/verify.yml',
      run_id: 30914559221,
      attempt: 1,
      event: 'push',
      head_sha: SHA40,
      tree: SHA40_B,
      conclusion: 'success',
    },
    toolchain: {
      node: { version: '22.14.0', identity_sha256: hash('f') },
      npm: { version: '10.9.2', identity_sha256: hash('a') },
      wrangler: { version: '4.84.1', identity_sha256: hash('b') },
      opennextjs_cloudflare: { version: '1.19.1', identity_sha256: hash('c') },
      package_json_sha256: hash('d'),
      lockfile_sha256: hash('e'),
    },
    artifact: {
      archive: { path: 'artifacts/worker.zip', sha256: hash('f'), bytes: 123 },
      worker: { path: 'artifacts/worker.js', sha256: hash('a'), bytes: 456 },
      file_tree: {
        sha256: hash('b'),
        complete: true,
        files: [
          { path: 'assets/index.html', sha256: hash('d'), bytes: 789 },
          { path: 'worker.js', sha256: hash('c'), bytes: 456 },
        ],
      },
    },
    migration: {
      delivery_mode: 'clean-start',
      reset_sql: {
        path: 'db/issue-23-clean-start-reset.sql',
        sha256: hash('f'),
      },
      runner: { path: 'scripts/migrations.mjs', sha256: hash('e') },
      catalog: {
        path: 'db/ledger-migrations',
        sha256: hash('a'),
        migrations: [
          { id: '001', path: 'db/ledger-migrations/001_initial_schema.sql', sha256: hash('b') },
          { id: '002', path: 'db/ledger-migrations/002_add_ai_image_configuration.sql', sha256: hash('c') },
          { id: '003', path: 'db/ledger-migrations/003_migrate_runtime_ai_configuration.sql', sha256: hash('d') },
          { id: '004', path: 'db/ledger-migrations/004_complete_historical_text_ai_schema.sql', sha256: hash('e') },
          { id: '005', path: 'db/ledger-migrations/005_fix_posts_fts_sync.sql', sha256: hash('f') },
          { id: '006', path: 'db/ledger-migrations/006_add_rollout_safety_controls.sql', sha256: hash('a') },
        ],
      },
      historical_data_disposition: {
        production_export: 'NOT_APPLICABLE',
        double_restore: 'NOT_APPLICABLE',
        historical_baseline_queries: 'NOT_APPLICABLE',
      },
    },
    target: {
      account_id: 'account-public-id',
      d1_database_id: 'd1-public-id',
      worker_name: 'blogman',
      origin: 'https://blog.example.com',
      baseline: {
        deployment_id: 'deployment-before',
        version_id: 'version-before',
        d1_database_id: 'd1-public-id',
        traffic: [{ version_id: 'version-before', percentage: 100 }],
      },
    },
    policy: {
      authorization: {
        manifest_binding: 'manifest_sha256',
        one_shot: true,
        credential_slots: [
          { name: 'cloudflare_delivery', scopes: ['account:read', 'workers:write', 'd1:write'] },
        ],
      },
      stages: DEFAULT_STAGE_POLICY,
      overall_timeout_seconds: 5400,
      drift: {
        frozen_preconditions: [
          'repository.commit',
          'repository.tree',
          'ci.head_sha',
          'ci.tree',
          'artifact.file_tree.sha256',
          'migration.catalog.sha256',
          'target.baseline',
        ],
        observations: [
          'target.deployment_id',
          'target.version_id',
          'target.traffic',
          'rehearsal.receipt_sha256',
        ],
        mismatch_classification: 'Manifest Drift',
      },
      evidence: {
        allowed_hash_algorithm: 'sha256',
        excluded: [
          'secret_values',
          'raw_private_adapter_output',
          'sql_bodies',
          'private_operator_paths',
        ],
        production_evidence: 'real_adapters_only',
        local_rehearsal_evidence: 'test_only',
      },
    },
    rehearsal: {
      runtime: { os: 'macos', architecture: 'arm64', node_version: '22.14.0' },
      network: 'disabled',
      status: 'PASS',
      receipt_sha256: hash('c'),
      production_write_adapter_calls: 0,
    },
  }
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliPath = join(repoRoot, 'scripts', 'issue-23-delivery-prepare.mjs')

describe('Issue #23 Delivery Preparation', () => {
  it('emits schema-ordered canonical bytes with an exact-byte identity', () => {
    const result = prepare(baseConfig())
    const text = result.bytes.toString('utf8')

    expect(result.value.format).toBe(CANONICAL_MANIFEST_FORMAT)
    expect(result.sha256).toBe(sha256(result.bytes))
    expect(JSON.parse(text)).toEqual(result.value)
    expect(Object.keys(result.value)).toEqual([
      'format',
      'preparation',
      'repository',
      'ci',
      'toolchain',
      'artifact',
      'migration',
      'target',
      'policy',
      'rehearsal',
    ])
    expect(text).toMatch(/^\{\n  "format": "blogman-issue-23-canonical-frozen-manifest\/v1",\n/u)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('PRIVATE')
    expect(text).not.toContain('DROP TABLE')
    expect(parseCanonicalManifest(result.bytes, result.sha256)).toEqual(result.value)
  })

  it('is repeatable and changes identity for meaningful input changes', () => {
    const first = prepare(baseConfig())
    const second = prepare(baseConfig())
    const changed = baseConfig()
    changed.toolchain.wrangler.version = '4.85.0'
    const changedResult = prepare(changed)

    expect(second.bytes).toEqual(first.bytes)
    expect(second.sha256).toBe(first.sha256)
    expect(changedResult.bytes).not.toEqual(first.bytes)
    expect(changedResult.sha256).not.toBe(first.sha256)
  })

  it('freezes the Issue #23 stage order and timeout policy', () => {
    const result = prepare(baseConfig())

    expect(result.value.policy.stages).toEqual([
      { name: 'authorization_accept', timeout_seconds: 30 },
      { name: 'live_preconditions', timeout_seconds: 120 },
      { name: 'd1_identity', timeout_seconds: 120 },
      { name: 'clean_start_reset', timeout_seconds: 300 },
      { name: 'empty_d1_proof', timeout_seconds: 300 },
      { name: 'migrations_001_006', timeout_seconds: 2100 },
      { name: 'reconciliation', timeout_seconds: 300 },
      { name: 'worker_deploy', timeout_seconds: 600 },
      { name: 'version_traffic_verification', timeout_seconds: 300 },
      { name: 'smoke_control_t0', timeout_seconds: 300 },
    ])
    expect(result.value.policy.overall_timeout_seconds).toBe(5400)
  })

  it('fails closed when a fixed stage policy is mutated', () => {
    const mutated = baseConfig()
    const stages: Array<{ name: string; timeout_seconds: number }> = mutated.policy.stages.map(
      (stage) => ({ ...stage }),
    )
    stages[0] = { name: 'authorization_accept', timeout_seconds: 31 }
    Reflect.set(mutated.policy, 'stages', stages)

    expect(() => prepare(mutated)).toThrow(/fixed Issue #23 order and timeouts/u)
  })

  it('rejects unknown fields and material secret, SQL, or private-path input', () => {
    const unknown = baseConfig()
    Reflect.set(unknown.policy.authorization.credential_slots[0], 'value', 'secret-value')
    expect(() => prepare(unknown)).toThrow(/not allowed/u)

    const sqlBody = baseConfig()
    Reflect.set(sqlBody.migration.reset_sql, 'sql', 'DROP TABLE posts')
    expect(() => prepare(sqlBody)).toThrow(/not allowed/u)

    const privatePath = baseConfig()
    privatePath.artifact.worker.path = '/private/operator/worker.js'
    expect(() => prepare(privatePath)).toThrow(/path/u)

    const topLevel = baseConfig()
    Reflect.set(topLevel, 'unexpected', true)
    expect(() => prepare(topLevel)).toThrow(/not allowed/u)
  })

  it('rejects missing identity, non-canonical bytes, and identity mismatch', () => {
    const missing = baseConfig()
    Reflect.deleteProperty(missing.artifact.file_tree, 'sha256')
    expect(() => prepare(missing)).toThrow(/sha256.*required/u)

    const result = prepare(baseConfig())
    expect(() => parseCanonicalManifest(result.bytes)).toThrow(/identity is required/u)
    expect(() => parseCanonicalManifest(result.bytes, '0'.repeat(64))).toThrow(/identity mismatch/u)

    const parsed = JSON.parse(result.bytes.toString('utf8'))
    const reversed = Object.fromEntries(
      Object.keys(parsed).reverse().map((key) => [key, parsed[key]]),
    )
    const reorderedBytes = Buffer.from(`${JSON.stringify(reversed)}\n`)
    expect(() => parseCanonicalManifest(reorderedBytes, sha256(reorderedBytes)))
      .toThrow(/canonical/u)

    const duplicateKeyBytes = Buffer.from(result.bytes.toString('utf8').replace(
      '{\n  "format":',
      '{\n  "format":',
    ).replace(
      '  "preparation":',
      `  "format": ${JSON.stringify(CANONICAL_MANIFEST_FORMAT)},\n  "preparation":`,
    ))
    expect(() => parseCanonicalManifest(duplicateKeyBytes, sha256(duplicateKeyBytes)))
      .toThrow(/duplicate/u)
  })

  it('keeps the production-write adapter untouched during read-only preparation', () => {
    const adapter = {
      calls: 0,
      write() {
        this.calls += 1
      },
    }

    const result = prepare(baseConfig(), { productionWriteAdapter: adapter })

    expect(adapter.calls).toBe(0)
    expect(result.value.rehearsal.production_write_adapter_calls).toBe(0)
  })

  it('writes only canonical manifest bytes through the formal CLI entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-prepare-'))
    const configPath = join(directory, 'prepare-config.json')
    const expected = prepare(baseConfig())
    writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2))

    try {
      const result = spawnSync(process.execPath, [cliPath, '--config', configPath], {
        cwd: repoRoot,
        encoding: 'buffer',
      })

      expect(result.status, result.stderr.toString('utf8')).toBe(0)
      expect(result.stderr.toString('utf8')).toBe('')
      expect(result.stdout).toEqual(expected.bytes)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
