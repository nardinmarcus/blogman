function fail(message) {
  throw new Error(`Issue #23 synthetic adapter: ${message}`)
}

const SYNTHETIC_LIVE_REPOSITORY_COMMIT = '1'.repeat(40)

export function runSyntheticStage(stage, manifest) {
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
