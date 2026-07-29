import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PHASE_B_STAGES,
  runPhaseBSequence,
  type PhaseBBindings,
  type PhaseBStage,
} from '../../scripts/phase-b-sequence.mjs'

const bindings: Readonly<PhaseBBindings> = Object.freeze({
  candidateId: 'a'.repeat(40),
  approvalPacketSha256: 'b'.repeat(64),
  buildArchiveSha256: 'c'.repeat(64),
  baselineDeploymentId: 'deployment-before',
  baselineVersionId: 'version-before',
  baselineD1DatabaseId: '22222222-3333-4444-8555-666666666666',
  deliveryMode: 'clean-start',
  cleanStartResetSqlSha256: 'd'.repeat(64),
  historicalDataDisposition: Object.freeze({
    productionExport: 'NOT_APPLICABLE',
    doubleRestore: 'NOT_APPLICABLE',
    historicalBaselineQueries: 'NOT_APPLICABLE',
  }),
})
const temporaryDirectories: string[] = []
const wranglerFilePrefix = '\u251c Checking if file needs uploading\n\u2502\n'
const successfulFileEnvelope = [{
  results: [{
    'Total queries executed': 3,
    'Rows read': 0,
    'Rows written': 9,
    'Database size (MB)': '0.25',
  }],
  success: true,
  finalBookmark: 'synthetic-bookmark',
  meta: { rows_read: 0, rows_written: 9, size_after: 250_000 },
}]
const duplicateSuccessEnvelope = String.raw`[{"results":[{"Total queries executed":3,"Rows read":0,"Rows written":9,"Database size (MB)":"0.25"}],"success":false,"\u0073uccess":true,"finalBookmark":"synthetic-bookmark","meta":{"rows_read":0,"rows_written":9,"size_after":250000}}]`
const duplicateQueryCountEnvelope = String.raw`[{"results":[{"Total queries executed":0,"\u0054otal queries executed":3,"Rows read":0,"Rows written":9,"Database size (MB)":"0.25"}],"success":true,"finalBookmark":"synthetic-bookmark","meta":{"rows_read":0,"rows_written":9,"size_after":250000}}]`
const duplicateMetaRowsEnvelope = String.raw`[{"results":[{"Total queries executed":3,"Rows read":0,"Rows written":9,"Database size (MB)":"0.25"}],"success":true,"finalBookmark":"synthetic-bookmark","meta":{"rows_read":0,"rows_written":8,"\u0072ows_written":9,"size_after":250000}}]`
const parserPath = join(process.cwd(), 'scripts', 'phase-b-sequence.mjs')

function validateWranglerD1FileResponse(stdout: string) {
  return spawnSync(process.execPath, [parserPath, 'validate-wrangler-d1-file-response'], {
    encoding: 'utf8', input: stdout,
  })
}

function validConfig() {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-phase-b-sequence-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'production-wrangler.toml')
  writeFileSync(path, 'name = "not-read-by-sequence"\n')
  chmodSync(path, 0o000)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function stageCounts() {
  return Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 0])) as Record<PhaseBStage, number>
}

