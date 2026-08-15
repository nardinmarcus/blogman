import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const longMigrationTest = 'tests/migrations/migration-runner.test.ts'

function workflowJob(workflow: string, name: string) {
  const jobsStart = workflow.indexOf('\njobs:\n')
  const marker = `  ${name}:\n`
  const jobStart = workflow.indexOf(marker, jobsStart)

  if (jobsStart === -1 || jobStart === -1) {
    throw new Error(`Workflow job not found: ${name}`)
  }

  const remainingWorkflow = workflow.slice(jobStart + marker.length)
  const nextJob = remainingWorkflow.search(/\n  [a-zA-Z0-9_-]+:\n/)

  return nextJob === -1
    ? workflow.slice(jobStart)
    : workflow.slice(jobStart, jobStart + marker.length + nextJob)
}

describe('Verify workflow test partition', () => {
  it('keeps the quick suite complete except for the long migration runner', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'verify.sh'), 'utf8')
    const scriptLines = script.split('\n')

    expect(script).toContain(`LONG_MIGRATION_TEST="${longMigrationTest}"`)
    expect(script).toContain('if [[ "${MODE}" == "quick" ]]')
    expect(scriptLines).toContain('  npm run test:run -- --exclude "${LONG_MIGRATION_TEST}"')
    expect(script).toContain('npm run lint')
    expect(script).toContain('npm run build')
    expect(script.match(/--exclude/g)).toHaveLength(1)
    expect(script.match(/tests\/migrations\/migration-runner\.test\.ts/g)).toHaveLength(1)
  })

  it('keeps quick and long verification as separate hard-fail jobs', () => {
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8')
    const quickJob = workflowJob(workflow, 'verify')
    const longJob = workflowJob(workflow, 'verify-migrations')

    expect(quickJob).toContain('timeout-minutes: 20')
    expect(quickJob.split('\n')).toContain('        run: npm run verify:quick')

    expect(longJob).toContain('timeout-minutes: 55')
    expect(longJob.split('\n')).toContain(
      `        run: npm run test:run -- ${longMigrationTest} --reporter=verbose`,
    )
    expect(longJob).not.toMatch(/^    if:/m)

    for (const job of [quickJob, longJob]) {
      expect(job).not.toContain('continue-on-error')
      expect(job).not.toContain('|| true')
    }
  })

  it('keeps the exact macOS formal gate in the candidate Verify workflow with read-only GitHub access', () => {
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8')
    const macosJob = workflowJob(workflow, 'verify-target-macos')

    expect(workflow).toContain('permissions:\n  contents: read\n  actions: read')
    expect(existsSync(join(repoRoot, '.github', 'workflows', 'formal-rehearsal-macos.yml'))).toBe(false)
    expect(macosJob).toContain('runs-on: macos-latest')
    expect(macosJob).toContain('timeout-minutes: 20')
    expect(macosJob).toContain("ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}")
    expect(macosJob).toContain('GH_TOKEN: ${{ github.token }}')
    expect(macosJob.match(/run: npm run test:run/g)).toHaveLength(3)
    expect(macosJob).toContain(
      'run: npm run test:run -- tests/scripts/issue-23-delivery-prepare.test.ts --reporter=verbose',
    )
    expect(macosJob).toContain(
      'run: npm run test:run -- tests/scripts/issue-92-formal-rehearsal.test.ts --reporter=verbose',
    )
    expect(macosJob).toContain(
      "run: npm run test:run -- tests/scripts/issue-23-delivery-durability.test.ts -t 'case-equivalent canonical namespace alias' --reporter=verbose",
    )
    expect(macosJob).not.toContain('workflow_run')
    expect(macosJob).not.toMatch(/secrets\.|contents: write|actions: write/u)
  })

  it('fails closed while skipping the long suite for proven-unrelated changes', () => {
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8')
    const longJob = workflowJob(workflow, 'verify-migrations')
    const requiredCondition = "if: steps.migration-changes.outputs.required != 'false'"

    expect(longJob).toContain('fetch-depth: 0')
    expect(longJob).toContain('id: migration-changes')
    expect(longJob).toContain('node scripts/verify-migrations-required.mjs')
    expect(longJob).toContain('required=true\\nreason=classifier-failed')
    expect(longJob.match(new RegExp(requiredCondition, 'g'))).toHaveLength(2)
    expect(longJob).toContain("if: steps.migration-changes.outputs.required == 'false'")
    expect(longJob).toContain(`run: 'echo "verify-migrations: not-required"'`)
    expect(longJob.indexOf('id: migration-changes'))
      .toBeLessThan(longJob.indexOf('name: Install dependencies'))
  })
})
