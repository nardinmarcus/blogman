import { prepare } from './issue-23-delivery-prepare.mjs'
import { runFormalRehearsalAttempt } from './issue-23-delivery-entry.mjs'

function fail(message) {
  throw new Error(`Issue #23 formal rehearsal: ${message}`)
}

/**
 * Formal no-network rehearsal entry.
 * Calls public prepare(config) with no options, then public execute(manifest, authorization)
 * inside the module-owned private adapter context.
 */
export function runFormalRehearsal(config, options = {}) {
  if (arguments.length < 1 || arguments.length > 2) {
    fail('runFormalRehearsal accepts config and optional options')
  }
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    fail('options must be a plain object when provided')
  }
  const prepared = prepare(config)
  return runFormalRehearsalAttempt(prepared, options)
}
