import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

describe('Issue #23 Phase B runbook order', () => {
  it('runs the remote migration plan before the one-shot export and isolated restores', () => {
    const runbook = readFileSync(join(repoRoot, 'docs', 'issue-23-phase-b-runbook.md'), 'utf8')
    const remotePlan = runbook.indexOf('scripts/migrations.mjs plan --database "$DATABASE" --remote')
    const privateExport = runbook.indexOf('scripts/rollout-safety.mjs backup export')
    const firstRestore = runbook.indexOf('scripts/rollout-safety.mjs backup restore')

    expect(remotePlan).toBeGreaterThan(-1)
    expect(privateExport).toBeGreaterThan(remotePlan)
    expect(firstRestore).toBeGreaterThan(remotePlan)
  })

  it('finishes at the immediate T0 event without an observation wait', () => {
    const runbook = readFileSync(join(repoRoot, 'docs', 'issue-23-phase-b-runbook.md'), 'utf8')
    const smoke = runbook.indexOf('run_production_smoke')
    const reconciliation = runbook.indexOf('blogman-d1-reconciliation-check/v2')
    const t0 = runbook.indexOf('blogman-t0-acceptance/v1')
    const verification = runbook.indexOf('--t0-report "$REPORT_DIR/t0-report.json"')

    expect(smoke).toBeGreaterThan(-1)
    expect(reconciliation).toBeGreaterThan(smoke)
    expect(t0).toBeGreaterThan(reconciliation)
    expect(verification).toBeGreaterThan(t0)
    expect(runbook).toContain('--d1-database "$DATABASE_ID"')
    expect(runbook).toContain("--write-out '%{http_code}'")
    expect(runbook).toContain('test "$SMOKE_AI_GENERATORS_STATUS" = 200')
    expect(runbook).toContain('--argjson ai_generators "$SMOKE_AI_GENERATORS_STATUS"')
    expect(runbook).not.toContain('checks:{search:200')
    expect(runbook).toContain('d1-info-t0-before.json')
    expect(runbook).toContain('d1-info-t0-after.json')
    expect(runbook.match(/verify_config_identity/g)).toHaveLength(4)
    expect(runbook).not.toContain('EARLIEST_END')
    expect(runbook).not.toContain('required_hours:24')
    expect(runbook).not.toContain('observation-window.json')
  })
})
