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
})
const temporaryDirectories: string[] = []

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
  it('stops at a failed remote plan before export or any later production stage', async () => {
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
      remote_migration_plan: 1,
      export: 0,
      double_restore: 0,
      upload: 0,
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

  it('pins the remote plan before export and double restore', () => {
    expect(PHASE_B_STAGES.indexOf('remote_migration_plan')).toBeLessThan(PHASE_B_STAGES.indexOf('export'))
    expect(PHASE_B_STAGES.indexOf('remote_migration_plan')).toBeLessThan(PHASE_B_STAGES.indexOf('double_restore'))
  })
})
