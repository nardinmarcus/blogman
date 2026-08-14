import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { parseStrictJson } from './issue-23-delivery-d1-contracts.mjs'
const PRODUCTION_AUTHORITY_HOME = resolve(userInfo().homedir)
const PRODUCTION_AUTHORITY_ROOT = join(
  PRODUCTION_AUTHORITY_HOME,
  '.local',
  'state',
  'blogman',
  'issue-23-production-authority-v1',
)
const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const TERMINAL_RESULT_FORMAT = 'blogman-issue-23-terminal-result/v1'
const RECORD_FORMATS = new Set([
  'blogman-issue-23-canonical-frozen-manifest/v1',
  'blogman-issue-23-d1-stages/v1',
  'blogman-issue-23-worker-stages/v1',
  TERMINAL_RESULT_FORMAT,
])
const DELIVERY_STAGES = Object.freeze([
  'authorization_accept', 'live_preconditions', 'd1_identity', 'clean_start_reset',
  'empty_d1_proof', 'migrations_001_006', 'reconciliation', 'worker_deploy',
  'version_traffic_verification', 'smoke_control_t0',
])
const D1_STAGES = Object.freeze([
  'd1_identity', 'clean_start_reset', 'empty_d1_proof', 'migrations_001_006', 'reconciliation',
])
const WORKER_STAGES = Object.freeze(['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'])
const D1_EVIDENCE_FIELDS = Object.freeze([
  'source', 'production', 'promotable', 'bindings_sha256', 'wrangler_sha256',
  'manifest_sha256', 'authorization_sha256', 'attempt_id', 'account_id',
  'd1_database_id', 'config_sha256', 'candidate_id', 'reset_sql_sha256',
  'migration_runner_sha256', 'migration_catalog_sha256', 'rollout_safety_sha256',
  'expected_reconciliation_sha256', 'trace_sha256',
])
const WORKER_EVIDENCE_HASHES = Object.freeze([
  'upload_acceptance_sha256', 'version_traffic_sha256', 'smoke_control_t0_sha256',
])
const TERMINAL_EVIDENCE_HASHES = Object.freeze([
  'd1_stage_receipt_sha256',
  ...[
    'bindings_sha256', 'wrangler_sha256', 'config_sha256', 'reset_sql_sha256',
    'migration_runner_sha256', 'migration_catalog_sha256', 'rollout_safety_sha256',
    'expected_reconciliation_sha256', 'trace_sha256',
  ].map((name) => `d1_${name}`),
  'worker_stage_receipt_sha256',
  ...WORKER_EVIDENCE_HASHES.map((name) => `worker_${name}`),
])
let temporaryFileSequence = 0

function fail(message) {
  throw new Error(`Issue #23 durable delivery sink: ${message}`)
}

export class DeliverySinkDeadlineError extends Error {
  constructor() {
    super('Issue #23 durable delivery sink: hard deadline exceeded')
    this.name = 'DeliverySinkDeadlineError'
  }
}

function checkDeadline(deadline) {
  if (deadline !== undefined && deadline() !== true) throw new DeliverySinkDeadlineError()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const PRIVATE_EVIDENCE_KEYS = new Set([
  'apikey', 'accesstoken', 'authorizationheader', 'body', 'content', 'cookie', 'credential',
  'html', 'password', 'privateoutput', 'rawoutput', 'rawprivateadapteroutput', 'rawresponse',
  'responsebody', 'secret', 'token',
])

function assertNoPrivateEvidence(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoPrivateEvidence)
    return
  }
  if (typeof value === 'string') {
    if (/(?<![A-Za-z0-9_-])(?:sk-|nm_)[A-Za-z0-9_-]{4,}/u.test(value)) fail('evidence contains a secret value')
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
    if (PRIVATE_EVIDENCE_KEYS.has(normalized)) fail('evidence contains a private field')
    assertNoPrivateEvidence(child)
  }
}

