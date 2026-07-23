import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

describe('Cloudflare migration entrypoints', () => {
  it('makes deploy depend on the fail-closed migration runner instead of schema replay', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'cf-deploy.sh'), 'utf8')
    const migrationPosition = script.indexOf('scripts/migrations.mjs" apply')
    const deployPosition = script.indexOf('opennextjs-cloudflare deploy')

    expect(script).not.toContain('db/schema.sql')
    expect(script).not.toContain('db/seed-template.sql')
    expect(script).not.toContain('|| true')
    expect(script).toContain('set -euo pipefail')
    expect(migrationPosition).toBeGreaterThan(-1)
    expect(deployPosition).toBeGreaterThan(migrationPosition)
    expect(script).toContain('--candidate "${CANDIDATE_ID}"')
  })

  it('uses the same migration runner when initializing a new D1 database', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'cf-init.sh'), 'utf8')

    expect(script).not.toContain('db/schema.sql')
    expect(script).not.toContain('db/seed-template.sql')
    expect(script).toContain('scripts/migrations.mjs" apply')
    expect(script).toContain('--candidate "${CANDIDATE_ID}"')
  })

  it('keeps full verification on the lockfile-installed OpenNext binary', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'verify.sh'), 'utf8')

    expect(script).not.toContain('@opennextjs/cloudflare@latest')
    expect(script).toContain('npx opennextjs-cloudflare build')
  })
})
