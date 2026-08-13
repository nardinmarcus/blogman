import { AsyncLocalStorage } from 'node:async_hooks'

const formalFaultHarness = new AsyncLocalStorage()
const STAGES = new Set([
  'authorization_accept',
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
const KINDS = new Set(['failure', 'timeout', 'malformed', 'drift', 'uncertainty'])

/** Internal test-only seam. It is deliberately not re-exported by production entrypoints. */
export function runFormalFaultHarnessForTestsOnly(fault, callback) {
  if (fault === null || typeof fault !== 'object' || Array.isArray(fault)
    || Object.keys(fault).length !== 2
    || !STAGES.has(fault.stage)
    || !KINDS.has(fault.kind)
    || typeof callback !== 'function') {
    throw new Error('Issue #23 formal fault harness: invalid test fault')
  }
  return formalFaultHarness.run(Object.freeze({ stage: fault.stage, kind: fault.kind }), callback)
}

export function currentFormalFaultForTestsOnly() {
  return formalFaultHarness.getStore() ?? null
}