function canonicalRecord(record, label) {
  if (!isRecord(record)
    || !(record.bytes instanceof Uint8Array)
    || typeof record.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
    fail(`${label} is malformed`)
  }
  const bytes = Buffer.from(record.bytes)
  if (sha256(bytes) !== record.sha256) fail(`${label} identity does not match bytes`)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)
    || !text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail(`${label} bytes are not canonical`)
  }
  let value
  try {
    value = parseStrictJson(text.slice(0, -1))
  } catch {
    fail(`${label} bytes are not valid strict JSON`)
  }
  if (!isRecord(value) || `${JSON.stringify(value, null, 2)}\n` !== text) {
    fail(`${label} bytes are not canonical`)
  }
  if (record.value !== undefined && (!isRecord(record.value) || JSON.stringify(record.value) !== JSON.stringify(value))) {
    fail(`${label} value does not match bytes`)
  }
  assertNoPrivateEvidence(value)
  return Object.freeze({
    value,
    bytes,
    sha256: record.sha256,
  })
}

function canonicalAuthorization(record) {
  const canonical = canonicalRecord(record, 'authorization')
  const keys = ['format', 'authorization_id', 'manifest_sha256', 'decision']
  if (Object.keys(canonical.value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(canonical.value, key))) {
    fail('authorization contains unsupported fields')
  }
  if (canonical.value.format !== AUTHORIZATION_FORMAT) fail('authorization format is invalid')
  if (typeof canonical.value.authorization_id !== 'string'
    || canonical.value.authorization_id.length === 0
    || canonical.value.authorization_id.length > 256
    || /[\u0000\r\n]/u.test(canonical.value.authorization_id)) {
    fail('authorization authorization_id is invalid')
  }
  if (typeof canonical.value.manifest_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(canonical.value.manifest_sha256)) {
    fail('authorization manifest identity is invalid')
  }
  if (canonical.value.decision !== 'approve') fail('authorization decision is invalid')
  return canonical
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function assertHash(value, label, nullable = false) {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} identity is invalid`)
}

function assertStageMaps(counts, durations, stages, label) {
  if (!exactKeys(counts, stages) || !exactKeys(durations, stages)) fail(`${label} Stage schema is invalid`)
  for (const stage of stages) {
    if (!Number.isSafeInteger(counts[stage]) || ![0, 1].includes(counts[stage])
      || !Number.isSafeInteger(durations[stage]) || durations[stage] < 0
      || (counts[stage] === 0 && durations[stage] !== 0)) {
      fail(`${label} Stage trajectory is invalid`)
    }
  }
}

function assertTerminalAttemptIdentity(value) {
  if (!exactKeys(value.identities, ['manifest_sha256', 'authorization_sha256'])) {
    fail('terminal result identities are invalid')
  }
  assertHash(value.identities.manifest_sha256, 'terminal manifest')
  assertHash(value.identities.authorization_sha256, 'terminal authorization')
  const expected = sha256(Buffer.from(`${JSON.stringify({
    format: 'blogman-issue-23-attempt/v1',
    manifest_sha256: value.identities.manifest_sha256,
    authorization_sha256: value.identities.authorization_sha256,
  }, null, 2)}\n`, 'utf8'))
  if (typeof value.attempt_id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.attempt_id)
    || value.attempt_id !== expected) {
    fail('terminal result attempt identity is invalid')
  }
}

function assertTerminalSchema(value) {
  const keys = [
    'format', 'identities', 'attempt_id', 'started_at', 'ended_at', 'authorization_consumed',
    'outcome', 'first_terminal_stage', 'failure', 'stage_counts', 'stage_durations_ms',
    'mutation_counts', 'evidence', 'finalized',
  ]
  if (!exactKeys(value, keys) || value.format !== TERMINAL_RESULT_FORMAT
    || value.authorization_consumed !== true || value.finalized !== true
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || typeof value.started_at !== 'string' || Number.isNaN(Date.parse(value.started_at))
    || typeof value.ended_at !== 'string' || Number.isNaN(Date.parse(value.ended_at))) {
    fail('terminal result schema is invalid')
  }
  assertTerminalAttemptIdentity(value)
  assertStageMaps(value.stage_counts, value.stage_durations_ms, DELIVERY_STAGES, 'terminal result')
  const terminalIndex = DELIVERY_STAGES.indexOf(value.first_terminal_stage)
  if (terminalIndex < 0 || DELIVERY_STAGES.some((stage, index) => (
    value.stage_counts[stage] !== (index <= terminalIndex ? 1 : 0)
  ))) fail('terminal result trajectory is contradictory')
  if (value.outcome === 'PASS') {
    if (value.first_terminal_stage !== 'smoke_control_t0' || value.failure !== null) {
      fail('terminal result trajectory is contradictory')
    }
  } else if (!exactKeys(value.failure, ['classification'])
    || typeof value.failure.classification !== 'string' || value.failure.classification.length === 0) {
    fail('terminal result failure is invalid')
  }
  if (!exactKeys(value.mutation_counts, ['production_writes', 'attempted', 'confirmed'])
    || Object.values(value.mutation_counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || value.mutation_counts.production_writes !== value.mutation_counts.confirmed
    || value.mutation_counts.confirmed > value.mutation_counts.attempted) {
    fail('terminal result mutation evidence is contradictory')
  }
  if (!exactKeys(value.evidence, ['source', 'production', 'promotable', 'hashes', 'cleanup'])
    || typeof value.evidence.source !== 'string' || typeof value.evidence.production !== 'boolean'
    || typeof value.evidence.promotable !== 'boolean'
    || value.evidence.promotable !== (value.evidence.production && value.outcome === 'PASS')
    || !exactKeys(value.evidence.hashes, TERMINAL_EVIDENCE_HASHES)
    || Object.values(value.evidence.hashes).some((hash) => hash !== null && !/^[a-f0-9]{64}$/u.test(hash))
    || !exactKeys(value.evidence.cleanup, ['created', 'cleaned', 'observed_absent'])
    || Object.values(value.evidence.cleanup).some((flag) => typeof flag !== 'boolean')) {
    fail('terminal result evidence schema is invalid')
  }
}

function assertD1Schema(value) {
  if (!exactKeys(value, [
    'format', 'outcome', 'first_terminal_stage', 'failure', 'stage_counts',
    'stage_durations_ms', 'evidence', 'finalized',
  ]) || value.format !== 'blogman-issue-23-d1-stages/v1' || value.finalized !== true
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || !exactKeys(value.evidence, D1_EVIDENCE_FIELDS)) {
    fail('D1 evidence schema contains unsupported fields')
  }
  assertStageMaps(value.stage_counts, value.stage_durations_ms, D1_STAGES, 'D1 evidence')
  for (const field of D1_EVIDENCE_FIELDS.filter((name) => name.endsWith('sha256'))) {
    assertHash(value.evidence[field], `D1 evidence ${field}`)
  }
}

function assertWorkerSchema(value) {
  if (!exactKeys(value, [
    'format', 'outcome', 'first_terminal_stage', 'failure', 'stage_counts',
    'stage_durations_ms', 'mutation_counts', 'evidence', 'finalized',
  ]) || value.format !== 'blogman-issue-23-worker-stages/v1' || value.finalized !== true
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || !exactKeys(value.mutation_counts, ['attempted', 'confirmed'])
    || !exactKeys(value.evidence, [
      'source', 'production', 'promotable', 'manifest_sha256', 'authorization_sha256',
      'attempt_id', 'candidate_id', 'hashes',
    ]) || !exactKeys(value.evidence.hashes, WORKER_EVIDENCE_HASHES)) {
    fail('Worker evidence schema contains unsupported fields')
  }
  assertStageMaps(value.stage_counts, value.stage_durations_ms, WORKER_STAGES, 'Worker evidence')
}

function syncDirectory(path) {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
}

function directoryIdentity(path, label) {
  let stat
  try { stat = lstatSync(path) } catch { fail(`${label} is unavailable`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a canonical directory`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label} owner drifted`)
  return Object.freeze({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 })
}

function canonicalDirectoryIdentity(path, label) {
  const identity = directoryIdentity(path, label)
  let canonical
  try { canonical = realpathSync(path) } catch { fail(`${label} is unavailable`) }
  if (canonical !== path) fail(`${label} resolved outside its canonical lexical path`)
  return identity
}

function secureDirectoryIdentity(path, label) {
  const identity = directoryIdentity(path, label)
  if (identity.mode !== 0o700) fail(`${label} mode drifted`)
  return identity
}

function assertDirectoryIdentity(path, expected, label, identity = secureDirectoryIdentity) {
  const actual = identity(path, label)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== expected.uid
    || actual.mode !== expected.mode) fail(`${label} root identity drifted`)
}

function createDirectory(path, label) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return secureDirectoryIdentity(path, label)
}

function createCanonicalProductionDirectory(path, label) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return canonicalDirectoryIdentity(path, label)
}

function assertSecureFile(path, label, expectedLinks = 1) {
  let stat
  try { stat = lstatSync(path) } catch { fail(`${label} is missing from the durable sink`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== expectedLinks) fail(`${label} is not a canonical durable file`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label} owner drifted`)
  if ((stat.mode & 0o777) !== 0o600) fail(`${label} mode drifted`)
}

