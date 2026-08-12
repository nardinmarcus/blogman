import { AsyncLocalStorage } from 'node:async_hooks'

const formalFaultHarness = new AsyncLocalStorage()

/** Internal test-only seam. It is deliberately not re-exported by production entrypoints. */
export function runFormalFaultHarnessForTestsOnly(failureStage, callback) {
  if (failureStage !== 'live_preconditions' || typeof callback !== 'function') {
    throw new Error('Issue #23 formal fault harness: invalid test fault')
  }
  return formalFaultHarness.run(Object.freeze({ failureStage }), callback)
}

export function currentFormalFaultStageForTestsOnly() {
  return formalFaultHarness.getStore()?.failureStage ?? null
}
