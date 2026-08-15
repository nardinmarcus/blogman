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
 * sink ROOT, omit an explicit ROOT, or carry write methods/authority overrides.
 */
export function runInFormalRehearsalContext(context, callback) {
  if (!exactKeys(context, ['sink', 'deliverySinkRoot', 'clock'])
    || !Array.isArray(context.sink)
    || typeof context.deliverySinkRoot !== 'string'
    || !exactKeys(context.clock, ['wallTimeMilliseconds', 'monotonicNanoseconds'])
    || typeof context.clock.wallTimeMilliseconds !== 'function'
    || typeof context.clock.monotonicNanoseconds !== 'function'
    || typeof callback !== 'function') {
    throw new Error('Issue #23 formal context requires a test-owned ROOT and exact clock')
  }
  return formalRehearsalContext.run(Object.freeze({
    sink: context.sink,
    deliverySinkRoot: context.deliverySinkRoot,
    clock: Object.freeze({
      wallTimeMilliseconds: context.clock.wallTimeMilliseconds,
      monotonicNanoseconds: context.clock.monotonicNanoseconds,
    }),
  }), callback)
}

export function currentFormalRehearsalContext() {
  return formalRehearsalContext.getStore() ?? null
}