function assertSecurePublishedFile(path, directory, label) {
  let metadata
  try { metadata = lstatSync(path) } catch { fail(`${label} is missing from the durable sink`) }
  if (metadata.nlink === 1) {
    assertSecureFile(path, label)
    return
  }
  if (metadata.nlink !== 2 || !metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o600) {
    fail(`${label} is not a canonical durable file`)
  }
  const destinationName = path.split('/').at(-1)
  const temporaryPrefix = `.${destinationName}.`
  const companions = readdirSync(directory).filter((name) => (
    name.startsWith(temporaryPrefix) && name.endsWith('.tmp')
  )).filter((name) => {
    try {
      const candidate = lstatSync(join(directory, name))
      return candidate.isFile() && !candidate.isSymbolicLink()
        && candidate.dev === metadata.dev && candidate.ino === metadata.ino
        && candidate.uid === metadata.uid && (candidate.mode & 0o777) === 0o600
    } catch {
      return false
    }
  })
  if (companions.length !== 1) {
    try {
      assertSecureFile(path, label)
      return
    } catch {
      fail(`${label} is not a canonical durable file`)
    }
  }
}

function atomicWrite(path, bytes, directory, deadline) {
  const temporary = join(
    directory,
    `.${path.split('/').at(-1)}.${process.pid}.${temporaryFileSequence += 1}.tmp`,
  )
  let descriptor
  try {
    checkDeadline(deadline)
    descriptor = openSync(temporary, 'wx', 0o600)
    writeAll(descriptor, bytes)
    fsyncSync(descriptor)
    checkDeadline(deadline)
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporary, path)
    assertSecureFile(path, 'durable destination', 2)
    syncDirectory(directory)
    unlinkSync(temporary)
    syncDirectory(directory)
    assertSecureFile(path, 'durable destination')
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function writeIfAbsent(path, bytes, directory, label, deadline) {
  try {
    atomicWrite(path, bytes, directory, deadline)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    assertSecurePublishedFile(path, directory, label)
    let existing
    try { existing = readFileSync(path) } catch { throw error }
    if (!existing.equals(bytes)) fail(`${label} has conflicting durable bytes`)
  }
}

function consumeAuthorization(root, record, deadline) {
  const canonical = canonicalAuthorization(record)
  const directory = join(root, 'authorizations')
  const destination = join(directory, `${canonical.sha256}.json`)
  try {
    atomicWrite(destination, canonical.bytes, directory, deadline)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      assertSecurePublishedFile(destination, directory, 'authorization')
      fail('authorization has already been consumed')
    }
    throw error
  }
  return canonical.sha256
}

