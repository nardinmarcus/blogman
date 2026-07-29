import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

describe('Issue #23 Phase B runbook order', () => {
  const readRunbook = () => readFileSync(
    join(repoRoot, 'docs', 'issue-23-phase-b-runbook.md'),
    'utf8',
  )

  const hasTightUploadSourceProof = (runbook: string) => {
    const uploadSection = runbook.slice(
      runbook.indexOf('## 3. Upload before the destructive boundary'),
      runbook.indexOf('## 4. Candidate-bound in-place reset'),
    )
    const lines = uploadSection.split('\n')
    const commands: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      let command = lines[index].trim()
      if (!command) continue
      while (command.endsWith('\\')) command += ` ${lines[++index].trim()}`
      commands.push(command)
    }
    const upload = commands.findIndex((command) => (
      command.startsWith('WRANGLER_OUTPUT_FILE_PATH="$UPLOAD_PRIVATE"')
    ))
    const sourceProof = commands.findIndex((command) => (
      command.startsWith('node scripts/issue-23-reseal.mjs verify-build-directory')
      && command.includes('--directory "$UPLOAD_SOURCE_DIRECTORY"')
    ))
    const snapshot = commands.findIndex((command) => (
      command.startsWith('node scripts/phase-b-sequence.mjs create-upload-source-snapshot')
    ))
    const snapshotProof = commands.findIndex((command) => (
      command.startsWith('node scripts/issue-23-reseal.mjs verify-build-directory')
      && command.includes('--directory "$UPLOAD_SOURCE_SNAPSHOT_DIRECTORY"')
      && command.includes('> "$REPORT_DIR/upload-build-directory-proof.json"')
    ))
    const reverify = commands.findIndex((command) => (
      command.startsWith('node scripts/phase-b-sequence.mjs verify-upload-source-snapshot')
    ))
    const postUploadProof = commands.findIndex((command) => (
      command.startsWith('node scripts/issue-23-reseal.mjs verify-build-directory')
      && command.includes('> "$REPORT_DIR/upload-build-directory-proof-after.json"')
    ))
    const acceptVersion = commands.findIndex((command) => command.startsWith("jq -s -e '[.[] | select(.type == \"version-upload\""))
    return sourceProof >= 0
      && snapshot > sourceProof
      && snapshotProof > snapshot
      && upload > snapshotProof
      && commands[upload - 1] === 'verify_config_identity'
      && commands[upload].includes('--assets "$UPLOAD_SOURCE_SNAPSHOT_DIRECTORY/assets"')
      && reverify > upload
      && postUploadProof > reverify
      && commands[postUploadProof + 1] === 'cmp "$REPORT_DIR/upload-build-directory-proof.json" "$REPORT_DIR/upload-build-directory-proof-after.json"'
      && acceptVersion > postUploadProof
  }

  const hasResetResponseValidationOrder = (runbook: string) => {
    const reset = runbook.indexOf(
      './node_modules/.bin/wrangler d1 execute "$DATABASE" --remote -c "$CONFIG" --json \\\n'
      + '  --file "$RESET_SQL" > "$RESET_PRIVATE"',
    )
    const validator = runbook.indexOf(
      'node scripts/phase-b-sequence.mjs validate-wrangler-d1-file-response \\\n'
      + '  < "$RESET_PRIVATE" >/dev/null',
    )
    const completedAt = runbook.indexOf('RESET_COMPLETED_AT=')
    const resetReport = runbook.indexOf('blogman-clean-start-reset/v1')
    const emptyProof = runbook.indexOf('## 5. Empty D1 proof')
    return reset >= 0
      && validator > reset
      && completedAt > validator
      && resetReport > completedAt
      && emptyProof > resetReport
  }

  it('revalidates the frozen config immediately before every production adapter', () => {
    const lines = readRunbook().split('\n')
    const adapterLines = lines.flatMap((line, index) => {
      const trimmed = line.trim()
      if (!/^(?:WRANGLER_OUTPUT_FILE_PATH=.*\s+)?(?:\.\/node_modules\/\.bin\/wrangler|npm exec -- opennextjs-cloudflare|node scripts\/(?:migrations|rollout-safety)\.mjs)/.test(trimmed)) {
        return []
      }
      let command = trimmed
      let cursor = index
      while (command.endsWith('\\')) command += ` ${lines[++cursor].trim()}`
      return command.includes('$CONFIG') ? [{ command, index }] : []
    })

    expect(adapterLines.length).toBeGreaterThan(0)
    for (const adapter of adapterLines) {
      let previous = adapter.index - 1
      while (previous >= 0 && lines[previous].trim() === '') previous -= 1
      expect(lines[previous].trim(), adapter.command).toBe('verify_config_identity')
    }
  })

  it('derives one uploaded version from private upload output and binds its evidence', () => {
    const runbook = readRunbook()
    expect(runbook).toContain('verify-build-directory')
    expect(runbook).toContain('WRANGLER_OUTPUT_FILE_PATH="$UPLOAD_PRIVATE"')
    expect(runbook).toContain('blogman-clean-start-upload/v1')
    expect(runbook).toContain('--clean-start-upload-report "$REPORT_DIR/clean-start-upload-report.json"')
    expect(runbook).not.toContain('versions list --json')
    expect(runbook).not.toContain('sort_by(.metadata.created_on) | last')
  })

  it('regenerates the actual upload-source proof immediately before the upload adapter', () => {
    const runbook = readRunbook()
    expect(runbook).toContain('pre-cas-build-directory-proof.json')
    expect(hasTightUploadSourceProof(runbook)).toBe(true)
    expect(runbook).toContain(
      'BUILD_DIRECTORY_PROOF_SHA256=$(shasum -a 256 "$REPORT_DIR/upload-build-directory-proof.json"',
    )
    expect(runbook).toContain(
      '--build-directory-proof "$REPORT_DIR/upload-build-directory-proof.json"',
    )

    const staleProofMutation = runbook.replaceAll(
      'upload-build-directory-proof.json',
      'pre-cas-build-directory-proof.json',
    )
    expect(hasTightUploadSourceProof(staleProofMutation)).toBe(false)
    expect(hasTightUploadSourceProof(runbook.replace(
      'node scripts/phase-b-sequence.mjs verify-upload-source-snapshot',
      'node scripts/phase-b-sequence.mjs skipped-upload-source-reverification',
    ))).toBe(false)
  })

  it('uploads before the bound reset and plans only after the empty-D1 proof', () => {
    const runbook = readRunbook()
    const upload = runbook.indexOf('## 3. Upload before the destructive boundary')
    const reset = runbook.indexOf('## 4. Candidate-bound in-place reset')
    const emptyProof = runbook.indexOf('## 5. Empty D1 proof')
    const remotePlan = runbook.indexOf('scripts/migrations.mjs plan --database "$DATABASE" --remote')

    expect(upload).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(upload)
    expect(emptyProof).toBeGreaterThan(reset)
    expect(remotePlan).toBeGreaterThan(-1)
    expect(remotePlan).toBeGreaterThan(emptyProof)
    expect(runbook).toContain('historical data export: `NOT_APPLICABLE`')
    expect(runbook).toContain('double restore: `NOT_APPLICABLE`')
    expect(runbook).toContain('historical baseline queries: `NOT_APPLICABLE`')
    expect(runbook).toContain("(name,tbl_name) IN (('_cf_KV','_cf_KV'),('_cf_METADATA','_cf_METADATA'))")
    expect(runbook).toContain("('_cf_METADATA','_cf_METADATA')")
    expect(runbook).not.toContain("name NOT LIKE '_cf_%'")
  })

  it('validates the reset response before creating reset evidence or entering empty proof', () => {
    const runbook = readRunbook()
    const validator = 'node scripts/phase-b-sequence.mjs validate-wrangler-d1-file-response \\\n'
      + '  < "$RESET_PRIVATE" >/dev/null\n'

    expect(hasResetResponseValidationOrder(runbook)).toBe(true)
    expect(hasResetResponseValidationOrder(runbook.replace(validator, ''))).toBe(false)
    expect(hasResetResponseValidationOrder(
      runbook.replace(validator, '').replace('verify_config_identity\n', validator),
    )).toBe(false)
  })

  it('finishes at the immediate T0 event without an observation wait', () => {
    const runbook = readRunbook()
    const smoke = runbook.indexOf('SMOKE_SEARCH_STATUS=')
    const reconciliation = runbook.indexOf('blogman-d1-reconciliation-check/v2')
    const t0 = runbook.indexOf('blogman-t0-acceptance/v2')
    const verification = runbook.indexOf('--t0-report "$REPORT_DIR/t0-report.json"')

    expect(smoke).toBeGreaterThan(-1)
    expect(reconciliation).toBeGreaterThan(smoke)
    expect(t0).toBeGreaterThan(reconciliation)
    expect(verification).toBeGreaterThan(t0)
    expect(runbook).toContain('--d1-database "$DATABASE_ID"')
    expect(runbook).toContain("--write-out '%{http_code}'")
    expect(runbook).toContain('test "$SMOKE_ADMIN_ARTICLE_STATUS" = 404')
    expect(runbook).toContain('test "$SMOKE_AI_GENERATORS_STATUS" = 200')
    expect(runbook).toContain('--argjson ai_generators "$SMOKE_AI_GENERATORS_STATUS"')
    expect(runbook).not.toContain('checks:{search:200')
    expect(runbook).toContain('d1-info-t0-before.json')
    expect(runbook).toContain('d1-info-t0-after.json')
    expect(runbook).not.toContain('EARLIEST_END')
    expect(runbook).not.toContain('required_hours:24')
    expect(runbook).not.toContain('observation-window.json')
  })
})
