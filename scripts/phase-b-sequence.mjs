import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const PHASE_B_STAGES = Object.freeze([
  'pre_cas_local_gates',
  'cas1',
  'd1_identity',
  'remote_migration_plan',
  'export',
  'double_restore',
  'upload',
  'migrations_001_006',
  'cas2',
  'traffic',
  'smoke_reconcile',
  't0',
])

const sha256 = /^[a-f0-9]{64}$/
const candidate = /^[a-f0-9]{40}$/

function validateInputs(configPath, bindings) {
  if (!isAbsolute(configPath)) throw new Error('Phase B requires an absolute CONFIG path')
  try {
    if (!lstatSync(configPath).isFile()) throw new Error()
  } catch {
    throw new Error('Phase B requires an absolute CONFIG path to an existing regular file')
  }
  if (!Object.isFrozen(bindings)) throw new Error('Phase B requires immutable Phase B bindings')
  if (!candidate.test(bindings.candidateId)
    || !sha256.test(bindings.approvalPacketSha256)
    || !sha256.test(bindings.buildArchiveSha256)
    || !bindings.baselineDeploymentId
    || !bindings.baselineVersionId) {
    throw new Error('Phase B bindings are incomplete or invalid')
  }
}

export async function runPhaseBSequence({ configPath, bindings, runStage }) {
  validateInputs(configPath, bindings)
  if (typeof runStage !== 'function') throw new Error('Phase B requires a stage executor')

  const context = Object.freeze({ configPath, bindings })
  const counts = Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 0]))
  for (const stage of PHASE_B_STAGES) {
    counts[stage] += 1
    await runStage(stage, context)
  }
  return Object.freeze(counts)
}