function readAuthorization(root, sha256Value) {
  if (typeof sha256Value !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256Value)) {
    fail('authorization identity is invalid')
  }
  let bytes
  const path = join(root, 'authorizations', `${sha256Value}.json`)
  assertSecureFile(path, 'authorization')
  try { bytes = readFileSync(path) } catch { fail('authorization is missing from the durable sink') }
  return canonicalAuthorization({ bytes, sha256: sha256Value })
}

function readRecord(root, sha256Value, label) {
  if (typeof sha256Value !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256Value)) {
    fail(`${label} identity is invalid`)
  }
  const path = join(root, 'records', `${sha256Value}.json`)
  let bytes
  assertSecureFile(path, label)
  try { bytes = readFileSync(path) } catch { fail(`${label} is missing from the durable sink`) }
  const record = canonicalRecord({ bytes, sha256: sha256Value }, label)
  if (!RECORD_FORMATS.has(record.value.format)) fail(`${label} format is invalid`)
  return record
}

function persistTerminalResult(root, input, deadline) {
  checkDeadline(deadline)
  if (!isRecord(input)
    || Object.keys(input).length !== 4
    || !['terminal', 'manifest', 'd1', 'worker'].every((key) => Object.hasOwn(input, key))) {
    fail('terminal persistence input is malformed')
  }
  const terminal = canonicalRecord(input.terminal, 'terminal result')
  assertTerminalAttemptIdentity(terminal.value)
  const manifest = canonicalRecord(input.manifest, 'manifest')
  const d1 = input.d1 === null ? null : canonicalRecord(input.d1, 'D1 evidence')
  const worker = input.worker === null ? null : canonicalRecord(input.worker, 'Worker evidence')
  assertTerminalSchema(terminal.value)
  if (d1 !== null) assertD1Schema(d1.value)
  if (worker !== null) assertWorkerSchema(worker.value)
  if (terminal.value.format !== TERMINAL_RESULT_FORMAT
    || manifest.value.format !== 'blogman-issue-23-canonical-frozen-manifest/v1'
    || (d1 !== null && d1.value.format !== 'blogman-issue-23-d1-stages/v1')
    || (worker !== null && worker.value.format !== 'blogman-issue-23-worker-stages/v1')) {
    fail('terminal persistence record formats are invalid')
  }
  const hashes = terminal.value.evidence?.hashes
  if (!isRecord(terminal.value.identities)
    || terminal.value.identities.manifest_sha256 !== manifest.sha256
    || typeof terminal.value.identities.authorization_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(terminal.value.identities.authorization_sha256)
    || !isRecord(hashes)
    || hashes.d1_stage_receipt_sha256 !== (d1?.sha256 ?? null)
    || hashes.worker_stage_receipt_sha256 !== (worker?.sha256 ?? null)) {
    fail('terminal persistence identities do not match durable evidence')
  }
  const authorization = readAuthorization(root, terminal.value.identities.authorization_sha256)
  if (authorization.value.manifest_sha256 !== manifest.sha256) {
    fail('terminal persistence authorization does not match manifest')
  }
  for (const [record, label] of [[d1, 'D1'], [worker, 'Worker']]) {
    if (record === null) continue
    const evidence = record.value.evidence
    if (!isRecord(evidence)
      || evidence.manifest_sha256 !== manifest.sha256
      || evidence.authorization_sha256 !== authorization.sha256
      || evidence.attempt_id !== terminal.value.attempt_id
      || evidence.candidate_id !== manifest.value.repository?.commit) {
      fail(`${label} evidence identity does not match Terminal Result`)
    }
  }
  const recordsDirectory = join(root, 'records')
  for (const [record, label] of [[manifest, 'manifest'], [d1, 'D1 evidence'], [worker, 'Worker evidence']]) {
    if (record !== null) writeIfAbsent(join(recordsDirectory, `${record.sha256}.json`), record.bytes, recordsDirectory, label, deadline)
  }
  const terminalDirectory = join(root, 'terminals')
  const terminalSlot = join(terminalDirectory, `${terminal.value.attempt_id}.json`)
  writeIfAbsent(terminalSlot, terminal.bytes, terminalDirectory, 'terminal result', deadline)
  return terminal.sha256
}