describe('Issue #23 Phase B fixed sequence', () => {
  it('stops at a failed empty-database plan after reset proof and before migrations', async () => {
    const counts = stageCounts()

    await expect(runPhaseBSequence({
      configPath: validConfig(),
      bindings,
      runStage: async (stage) => {
        counts[stage] += 1
        if (stage === 'remote_migration_plan') throw new Error('remote plan failed')
      },
    })).rejects.toThrow('remote plan failed')

    expect(counts).toEqual({
      pre_cas_local_gates: 1,
      cas1: 1,
      d1_identity: 1,
      upload: 1,
      clean_start_reset: 1,
      clean_start_empty_verify: 1,
      remote_migration_plan: 1,
      migrations_001_006: 0,
      cas2: 0,
      traffic: 0,
      smoke_reconcile: 0,
      t0: 0,
    })
  })

  it('validates absolute CONFIG and immutable bindings before running a stage', async () => {
    let stagesStarted = 0
    const runStage = async () => { stagesStarted += 1 }

    await expect(runPhaseBSequence({
      configPath: 'wrangler.toml', bindings, runStage,
    })).rejects.toThrow('absolute CONFIG')
    await expect(runPhaseBSequence({
      configPath: validConfig(), bindings: { ...bindings }, runStage,
    })).rejects.toThrow('immutable Phase B bindings')
    const missingD1 = Object.freeze({ ...bindings, baselineD1DatabaseId: '' })
    await expect(runPhaseBSequence({
      configPath: validConfig(), bindings: missingD1, runStage,
    })).rejects.toThrow('incomplete or invalid')
    const unboundAuthorization = Object.freeze({
      ...bindings,
      historicalDataDisposition: Object.freeze({
        ...bindings.historicalDataDisposition,
        productionExport: 'skip',
      }),
    })
    await expect(runPhaseBSequence({
      configPath: validConfig(), bindings: unboundAuthorization, runStage,
    })).rejects.toThrow('clean-start authorization')
    expect(stagesStarted).toBe(0)
  })

  it('runs every fixed stage exactly once without retries', async () => {
    const observed: PhaseBStage[] = []
    const counts = await runPhaseBSequence({
      configPath: validConfig(),
      bindings,
      runStage: async (stage) => { observed.push(stage) },
    })

    expect(observed).toEqual(PHASE_B_STAGES)
    expect(counts).toEqual(Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 1])))
    expect(Object.values(counts)).toEqual(PHASE_B_STAGES.map(() => 1))
  })

  it('binds the validated absolute CONFIG and immutable identities into every stage', async () => {
    const configPath = validConfig()
    const contexts: unknown[] = []
    await runPhaseBSequence({
      configPath,
      bindings,
      runStage: async (_stage, context) => { contexts.push(context) },
    })

    expect(contexts).toHaveLength(PHASE_B_STAGES.length)
    expect(new Set(contexts).size).toBe(1)
    expect(contexts[0]).toEqual({ configPath, bindings })
    expect(Object.isFrozen(contexts[0])).toBe(true)
  })

  it('fails closed at every stage without retrying or entering the suffix', async () => {
    for (const failedStage of PHASE_B_STAGES) {
      const observed: PhaseBStage[] = []
      await expect(runPhaseBSequence({
        configPath: validConfig(),
        bindings,
        runStage: async (stage) => {
          observed.push(stage)
          if (stage === failedStage) throw new Error(`failed: ${stage}`)
        },
      })).rejects.toThrow(`failed: ${failedStage}`)

      const failedIndex = PHASE_B_STAGES.indexOf(failedStage)
      expect(observed).toEqual(PHASE_B_STAGES.slice(0, failedIndex + 1))
      expect(observed.filter((stage) => stage === failedStage)).toHaveLength(1)
    }
  })

  it('uploads before reset and plans only after proving the bound D1 is empty', () => {
    expect(PHASE_B_STAGES.indexOf('upload')).toBeLessThan(PHASE_B_STAGES.indexOf('clean_start_reset'))
    expect(PHASE_B_STAGES.indexOf('clean_start_reset')).toBeLessThan(PHASE_B_STAGES.indexOf('clean_start_empty_verify'))
    expect(PHASE_B_STAGES.indexOf('clean_start_empty_verify')).toBeLessThan(PHASE_B_STAGES.indexOf('remote_migration_plan'))
    expect(PHASE_B_STAGES).not.toContain('export')
    expect(PHASE_B_STAGES).not.toContain('double_restore')
  })

  it.each([
    ['plain JSON', `${JSON.stringify(successfulFileEnvelope)}\n`],
    ['Wrangler 4.86 file prefix', `${wranglerFilePrefix}${JSON.stringify(successfulFileEnvelope)}\n`],
  ])('accepts one deterministic successful %s envelope', (_name, stdout) => {
    expect(validateWranglerD1FileResponse(stdout)).toMatchObject({
      status: 0, stdout: '{"state":"valid"}\n', stderr: '',
    })
  })

  it.each([
    ['HTML', '<html>upstream error</html>'],
    ['arbitrary log prefix', `log line\n${JSON.stringify(successfulFileEnvelope)}`],
    ['multiple JSON values', `${JSON.stringify(successfulFileEnvelope)}\n${JSON.stringify(successfulFileEnvelope)}`],
    ['truncated JSON', JSON.stringify(successfulFileEnvelope).slice(0, -1)],
    ['mixed trailing noise', `${JSON.stringify(successfulFileEnvelope)}\nlog line`],
    ['multiple envelopes', JSON.stringify([...successfulFileEnvelope, ...successfulFileEnvelope])],
    ['unsuccessful envelope', JSON.stringify([{ ...successfulFileEnvelope[0], success: false }])],
    ['empty bookmark', JSON.stringify([{ ...successfulFileEnvelope[0], finalBookmark: '' }])],
    ['missing results', JSON.stringify([{ ...successfulFileEnvelope[0], results: undefined }])],
    ['zero executed queries', JSON.stringify([{
      ...successfulFileEnvelope[0],
      results: [{ ...successfulFileEnvelope[0].results[0], 'Total queries executed': 0 }],
    }])],
    ['ambiguous result rows', JSON.stringify([{
      ...successfulFileEnvelope[0],
      results: [...successfulFileEnvelope[0].results, ...successfulFileEnvelope[0].results],
    }])],
    ['mismatched row count', JSON.stringify([{
      ...successfulFileEnvelope[0],
      results: [{ ...successfulFileEnvelope[0].results[0], 'Rows written': 8 }],
    }])],
    ['unknown top-level field', JSON.stringify([{ ...successfulFileEnvelope[0], extra: true }])],
    ['contradictory duplicate success members', duplicateSuccessEnvelope],
    ['contradictory duplicate query-count members', duplicateQueryCountEnvelope],
    ['contradictory duplicate meta rows-written members', duplicateMetaRowsEnvelope],
  ])('rejects %s without echoing stdout', (_name, stdout) => {
    const invalid = validateWranglerD1FileResponse(stdout)
    expect(invalid).toMatchObject({
      status: 1, stdout: '', stderr: 'Invalid Wrangler D1 file response\n',
    })
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(stdout)
  })
})
