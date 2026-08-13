import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const TERMINAL_RESULT_FORMAT = 'blogman-issue-23-terminal-result/v1'
const RECORD_FORMATS = new Set([
  'blogman-issue-23-canonical-frozen-manifest/v1',
  'blogman-issue-23-d1-stages/v1',
  'blogman-issue-23-worker-stages/v1',
  TERMINAL_RESULT_FORMAT,
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
  'body', 'content', 'html', 'token', 'password', 'secret', 'rawresponse', 'responsebody',
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
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail(`${label} bytes are not canonical`)
  }
  let value
  try {
    value = JSON.parse(text.slice(0, -1))
  } catch {
    fail(`${label} bytes are not valid JSON`)
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

function secureDirectoryIdentity(path, label) {
  let stat
  try { stat = lstatSync(path) } catch { fail(`${label} is unavailable`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a canonical directory`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label} owner drifted`)
  if ((stat.mode & 0o777) !== 0o700) fail(`${label} mode drifted`)
  return Object.freeze({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 })
}

function assertDirectoryIdentity(path, expected, label) {
  const actual = secureDirectoryIdentity(path, label)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== expected.uid
    || actual.mode !== expected.mode) fail(`${label} root identity drifted`)
}

function createDirectory(path, label) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return secureDirectoryIdentity(path, label)
}

function assertSecureFile(path, label) {
  let stat
  try { stat = lstatSync(path) } catch { fail(`${label} is missing from the durable sink`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label} is not a canonical durable file`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label} owner drifted`)
  if ((stat.mode & 0o777) !== 0o600) fail(`${label} mode drifted`)
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
    unlinkSync(temporary)
    syncDirectory(directory)
    checkDeadline(deadline)
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
    if (error?.code === 'EEXIST') fail('authorization has already been consumed')
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
  if (!isRecord(input)
    || Object.keys(input).length !== 4
    || !['terminal', 'manifest', 'd1', 'worker'].every((key) => Object.hasOwn(input, key))) {
    fail('terminal persistence input is malformed')
  }
  const terminal = canonicalRecord(input.terminal, 'terminal result')
  const manifest = canonicalRecord(input.manifest, 'manifest')
  const d1 = input.d1 === null ? null : canonicalRecord(input.d1, 'D1 evidence')
  const worker = input.worker === null ? null : canonicalRecord(input.worker, 'Worker evidence')
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
  if (worker !== null) {
    const evidence = worker.value.evidence
    if (!isRecord(evidence)
      || evidence.manifest_sha256 !== manifest.sha256
      || evidence.authorization_sha256 !== authorization.sha256
      || evidence.attempt_id !== terminal.value.attempt_id
      || evidence.candidate_id !== manifest.value.repository?.commit) {
      fail('Worker evidence identity does not match Terminal Result')
    }
  }
  const recordsDirectory = join(root, 'records')
  for (const [record, label] of [[manifest, 'manifest'], [d1, 'D1 evidence'], [worker, 'Worker evidence']]) {
    if (record !== null) writeIfAbsent(join(recordsDirectory, `${record.sha256}.json`), record.bytes, recordsDirectory, label, deadline)
  }
  const terminalDirectory = join(root, 'terminals')
  writeIfAbsent(join(terminalDirectory, `${terminal.sha256}.json`), terminal.bytes, terminalDirectory, 'terminal result', deadline)
  return terminal.sha256
}

function readTerminalEvidence(root, terminalSha256) {
  if (typeof terminalSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(terminalSha256)) {
    fail('terminal result identity is invalid')
  }
  const terminalPath = join(root, 'terminals', `${terminalSha256}.json`)
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

export function repositoryDeliverySinkRoot(repositoryRoot = REPOSITORY_ROOT) {
  const output = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim()
  if (!isAbsolute(output) || realpathSync(output) !== resolve(output)) fail('repository common root is not canonical')
  return join(output, 'blogman-issue-23-delivery')
}

export function createRepositoryDeliverySink(root = repositoryDeliverySinkRoot()) {
  const requestedRoot = resolve(root)
  createDirectory(requestedRoot, 'sink root')
  const resolvedRoot = realpathSync(requestedRoot)
  const rootIdentity = secureDirectoryIdentity(resolvedRoot, 'sink root')
  const directories = Object.freeze(Object.fromEntries(['authorizations', 'records', 'terminals'].map((name) => {
    const path = join(resolvedRoot, name)
    return [name, Object.freeze({ path, identity: createDirectory(path, `${name} directory`) })]
  })))
  const assertSinkIdentity = () => {
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

function defaultSink() {
  return createRepositoryDeliverySink()
}

export const repositoryDeliverySink = Object.freeze({
  consumeAuthorization: (record) => defaultSink().consumeAuthorization(record),
  persistTerminalResult: (input) => defaultSink().persistTerminalResult(input),
  readTerminalEvidence: (terminalSha256) => defaultSink().readTerminalEvidence(terminalSha256),
})