function readTerminalEvidence(root, terminalSha256) {
  if (typeof terminalSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(terminalSha256)) {
    fail('terminal result identity is invalid')
  }
  const terminalDirectory = join(root, 'terminals')
  let terminalPath
  for (const name of readdirSync(terminalDirectory).sort()) {
    const candidate = join(terminalDirectory, name)
    assertSecureFile(candidate, 'terminal result')
    const bytes = readFileSync(candidate)
    if (sha256(bytes) === terminalSha256) {
      terminalPath = candidate
      break
    }
  }
  if (!terminalPath) fail('terminal result is missing from the durable sink')
  let terminalBytes
  assertSecureFile(terminalPath, 'terminal result')
  try { terminalBytes = readFileSync(terminalPath) } catch { fail('terminal result is missing from the durable sink') }
  const terminal = canonicalRecord({ bytes: terminalBytes, sha256: terminalSha256 }, 'terminal result')
  if (terminal.value.format !== TERMINAL_RESULT_FORMAT) fail('terminal result format is invalid')
  const hashes = terminal.value.evidence?.hashes ?? {}
  const manifest = readRecord(root, terminal.value.identities.manifest_sha256, 'manifest')
  const authorization = readAuthorization(root, terminal.value.identities.authorization_sha256)
  if (authorization.value.manifest_sha256 !== manifest.sha256) {
    fail('terminal result identity set is inconsistent')
  }
  return Object.freeze({
    terminal,
    manifest,
    authorization,
    d1: hashes.d1_stage_receipt_sha256 === null ? null : readRecord(root, hashes.d1_stage_receipt_sha256, 'D1 evidence'),
    worker: hashes.worker_stage_receipt_sha256 === null ? null : readRecord(root, hashes.worker_stage_receipt_sha256, 'Worker evidence'),
  })
}

