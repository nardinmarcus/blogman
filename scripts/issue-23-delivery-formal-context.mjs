import { AsyncLocalStorage } from 'node:async_hooks'

const formalRehearsalContext = new AsyncLocalStorage()

export function runInFormalRehearsalContext(context, callback) {
  return formalRehearsalContext.run(context, callback)
}

export function currentFormalRehearsalContext() {
  return formalRehearsalContext.getStore() ?? null
}
