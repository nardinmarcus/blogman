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
})