export function repositoryDeliverySinkRoot() {
  return PRODUCTION_AUTHORITY_ROOT
}

function deliverySink(resolvedRoot, rootIdentity, ancestors = []) {
  const directories = Object.freeze(Object.fromEntries(['authorizations', 'records', 'terminals'].map((name) => {
    const path = join(resolvedRoot, name)
    return [name, Object.freeze({ path, identity: createDirectory(path, `${name} directory`) })]
  })))
  const assertSinkIdentity = () => {
    for (const entry of ancestors) {
      assertDirectoryIdentity(entry.path, entry.identity, entry.label, canonicalDirectoryIdentity)
    }
    assertDirectoryIdentity(resolvedRoot, rootIdentity, 'sink root')
    for (const [name, entry] of Object.entries(directories)) {
      assertDirectoryIdentity(entry.path, entry.identity, `${name} directory`)
    }
  }
  return Object.freeze({
    consumeAuthorization(record, deadline) {
      assertSinkIdentity()
      return consumeAuthorization(resolvedRoot, record, deadline)
    },
    persistTerminalResult(input, deadline) {
      assertSinkIdentity()
      return persistTerminalResult(resolvedRoot, input, deadline)
    },
    readTerminalEvidence(terminalSha256) {
      assertSinkIdentity()
      return readTerminalEvidence(resolvedRoot, terminalSha256)
    },
  })
}

export function createRepositoryDeliverySink(root) {
  if (typeof root !== 'string') fail('explicit test-only sink root is required')
  const requestedRoot = resolve(root)
  mkdirSync(dirname(requestedRoot), { recursive: true, mode: 0o700 })
  createDirectory(requestedRoot, 'sink root')
  const resolvedRoot = realpathSync(requestedRoot)
  const rootIdentity = secureDirectoryIdentity(resolvedRoot, 'sink root')
  return deliverySink(resolvedRoot, rootIdentity)
}

function createCanonicalProductionSink() {
  const ancestors = []
  let path = PRODUCTION_AUTHORITY_HOME
  ancestors.push(Object.freeze({
    path,
    label: 'authority home',
    identity: canonicalDirectoryIdentity(path, 'authority home'),
  }))
  for (const name of ['.local', 'state', 'blogman', 'issue-23-production-authority-v1']) {
    path = join(path, name)
    ancestors.push(Object.freeze({
      path,
      label: `authority ${name} directory`,
      identity: createCanonicalProductionDirectory(path, `authority ${name} directory`),
    }))
  }
  if (path !== PRODUCTION_AUTHORITY_ROOT || realpathSync(path) !== PRODUCTION_AUTHORITY_ROOT) {
    fail('production authority resolved outside its canonical lexical root')
  }
  const rootIdentity = secureDirectoryIdentity(PRODUCTION_AUTHORITY_ROOT, 'sink root')
  return deliverySink(PRODUCTION_AUTHORITY_ROOT, rootIdentity, ancestors)
}

function defaultSink() {
  return createCanonicalProductionSink()
}

/** Canonical production authority. Test/formal sinks cannot replace this facade. */
export const repositoryDeliverySink = Object.freeze({
  consumeAuthorization: (record, deadline) => defaultSink().consumeAuthorization(record, deadline),
  persistTerminalResult: (input, deadline) => defaultSink().persistTerminalResult(input, deadline),
  readTerminalEvidence: (terminalSha256) => defaultSink().readTerminalEvidence(terminalSha256),
})
