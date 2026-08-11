import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')

export const D1_TRANSPORT_TIMEOUT_MS = 300_000
export const D1_TRANSPORT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export const D1_TRANSPORT_FAILURE_CLASSIFICATIONS = Object.freeze({
  TIMEOUT: 'timeout',
  NONZERO: 'nonzero',
  MALFORMED: 'malformed',
  UNCERTAIN: 'uncertain',
})

export class D1TransportError extends Error {
  constructor(classification) {
    super(`D1 transport ${classification}`)
    this.name = 'D1TransportError'
    this.classification = classification
  }
}

function fail(message) {
  throw new Error(`D1 transport: ${message}`)
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertExactKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)
    || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

function assertSafeToken(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    fail(`${label} is invalid`)
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string'
    || !isAbsolute(value)
    || resolve(value) !== value
    || /[\u0000\r\n]/u.test(value)) {
    fail(`${label} must be an absolute normalized path`)
  }
}

function assertSql(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
    fail('query must be non-empty SQL')
  }
}

function validateConfig(config) {
  assertExactKeys(config, ['mode', 'database', 'configPath', 'persistPath'], 'config')
  if (config.mode !== 'local' && config.mode !== 'remote') {
    fail('mode must be local or remote')
  }
  assertSafeToken(config.database, 'database')
  assertAbsolutePath(config.configPath, 'configPath')

  if (config.mode === 'local') {
    assertAbsolutePath(config.persistPath, 'persistPath')
  } else if (config.persistPath !== undefined) {
    fail('remote mode forbids persistPath')
  }

  return Object.freeze({
    mode: config.mode,
    database: config.database,
    configPath: config.configPath,
    ...(config.mode === 'local' ? { persistPath: config.persistPath } : {}),
  })
}

function validateOperation(operation) {
  assertExactKeys(operation, ['kind', 'sql', 'path'], 'operation')
  if (operation.kind === 'query') {
    if (operation.path !== undefined) fail('query operation cannot include a path')
    assertSql(operation.sql)
    return { kind: 'query', sql: operation.sql }
  }
  if (operation.kind === 'file') {
    if (operation.sql !== undefined) fail('file operation cannot include SQL')
    assertAbsolutePath(operation.path, 'file path')
    return { kind: 'file', path: operation.path }
  }
  fail('operation kind is invalid')
}

function spawnOptions() {
  return Object.freeze({
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: D1_TRANSPORT_MAX_OUTPUT_BYTES,
    timeout: D1_TRANSPORT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    shell: false,
    stdio: Object.freeze(['ignore', 'pipe', 'pipe']),
  })
}

export function buildD1Command(config, operation) {
  const normalizedConfig = validateConfig(config)
  const normalizedOperation = validateOperation(operation)
  const args = [
    'd1',
    'execute',
    normalizedConfig.database,
    normalizedConfig.mode === 'local' ? '--local' : '--remote',
  ]
  if (normalizedConfig.mode === 'local') {
    args.push('--persist-to', normalizedConfig.persistPath)
  }
  args.push('--config', normalizedConfig.configPath)
  if (normalizedOperation.kind === 'query') {
    args.push('--command', normalizedOperation.sql)
  } else {
    args.push('--file', normalizedOperation.path)
  }
  args.push('--json')

  return Object.freeze({
    executable: wranglerPath,
    args: Object.freeze(args),
    options: spawnOptions(),
  })
}

function bytesOf(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return null
}

function assertUniqueJsonObjectKeys(json) {
  let index = 0

  function skipWhitespace() {
    while (index < json.length && /[ \t\n\r]/u.test(json[index])) index += 1
  }

  function scanString() {
    const start = index
    if (json[index] !== '"') throw new SyntaxError()
    index += 1
    while (index < json.length) {
      if (json[index] === '"') {
        index += 1
        return JSON.parse(json.slice(start, index))
      }
      if (json[index] === '\\') index += 1
      index += 1
    }
    throw new SyntaxError()
  }

  function scanPrimitive() {
    const start = index
    while (index < json.length && !',]} \t\n\r'.includes(json[index])) index += 1
    if (start === index) throw new SyntaxError()
  }

  function scanArray() {
    index += 1
    skipWhitespace()
    if (json[index] === ']') {
      index += 1
      return
    }
    while (index < json.length) {
      scanValue()
      skipWhitespace()
      if (json[index] === ']') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError()
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError()
  }

  function scanObject() {
    index += 1
    skipWhitespace()
    if (json[index] === '}') {
      index += 1
      return
    }
    const keys = new Set()
    while (index < json.length) {
      const key = scanString()
      if (keys.has(key)) throw new SyntaxError()
      keys.add(key)
      skipWhitespace()
      if (json[index] !== ':') throw new SyntaxError()
      index += 1
      scanValue()
      skipWhitespace()
      if (json[index] === '}') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError()
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError()
  }

  function scanValue() {
    skipWhitespace()
    if (json[index] === '{') scanObject()
    else if (json[index] === '[') scanArray()
    else if (json[index] === '"') scanString()
    else scanPrimitive()
  }

  scanValue()
  skipWhitespace()
  if (index !== json.length) throw new SyntaxError()
}

export function parseD1JsonResponse(output) {
  const bytes = bytesOf(output)
  if (!bytes || bytes.length > D1_TRANSPORT_MAX_OUTPUT_BYTES) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }

  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }

  let response
  try {
    assertUniqueJsonObjectKeys(text)
    response = JSON.parse(text)
  } catch {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }

  if (!Array.isArray(response) || response.length !== 1 || !isPlainRecord(response[0])) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
  const envelope = response[0]
  const keys = Object.keys(envelope).sort().join(',')
  if (keys !== 'meta,results,success'
    || envelope.success !== true
    || !isPlainRecord(envelope.meta)
    || !Array.isArray(envelope.results)) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
  return envelope.results
}

function classifyChildResult(result) {
  if (!isPlainRecord(result)) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  if (result.error?.code === 'ETIMEDOUT') {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT)
  }
  if (result.error || result.signal) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  if (!Number.isSafeInteger(result.status)) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  if (result.status !== 0) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.NONZERO)
  }
  const output = bytesOf(result.stdout)
  if (output?.length > D1_TRANSPORT_MAX_OUTPUT_BYTES) {
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  return parseD1JsonResponse(output ?? result.stdout)
}

export function createD1Transport(config, dependencies = {}) {
  const normalizedConfig = validateConfig(config)
  assertExactKeys(dependencies, ['runChild'], 'dependencies')
  if (dependencies.runChild !== undefined && typeof dependencies.runChild !== 'function') {
    fail('runChild must be a function')
  }

  const runChild = dependencies.runChild ?? ((spec) => (
    spawnSync(spec.executable, spec.args, spec.options)
  ))

  function run(operation) {
    const spec = buildD1Command(normalizedConfig, operation)
    let result
    try {
      result = runChild(spec)
    } catch {
      throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
    }
    return classifyChildResult(result)
  }

  function query(sql) {
    return run({ kind: 'query', sql })
  }

  function executeFile(path) {
    return run({ kind: 'file', path })
  }

  return Object.freeze({ executeFile, query })
}
