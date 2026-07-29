import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PHASE_B_STAGES = Object.freeze([
  'pre_cas_local_gates',
  'cas1',
  'd1_identity',
  'upload',
  'clean_start_reset',
  'clean_start_empty_verify',
  'remote_migration_plan',
  'migrations_001_006',
  'cas2',
  'traffic',
  'smoke_reconcile',
  't0',
])

const sha256 = /^[a-f0-9]{64}$/
const candidate = /^[a-f0-9]{40}$/
const wranglerD1FilePrefix = '\u251c Checking if file needs uploading\n\u2502\n'
const envelopeKeys = ['finalBookmark', 'meta', 'results', 'success']
const resultKeys = [
  'Database size (MB)',
  'Rows read',
  'Rows written',
  'Total queries executed',
]

function invalidWranglerD1FileResponse() {
  throw new Error('Invalid Wrangler D1 file response')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function assertUniqueJsonObjectKeys(json) {
  let index = 0

  function skipWhitespace() {
    while (index < json.length) {
      const character = json[index]
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') break
      index += 1
    }
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
    while (index < json.length) {
      const character = json[index]
      if (character === ',' || character === ']' || character === '}'
        || character === ' ' || character === '\t' || character === '\n' || character === '\r') {
        return
      }
      index += 1
    }
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

function parseStrictJson(json) {
  try {
    const value = JSON.parse(json)
    assertUniqueJsonObjectKeys(json)
    return value
  } catch {
    invalidWranglerD1FileResponse()
  }
}

function parseWranglerD1FileResponse(stdout) {
  if (typeof stdout !== 'string') invalidWranglerD1FileResponse()
  const json = stdout.startsWith(wranglerD1FilePrefix)
    ? stdout.slice(wranglerD1FilePrefix.length)
    : stdout
  const response = parseStrictJson(json)
  if (!Array.isArray(response) || response.length !== 1) {
    invalidWranglerD1FileResponse()
  }

  const entry = response[0]
  if (!hasExactKeys(entry, envelopeKeys)
    || entry.success !== true
    || typeof entry.finalBookmark !== 'string'
    || entry.finalBookmark.trim() !== entry.finalBookmark
    || entry.finalBookmark.length === 0
    || !isRecord(entry.meta)
    || !Array.isArray(entry.results)
    || entry.results.length !== 1) {
    invalidWranglerD1FileResponse()
  }

  const row = entry.results[0]
  if (!hasExactKeys(row, resultKeys)
    || !isPositiveSafeInteger(row['Total queries executed'])
    || !isNonNegativeSafeInteger(row['Rows read'])
    || !isNonNegativeSafeInteger(row['Rows written'])
    || typeof row['Database size (MB)'] !== 'string'
    || !/^\d+\.\d{2}$/.test(row['Database size (MB)'])
    || !isNonNegativeSafeInteger(entry.meta.rows_read)
    || !isNonNegativeSafeInteger(entry.meta.rows_written)
    || !isNonNegativeSafeInteger(entry.meta.size_after)
    || row['Rows read'] !== entry.meta.rows_read
    || row['Rows written'] !== entry.meta.rows_written
    || row['Database size (MB)'] !== (entry.meta.size_after / 1e6).toFixed(2)) {
    invalidWranglerD1FileResponse()
  }
  return response
}

function hasCleanStartAuthorization(bindings) {
  const disposition = bindings.historicalDataDisposition
  return bindings.deliveryMode === 'clean-start'
    && sha256.test(bindings.cleanStartResetSqlSha256)
    && Object.isFrozen(disposition)
    && disposition.productionExport === 'NOT_APPLICABLE'
    && disposition.doubleRestore === 'NOT_APPLICABLE'
    && disposition.historicalBaselineQueries === 'NOT_APPLICABLE'
    && JSON.stringify(Object.keys(disposition).sort()) === JSON.stringify([
      'doubleRestore',
      'historicalBaselineQueries',
      'productionExport',
    ])
}

function validateInputs(configPath, bindings) {
  if (!isAbsolute(configPath)) throw new Error('Phase B requires an absolute CONFIG path')
  try {
    if (!lstatSync(configPath).isFile()) throw new Error()
  } catch {
    throw new Error('Phase B requires an absolute CONFIG path to an existing regular file')
  }
  if (!Object.isFrozen(bindings)) throw new Error('Phase B requires immutable Phase B bindings')
  if (!candidate.test(bindings.candidateId)
    || !sha256.test(bindings.approvalPacketSha256)
    || !sha256.test(bindings.buildArchiveSha256)
    || !bindings.baselineDeploymentId
    || !bindings.baselineVersionId
    || !bindings.baselineD1DatabaseId) {
    throw new Error('Phase B bindings are incomplete or invalid')
  }
  if (!hasCleanStartAuthorization(bindings)) {
    throw new Error('Phase B clean-start authorization is incomplete or invalid')
  }
}

export async function runPhaseBSequence({ configPath, bindings, runStage }) {
  validateInputs(configPath, bindings)
  if (typeof runStage !== 'function') throw new Error('Phase B requires a stage executor')

  const context = Object.freeze({ configPath, bindings })
  const counts = Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 0]))
  for (const stage of PHASE_B_STAGES) {
    counts[stage] += 1
    await runStage(stage, context)
  }
  return Object.freeze(counts)
}

function isMainModule() {
  return process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

if (isMainModule()) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'validate-wrangler-d1-file-response') {
      invalidWranglerD1FileResponse()
    }
    parseWranglerD1FileResponse(readFileSync(0, 'utf8'))
    process.stdout.write('{"state":"valid"}\n')
  } catch {
    process.stderr.write('Invalid Wrangler D1 file response\n')
    process.exitCode = 1
  }
}
