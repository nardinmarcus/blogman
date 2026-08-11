function fail(message) {
  throw new Error(`Issue #23 synthetic adapter: ${message}`)
}

const SYNTHETIC_LIVE_REPOSITORY_COMMIT = '1'.repeat(40)
const SYNTHETIC_LIVE_D1_DATABASE_ID = 'd1-public-id'
const SYNTHETIC_FIRST_ERROR_STAGES = new Set([
  'live_preconditions',
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
  'worker_deploy',
  'version_traffic_verification',
  'smoke_control_t0',
])
const SYNTHETIC_SCENARIOS = Object.freeze({
  'synthetic-stage-timeout': Object.freeze({
    stage: 'live_preconditions',
    result: Object.freeze({ outcome: 'PASS', duration_ms: 5401000 }),
  }),
  'synthetic-stage-timeout-equality': Object.freeze({
    stage: 'live_preconditions',
    result: Object.freeze({ outcome: 'PASS', duration_ms: 120000 }),
  }),
  'synthetic-overall-timeout': Object.freeze({
    stage: 'live_preconditions',
    result: Object.freeze({ outcome: 'PASS', duration_ms: 0, synthetic_elapsed_ms: 5401000 }),
  }),
  'synthetic-overall-timeout-equality': Object.freeze({
    stage: 'live_preconditions',
    result: Object.freeze({ outcome: 'PASS', duration_ms: 0, synthetic_elapsed_ms: 5400000 }),
  }),
  'synthetic-uncertain-adapter': Object.freeze({
    stage: 'd1_identity',
    result: Object.freeze({
      outcome: 'MAYBE',
      classification: 'private-synthetic-classification',
      duration_ms: 0,
      raw_output: 'synthetic-private-output',
    }),
  }),
})

function scenarioResult(stage, manifest) {
  if (!Object.hasOwn(manifest ?? {}, 'marker') || typeof manifest.marker !== 'string') return null
  if (SYNTHETIC_FIRST_ERROR_STAGES.has(stage)
    && manifest.marker === `synthetic-first-error-${stage}`) {
    return {
      outcome: 'NON_PASS',
      classification: 'synthetic_adapter_non_pass',
      duration_ms: 0,
    }
  }
  if (!Object.hasOwn(SYNTHETIC_SCENARIOS, manifest.marker)) return null
  const scenario = SYNTHETIC_SCENARIOS[manifest.marker]
  if (!scenario || scenario.stage !== stage) return null
  return { ...scenario.result }
}

export function runSyntheticStage(stage, manifest) {
  const scenario = scenarioResult(stage, manifest)
  if (scenario) return scenario
  switch (stage) {
    case 'live_preconditions':
      if (manifest.repository.commit !== SYNTHETIC_LIVE_REPOSITORY_COMMIT) {
        return {
          outcome: 'NON_PASS',
          classification: 'Manifest Drift',
          duration_ms: 0,
        }
      }
      return { outcome: 'PASS', duration_ms: 0 }
    case 'd1_identity':
      if (manifest.target
        && Object.hasOwn(manifest.target, 'd1_database_id')
        && manifest.target.d1_database_id !== SYNTHETIC_LIVE_D1_DATABASE_ID) {
        return {
          outcome: 'NON_PASS',
          classification: 'synthetic_adapter_non_pass',
          duration_ms: 0,
        }
      }
      return { outcome: 'PASS', duration_ms: 0 }
    case 'clean_start_reset':
      return { outcome: 'PASS', duration_ms: 0 }
    case 'empty_d1_proof':
      return { outcome: 'PASS', duration_ms: 0 }
    case 'migrations_001_006':
      return { outcome: 'PASS', duration_ms: 0 }
    case 'reconciliation':
      return { outcome: 'PASS', duration_ms: 0 }
    case 'worker_deploy':
      return { outcome: 'PASS', duration_ms: 0 }
    case 'version_traffic_verification':
      return { outcome: 'PASS', duration_ms: 0 }
    case 'smoke_control_t0':
      return { outcome: 'PASS', duration_ms: 0 }
    default:
      fail(`${stage} is deferred in this slice`)
  }
}
