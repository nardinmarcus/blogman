function fail(message) {
  throw new Error(`Issue #23 synthetic adapter: ${message}`)
}

export function runSyntheticStage(stage) {
  switch (stage) {
    case 'live_preconditions':
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
      return {
        outcome: 'NON_PASS',
        classification: 'synthetic_adapter_non_pass',
        duration_ms: 0,
      }
    default:
      fail(`${stage} is deferred in this slice`)
  }
}
