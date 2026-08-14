import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORMAL_EXECUTION_CLOSURE_PATHS } from '../../scripts/issue-23-delivery-execution-closure.mjs'

const repoRoot = process.cwd()
const deliverySources = [
  'scripts/issue-23-delivery-prepare.mjs',
  'scripts/issue-23-delivery-entry.mjs',
  'scripts/issue-23-delivery-worker-transport.mjs',
]

function source(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8')
}

describe('Issue #93 delivery control-plane cutover', () => {
  it('binds the formal execute entry and private Worker upload entry without the retired Phase B control plane', () => {
    const schema = JSON.parse(source(
      'schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
    ))
    const preparation = schema.properties.preparation

    expect(preparation.required).toEqual([
      'prepare_entry',
      'execute_entry',
      'worker_upload_entry',
      'manifest_schema',
    ])
    expect(existsSync(join(repoRoot, 'scripts/issue-23-delivery-worker-upload.mjs'))).toBe(true)
    expect(existsSync(join(repoRoot, 'scripts/issue-23-delivery-synthetic-adapter.mjs'))).toBe(false)
    expect(existsSync(join(repoRoot, 'scripts/phase-b-sequence.mjs'))).toBe(false)
    expect(existsSync(join(repoRoot, 'scripts/phase-b-sequence.d.mts'))).toBe(false)

    for (const path of deliverySources) {
      const contents = source(path)
      expect(contents, path).not.toContain('phase-b-sequence')
      expect(contents, path).not.toContain('issue-23-delivery-history-audit')
      expect(contents, path).not.toContain('schemas/issue-23-reseal')
      expect(contents, path).not.toContain('executeSyntheticForTest')
      expect(contents, path).not.toContain('runSyntheticStage')
    }
  })

  it('pins every formal execution-closure member and removes runtime provenance caches', () => {
    expect(FORMAL_EXECUTION_CLOSURE_PATHS).toEqual([
      'scripts/issue-23-build-proof.mjs',
      'scripts/issue-23-delivery-d1-child.mjs',
      'scripts/issue-23-delivery-d1-contracts.mjs',
      'scripts/issue-23-delivery-d1-stages.mjs',
      'scripts/issue-23-delivery-d1-transport.mjs',
      'scripts/issue-23-delivery-entry.mjs',
      'scripts/issue-23-delivery-evidence-sink.mjs',
      'scripts/issue-23-delivery-evidence-sink-internal.mjs',
      'scripts/issue-23-delivery-execution-closure.mjs',
      'scripts/issue-23-delivery-formal-context.mjs',
      'scripts/issue-23-delivery-formal-fault-harness.mjs',
      'scripts/issue-23-delivery-formal-runtime.mjs',
      'scripts/issue-23-delivery-prepare.mjs',
      'scripts/issue-23-delivery-rehearsal.mjs',
      'scripts/issue-23-delivery-worker-stages.mjs',
      'scripts/issue-23-delivery-worker-transport.mjs',
      'scripts/issue-23-delivery-worker-upload.mjs',
    ])
    for (const path of [
      'scripts/issue-23-delivery-d1-stages.mjs',
      'scripts/issue-23-delivery-d1-transport.mjs',
      'scripts/issue-23-delivery-worker-stages.mjs',
      'scripts/issue-23-delivery-worker-transport.mjs',
    ]) {
      expect(source(path), path).not.toMatch(/WeakMap|getD1TransportProvenance|getWorkerTransportProvenance/u)
    }
  })

  it('keeps synthetic evidence on the formal public seam and permanently non-promotable', async () => {
    const deliveryEntry = await import('../../scripts/issue-23-delivery-entry.mjs')
    expect(deliveryEntry).not.toHaveProperty('executeSyntheticForTest')
    expect(source('scripts/issue-23-delivery-worker-transport.mjs')).toContain('FORMAL_REHEARSAL_WORKER_EVIDENCE_SOURCE')
  })

  it('keeps the operator runbook documentary instead of implementing a shell production sequence', () => {
    const runbook = source('docs/issue-23-phase-b-runbook.md')

    for (const section of [
      'Delivery Preparation',
      'Independent Review',
      'Exact Authorization',
      'Execute',
      'Terminal Result',
    ]) {
      expect(runbook).toContain(section)
    }
    expect(runbook).not.toContain('```bash')
    expect(runbook).not.toContain('set -euo pipefail')
    expect(runbook).not.toContain('wrangler d1')
    expect(runbook).not.toContain('versions deploy')
    expect(runbook).not.toContain('phase-b-sequence')
    expect(runbook).not.toContain('issue-23-reseal')
  })

  it('exposes historical evidence only through the read-only audit command', async () => {
    const packageJson = JSON.parse(source('package.json'))
    const auditSource = source('scripts/issue-23-delivery-history-audit.mjs')
    const audit = await import('../../scripts/issue-23-delivery-history-audit.mjs')

    expect(packageJson.scripts).not.toHaveProperty('issue-23:reseal')
    expect(packageJson.scripts['issue-23:audit']).toBe(
      'node scripts/issue-23-delivery-history-audit.mjs',
    )
    expect(Object.keys(audit).sort()).toEqual([
      'auditHistoricalDocument',
      'auditHistoricalPackage',
    ])
    expect(auditSource).not.toContain('node:child_process')
    expect(auditSource).not.toMatch(/\b(?:chmod|mkdir|rename|rm|writeFile)Sync\b/u)
  })

  it('keeps the legacy audit adapter outside the new execute dependency graph', () => {
    const rolloutSafety = source('scripts/rollout-safety.mjs')
    const workerTransport = source('scripts/issue-23-delivery-worker-transport.mjs')

    expect(rolloutSafety).not.toContain('issue-23-delivery-history-audit')
    expect(rolloutSafety).not.toContain("domain === 'candidate'")
    expect(rolloutSafety).not.toContain("action === 'set'")
    expect(rolloutSafety).not.toContain("action === 'status'")
    expect(workerTransport).not.toContain('issue-23-delivery-history-audit')
    expect(workerTransport).toContain("'rollout', 'controls-status'")
    expect(workerTransport).toContain("'reconcile', 'compare'")
  })

  it('rejects retired candidate and control-mutation commands', () => {
    const rolloutSafety = source('scripts/rollout-safety.mjs')

    expect(rolloutSafety).not.toContain('function verifyCandidate(')
    expect(rolloutSafety).not.toContain('function verifyPreMigrationCandidate(')
    expect(rolloutSafety).not.toContain('function rolloutSet(')
    expect(rolloutSafety).not.toContain('function rolloutStatus(')
    expect(rolloutSafety).toContain("Expected rollout action: controls-status")
    expect(rolloutSafety).toContain(
      "Expected command domain: backup, reconcile, rollout, or request",
    )
  })
})
