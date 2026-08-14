import { AsyncLocalStorage } from 'node:async_hooks'

const formalRehearsalContext = new AsyncLocalStorage()

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

/**
 * Narrow test-only ambient seam. It cannot select the canonical production
 * sink, omit an explicit sink, or carry adapter factories/authority overrides.
 */
export function runInFormalRehearsalContext(context, callback) {
  if (!exactKeys(context, ['sink', 'deliverySink', 'clock'])
    || !Array.isArray(context.sink)
    || !isRecord(context.deliverySink)
    || context.deliverySink.authority_class !== 'explicit-test-only'
    || typeof context.deliverySink.consumeAuthorization !== 'function'
    || typeof context.deliverySink.persistTerminalResult !== 'function'
    || typeof context.deliverySink.readTerminalEvidence !== 'function'
    || !exactKeys(context.clock, ['wallTimeMilliseconds', 'monotonicNanoseconds'])
    || typeof context.clock.wallTimeMilliseconds !== 'function'
    || typeof context.clock.monotonicNanoseconds !== 'function'
    || typeof callback !== 'function') {
    throw new Error('Issue #23 formal context requires an explicit test-owned sink and exact clock')
  }
  return formalRehearsalContext.run(Object.freeze({
    sink: context.sink,
    deliverySink: context.deliverySink,
    clock: Object.freeze({
      wallTimeMilliseconds: context.clock.wallTimeMilliseconds,
      monotonicNanoseconds: context.clock.monotonicNanoseconds,
    }),
  }), callback)
}

export function currentFormalRehearsalContext() {
  return formalRehearsalContext.getStore() ?? null
}
