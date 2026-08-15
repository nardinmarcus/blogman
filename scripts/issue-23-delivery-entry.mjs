import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { platform, tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANONICAL_MANIFEST_FORMAT,
  parseCanonicalManifest,
  prepare,
} from './issue-23-delivery-prepare.mjs'
import { currentFormalRehearsalContext, runInFormalRehearsalContext } from './issue-23-delivery-formal-context.mjs'
import { currentFormalFaultForTestsOnly } from './issue-23-delivery-formal-fault-harness.mjs'
import {
  D1_COMMAND_CONTRACT,
  D1_TRANSPORT_FAILURE_CLASSIFICATIONS,
  D1_TRANSPORT_MAX_OUTPUT_BYTES,
  D1TransportError,
  createRehearsalD1Transport,
} from './issue-23-delivery-d1-transport.mjs'
import {
  d1StageBindingsSha256,
  hashD1ArtifactDirectory,
  parseStrictJson,
} from './issue-23-delivery-d1-contracts.mjs'
import { D1ChildError, runBoundedChild } from './issue-23-delivery-d1-child.mjs'
import { runD1Stages } from './issue-23-delivery-d1-stages.mjs'
import {
  WORKER_COMMAND_CONTRACT,
  createRehearsalWorkerTransport,
} from './issue-23-delivery-worker-transport.mjs'
import { WorkerTransportError, runWorkerStages } from './issue-23-delivery-worker-stages.mjs'
import { formalExecutionClosureSha256 } from './issue-23-delivery-execution-closure.mjs'

const AUTHORIZATION_ID_PATTERN = /^issue23-authorization-[a-f0-9]{64}$/u

function buildDeliverySinkOwnership() {
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
  const FAILURE_CLASSIFICATIONS_BY_OUTCOME = Object.freeze({
    TIMEOUT: new Set(['overall_timeout', 'stage_timeout', 'timeout']),
    UNCERTAIN: new Set([
      'uncertain', 'formal_rehearsal_uncertain', 'live_preconditions_uncertain',
      'worker_adapter_uncertain',
    ]),
    NON_PASS: new Set([
      'Manifest Drift', 'cloudflare_permission_insufficient', 'd1_not_empty',
      'empty_only_plan_invalid', 'formal_rehearsal_forced_failure', 'migration_contract_invalid',
      'migration_ledger_invalid', 'reconciliation_contract_invalid', 'reconciliation_drift',
      'smoke_control_contract_invalid', 'version_traffic_mismatch',
    ]),
    ERROR: new Set([
      'cloudflare_auth_unavailable', 'credential_authority_unavailable', 'd1_identity_malformed',
      'd1_identity_response_invalid', 'deployment_status_malformed', 'empty_d1_proof_invalid',
      'formal_rehearsal_d1_adapter_error', 'formal_rehearsal_d1_result_malformed',
      'formal_rehearsal_d1_setup_error', 'formal_rehearsal_response_malformed',
      'live_preconditions_error', 'live_preconditions_malformed', 'malformed', 'nonzero',
      'production_d1_adapter_error', 'production_d1_result_malformed', 'production_d1_setup_error',
      'reconciliation_malformed', 'reconciliation_response_invalid', 'reset_response_invalid',
      'rollout_controls_malformed', 'smoke_auth_policy_invalid', 'smoke_auth_unavailable', 'stage_error',
      'transport_binding_mismatch', 'transport_error', 'upload_acceptance_malformed',
      'upload_contract_invalid', 'worker_adapter_error', 'worker_adapter_nonzero',
      'worker_response_malformed', 'worker_result_malformed',
    ]),
  })
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

  class DeliverySinkDeadlineError extends Error {
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
      || !AUTHORIZATION_ID_PATTERN.test(canonical.value.authorization_id)) {
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

  function validFailureClassification(outcome, classification) {
    return typeof classification === 'string'
      && FAILURE_CLASSIFICATIONS_BY_OUTCOME[outcome]?.has(classification) === true
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
      || !validFailureClassification(value.outcome, value.failure.classification)) {
      fail('terminal result outcome/classification is invalid')
    }
    if (!exactKeys(value.mutation_counts, ['production_writes', 'attempted', 'confirmed'])
      || Object.values(value.mutation_counts).some((count) => !Number.isSafeInteger(count) || count < 0)
      || value.mutation_counts.production_writes !== value.mutation_counts.confirmed
      || value.mutation_counts.confirmed > value.mutation_counts.attempted
      || value.mutation_counts.attempted > (
        value.stage_counts.clean_start_reset + value.stage_counts.migrations_001_006
        + value.stage_counts.worker_deploy + value.stage_counts.version_traffic_verification
      )) {
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
    const terminalIndex = value.outcome === 'PASS' ? D1_STAGES.length - 1 : D1_STAGES.indexOf(value.first_terminal_stage)
    if (terminalIndex < 0 || D1_STAGES.some((stage, index) => (
      value.stage_counts[stage] !== (index <= terminalIndex ? 1 : 0)
    )) || (value.outcome === 'PASS'
      ? value.first_terminal_stage !== null || value.failure !== null
      : !exactKeys(value.failure, ['classification'])
        || !validFailureClassification(value.outcome, value.failure.classification))
      || typeof value.evidence.source !== 'string'
      || typeof value.evidence.production !== 'boolean'
      || value.evidence.promotable !== (value.evidence.production && value.outcome === 'PASS')) {
      fail('D1 evidence trajectory is contradictory')
    }
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
    const terminalIndex = value.outcome === 'PASS'
      ? WORKER_STAGES.length - 1
      : WORKER_STAGES.indexOf(value.first_terminal_stage)
    const preAdapterFailure = value.first_terminal_stage === 'worker_deploy'
      && ['overall_timeout', 'worker_result_malformed'].includes(value.failure?.classification)
      && value.mutation_counts.attempted === 0
      && value.mutation_counts.confirmed === 0
    if (terminalIndex < 0 || WORKER_STAGES.some((stage, index) => (
      value.stage_counts[stage] !== (index <= terminalIndex ? 1 : 0)
    )) || (value.outcome === 'PASS'
      ? value.first_terminal_stage !== null || value.failure !== null
      : !exactKeys(value.failure, ['classification'])
        || !validFailureClassification(value.outcome, value.failure.classification))
      || !Number.isSafeInteger(value.mutation_counts.attempted)
      || !Number.isSafeInteger(value.mutation_counts.confirmed)
      || value.mutation_counts.confirmed < 0
      || value.mutation_counts.confirmed > value.mutation_counts.attempted
      || (!preAdapterFailure
        && value.mutation_counts.attempted !== (terminalIndex >= 1 ? 2 : 1))
      || value.mutation_counts.confirmed !== (terminalIndex >= 2 ? 2 : terminalIndex >= 1 ? 1 : 0)
      || typeof value.evidence.source !== 'string'
      || typeof value.evidence.production !== 'boolean'
      || value.evidence.promotable !== (value.evidence.production && value.outcome === 'PASS')) {
      fail('Worker evidence trajectory is contradictory')
    }
    for (const field of ['manifest_sha256', 'authorization_sha256', 'attempt_id']) {
      assertHash(value.evidence[field], `Worker evidence ${field}`)
    }
    for (const hash of Object.values(value.evidence.hashes)) assertHash(hash, 'Worker evidence hash', true)
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

  function secureCanonicalDirectoryIdentity(path, label) {
    const identity = canonicalDirectoryIdentity(path, label)
    if (identity.mode !== 0o700) fail(`${label} mode drifted`)
    return identity
  }

  function trustedCanonicalAncestorIdentity(path, label) {
    const identity = canonicalDirectoryIdentity(path, label)
    if ((identity.mode & 0o022) !== 0) fail(`${label} is a group- or world-writable authority ancestor`)
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

  function reconciledMutationCounts(terminal, d1, worker) {
    if (terminal.evidence.production !== true) return { production_writes: 0, attempted: 0, confirmed: 0 }
    const d1Attempted = d1 === null
      ? 0
      : d1.stage_counts.clean_start_reset + d1.stage_counts.migrations_001_006
    const d1TerminalIndex = d1 === null ? -1 : D1_STAGES.indexOf(d1.first_terminal_stage)
    const d1Confirmed = d1 === null ? 0 : d1.outcome === 'PASS'
      ? 2
      : d1TerminalIndex > D1_STAGES.indexOf('migrations_001_006') ? 2
        : d1TerminalIndex > D1_STAGES.indexOf('clean_start_reset') ? 1 : 0
    const attempted = d1Attempted + (worker?.mutation_counts.attempted ?? 0)
    const confirmed = d1Confirmed + (worker?.mutation_counts.confirmed ?? 0)
    return { production_writes: confirmed, attempted, confirmed }
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
        || evidence.candidate_id !== manifest.value.repository?.commit
        || evidence.production !== terminal.value.evidence.production) {
        fail(`${label} evidence identity does not match Terminal Result`)
      }
    }
    const expectedMutations = reconciledMutationCounts(terminal.value, d1?.value ?? null, worker?.value ?? null)
    if (!Object.entries(expectedMutations).every(([name, count]) => terminal.value.mutation_counts[name] === count)) {
      fail('terminal mutation evidence contradicts D1/Worker sidecars')
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
        const result = consumeAuthorization(resolvedRoot, record, deadline)
        assertSinkIdentity()
        return result
      },
      persistTerminalResult(input, deadline) {
        assertSinkIdentity()
        const result = persistTerminalResult(resolvedRoot, input, deadline)
        assertSinkIdentity()
        return result
      },
      readTerminalEvidence(terminalSha256) {
        assertSinkIdentity()
        const result = readTerminalEvidence(resolvedRoot, terminalSha256)
        assertSinkIdentity()
        return result
      },
    })
  }

  function isSameOrDescendant(root, candidate) {
    const path = relative(root, candidate)
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  function overlapsCanonicalAuthority(path) {
    if (isSameOrDescendant(PRODUCTION_AUTHORITY_ROOT, path)
      || isSameOrDescendant(path, PRODUCTION_AUTHORITY_ROOT)) return true
    if (platform() !== 'darwin') return false
    const foldedAuthority = PRODUCTION_AUTHORITY_ROOT.toLowerCase()
    const foldedPath = path.toLowerCase()
    return isSameOrDescendant(foldedAuthority, foldedPath)
      || isSameOrDescendant(foldedPath, foldedAuthority)
  }

  function canonicalNamespaceDirectoryIdentities() {
    const identities = []
    let path = PRODUCTION_AUTHORITY_HOME
    for (const name of ['.local', 'state', 'blogman', 'issue-23-production-authority-v1']) {
      path = join(path, name)
      try {
        const metadata = lstatSync(path)
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          identities.push({ dev: metadata.dev, ino: metadata.ino })
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') fail('canonical production authority path is unavailable')
      }
    }
    return identities
  }

  function sharesCanonicalNamespaceDirectory(path) {
    const canonical = canonicalNamespaceDirectoryIdentities()
    let current = path
    while (true) {
      try {
        const metadata = lstatSync(current)
        if (metadata.isDirectory() && canonical.some(({ dev, ino }) => metadata.dev === dev && metadata.ino === ino)) {
          return true
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') fail('test-only sink path is unavailable')
      }
      if (current === PRODUCTION_AUTHORITY_HOME) return false
      const parent = dirname(current)
      if (parent === current) return false
      current = parent
    }
  }

  function prospectiveRealPath(path) {
    let existing = path
    const suffix = []
    while (true) {
      try {
        lstatSync(existing)
        break
      } catch (error) {
        if (error?.code !== 'ENOENT') fail('test-only sink path is unavailable')
        const parent = dirname(existing)
        if (parent === existing) fail('test-only sink path is unavailable')
        suffix.unshift(basename(existing))
        existing = parent
      }
    }
    try {
      return resolve(realpathSync(existing), ...suffix)
    } catch {
      fail('test-only sink path is unavailable')
    }
  }

  function rejectCanonicalAuthorityOverlap(path) {
    if (overlapsCanonicalAuthority(path) || sharesCanonicalNamespaceDirectory(path)) {
      fail('test-only sink refuses canonical production authority overlap')
    }
  }

  function createTestDeliverySink(root) {
    if (typeof root !== 'string') fail('explicit test-only sink root is required')
    const requestedRoot = resolve(root)
    rejectCanonicalAuthorityOverlap(requestedRoot)
    rejectCanonicalAuthorityOverlap(prospectiveRealPath(requestedRoot))
    mkdirSync(dirname(requestedRoot), { recursive: true, mode: 0o700 })
    createDirectory(requestedRoot, 'sink root')
    const resolvedRoot = realpathSync(requestedRoot)
    rejectCanonicalAuthorityOverlap(resolvedRoot)
    const rootIdentity = secureDirectoryIdentity(resolvedRoot, 'sink root')
    return deliverySink(resolvedRoot, rootIdentity)
  }

  function existingDeliveryReader(resolvedRoot, rootIdentity, ancestors) {
    const directories = Object.freeze(Object.fromEntries(['authorizations', 'records', 'terminals'].map((name) => {
      const path = join(resolvedRoot, name)
      return [name, Object.freeze({ path, identity: secureCanonicalDirectoryIdentity(path, `${name} directory`) })]
    })))
    const assertReaderIdentity = () => {
      for (const entry of ancestors) {
        assertDirectoryIdentity(entry.path, entry.identity, entry.label, canonicalDirectoryIdentity)
      }
      assertDirectoryIdentity(resolvedRoot, rootIdentity, 'sink root', secureCanonicalDirectoryIdentity)
      for (const [name, entry] of Object.entries(directories)) {
        assertDirectoryIdentity(entry.path, entry.identity, `${name} directory`, secureCanonicalDirectoryIdentity)
      }
    }
    return Object.freeze({
      readTerminalEvidence(terminalSha256) {
        assertReaderIdentity()
        const result = readTerminalEvidence(resolvedRoot, terminalSha256)
        assertReaderIdentity()
        return result
      },
    })
  }

  function canonicalDeliveryReader() {
    const ancestors = []
    let path = PRODUCTION_AUTHORITY_HOME
    ancestors.push(Object.freeze({
      path,
      label: 'authority home',
      identity: trustedCanonicalAncestorIdentity(path, 'authority home'),
    }))
    for (const name of ['.local', 'state', 'blogman', 'issue-23-production-authority-v1']) {
      path = join(path, name)
      const label = `authority ${name} directory`
      const trustedSubtree = name === 'blogman' || name === 'issue-23-production-authority-v1'
      ancestors.push(Object.freeze({
        path,
        label,
        identity: trustedSubtree
          ? secureCanonicalDirectoryIdentity(path, label)
          : trustedCanonicalAncestorIdentity(path, label),
      }))
    }
    if (path !== PRODUCTION_AUTHORITY_ROOT || realpathSync(path) !== PRODUCTION_AUTHORITY_ROOT) {
      fail('production authority resolved outside its canonical lexical root')
    }
    const rootIdentity = secureCanonicalDirectoryIdentity(PRODUCTION_AUTHORITY_ROOT, 'sink root')
    return existingDeliveryReader(PRODUCTION_AUTHORITY_ROOT, rootIdentity, ancestors)
  }

  function canonicalDeliverySink() {
    // Trust path: home/.local/state must be canonical, owner-controlled, and not
    // world-writable; the dedicated blogman/root subtree is strictly mode 0700.
    const ancestors = []
    let path = PRODUCTION_AUTHORITY_HOME
    ancestors.push(Object.freeze({
      path,
      label: 'authority home',
      identity: trustedCanonicalAncestorIdentity(path, 'authority home'),
    }))
    for (const name of ['.local', 'state', 'blogman', 'issue-23-production-authority-v1']) {
      path = join(path, name)
      const label = `authority ${name} directory`
      createCanonicalProductionDirectory(path, label)
      const trustedSubtree = name === 'blogman' || name === 'issue-23-production-authority-v1'
      ancestors.push(Object.freeze({
        path,
        label,
        identity: trustedSubtree
          ? secureCanonicalDirectoryIdentity(path, label)
          : trustedCanonicalAncestorIdentity(path, label),
      }))
    }
    if (path !== PRODUCTION_AUTHORITY_ROOT || realpathSync(path) !== PRODUCTION_AUTHORITY_ROOT) {
      fail('production authority resolved outside its canonical lexical root')
    }
    const rootIdentity = secureDirectoryIdentity(PRODUCTION_AUTHORITY_ROOT, 'sink root')
    return deliverySink(PRODUCTION_AUTHORITY_ROOT, rootIdentity, ancestors)
  }

  return Object.freeze({
    DeliverySinkDeadlineError,
    createTestDeliverySink,
    canonicalDeliveryReader,
    canonicalDeliverySink,
    isCanonicalProductionAuthorityRoot: (path) => resolve(path) === PRODUCTION_AUTHORITY_ROOT,
  })
}

const {
  DeliverySinkDeadlineError,
  createTestDeliverySink,
  canonicalDeliveryReader,
  canonicalDeliverySink,
  isCanonicalProductionAuthorityRoot,
} = buildDeliverySinkOwnership()

export { DeliverySinkDeadlineError, createTestDeliverySink }

export const LOCAL_ENTRY_FORMAT = 'blogman-issue-23-local-entry/v1'
export const LOCAL_SUPERVISOR_FORMAT = 'blogman-issue-23-supervisor/v1'

const FORMAL_REHEARSAL_EVIDENCE_SOURCE = 'formal-rehearsal-test-evidence'
const TERMINAL_RESULT_FORMAT = 'blogman-issue-23-terminal-result/v1'

function fail(message) {
  throw new Error(`Issue #23 local entry: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function stableOutput(value) {
  if (Array.isArray(value)) return value.map(stableOutput)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/_at$/u.test(key))
      .map(([key, child]) => [key, stableOutput(child)]))
  }
  return value
}

function assertSafeString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    fail(`${label} must be a non-empty single-line string`)
  }
}

export function buildLocalRehearsalCommands({ runnerPath, configPath, stateToken, candidate }) {
  assertSafeString(runnerPath, 'runnerPath')
  assertSafeString(configPath, 'configPath')
  assertSafeString(stateToken, 'stateToken')
  assertSafeString(candidate, 'candidate')
  const common = [
    '--database', 'DB', '--local', '--persist-to', stateToken, '--config', configPath,
  ]
  return [
    { name: 'catalog', args: ['catalog'] },
    { name: 'apply', args: ['apply', ...common, '--candidate', candidate] },
    { name: 'verify', args: ['verify', ...common] },
  ].map((command) => ({
    ...command,
    executable: process.execPath,
    argv: [runnerPath, ...command.args],
  }))
}

export function parseLocalCommandResult(result, name) {
  if (result?.error?.code === 'ETIMEDOUT') {
    fail(`${name} command timed out`)
  }
  if (!result || typeof result.stdout !== 'string' || result.stderr !== '') {
    fail(`${name} command did not complete successfully`)
  }
  if (result.status !== 0 || result.signal) {
    fail(`${name} command did not complete successfully`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    fail(`${name} command did not return JSON`)
  }
  if (parsed?.format === LOCAL_SUPERVISOR_FORMAT) {
    if (parsed.status === 'timed_out') fail(`${name} command timed out`)
    if (parsed.status === 'output_overflow') fail(`${name} command output exceeded the bounded limit`)
    if (parsed.status === 'residual_process_group') fail(`${name} command left a residual process group`)
    if (parsed.status !== 'completed' || parsed.residual_process_group !== false) {
      fail(`${name} command did not complete successfully`)
    }
    if (typeof parsed.stdout !== 'string' || parsed.stderr !== '') {
      fail(`${name} command did not complete successfully`)
    }
    try {
      return JSON.parse(parsed.stdout)
    } catch {
      fail(`${name} command did not return JSON`)
    }
  }
  return parsed
}

export function buildLocalEntryReceipt({
  manifestDraftSha256,
  commands,
  outputs,
  runtime,
  network,
  networkEvidence,
  disposableState,
  adapterOutputs,
}) {
  if (!/^[a-f0-9]{64}$/u.test(manifestDraftSha256 || '')) fail('manifest draft identity is invalid')
  if (!Array.isArray(commands) || !Array.isArray(outputs) || commands.length !== outputs.length) {
    fail('command and output identities must have equal lengths')
  }
  if (!runtime || network !== 'disabled'
    || !['macos-sandbox-exec-loopback', 'node-guard-only'].includes(networkEvidence?.boundary)
    || networkEvidence.external_probe !== 'blocked'
    || !disposableState?.created
    || !disposableState?.cleaned
    || !disposableState?.observed_absent) {
    fail('runtime, network, and disposable-state evidence is incomplete')
  }
  const commandInputs = commands.map(({ name, args }) => ({ name, args }))
  const outputIdentities = outputs.map((output) => ({
    name: output.name,
    sha256: sha256(canonicalBytes(stableOutput(output.value))),
  }))
  const receipt = {
    format: LOCAL_ENTRY_FORMAT,
    manifest_draft_sha256: manifestDraftSha256,
    command_inputs: commandInputs,
    output_identities: outputIdentities,
    adapter_output_identities: adapterOutputs ?? [],
    runtime,
    network,
    network_evidence: networkEvidence,
    disposable_state: disposableState,
  }
  const bytes = canonicalBytes(receipt)
  return { value: receipt, bytes, sha256: sha256(bytes) }
}

const AUTHORIZATION_FORMAT = 'blogman-issue-23-authorization/v1'
const DELIVERY_STAGE_POLICY = Object.freeze([
  Object.freeze({ name: 'authorization_accept', timeout_seconds: 30 }),
  Object.freeze({ name: 'live_preconditions', timeout_seconds: 120 }),
  Object.freeze({ name: 'd1_identity', timeout_seconds: 120 }),
  Object.freeze({ name: 'clean_start_reset', timeout_seconds: 300 }),
  Object.freeze({ name: 'empty_d1_proof', timeout_seconds: 300 }),
  Object.freeze({ name: 'migrations_001_006', timeout_seconds: 2100 }),
  Object.freeze({ name: 'reconciliation', timeout_seconds: 300 }),
  Object.freeze({ name: 'worker_deploy', timeout_seconds: 600 }),
  Object.freeze({ name: 'version_traffic_verification', timeout_seconds: 300 }),
  Object.freeze({ name: 'smoke_control_t0', timeout_seconds: 300 }),
])
const DELIVERY_STAGES = Object.freeze(DELIVERY_STAGE_POLICY.map(({ name }) => name))
const OVERALL_TIMEOUT_SECONDS = 5400
const PRODUCTION_D1_STAGES = Object.freeze([
  'd1_identity',
  'clean_start_reset',
  'empty_d1_proof',
  'migrations_001_006',
  'reconciliation',
])
const PRODUCTION_D1_MIGRATION_NAMES = Object.freeze([
  '001_initial_schema',
  '002_add_ai_image_configuration',
  '003_migrate_runtime_ai_configuration',
  '004_complete_historical_text_ai_schema',
  '005_fix_posts_fts_sync',
  '006_add_rollout_safety_controls',
])
const PRODUCTION_D1_CANONICAL_PATHS = Object.freeze({
  config_path: 'wrangler.toml',
  reset_sql_path: 'db/issue-23-clean-start-reset.sql',
  migration_runner_path: 'scripts/migrations.mjs',
  migration_catalog_path: 'db/ledger-migrations',
  rollout_safety_path: 'scripts/rollout-safety.mjs',
})
const ENTRY_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_RECONCILIATION_FORMAT = 'blogman-d1-reconciliation/v1'

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertExactKeys(value, keys, label) {
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

function exact(value, keys) {
  return isPlainRecord(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function canonicalJsonBytes(value) {
  const json = JSON.stringify(value, null, 2)
  if (typeof json !== 'string') fail('value is not canonical JSON')
  return Buffer.from(`${json}\n`, 'utf8')
}

function isJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (isPlainRecord(value)) return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string' && isJsonValue(value[key])
  ))
  return false
}

function normalizedJsonValue(value) {
  if (Array.isArray(value)) return value.map(normalizedJsonValue)
  if (isPlainRecord(value)) {
    return Object.fromEntries(Reflect.ownKeys(value).sort().map((key) => [key, normalizedJsonValue(value[key])]))
  }
  return value
}

function sameJsonValue(left, right) {
  return JSON.stringify(normalizedJsonValue(left)) === JSON.stringify(normalizedJsonValue(right))
}

const CANONICAL_MANIFEST_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u
const CANONICAL_MANIFEST_ARTIFACT_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._/-]+$/u
const CANONICAL_MANIFEST_SHA256_PATTERN = /^[a-f0-9]{64}$/u
const CANONICAL_MANIFEST_SHA40_PATTERN = /^[a-f0-9]{40}$/u
const CANONICAL_MANIFEST_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,2}(?:[-+][A-Za-z0-9._-]+)?$/u
const CANONICAL_MANIFEST_NAME_PATTERN = /^[a-z][a-z0-9_:-]*$/u
const CANONICAL_MANIFEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u
const CANONICAL_MANIFEST_WORKER_PATTERN = /^[A-Za-z0-9._-]+$/u
const CANONICAL_MANIFEST_ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9._/-]+$/u
const SYSTEM_CURL_PATH = '/usr/bin/curl'
const SMOKE_CREDENTIAL_ENV = 'DELIVERY_SMOKE_ADMIN'
const CLOUDFLARE_TOKEN_ENV = 'CLOUDFLARE_API_TOKEN'
const CLOUDFLARE_ACCOUNT_ENV = 'CLOUDFLARE_ACCOUNT_ID'
const CLOUDFLARE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,512}$/u
const CLOUDFLARE_SCOPES = Object.freeze(['account:read', 'd1:write', 'workers:write'])
const CHILD_ENV_ALLOWLIST = Object.freeze(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'])
const SMOKE_CREDENTIAL_PATTERN = /^[A-Za-z0-9._~-]+$/u
const CANONICAL_MANIFEST_ROOT_KEYS = [
  'format',
  'preparation',
  'repository',
  'ci',
  'toolchain',
  'artifact',
  'migration',
  'd1',
  'target',
  'policy',
  'rehearsal',
]
const PRODUCTION_MANIFEST_POLICY = Object.freeze({
  conclusion: 'success',
  ciEvidenceClass: 'production-ci-evidence',
  d1EvidenceClass: 'production',
})
const FORMAL_REHEARSAL_MANIFEST_POLICY = Object.freeze({
  conclusion: 'in_progress-test-evidence',
  ciEvidenceClass: FORMAL_REHEARSAL_EVIDENCE_SOURCE,
  d1EvidenceClass: FORMAL_REHEARSAL_EVIDENCE_SOURCE,
})
const CANONICAL_MANIFEST_FROZEN_PRECONDITIONS = Object.freeze([
  'repository.commit',
  'repository.tree',
  'ci.head_sha',
  'ci.tree',
  'artifact.file_tree.sha256',
  'migration.catalog.sha256',
  'target.baseline',
])
const CANONICAL_MANIFEST_OBSERVATIONS = Object.freeze([
  'target.deployment_id',
  'target.version_id',
  'target.traffic',
  'rehearsal.receipt_sha256',
])
const REQUIRED_CREDENTIAL_SLOTS = Object.freeze([
  Object.freeze({ name: 'cloudflare_delivery', scopes: Object.freeze(['account:read', 'd1:write', 'workers:write']) }),
  Object.freeze({ name: 'delivery_smoke_admin', scopes: Object.freeze(['admin:smoke']) }),
])
const CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS = Object.freeze([
  'secret_values',
  'raw_private_adapter_output',
  'sql_bodies',
  'private_operator_paths',
])

function assertSchemaKeys(value, keys, label) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`)
  const actual = Reflect.ownKeys(value)
  const missing = keys.filter((key) => !actual.includes(key))
  if (missing.length > 0) fail(`${label} is missing required field ${missing[0]}`)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${label} contains unsupported fields`)
  }
}

function schemaRecord(value, keys, label) {
  if (keys) assertSchemaKeys(value, keys, label)
  else if (!isPlainRecord(value)) fail(`${label} must be an object`)
  return value
}

function schemaString(value, label, pattern = null) {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`)
  }
  return value
}

function schemaSha256(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_SHA256_PATTERN)
}

function schemaPath(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_PATH_PATTERN)
}

function schemaArtifactPath(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_ARTIFACT_PATH_PATTERN)
}

function schemaVersion(value, label) {
  return schemaString(value, label, CANONICAL_MANIFEST_VERSION_PATTERN)
}

function schemaNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`)
  return value
}

function schemaPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`)
  return value
}

function canonicalTimestampMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null
  const milliseconds = Date.parse(value)
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null
}

function validateManifestReference(value, label, includeBytes = false) {
  const keys = includeBytes ? ['path', 'sha256', 'bytes'] : ['path', 'sha256']
  schemaRecord(value, keys, label)
  schemaPath(value.path, `${label}.path`)
  schemaSha256(value.sha256, `${label}.sha256`)
  if (includeBytes) schemaNonNegativeInteger(value.bytes, `${label}.bytes`)
}

function validateToolchainEntry(value, label) {
  schemaRecord(value, ['version', 'identity_sha256'], label)
  schemaVersion(value.version, `${label}.version`)
  schemaSha256(value.identity_sha256, `${label}.identity_sha256`)
}

function validateCanonicalManifestSchema(value, policy = PRODUCTION_MANIFEST_POLICY) {
  schemaRecord(value, CANONICAL_MANIFEST_ROOT_KEYS, 'canonical manifest')
  if (value.format !== CANONICAL_MANIFEST_FORMAT) fail('manifest format is invalid')

  schemaRecord(
    value.preparation,
    ['prepare_entry', 'execute_entry', 'worker_upload_entry', 'manifest_schema'],
    'manifest preparation',
  )
  validateManifestReference(value.preparation.prepare_entry, 'manifest preparation.prepare_entry')
  validateManifestReference(value.preparation.execute_entry, 'manifest preparation.execute_entry')
  validateManifestReference(value.preparation.worker_upload_entry, 'manifest preparation.worker_upload_entry')
  validateManifestReference(value.preparation.manifest_schema, 'manifest preparation.manifest_schema')

  schemaRecord(value.repository, ['canonical', 'remote', 'commit', 'tree', 'clean'], 'manifest repository')
  if (value.repository.canonical !== 'nardinmarcus/blogman') {
    fail('manifest repository.canonical is invalid')
  }
  if (value.repository.remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('manifest repository.remote is invalid')
  }
  schemaString(value.repository.commit, 'manifest repository.commit', CANONICAL_MANIFEST_SHA40_PATTERN)
  schemaString(value.repository.tree, 'manifest repository.tree', CANONICAL_MANIFEST_SHA40_PATTERN)
  if (value.repository.clean !== true) fail('manifest repository.clean is invalid')

  schemaRecord(
    value.ci,
    ['provider', 'workflow', 'run_id', 'attempt', 'event', 'head_sha', 'tree', 'conclusion', 'evidence_class'],
    'manifest ci',
  )
  if (value.ci.provider !== 'github-actions') fail('manifest ci.provider is invalid')
  schemaPath(value.ci.workflow, 'manifest ci.workflow')
  schemaPositiveInteger(value.ci.run_id, 'manifest ci.run_id')
  if (value.ci.attempt !== 1) fail('manifest ci.attempt is invalid')
  if (!['push', 'pull_request'].includes(value.ci.event)) fail('manifest ci.event is invalid')
  schemaString(value.ci.head_sha, 'manifest ci.head_sha', CANONICAL_MANIFEST_SHA40_PATTERN)
  schemaString(value.ci.tree, 'manifest ci.tree', CANONICAL_MANIFEST_SHA40_PATTERN)
  if (value.ci.conclusion !== policy.conclusion
    || value.ci.evidence_class !== policy.ciEvidenceClass) {
    fail('manifest ci evidence classification is invalid')
  }

  schemaRecord(
    value.toolchain,
    ['node', 'npm', 'curl', 'wrangler', 'opennextjs_cloudflare', 'package_json_sha256', 'lockfile_sha256'],
    'manifest toolchain',
  )
  validateToolchainEntry(value.toolchain.node, 'manifest toolchain.node')
  validateToolchainEntry(value.toolchain.npm, 'manifest toolchain.npm')
  validateToolchainEntry(value.toolchain.curl, 'manifest toolchain.curl')
  validateToolchainEntry(value.toolchain.wrangler, 'manifest toolchain.wrangler')
  validateToolchainEntry(value.toolchain.opennextjs_cloudflare, 'manifest toolchain.opennextjs_cloudflare')
  schemaSha256(value.toolchain.package_json_sha256, 'manifest toolchain.package_json_sha256')
  schemaSha256(value.toolchain.lockfile_sha256, 'manifest toolchain.lockfile_sha256')

  schemaRecord(value.artifact, ['archive', 'worker', 'file_tree'], 'manifest artifact')
  validateManifestReference(value.artifact.archive, 'manifest artifact.archive', true)
  validateManifestReference(value.artifact.worker, 'manifest artifact.worker', true)
  schemaRecord(value.artifact.file_tree, ['sha256', 'complete', 'files'], 'manifest artifact.file_tree')
  schemaSha256(value.artifact.file_tree.sha256, 'manifest artifact.file_tree.sha256')
  if (value.artifact.file_tree.complete !== true) fail('manifest artifact.file_tree.complete is invalid')
  if (!Array.isArray(value.artifact.file_tree.files) || value.artifact.file_tree.files.length < 1) {
    fail('manifest artifact.file_tree.files is invalid')
  }
  value.artifact.file_tree.files.forEach((file, index) => {
    const label = `manifest artifact.file_tree.files[${index}]`
    schemaRecord(file, ['path', 'sha256', 'bytes'], label)
    schemaArtifactPath(file.path, `${label}.path`)
    schemaSha256(file.sha256, `${label}.sha256`)
    schemaNonNegativeInteger(file.bytes, `${label}.bytes`)
  })

  schemaRecord(
    value.migration,
    ['delivery_mode', 'reset_sql', 'runner', 'catalog', 'historical_data_disposition'],
    'manifest migration',
  )
  if (value.migration.delivery_mode !== 'clean-start') fail('manifest migration.delivery_mode is invalid')
  validateManifestReference(value.migration.reset_sql, 'manifest migration.reset_sql')
  validateManifestReference(value.migration.runner, 'manifest migration.runner')
  schemaRecord(value.migration.catalog, ['path', 'sha256', 'migrations'], 'manifest migration.catalog')
  schemaPath(value.migration.catalog.path, 'manifest migration.catalog.path')
  schemaSha256(value.migration.catalog.sha256, 'manifest migration.catalog.sha256')
  if (!Array.isArray(value.migration.catalog.migrations)
    || value.migration.catalog.migrations.length < 6
    || value.migration.catalog.migrations.length > 6) {
    fail('manifest migration.catalog.migrations is invalid')
  }
  value.migration.catalog.migrations.forEach((migration, index) => {
    schemaRecord(migration, ['id', 'path', 'sha256'], `manifest migration.catalog.migrations[${index}]`)
    schemaString(migration.id, `manifest migration.catalog.migrations[${index}].id`, /^00[1-6]$/u)
    schemaPath(migration.path, `manifest migration.catalog.migrations[${index}].path`)
    schemaSha256(migration.sha256, `manifest migration.catalog.migrations[${index}].sha256`)
  })
  schemaRecord(
    value.migration.historical_data_disposition,
    ['production_export', 'double_restore', 'historical_baseline_queries'],
    'manifest migration.historical_data_disposition',
  )
  for (const field of ['production_export', 'double_restore', 'historical_baseline_queries']) {
    if (value.migration.historical_data_disposition[field] !== 'NOT_APPLICABLE') {
      fail(`manifest migration.historical_data_disposition.${field} is invalid`)
    }
  }

  schemaRecord(
    value.target,
    ['account_id', 'd1_database_id', 'worker_name', 'origin', 'baseline', 'smoke'],
    'manifest target',
  )
  schemaString(value.target.account_id, 'manifest target.account_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(value.target.d1_database_id, 'manifest target.d1_database_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(value.target.worker_name, 'manifest target.worker_name', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaString(value.target.origin, 'manifest target.origin', CANONICAL_MANIFEST_ORIGIN_PATTERN)
  schemaRecord(
    value.target.baseline,
    ['deployment_id', 'version_id', 'd1_database_id', 'traffic'],
    'manifest target.baseline',
  )
  schemaString(value.target.baseline.deployment_id, 'manifest target.baseline.deployment_id', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaString(value.target.baseline.version_id, 'manifest target.baseline.version_id', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaString(value.target.baseline.d1_database_id, 'manifest target.baseline.d1_database_id', CANONICAL_MANIFEST_ID_PATTERN)
  if (!Array.isArray(value.target.baseline.traffic) || value.target.baseline.traffic.length < 1) {
    fail('manifest target.baseline.traffic is invalid')
  }
  value.target.baseline.traffic.forEach((traffic, index) => {
    schemaRecord(traffic, ['version_id', 'percentage'], `manifest target.baseline.traffic[${index}]`)
    schemaString(traffic.version_id, `manifest target.baseline.traffic[${index}].version_id`, CANONICAL_MANIFEST_WORKER_PATTERN)
    schemaNonNegativeInteger(traffic.percentage, `manifest target.baseline.traffic[${index}].percentage`)
  })
  schemaRecord(value.target.smoke, ['requests', 'admin_credential_slot'], 'manifest target.smoke')
  if (value.target.smoke.admin_credential_slot !== 'delivery_smoke_admin'
    || !sameJsonValue(value.target.smoke.requests, [
      { path: '/api/search', status: 200 },
      { path: '/api/settings/appearance', status: 200 },
      { path: '/api/admin/tokens', status: 200 },
      { path: '/api/admin/ai-provider', status: 200 },
      { path: '/api/admin/ai-post-generators', status: 200 },
      { path: '/api/admin/posts/__blogman_smoke_absent__', status: 404 },
    ])) fail('manifest target.smoke is not canonical')

  schemaRecord(
    value.policy,
    ['authorization', 'stages', 'overall_timeout_seconds', 'drift', 'evidence'],
    'manifest policy',
  )
  schemaRecord(
    value.policy.authorization,
    ['manifest_binding', 'one_shot', 'credential_slots'],
    'manifest policy.authorization',
  )
  if (value.policy.authorization.manifest_binding !== 'manifest_sha256'
    || value.policy.authorization.one_shot !== true) {
    fail('manifest policy.authorization is invalid')
  }
  if (!Array.isArray(value.policy.authorization.credential_slots)
    || value.policy.authorization.credential_slots.length < 1) {
    fail('manifest policy.authorization.credential_slots is invalid')
  }
  value.policy.authorization.credential_slots.forEach((slot, index) => {
    schemaRecord(slot, ['name', 'scopes'], `manifest policy.authorization.credential_slots[${index}]`)
    schemaString(slot.name, `manifest policy.authorization.credential_slots[${index}].name`, CANONICAL_MANIFEST_NAME_PATTERN)
    if (!Array.isArray(slot.scopes) || slot.scopes.length < 1) {
      fail(`manifest policy.authorization.credential_slots[${index}].scopes is invalid`)
    }
    slot.scopes.forEach((scope, scopeIndex) => {
      schemaString(
        scope,
        `manifest policy.authorization.credential_slots[${index}].scopes[${scopeIndex}]`,
        CANONICAL_MANIFEST_NAME_PATTERN,
      )
    })
  })
  if (!Array.isArray(value.policy.stages) || value.policy.stages.length !== DELIVERY_STAGE_POLICY.length) {
    fail('manifest policy.stages is invalid')
  }
  value.policy.stages.forEach((stage, index) => {
    schemaRecord(stage, ['name', 'timeout_seconds'], `manifest policy.stages[${index}]`)
    schemaString(stage.name, `manifest policy.stages[${index}].name`, CANONICAL_MANIFEST_NAME_PATTERN)
    schemaPositiveInteger(stage.timeout_seconds, `manifest policy.stages[${index}].timeout_seconds`)
  })
  if (value.policy.overall_timeout_seconds !== OVERALL_TIMEOUT_SECONDS) {
    fail('manifest policy.overall_timeout_seconds is invalid')
  }
  schemaRecord(
    value.policy.drift,
    ['frozen_preconditions', 'observations', 'mismatch_classification'],
    'manifest policy.drift',
  )
  if (!Array.isArray(value.policy.drift.frozen_preconditions)
    || value.policy.drift.frozen_preconditions.length < 1
    || value.policy.drift.frozen_preconditions.some((item) => typeof item !== 'string')) {
    fail('manifest policy.drift.frozen_preconditions is invalid')
  }
  if (!Array.isArray(value.policy.drift.observations)
    || value.policy.drift.observations.length < 1
    || value.policy.drift.observations.some((item) => typeof item !== 'string')) {
    fail('manifest policy.drift.observations is invalid')
  }
  if (value.policy.drift.mismatch_classification !== 'Manifest Drift') {
    fail('manifest policy.drift.mismatch_classification is invalid')
  }
  schemaRecord(
    value.policy.evidence,
    ['allowed_hash_algorithm', 'excluded', 'production_evidence', 'local_rehearsal_evidence'],
    'manifest policy.evidence',
  )
  if (value.policy.evidence.allowed_hash_algorithm !== 'sha256'
    || value.policy.evidence.production_evidence !== 'real_adapters_only'
    || value.policy.evidence.local_rehearsal_evidence !== 'test_only') {
    fail('manifest policy.evidence is invalid')
  }
  if (!Array.isArray(value.policy.evidence.excluded)
    || value.policy.evidence.excluded.length !== CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS.length
    || value.policy.evidence.excluded.some((item) => !CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS.includes(item))) {
    fail('manifest policy.evidence.excluded is invalid')
  }

  schemaRecord(
    value.rehearsal,
    [
      'runtime',
      'runtime_receipt',
      'network',
      'status',
      'receipt_sha256',
      'production_write_adapter_calls',
      'expected_reconciliation_sha256',
      'd1_stage_receipt_sha256',
      'cleanup',
    ],
    'manifest rehearsal',
  )
  schemaRecord(value.rehearsal.runtime, ['os', 'architecture', 'node_version'], 'manifest rehearsal.runtime')
  if (value.rehearsal.runtime.os !== 'macos') fail('manifest rehearsal.runtime.os is invalid')
  schemaString(value.rehearsal.runtime.architecture, 'manifest rehearsal.runtime.architecture', CANONICAL_MANIFEST_WORKER_PATTERN)
  schemaVersion(value.rehearsal.runtime.node_version, 'manifest rehearsal.runtime.node_version')
  schemaRecord(value.rehearsal.runtime_receipt, [
    'format', 'os', 'arch', 'node', 'npm', 'wrangler', 'opennextjs_cloudflare', 'curl', 'entry',
  ], 'manifest rehearsal.runtime_receipt')
  if (value.rehearsal.runtime_receipt.format !== 'blogman-issue-23-formal-rehearsal-runtime-receipt/v1'
    || value.rehearsal.runtime_receipt.os !== 'macos'
    || value.rehearsal.runtime_receipt.arch !== value.rehearsal.runtime.architecture) {
    fail('manifest rehearsal.runtime_receipt is invalid')
  }
  for (const name of ['node', 'npm', 'wrangler', 'opennextjs_cloudflare', 'curl']) {
    const tool = value.rehearsal.runtime_receipt[name]
    schemaRecord(tool, ['version', 'identity_sha256'], `manifest rehearsal.runtime_receipt.${name}`)
    schemaVersion(tool.version, `manifest rehearsal.runtime_receipt.${name}.version`)
    schemaSha256(tool.identity_sha256, `manifest rehearsal.runtime_receipt.${name}.identity_sha256`)
  }
  schemaRecord(value.rehearsal.runtime_receipt.entry, ['path', 'identity_sha256'], 'manifest rehearsal.runtime_receipt.entry')
  if (value.rehearsal.runtime_receipt.entry.path !== 'scripts/issue-23-delivery-entry.mjs') {
    fail('manifest rehearsal.runtime_receipt.entry is invalid')
  }
  schemaSha256(value.rehearsal.runtime_receipt.entry.identity_sha256, 'manifest rehearsal.runtime_receipt.entry.identity_sha256')
  if (value.rehearsal.runtime_receipt.node.version !== value.toolchain.node.version
    || value.rehearsal.runtime_receipt.node.identity_sha256 !== value.toolchain.node.identity_sha256
    || value.rehearsal.runtime_receipt.npm.identity_sha256 !== value.toolchain.npm.identity_sha256
    || value.rehearsal.runtime_receipt.wrangler.identity_sha256 !== value.toolchain.wrangler.identity_sha256
    || value.rehearsal.runtime_receipt.opennextjs_cloudflare.identity_sha256 !== value.toolchain.opennextjs_cloudflare.identity_sha256
    || value.rehearsal.runtime_receipt.curl.identity_sha256 !== value.toolchain.curl.identity_sha256) {
    fail('manifest rehearsal.runtime_receipt is not bound to the frozen toolchain')
  }
  if (value.rehearsal.network !== 'disabled' || value.rehearsal.status !== 'PASS') {
    fail('manifest rehearsal state is invalid')
  }
  schemaSha256(value.rehearsal.receipt_sha256, 'manifest rehearsal.receipt_sha256')
  if (value.rehearsal.production_write_adapter_calls !== 0) {
    fail('manifest rehearsal.production_write_adapter_calls is invalid')
  }
  schemaSha256(
    value.rehearsal.expected_reconciliation_sha256,
    'manifest rehearsal.expected_reconciliation_sha256',
  )
  schemaSha256(value.rehearsal.d1_stage_receipt_sha256, 'manifest rehearsal.d1_stage_receipt_sha256')
  schemaRecord(
    value.rehearsal.cleanup,
    ['created', 'cleaned', 'observed_absent'],
    'manifest rehearsal.cleanup',
  )
  if (value.rehearsal.cleanup.created !== true
    || value.rehearsal.cleanup.cleaned !== true
    || value.rehearsal.cleanup.observed_absent !== true) {
    fail('manifest rehearsal.cleanup is invalid')
  }

  return value
}

function assertCanonicalManifestRelationships(manifest, policy = PRODUCTION_MANIFEST_POLICY) {
  if (manifest.repository.canonical !== 'nardinmarcus/blogman'
    || manifest.repository.remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('manifest repository identity is not canonical')
  }
  if (manifest.ci.head_sha !== manifest.repository.commit) {
    fail('manifest ci.head_sha must equal repository.commit')
  }
  if (manifest.ci.tree !== manifest.repository.tree) {
    fail('manifest ci.tree must equal repository.tree')
  }
  if (manifest.ci.conclusion !== policy.conclusion
    || manifest.ci.evidence_class !== policy.ciEvidenceClass) {
    fail('manifest ci evidence classification is invalid')
  }
  if (manifest.preparation.execute_entry.path !== 'scripts/issue-23-delivery-entry.mjs') {
    fail('manifest preparation.execute_entry must bind the formal delivery entry')
  }
  if (manifest.preparation.worker_upload_entry.path !== 'scripts/issue-23-delivery-worker-upload.mjs') {
    fail('manifest preparation.worker_upload_entry must bind the private Worker upload entry')
  }

  const publicPaths = [
    ['preparation.prepare_entry.path', manifest.preparation.prepare_entry.path],
    ['preparation.execute_entry.path', manifest.preparation.execute_entry.path],
    ['preparation.worker_upload_entry.path', manifest.preparation.worker_upload_entry.path],
    ['preparation.manifest_schema.path', manifest.preparation.manifest_schema.path],
    ['ci.workflow', manifest.ci.workflow],
    ['artifact.archive.path', manifest.artifact.archive.path],
    ['artifact.worker.path', manifest.artifact.worker.path],
    ['migration.reset_sql.path', manifest.migration.reset_sql.path],
    ['migration.runner.path', manifest.migration.runner.path],
    ['migration.catalog.path', manifest.migration.catalog.path],
    ...manifest.artifact.file_tree.files.map((file, index) => [
      `artifact.file_tree.files[${index}].path`,
      file.path,
    ]),
    ...manifest.migration.catalog.migrations.map((migration, index) => [
      `migration.catalog.migrations[${index}].path`,
      migration.path,
    ]),
  ]
  for (const [label, path] of publicPaths) {
    if (/(^|\/)(?:private|operator|secret|credential|tmp)(?:\/|$)/iu.test(path)) {
      fail(`${label} contains a private operator path`)
    }
  }

  const filePaths = manifest.artifact.file_tree.files.map((file) => file.path)
  if (new Set(filePaths).size !== filePaths.length) {
    fail('artifact.file_tree.files must not contain duplicate paths')
  }
  if (!sameJsonValue(filePaths, [...filePaths].sort())) {
    fail('artifact.file_tree.files must be ordered by public path')
  }

  const migrationIds = manifest.migration.catalog.migrations.map((migration) => migration.id)
  if (!sameJsonValue(migrationIds, ['001', '002', '003', '004', '005', '006'])) {
    fail('manifest migration.catalog.migrations must contain 001 through 006 in order')
  }

  if (manifest.d1.mode !== 'remote' || manifest.d1.evidence_class !== policy.d1EvidenceClass) {
    fail('manifest d1 evidence classification is invalid')
  }
  if (manifest.d1.database !== 'DB'
    || manifest.d1.config_path !== PRODUCTION_D1_CANONICAL_PATHS.config_path
    || manifest.d1.reset_sql_path !== PRODUCTION_D1_CANONICAL_PATHS.reset_sql_path
    || manifest.d1.migration_runner_path !== PRODUCTION_D1_CANONICAL_PATHS.migration_runner_path
    || manifest.d1.migration_catalog_path !== PRODUCTION_D1_CANONICAL_PATHS.migration_catalog_path
    || manifest.d1.rollout_safety_path !== PRODUCTION_D1_CANONICAL_PATHS.rollout_safety_path) {
    fail('manifest d1 paths must identify the canonical production artifacts')
  }
  if (manifest.d1.account_id !== manifest.target.account_id
    || manifest.d1.d1_database_id !== manifest.target.d1_database_id
    || manifest.d1.candidate_id !== manifest.repository.commit
    || manifest.d1.wrangler_sha256 !== manifest.toolchain.wrangler.identity_sha256) {
    fail('manifest d1 identities do not match the frozen production facts')
  }
  if (manifest.d1.expected_reconciliation_format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('manifest d1 expected reconciliation format is not canonical')
  }
  if (sha256(canonicalD1ExpectedReconciliationBytes(manifest.d1.expected_reconciliation))
    !== manifest.d1.expected_reconciliation_sha256) {
    fail('manifest d1 expected reconciliation hash does not match its frozen bytes')
  }
  if (!manifest.d1.migrations.every((migration, index) => (
    migration.number === index + 1
      && migration.name === PRODUCTION_D1_MIGRATION_NAMES[index]
  ))) {
    fail('manifest d1 migrations must be the canonical checksum set')
  }

  if (manifest.rehearsal.expected_reconciliation_sha256 !== manifest.d1.expected_reconciliation_sha256) {
    fail('manifest rehearsal expected reconciliation identity must bind the D1 snapshot')
  }
  if (manifest.target.baseline.d1_database_id !== manifest.target.d1_database_id) {
    fail('manifest target.baseline.d1_database_id must equal target.d1_database_id')
  }
  if (manifest.target.baseline.traffic.length !== 1
    || manifest.target.baseline.traffic[0].version_id !== manifest.target.baseline.version_id
    || manifest.target.baseline.traffic[0].percentage !== 100) {
    fail('manifest target.baseline.traffic must bind one 100% baseline version')
  }

  const credentialSlots = manifest.policy.authorization.credential_slots.map((slot) => ({
    name: slot.name,
    scopes: [...slot.scopes].sort(),
  }))
  if (!sameJsonValue(credentialSlots, REQUIRED_CREDENTIAL_SLOTS)) {
    fail('manifest policy.authorization credential slots are not canonical; delivery_smoke_admin requires admin:smoke')
  }

  if (!sameJsonValue(manifest.policy.stages, DELIVERY_STAGE_POLICY)) {
    fail('manifest policy.stages must use the fixed Issue #23 order and timeouts')
  }
  if (!sameJsonValue(manifest.policy.drift.frozen_preconditions, CANONICAL_MANIFEST_FROZEN_PRECONDITIONS)) {
    fail('manifest policy.drift.frozen_preconditions are not canonical')
  }
  if (!sameJsonValue(manifest.policy.drift.observations, CANONICAL_MANIFEST_OBSERVATIONS)) {
    fail('manifest policy.drift.observations are not canonical')
  }
  if (!sameJsonValue(manifest.policy.evidence.excluded, CANONICAL_MANIFEST_EVIDENCE_EXCLUSIONS)) {
    fail('manifest policy.evidence.excluded is not canonical')
  }
  if (manifest.rehearsal.runtime.node_version !== manifest.toolchain.node.version) {
    fail('manifest rehearsal.runtime.node_version must equal toolchain.node.version')
  }

  return manifest
}

const CANONICAL_MANIFEST_ORDER = {
  format: null,
  preparation: {
    prepare_entry: { path: null, sha256: null },
    execute_entry: { path: null, sha256: null },
    worker_upload_entry: { path: null, sha256: null },
    manifest_schema: { path: null, sha256: null },
  },
  repository: { canonical: null, remote: null, commit: null, tree: null, clean: null },
  ci: {
    provider: null,
    workflow: null,
    run_id: null,
    attempt: null,
    event: null,
    head_sha: null,
    tree: null,
    conclusion: null,
    evidence_class: null,
  },
  toolchain: {
    node: { version: null, identity_sha256: null },
    npm: { version: null, identity_sha256: null },
    curl: { version: null, identity_sha256: null },
    wrangler: { version: null, identity_sha256: null },
    opennextjs_cloudflare: { version: null, identity_sha256: null },
    package_json_sha256: null,
    lockfile_sha256: null,
  },
  artifact: {
    archive: { path: null, sha256: null, bytes: null },
    worker: { path: null, sha256: null, bytes: null },
    file_tree: {
      sha256: null,
      complete: null,
      files: { path: null, sha256: null, bytes: null },
    },
  },
  migration: {
    delivery_mode: null,
    reset_sql: { path: null, sha256: null },
    runner: { path: null, sha256: null },
    catalog: {
      path: null,
      sha256: null,
      migrations: { id: null, path: null, sha256: null },
    },
    historical_data_disposition: {
      production_export: null,
      double_restore: null,
      historical_baseline_queries: null,
    },
  },
  d1: {
    mode: null,
    database: null,
    config_path: null,
    config_sha256: null,
    wrangler_sha256: null,
    account_id: null,
    d1_database_id: null,
    reset_sql_path: null,
    reset_sql_sha256: null,
    migration_runner_path: null,
    migration_runner_sha256: null,
    migration_catalog_path: null,
    migration_catalog_sha256: null,
    rollout_safety_path: null,
    rollout_safety_sha256: null,
    expected_reconciliation_format: null,
    expected_reconciliation_sha256: null,
    expected_reconciliation: {
      format: null,
      schema: { sha256: null },
      migration_ledger: { state: null, row_count: null, sha256: null },
      posts: { count: null, status: 'sorted', content_sha256: null },
    },
    candidate_id: null,
    evidence_class: null,
    migrations: { number: null, name: null, checksum: null },
  },
  target: {
    account_id: null,
    d1_database_id: null,
    worker_name: null,
    origin: null,
    smoke: { requests: { path: null, status: null }, admin_credential_slot: null },
    baseline: {
      deployment_id: null,
      version_id: null,
      d1_database_id: null,
      traffic: { version_id: null, percentage: null },
    },
  },
  policy: {
    authorization: {
      manifest_binding: null,
      one_shot: null,
      credential_slots: { name: null, scopes: 'sorted' },
    },
    stages: { name: null, timeout_seconds: null },
    overall_timeout_seconds: null,
    drift: {
      frozen_preconditions: 'sorted',
      observations: 'sorted',
      mismatch_classification: null,
    },
    evidence: {
      allowed_hash_algorithm: null,
      excluded: 'sorted',
      production_evidence: null,
      local_rehearsal_evidence: null,
    },
  },
  rehearsal: {
    runtime: { os: null, architecture: null, node_version: null },
    runtime_receipt: {
      format: null,
      os: null,
      arch: null,
      node: { version: null, identity_sha256: null },
      npm: { version: null, identity_sha256: null },
      wrangler: { version: null, identity_sha256: null },
      opennextjs_cloudflare: { version: null, identity_sha256: null },
      curl: { version: null, identity_sha256: null },
      entry: { path: null, identity_sha256: null },
    },
    network: null,
    status: null,
    receipt_sha256: null,
    production_write_adapter_calls: null,
    expected_reconciliation_sha256: null,
    d1_stage_receipt_sha256: null,
    cleanup: { created: null, cleaned: null, observed_absent: null },
  },
}

function orderCanonicalManifestValue(value, order) {
  if (Array.isArray(value)) return value.map((item) => orderCanonicalManifestValue(item, order))
  if (!isPlainRecord(value)) return value
  if (order === 'sorted') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
  }
  const keys = isPlainRecord(order) ? Object.keys(order) : Object.keys(value)
  return Object.fromEntries(keys.map((key) => [
    key,
    orderCanonicalManifestValue(value[key], isPlainRecord(order) ? order[key] : undefined),
  ]))
}

function manifestBytesForPolicy(value) {
  return canonicalJsonBytes(orderCanonicalManifestValue(value, CANONICAL_MANIFEST_ORDER))
}

function validateManifestStructure(value, manifestBytes, policy) {
  validateCanonicalManifestSchema(value, policy)
  const d1 = validateD1(value, policy)
  schemaString(d1.account_id, 'manifest d1.account_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(d1.d1_database_id, 'manifest d1.d1_database_id', CANONICAL_MANIFEST_ID_PATTERN)
  schemaString(d1.candidate_id, 'manifest d1.candidate_id', CANONICAL_MANIFEST_SHA40_PATTERN)
  assertCanonicalManifestRelationships(value, policy)
  if (!Buffer.from(manifestBytes).equals(manifestBytesForPolicy(value))) {
    fail('manifest bytes are not schema-canonical JSON')
  }
  return d1
}

function validateCanonicalManifest(value, manifestBytes) {
  return validateManifestStructure(value, manifestBytes, PRODUCTION_MANIFEST_POLICY)
}

function validateFormalRehearsalManifest(value, manifestBytes) {
  return validateManifestStructure(value, manifestBytes, FORMAL_REHEARSAL_MANIFEST_POLICY)
}

function terminalResult(value) {
  const bytes = canonicalJsonBytes(value)
  return Object.freeze({ value, bytes, sha256: sha256(bytes) })
}

function createAttemptClock() {
  const clock = currentFormalContext()?.clock
  const startedMilliseconds = clock ? clock.wallTimeMilliseconds() : Date.now()
  const startedMonotonic = clock ? clock.monotonicNanoseconds() : process.hrtime.bigint()
  const measuredMilliseconds = () => {
    const current = clock ? clock.monotonicNanoseconds() : process.hrtime.bigint()
    return current >= startedMonotonic ? Math.ceil(Number(current - startedMonotonic) / 1e6) : 0
  }
  if (!Number.isSafeInteger(startedMilliseconds) || startedMilliseconds < 0
    || typeof startedMonotonic !== 'bigint' || startedMonotonic < 0n) {
    fail('internal attempt clock is invalid')
  }
  return Object.freeze({
    started_at: new Date(startedMilliseconds).toISOString(),
    elapsedMilliseconds: measuredMilliseconds,
    finish(minimumElapsedMilliseconds) {
      const elapsed = Math.max(minimumElapsedMilliseconds, measuredMilliseconds())
      return new Date(startedMilliseconds + elapsed).toISOString()
    },
  })
}

function stageCounts(trace) {
  const counts = Object.fromEntries(DELIVERY_STAGES.map((stage) => [stage, 0]))
  counts.authorization_accept = 1
  for (const entry of trace) {
    if (entry.stage !== 'authorization_accept') counts[entry.stage] += 1
  }
  return counts
}

function stageDurations(trace) {
  const durations = Object.fromEntries(DELIVERY_STAGES.map((stage) => [stage, 0]))
  for (const entry of trace) durations[entry.stage] += entry.duration_ms
  return durations
}

function assertWranglerTargetBinding(manifestValue) {
  const configText = readFileSync(resolve(ENTRY_REPO_ROOT, manifestValue.d1.config_path), 'utf8')
  const topLevelConfig = configText.split(/^\s*\[/mu, 1)[0]
  const workerName = topLevelConfig.match(/^\s*name\s*=\s*["']([^"']+)["']\s*$/mu)?.[1]
  const databaseSection = [...configText.matchAll(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/gu)]
    .find(([, section]) => section.match(/^binding\s*=\s*["']([^"']+)["']/mu)?.[1] === manifestValue.d1.database)?.[1]
  const databaseId = databaseSection?.match(/^database_id\s*=\s*["']([^"']+)["']/mu)?.[1]
  if (workerName !== manifestValue.target.worker_name || databaseId !== manifestValue.target.d1_database_id) {
    fail('Wrangler config target identity drifted from the manifest')
  }
}

function assertCurrentRepositoryIdentity(manifestValue) {
  const runGit = (args) => {
    try {
      return execFileSync('/usr/bin/git', args, {
        cwd: ENTRY_REPO_ROOT,
        encoding: 'utf8',
        env: Object.assign(Object.create(null), { LC_ALL: 'C', PATH: '/usr/bin:/bin' }),
      }).trim()
    } catch {
      fail('live repository identity is unavailable')
    }
  }
  const commit = runGit(['rev-parse', 'HEAD'])
  const tree = runGit(['rev-parse', 'HEAD^{tree}'])
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'])
  if (commit !== manifestValue.repository.commit
    || tree !== manifestValue.repository.tree
    || status !== ''
    || manifestValue.repository.clean !== true) {
    fail('live repository identity is Manifest Drift')
  }
}

function assertCurrentFormalEntryClosure(manifestValue) {
  const files = [
    ['preparation.prepare_entry', manifestValue.preparation.prepare_entry],
    ['preparation.worker_upload_entry', manifestValue.preparation.worker_upload_entry],
    ['preparation.manifest_schema', manifestValue.preparation.manifest_schema],
    ['d1.config', { path: manifestValue.d1.config_path, sha256: manifestValue.d1.config_sha256 }],
    ['d1.reset_sql', { path: manifestValue.d1.reset_sql_path, sha256: manifestValue.d1.reset_sql_sha256 }],
    ['d1.migration_runner', { path: manifestValue.d1.migration_runner_path, sha256: manifestValue.d1.migration_runner_sha256 }],
    ['d1.rollout_safety', { path: manifestValue.d1.rollout_safety_path, sha256: manifestValue.d1.rollout_safety_sha256 }],
  ]
  try {
    for (const [label, reference] of files) {
      const path = resolve(ENTRY_REPO_ROOT, reference.path)
      if (realpathSync(path) !== path || sha256(readFileSync(path)) !== reference.sha256) {
        throw new Error(`${label} drifted`)
      }
    }
    const catalogPath = resolve(ENTRY_REPO_ROOT, manifestValue.d1.migration_catalog_path)
    if (realpathSync(catalogPath) !== catalogPath
      || hashD1ArtifactDirectory(catalogPath) !== manifestValue.d1.migration_catalog_sha256) {
      throw new Error('d1 migration catalog drifted')
    }
    if (formalExecutionClosureSha256(ENTRY_REPO_ROOT)
      !== manifestValue.preparation.execute_entry.sha256) {
      throw new Error('formal execution module closure drifted')
    }
    if (manifestValue.rehearsal.runtime_receipt.entry.identity_sha256
      !== manifestValue.preparation.execute_entry.sha256) {
      throw new Error('formal runtime entry identity drifted')
    }
  } catch (error) {
    fail(`formal execute entry/control-plane closure drifted from the manifest: ${error instanceof Error ? error.message : 'unknown'}`)
  }
}

function validatePreparedManifest(manifest) {
  if (!isPlainRecord(manifest)) fail('manifest must be a plain record')
  assertExactKeys(manifest, ['value', 'bytes', 'sha256'], 'manifest')
  if (!isJsonValue(manifest.value) || !isPlainRecord(manifest.value)) {
    fail('manifest value must be a JSON record')
  }
  if (!(manifest.bytes instanceof Uint8Array)) fail('manifest bytes must be bytes')
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    fail('manifest identity is invalid')
  }

  const bytes = Buffer.from(manifest.bytes)
  const text = bytes.toString('utf8')
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail('manifest bytes must use canonical JSON with one LF')
  }
  let parsed
  try {
    parsed = JSON.parse(text.slice(0, -1))
  } catch {
    fail('manifest bytes must contain JSON')
  }
  if (!isPlainRecord(parsed) || !bytes.equals(canonicalJsonBytes(parsed))) {
    fail('manifest bytes are not canonical JSON')
  }
  if (!sameJsonValue(parsed, manifest.value)) fail('manifest value does not match bytes')
  if (sha256(bytes) !== manifest.sha256) fail('manifest identity does not match bytes')
  return bytes
}

function executionDeliverySink() {
  const context = currentFormalContext()
  if (!context) return canonicalDeliverySink()
  let sinkRoot
  let systemTemporaryRoot
  try {
    sinkRoot = realpathSync(context.deliverySinkRoot)
    systemTemporaryRoot = realpathSync(tmpdir())
    const metadata = lstatSync(sinkRoot)
    const fromTemporaryRoot = relative(systemTemporaryRoot, sinkRoot)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700
      || fromTemporaryRoot === '' || fromTemporaryRoot === '..' || fromTemporaryRoot.startsWith('../')
      || isCanonicalProductionAuthorityRoot(sinkRoot)) {
      throw new Error('untrusted formal sink root')
    }
  } catch {
    fail('formal execution requires a test-owned ROOT under the system temporary directory')
  }
  return createTestDeliverySink(sinkRoot)
}

function acceptAuthorization(manifestSha256, authorization, deadline) {
  if (!isPlainRecord(authorization)) fail('authorization must be a canonical record')
  assertExactKeys(authorization, ['bytes', 'sha256'], 'authorization')
  if (!(authorization.bytes instanceof Uint8Array)
    || typeof authorization.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(authorization.sha256)) {
    fail('authorization record is malformed')
  }
  const authorizationBytes = Buffer.from(authorization.bytes)
  const text = authorizationBytes.toString('utf8')
  let value
  try {
    value = parseStrictJson(text.slice(0, -1))
  } catch {
    fail('authorization bytes are not valid strict JSON')
  }
  if (!Buffer.from(text, 'utf8').equals(authorizationBytes)
    || !text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')
    || !isPlainRecord(value)) {
    fail('authorization bytes are not canonical JSON')
  }
  assertExactKeys(value, ['format', 'authorization_id', 'manifest_sha256', 'decision'], 'authorization')
  const canonicalValue = {
    format: value.format,
    authorization_id: value.authorization_id,
    manifest_sha256: value.manifest_sha256,
    decision: value.decision,
  }
  if (!authorizationBytes.equals(canonicalJsonBytes(canonicalValue))) {
    fail('authorization bytes are not schema-canonical JSON')
  }
  if (sha256(authorizationBytes) !== authorization.sha256) fail('authorization identity does not match bytes')
  if (value.format !== AUTHORIZATION_FORMAT) fail('authorization format is invalid')
  if (typeof value.authorization_id !== 'string' || !AUTHORIZATION_ID_PATTERN.test(value.authorization_id)) {
    fail('authorization_id is invalid')
  }
  if (value.manifest_sha256 !== manifestSha256) fail('authorization manifest does not match')
  if (value.decision !== 'approve') fail('authorization decision must be approve')

  executionDeliverySink().consumeAuthorization({ bytes: authorizationBytes, sha256: authorization.sha256 }, deadline)
  return authorization.sha256
}

function canonicalD1ExpectedReconciliation(value) {
  if (!isPlainRecord(value)) fail('expected reconciliation must be a plain record')
  assertExactKeys(value, ['format', 'schema', 'migration_ledger', 'posts'], 'expected reconciliation')
  if (value.format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('expected reconciliation format is invalid')
  }
  assertExactKeys(value.schema, ['sha256'], 'expected reconciliation schema')
  if (typeof value.schema.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.schema.sha256)) {
    fail('expected reconciliation schema hash is invalid')
  }
  assertExactKeys(value.migration_ledger, ['state', 'row_count', 'sha256'], 'expected reconciliation migration ledger')
  if (!['absent', 'present'].includes(value.migration_ledger.state)
    || !Number.isSafeInteger(value.migration_ledger.row_count)
    || value.migration_ledger.row_count < 0
    || !/^[a-f0-9]{64}$/u.test(value.migration_ledger.sha256)) {
    fail('expected reconciliation migration ledger is invalid')
  }
  assertExactKeys(value.posts, ['count', 'status', 'content_sha256'], 'expected reconciliation posts')
  if (!Number.isSafeInteger(value.posts.count)
    || value.posts.count < 0
    || !isPlainRecord(value.posts.status)
    || !/^[a-f0-9]{64}$/u.test(value.posts.content_sha256)) {
    fail('expected reconciliation posts are invalid')
  }
  for (const count of Object.values(value.posts.status)) {
    if (!Number.isSafeInteger(count) || count < 0) fail('expected reconciliation post status is invalid')
  }
  return {
    format: value.format,
    schema: { sha256: value.schema.sha256 },
    migration_ledger: {
      state: value.migration_ledger.state,
      row_count: value.migration_ledger.row_count,
      sha256: value.migration_ledger.sha256,
    },
    posts: {
      count: value.posts.count,
      status: Object.fromEntries(Object.entries(value.posts.status).sort()),
      content_sha256: value.posts.content_sha256,
    },
  }
}

function canonicalD1ExpectedReconciliationBytes(value) {
  return canonicalJsonBytes(canonicalD1ExpectedReconciliation(value))
}

function validateD1(manifestValue, policy = PRODUCTION_MANIFEST_POLICY) {
  if (!isPlainRecord(manifestValue) || !isPlainRecord(manifestValue.d1)) {
    fail('production manifest requires a derived d1 block')
  }
  const d1 = manifestValue.d1
  assertExactKeys(d1, [
    'mode',
    'database',
    'config_path',
    'config_sha256',
    'wrangler_sha256',
    'account_id',
    'd1_database_id',
    'reset_sql_path',
    'reset_sql_sha256',
    'migration_runner_path',
    'migration_runner_sha256',
    'migration_catalog_path',
    'migration_catalog_sha256',
    'rollout_safety_path',
    'rollout_safety_sha256',
    'expected_reconciliation_format',
    'expected_reconciliation_sha256',
    'expected_reconciliation',
    'candidate_id',
    'evidence_class',
    'migrations',
  ], 'd1')
  if (d1.mode !== 'remote' || d1.evidence_class !== policy.d1EvidenceClass) {
    fail('manifest d1 evidence classification is invalid')
  }
  if (d1.database !== 'DB') fail('production d1 database is not canonical')
  for (const [field, expected] of Object.entries(PRODUCTION_D1_CANONICAL_PATHS)) {
    if (d1[field] !== expected) fail(`production d1 ${field} is not canonical`)
  }
  for (const field of ['config_path', 'reset_sql_path', 'migration_runner_path', 'migration_catalog_path', 'rollout_safety_path']) {
    assertSafeString(d1[field], `d1.${field}`)
  }
  for (const field of [
    'config_sha256',
    'wrangler_sha256',
    'reset_sql_sha256',
    'migration_runner_sha256',
    'migration_catalog_sha256',
    'rollout_safety_sha256',
    'expected_reconciliation_sha256',
  ]) {
    if (typeof d1[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(d1[field])) {
      fail(`d1.${field} is not a SHA-256 identity`)
    }
  }
  for (const field of ['account_id', 'd1_database_id', 'candidate_id']) {
    assertSafeString(d1[field], `d1.${field}`)
  }
  if (!/^[a-f0-9]{40}$/u.test(d1.candidate_id)) fail('d1.candidate_id is invalid')
  if (d1.expected_reconciliation_format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('expected reconciliation format is invalid')
  }
  const expectedReconciliation = canonicalD1ExpectedReconciliation(d1.expected_reconciliation)
  if (sha256(canonicalD1ExpectedReconciliationBytes(expectedReconciliation)) !== d1.expected_reconciliation_sha256) {
    fail('expected reconciliation hash does not match frozen bytes')
  }
  if (!Array.isArray(d1.migrations) || d1.migrations.length !== PRODUCTION_D1_MIGRATION_NAMES.length) {
    fail('d1 migrations are invalid')
  }
  for (const [index, migration] of d1.migrations.entries()) {
    assertExactKeys(migration, ['number', 'name', 'checksum'], `d1 migration ${index + 1}`)
    if (migration.number !== index + 1
      || migration.name !== PRODUCTION_D1_MIGRATION_NAMES[index]
      || typeof migration.checksum !== 'string'
      || !/^[a-f0-9]{64}$/u.test(migration.checksum)) {
      fail(`d1 migration ${index + 1} is not canonical`)
    }
  }
  if (isPlainRecord(manifestValue.repository)
    && Object.hasOwn(manifestValue.repository, 'commit')
    && manifestValue.repository.commit !== d1.candidate_id) {
    fail('d1 candidate does not match repository commit')
  }
  if (isPlainRecord(manifestValue.target)
    && (manifestValue.target.account_id !== d1.account_id
      || manifestValue.target.d1_database_id !== d1.d1_database_id)) {
    fail('d1 identities do not match target facts')
  }
  return { ...d1, expected_reconciliation: expectedReconciliation }
}

function materializeExpectedReconciliation(d1) {
  const bytes = canonicalD1ExpectedReconciliationBytes(d1.expected_reconciliation)
  let temporaryDirectory
  let directory
  let path
  try {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-execute-expected-'))
    directory = realpathSync(temporaryDirectory)
    chmodSync(directory, 0o700)
    path = join(directory, 'expected-reconciliation.json')
    writeFileSync(path, bytes, { mode: 0o600 })
    chmodSync(path, 0o600)
    return { directory, path }
  } catch (error) {
    const partialDirectory = directory ?? temporaryDirectory
    if (partialDirectory) error.materialized = { directory: partialDirectory, path }
    throw error
  }
}

function disposeExpectedReconciliation(materialized) {
  if (!materialized) return { created: false, cleaned: true, observed_absent: true }
  let cleaned = false
  let observedAbsent = false
  try {
    rmSync(materialized.directory, { recursive: true, force: true })
    cleaned = !existsSync(materialized.directory)
    observedAbsent = cleaned && !existsSync(materialized.path)
  } catch {
    cleaned = false
    observedAbsent = false
  }
  return { created: true, cleaned, observed_absent: observedAbsent }
}

function deriveProductionD1Bindings(d1, expectedPath, identity) {
  const bindings = { ...d1, ...identity }
  delete bindings.expected_reconciliation_format
  delete bindings.expected_reconciliation
  bindings.config_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.config_path))
  bindings.reset_sql_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.reset_sql_path))
  bindings.migration_runner_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.migration_runner_path))
  bindings.migration_catalog_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.migration_catalog_path))
  bindings.rollout_safety_path = realpathSync(resolve(ENTRY_REPO_ROOT, d1.rollout_safety_path))
  bindings.expected_reconciliation_path = expectedPath
  return bindings
}

const PRODUCTION_D1_EVIDENCE_POLICY = Object.freeze({
  input_source: 'stage-runner-non-production',
  source: 'production',
  production: true,
  allow_promotable_pass: true,
  malformed_classification: 'production_d1_result_malformed',
})

const FORMAL_REHEARSAL_D1_EVIDENCE_POLICY = Object.freeze({
  input_source: 'stage-runner-non-production',
  source: FORMAL_REHEARSAL_EVIDENCE_SOURCE,
  production: false,
  allow_promotable_pass: false,
  malformed_classification: 'formal_rehearsal_d1_result_malformed',
})

const PRODUCTION_D1_RECEIPT_POLICY = Object.freeze({
  ...PRODUCTION_D1_EVIDENCE_POLICY,
  input_source: 'production',
  input_production: true,
})

const FORMAL_REHEARSAL_D1_RECEIPT_POLICY = Object.freeze({
  ...FORMAL_REHEARSAL_D1_EVIDENCE_POLICY,
  input_source: FORMAL_REHEARSAL_EVIDENCE_SOURCE,
  input_production: false,
})

function sanitizedD1Error(
  classification,
  d1,
  attemptIdentity,
  evidencePolicy = PRODUCTION_D1_EVIDENCE_POLICY,
  outcome = 'ERROR',
  entered = true,
) {
  const stageCounts = Object.fromEntries(PRODUCTION_D1_STAGES.map((stage) => [stage, 0]))
  const stageDurations = Object.fromEntries(PRODUCTION_D1_STAGES.map((stage) => [stage, 0]))
  if (entered) {
    stageCounts.d1_identity = 1
    stageDurations.d1_identity = 1
  }
  const identity = {
    manifest_sha256: attemptIdentity.manifest_sha256,
    authorization_sha256: attemptIdentity.authorization_sha256,
    attempt_id: attemptIdentity.attempt_id,
    account_id: d1.account_id,
    d1_database_id: d1.d1_database_id,
    candidate_id: d1.candidate_id,
  }
  const value = {
    format: 'blogman-issue-23-d1-stages/v1',
    outcome,
    first_terminal_stage: entered ? 'd1_identity' : null,
    failure: { classification },
    stage_counts: stageCounts,
    stage_durations_ms: stageDurations,
    evidence: {
      source: evidencePolicy.source,
      production: evidencePolicy.production,
      promotable: false,
      bindings_sha256: sha256(canonicalJsonBytes(identity)),
      wrangler_sha256: d1.wrangler_sha256,
      ...identity,
      config_sha256: d1.config_sha256,
      reset_sql_sha256: d1.reset_sql_sha256,
      migration_runner_sha256: d1.migration_runner_sha256,
      migration_catalog_sha256: d1.migration_catalog_sha256,
      rollout_safety_sha256: d1.rollout_safety_sha256,
      expected_reconciliation_sha256: d1.expected_reconciliation_sha256,
      trace_sha256: sha256(canonicalJsonBytes([])),
    },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  return Object.freeze({ value, bytes, sha256: sha256(bytes) })
}

function normalizeD1Result(result, evidencePolicy, d1, identity) {
  const malformed = () => {
    const receipt = sanitizedD1Error(evidencePolicy.malformed_classification, d1, identity, evidencePolicy)
    return {
      outcome: 'ERROR',
      first_terminal_stage: 'd1_identity',
      failure: { classification: evidencePolicy.malformed_classification },
      stage_counts: { ...receipt.value.stage_counts, d1_identity: 1 },
      stage_durations_ms: { ...receipt.value.stage_durations_ms, d1_identity: 1 },
      evidence_hashes: Object.fromEntries(D1_EVIDENCE_HASHES.map((name) => [name, receipt.value.evidence[name]])),
      sha256: receipt.sha256,
      receipt,
    }
  }
  if (!isPlainRecord(result) || !isPlainRecord(result.value)
    || !(result.bytes instanceof Uint8Array)
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)
    || sha256(Buffer.from(result.bytes)) !== result.sha256) {
    return malformed()
  }
  const value = result.value
  if (!Buffer.from(result.bytes).equals(canonicalJsonBytes(value))) return malformed()
  const acceptedReceipt = () => {
    const acceptedValue = structuredClone(value)
    acceptedValue.evidence.source = evidencePolicy.source
    acceptedValue.evidence.production = evidencePolicy.production
    acceptedValue.evidence.promotable = (
      evidencePolicy.allow_promotable_pass && evidencePolicy.production && acceptedValue.outcome === 'PASS'
    )
    const bytes = canonicalJsonBytes(acceptedValue)
    return Object.freeze({ value: acceptedValue, bytes, sha256: sha256(bytes) })
  }
  if (value.format !== 'blogman-issue-23-d1-stages/v1'
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || !isPlainRecord(value.stage_counts)
    || !isPlainRecord(value.stage_durations_ms)
    || !isPlainRecord(value.evidence)
    || !exact(value, [
      'format', 'outcome', 'first_terminal_stage', 'failure', 'stage_counts',
      'stage_durations_ms', 'evidence', 'finalized',
    ]) || value.finalized !== true
    || !exact(value.evidence, [
      'source', 'production', 'promotable', ...D1_EVIDENCE_HASHES,
      'manifest_sha256', 'authorization_sha256', 'attempt_id',
      'account_id', 'd1_database_id', 'candidate_id',
    ])
    || value.evidence.source !== evidencePolicy.input_source
    || value.evidence.production !== (evidencePolicy.input_production ?? false)
    || value.evidence.promotable !== (
      (evidencePolicy.input_production ?? false) && value.outcome === 'PASS'
    )
    || !D1_EVIDENCE_IDENTITIES.every((field) => value.evidence[field] === identity[field])
    || D1_EVIDENCE_HASHES.some((name) => !/^[a-f0-9]{64}$/u.test(value.evidence[name]))) {
    return malformed()
  }
  const countKeys = Reflect.ownKeys(value.stage_counts)
  const durationKeys = Reflect.ownKeys(value.stage_durations_ms)
  if (countKeys.length !== PRODUCTION_D1_STAGES.length
    || durationKeys.length !== PRODUCTION_D1_STAGES.length
    || PRODUCTION_D1_STAGES.some((stage) => !countKeys.includes(stage) || !durationKeys.includes(stage))) {
    return malformed()
  }
  for (const stage of PRODUCTION_D1_STAGES) {
    if (!Number.isSafeInteger(value.stage_counts[stage])
      || ![0, 1].includes(value.stage_counts[stage])
      || !Number.isSafeInteger(value.stage_durations_ms[stage])
      || value.stage_durations_ms[stage] < 0
      || (value.stage_counts[stage] === 0 && value.stage_durations_ms[stage] !== 0)
      || (value.stage_counts[stage] === 1 && value.stage_durations_ms[stage] <= 0)) {
      return malformed()
    }
  }
  if (value.outcome === 'ERROR' && value.first_terminal_stage === null
    && isPlainRecord(value.failure) && validFailureClassification(value.outcome, value.failure.classification)
    && PRODUCTION_D1_STAGES.every((stage) => value.stage_counts[stage] === 0
      && value.stage_durations_ms[stage] === 0)) {
    return {
      outcome: 'ERROR',
      first_terminal_stage: 'd1_identity',
      failure: { classification: value.failure.classification },
      stage_counts: { ...value.stage_counts, d1_identity: 1 },
      stage_durations_ms: { ...value.stage_durations_ms, d1_identity: 1 },
      evidence_hashes: Object.fromEntries(D1_EVIDENCE_HASHES.map((name) => [name, value.evidence[name]])),
      sha256: acceptedReceipt().sha256,
      receipt: acceptedReceipt(),
    }
  }
  if (value.outcome === 'PASS') {
    if (value.first_terminal_stage !== null
      || value.failure !== null
      || PRODUCTION_D1_STAGES.some((stage) => value.stage_counts[stage] !== 1)) {
      return malformed()
    }
    return {
      outcome: 'PASS',
      first_terminal_stage: null,
      failure: null,
      stage_counts: { ...value.stage_counts },
      stage_durations_ms: { ...value.stage_durations_ms },
      evidence_hashes: Object.fromEntries(D1_EVIDENCE_HASHES.map((name) => [name, value.evidence[name]])),
      sha256: acceptedReceipt().sha256,
      receipt: acceptedReceipt(),
    }
  }
  if (typeof value.first_terminal_stage !== 'string'
    || !PRODUCTION_D1_STAGES.includes(value.first_terminal_stage)
    || !isPlainRecord(value.failure)
    || !validFailureClassification(value.outcome, value.failure.classification)
    || !PRODUCTION_D1_STAGES.every((stage, index) => (
      value.stage_counts[stage] === (index <= PRODUCTION_D1_STAGES.indexOf(value.first_terminal_stage) ? 1 : 0)
    ))) {
    return malformed()
  }
  return {
    outcome: value.outcome,
    first_terminal_stage: value.first_terminal_stage,
    failure: { classification: value.failure.classification },
    stage_counts: { ...value.stage_counts },
    stage_durations_ms: { ...value.stage_durations_ms },
    evidence_hashes: Object.fromEntries(D1_EVIDENCE_HASHES.map((name) => [name, value.evidence[name]])),
    sha256: acceptedReceipt().sha256,
    receipt: acceptedReceipt(),
  }
}

function normalizeProductionD1Result(result, d1, identity) {
  return normalizeD1Result(result, PRODUCTION_D1_EVIDENCE_POLICY, d1, identity)
}

function normalizeProductionD1Receipt(result, d1, identity) {
  return normalizeD1Result(result, PRODUCTION_D1_RECEIPT_POLICY, d1, identity)
}

/** Private rehearsal path only. Never used by public production execute. */
function normalizeFormalRehearsalD1Result(result, d1, identity) {
  return normalizeD1Result(result, FORMAL_REHEARSAL_D1_EVIDENCE_POLICY, d1, identity)
}

function normalizeFormalRehearsalD1Receipt(result, d1, identity) {
  return normalizeD1Result(result, FORMAL_REHEARSAL_D1_RECEIPT_POLICY, d1, identity)
}

const WORKER_RESULT_STAGES = Object.freeze(['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'])
const D1_EVIDENCE_IDENTITIES = Object.freeze([
  'manifest_sha256', 'authorization_sha256', 'attempt_id', 'candidate_id',
])
const D1_EVIDENCE_HASHES = Object.freeze([
  'bindings_sha256',
  'wrangler_sha256',
  'config_sha256',
  'reset_sql_sha256',
  'migration_runner_sha256',
  'migration_catalog_sha256',
  'rollout_safety_sha256',
  'expected_reconciliation_sha256',
  'trace_sha256',
])
const WORKER_EVIDENCE_HASHES = Object.freeze([
  'upload_acceptance_sha256', 'version_traffic_sha256', 'smoke_control_t0_sha256',
])
const WORKER_EVIDENCE_IDENTITIES = Object.freeze([
  'manifest_sha256', 'authorization_sha256', 'attempt_id', 'candidate_id',
])
const FAILURE_CLASSIFICATIONS_BY_OUTCOME = Object.freeze({
  TIMEOUT: new Set(['overall_timeout', 'stage_timeout', 'timeout']),
  UNCERTAIN: new Set([
    'uncertain', 'formal_rehearsal_uncertain', 'live_preconditions_uncertain',
    'worker_adapter_uncertain',
  ]),
  NON_PASS: new Set([
    'Manifest Drift', 'cloudflare_permission_insufficient', 'd1_not_empty',
    'empty_only_plan_invalid', 'formal_rehearsal_forced_failure', 'migration_contract_invalid',
    'migration_ledger_invalid', 'reconciliation_contract_invalid', 'reconciliation_drift',
    'smoke_control_contract_invalid', 'version_traffic_mismatch',
  ]),
  ERROR: new Set([
    'cloudflare_auth_unavailable', 'credential_authority_unavailable', 'd1_identity_malformed',
    'd1_identity_response_invalid', 'deployment_status_malformed', 'empty_d1_proof_invalid', 'formal_rehearsal_d1_adapter_error', 'formal_rehearsal_d1_result_malformed',
    'formal_rehearsal_d1_setup_error', 'formal_rehearsal_response_malformed',
    'live_preconditions_error', 'live_preconditions_malformed', 'malformed', 'nonzero',
    'production_d1_adapter_error', 'production_d1_result_malformed', 'production_d1_setup_error',
    'reconciliation_malformed', 'reconciliation_response_invalid', 'reset_response_invalid',
    'rollout_controls_malformed', 'smoke_auth_policy_invalid', 'smoke_auth_unavailable', 'stage_error',
    'transport_binding_mismatch', 'transport_error', 'upload_acceptance_malformed',
    'upload_contract_invalid', 'worker_adapter_error', 'worker_adapter_nonzero', 'worker_response_malformed', 'worker_result_malformed',
  ]),
})

function validFailureClassification(outcome, classification) {
  return typeof classification === 'string'
    && FAILURE_CLASSIFICATIONS_BY_OUTCOME[outcome]?.has(classification) === true
}
const TERMINAL_EVIDENCE_HASHES = Object.freeze([
  'd1_stage_receipt_sha256',
  ...D1_EVIDENCE_HASHES.map((name) => `d1_${name}`),
  'worker_stage_receipt_sha256',
  ...WORKER_EVIDENCE_HASHES.map((name) => `worker_${name}`),
])

function preWorkerOverallTimeoutResult(evidencePolicy, identity) {
  const value = {
    format: 'blogman-issue-23-worker-stages/v1',
    outcome: 'TIMEOUT',
    first_terminal_stage: 'worker_deploy',
    failure: { classification: 'overall_timeout' },
    stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    stage_durations_ms: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    mutation_counts: { attempted: 0, confirmed: 0 },
    evidence: {
      source: evidencePolicy.source,
      production: evidencePolicy.production,
      promotable: false,
      ...identity,
      hashes: {
        upload_acceptance_sha256: null,
        version_traffic_sha256: null,
        smoke_control_t0_sha256: null,
      },
    },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  const receipt = Object.freeze({ value, bytes, sha256: sha256(bytes) })
  return {
    outcome: value.outcome,
    first_terminal_stage: value.first_terminal_stage,
    failure: value.failure,
    stage_counts: value.stage_counts,
    stage_durations_ms: value.stage_durations_ms,
    mutation_counts: value.mutation_counts,
    evidence_hashes: value.evidence.hashes,
    sha256: receipt.sha256,
    receipt,
  }
}

function malformedWorkerResult(evidencePolicy, identity) {
  const value = {
    format: 'blogman-issue-23-worker-stages/v1',
    outcome: 'ERROR',
    first_terminal_stage: 'worker_deploy',
    failure: { classification: 'worker_result_malformed' },
    stage_counts: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    stage_durations_ms: { worker_deploy: 1, version_traffic_verification: 0, smoke_control_t0: 0 },
    mutation_counts: { attempted: 0, confirmed: 0 },
    evidence: {
      source: evidencePolicy.source,
      production: evidencePolicy.production,
      promotable: false,
      ...identity,
      hashes: {
        upload_acceptance_sha256: null,
        version_traffic_sha256: null,
        smoke_control_t0_sha256: null,
      },
    },
    finalized: true,
  }
  const bytes = canonicalJsonBytes(value)
  const receipt = Object.freeze({ value, bytes, sha256: sha256(bytes) })
  return {
    outcome: value.outcome,
    first_terminal_stage: 'worker_deploy',
    failure: value.failure,
    stage_counts: value.stage_counts,
    stage_durations_ms: value.stage_durations_ms,
    mutation_counts: value.mutation_counts,
    evidence_hashes: { ...value.evidence.hashes },
    sha256: receipt.sha256,
    receipt,
  }
}

const PRODUCTION_WORKER_EVIDENCE_POLICY = Object.freeze({
  input_source: 'stage-runner-non-production',
  source: 'production',
  production: true,
  allow_promotable_pass: true,
})

const FORMAL_REHEARSAL_WORKER_EVIDENCE_POLICY = Object.freeze({
  input_source: 'stage-runner-non-production',
  source: FORMAL_REHEARSAL_EVIDENCE_SOURCE,
  production: false,
  allow_promotable_pass: false,
})

const PRODUCTION_WORKER_RECEIPT_POLICY = Object.freeze({
  ...PRODUCTION_WORKER_EVIDENCE_POLICY,
  input_source: 'production',
  input_production: true,
})

function normalizeWorkerResult(result, evidencePolicy, identity) {
  const malformed = () => malformedWorkerResult(evidencePolicy, identity)
  if (!isPlainRecord(result) || !isPlainRecord(result.value) || !(result.bytes instanceof Uint8Array)
    || !/^[a-f0-9]{64}$/u.test(result.sha256)) return malformed()
  const value = result.value
  const bytes = Buffer.from(result.bytes)
  if (sha256(bytes) !== result.sha256 || !bytes.equals(canonicalJsonBytes(value))
    || !exact(value, [
      'format', 'outcome', 'first_terminal_stage', 'failure', 'stage_counts',
      'stage_durations_ms', 'mutation_counts', 'evidence', 'finalized',
    ]) || value.format !== 'blogman-issue-23-worker-stages/v1' || value.finalized !== true
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || !isPlainRecord(value.stage_counts) || !isPlainRecord(value.stage_durations_ms)
    || !isPlainRecord(value.mutation_counts) || !isPlainRecord(value.evidence)
    || !exact(value.stage_counts, WORKER_RESULT_STAGES)
    || !exact(value.stage_durations_ms, WORKER_RESULT_STAGES)
    || !exact(value.mutation_counts, ['attempted', 'confirmed'])
    || !exact(value.evidence, ['source', 'production', 'promotable', ...WORKER_EVIDENCE_IDENTITIES, 'hashes'])
    || value.evidence.source !== evidencePolicy.input_source
    || value.evidence.production !== (evidencePolicy.input_production ?? false)
    || value.evidence.promotable !== (
      (evidencePolicy.input_production ?? false) && value.outcome === 'PASS'
    )
    || !WORKER_EVIDENCE_IDENTITIES.every((field) => value.evidence[field] === identity[field])
    || !isPlainRecord(value.evidence.hashes) || !exact(value.evidence.hashes, WORKER_EVIDENCE_HASHES)) {
    return malformed()
  }
  for (const stage of WORKER_RESULT_STAGES) {
    if (!Number.isSafeInteger(value.stage_counts[stage]) || ![0, 1].includes(value.stage_counts[stage])
      || !Number.isSafeInteger(value.stage_durations_ms[stage]) || value.stage_durations_ms[stage] < 0
      || (value.stage_counts[stage] === 1 && value.stage_durations_ms[stage] <= 0)
      || (value.stage_counts[stage] === 0 && value.stage_durations_ms[stage] !== 0)) {
      return malformed()
    }
  }
  const preAdapterFailure = value.first_terminal_stage === 'worker_deploy'
    && ['overall_timeout', 'worker_result_malformed'].includes(value.failure?.classification)
    && value.mutation_counts.attempted === 0
    && value.mutation_counts.confirmed === 0
  if (!Number.isSafeInteger(value.mutation_counts.attempted) || !Number.isSafeInteger(value.mutation_counts.confirmed)
    || (!preAdapterFailure && (value.mutation_counts.attempted < 1 || value.mutation_counts.attempted > 2))
    || value.mutation_counts.confirmed < 0 || value.mutation_counts.confirmed > value.mutation_counts.attempted) {
    return malformed()
  }
  const terminalIndex = value.outcome === 'PASS' ? WORKER_RESULT_STAGES.length - 1
    : WORKER_RESULT_STAGES.indexOf(value.first_terminal_stage)
  if (terminalIndex < 0
    || WORKER_RESULT_STAGES.some((stage, index) => value.stage_counts[stage] !== (index <= terminalIndex ? 1 : 0))
    || WORKER_EVIDENCE_HASHES.some((name, index) => (
      index < terminalIndex ? !/^[a-f0-9]{64}$/u.test(value.evidence.hashes[name])
        : index === terminalIndex && value.outcome === 'PASS' ? !/^[a-f0-9]{64}$/u.test(value.evidence.hashes[name])
          : value.evidence.hashes[name] !== null
    ))) return malformed()
  if (value.outcome === 'PASS') {
    if (value.first_terminal_stage !== null || value.failure !== null
      || value.mutation_counts.attempted !== 2 || value.mutation_counts.confirmed !== 2) {
      return malformed()
    }
  } else if (!exact(value.failure, ['classification'])
    || !validFailureClassification(value.outcome, value.failure.classification)
    || (!preAdapterFailure && value.mutation_counts.attempted !== (terminalIndex >= 1 ? 2 : 1))
    || value.mutation_counts.confirmed !== (terminalIndex >= 2 ? 2 : terminalIndex >= 1 ? 1 : 0)) {
    return malformed()
  }
  const acceptedValue = structuredClone(value)
  acceptedValue.evidence.source = evidencePolicy.source
  acceptedValue.evidence.production = evidencePolicy.production
  acceptedValue.evidence.promotable = (
    evidencePolicy.allow_promotable_pass && evidencePolicy.production && acceptedValue.outcome === 'PASS'
  )
  const acceptedBytes = canonicalJsonBytes(acceptedValue)
  const receipt = Object.freeze({ value: acceptedValue, bytes: acceptedBytes, sha256: sha256(acceptedBytes) })
  return {
    outcome: value.outcome,
    first_terminal_stage: value.first_terminal_stage,
    failure: value.failure,
    stage_counts: value.stage_counts,
    stage_durations_ms: value.stage_durations_ms,
    mutation_counts: value.mutation_counts,
    evidence_hashes: Object.fromEntries(WORKER_EVIDENCE_HASHES.map((name) => [name, value.evidence.hashes[name]])),
    sha256: receipt.sha256,
    receipt,
  }
}

function normalizeProductionWorkerResult(result, identity) {
  return normalizeWorkerResult(result, PRODUCTION_WORKER_EVIDENCE_POLICY, identity)
}

function normalizeProductionWorkerReceipt(result, identity) {
  return normalizeWorkerResult(result, PRODUCTION_WORKER_RECEIPT_POLICY, identity)
}

export function normalizeWorkerResultForTestsOnly(result, identity) {
  return normalizeFormalRehearsalWorkerResult(result, identity)
}

function normalizeFormalRehearsalWorkerResult(result, identity) {
  return normalizeWorkerResult(result, FORMAL_REHEARSAL_WORKER_EVIDENCE_POLICY, identity)
}

function npmCliPath(nodePath) {
  return join(dirname(dirname(nodePath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function workerBindings(manifest, expectedReconciliationPath, identity, smokeCredential) {
  const nodePath = realpathSync(process.execPath)
  const npmPath = realpathSync(npmCliPath(nodePath))
  return {
    ...identity,
    smoke_admin_credential: smokeCredential,
    config_path: resolve(ENTRY_REPO_ROOT, manifest.d1.config_path), config_sha256: manifest.d1.config_sha256,
    artifact_archive_path: resolve(ENTRY_REPO_ROOT, manifest.artifact.archive.path), artifact_archive_sha256: manifest.artifact.archive.sha256,
    artifact_source_path: resolve(ENTRY_REPO_ROOT, dirname(manifest.artifact.worker.path)),
    artifact_file_tree_sha256: manifest.artifact.file_tree.sha256,
    artifact_file_tree_files: manifest.artifact.file_tree.files,
    artifact_sha256: manifest.artifact.file_tree.sha256,
    candidate_id: manifest.repository.commit, worker_name: manifest.target.worker_name, d1_database_id: manifest.target.d1_database_id,
    rollout_safety_path: resolve(ENTRY_REPO_ROOT, manifest.d1.rollout_safety_path), rollout_safety_sha256: manifest.d1.rollout_safety_sha256,
    expected_reconciliation_path: expectedReconciliationPath,
    expected_reconciliation_sha256: manifest.d1.expected_reconciliation_sha256,
    worker_upload_entry_path: resolve(
      ENTRY_REPO_ROOT,
      manifest.preparation.worker_upload_entry.path,
    ),
    worker_upload_entry_sha256: manifest.preparation.worker_upload_entry.sha256,
    wrangler_path: realpathSync(resolve(ENTRY_REPO_ROOT, 'node_modules/.bin/wrangler')), wrangler_sha256: manifest.d1.wrangler_sha256,
    node_path: nodePath, node_sha256: manifest.toolchain.node.identity_sha256,
    npm_path: npmPath, npm_sha256: manifest.toolchain.npm.identity_sha256,
    open_next_path: realpathSync(resolve(ENTRY_REPO_ROOT, 'node_modules/.bin/opennextjs-cloudflare')),
    open_next_sha256: manifest.toolchain.opennextjs_cloudflare.identity_sha256,
    working_directory: realpathSync(ENTRY_REPO_ROOT),
    curl_path: realpathSync(SYSTEM_CURL_PATH), curl_sha256: manifest.toolchain.curl.identity_sha256,
    package_json_path: resolve(ENTRY_REPO_ROOT, 'package.json'), package_json_sha256: manifest.toolchain.package_json_sha256,
    lockfile_path: resolve(ENTRY_REPO_ROOT, 'package-lock.json'), lockfile_sha256: manifest.toolchain.lockfile_sha256,
    database: manifest.d1.database, origin: manifest.target.origin, smoke: manifest.target.smoke,
    baseline: manifest.target.baseline,
  }
}

function currentFormalContext() {
  return currentFormalRehearsalContext()
}

function projectedEnvironment(values = {}) {
  return Object.assign(Object.create(null), Object.fromEntries([
    ...CHILD_ENV_ALLOWLIST.filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]]),
    ...Object.entries(values),
  ]))
}

function formalAdapterFactories(context) {
  return Object.freeze({
    createD1Transport(bindings, environments) {
      return createRehearsalD1Transport(
        bindings,
        context.sink,
        currentFormalFaultForTestsOnly(),
        environments.cloudflare,
      )
    },
    createWorkerTransport(bindings, environments) {
      return createRehearsalWorkerTransport(bindings, context.sink, currentFormalFaultForTestsOnly(), environments)
    },
    normalizeD1Result: normalizeFormalRehearsalD1Result,
    normalizeD1Error: normalizeFormalRehearsalD1Receipt,
    normalizeWorkerResult: normalizeFormalRehearsalWorkerResult,
    resolveCredentials(manifest) {
      return Object.freeze({
        smoke: 'formal-rehearsal-smoke-credential',
        environments: Object.freeze({
          cloudflare: Object.freeze(projectedEnvironment({
            [CLOUDFLARE_TOKEN_ENV]: 'formal-cloudflare-placeholder',
            [CLOUDFLARE_ACCOUNT_ENV]: manifest.target.account_id,
          })),
          smoke: Object.freeze(Object.create(null)),
        }),
      })
    },
    d1Error(classification, d1, identity, outcome, entered) {
      return sanitizedD1Error(
        classification, d1, identity, FORMAL_REHEARSAL_D1_EVIDENCE_POLICY, outcome, entered,
      )
    },
    evidence: Object.freeze({
      source: FORMAL_REHEARSAL_EVIDENCE_SOURCE,
      production: false,
      promotable: false,
    }),
    zeroMutations: true,
  })
}

const d1 = D1_COMMAND_CONTRACT

function runProductionD1Bounded(
  executable,
  args,
  timeoutMs,
  environment = process.env,
  timeoutClassification = D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT,
) {
  try {
    return runBoundedChild(
      executable,
      args,
      timeoutMs,
      D1_TRANSPORT_MAX_OUTPUT_BYTES,
      d1.repoRoot,
      environment,
    )
  } catch (error) {
    if (error instanceof D1ChildError) {
      throw new D1TransportError(
        error.classification === D1_TRANSPORT_FAILURE_CLASSIFICATIONS.TIMEOUT
          ? timeoutClassification
          : error.classification,
        error.durationMs,
      )
    }
    throw new D1TransportError(D1_TRANSPORT_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
}

function createProductionD1Transport(config, childEnvironment, monotonicMs) {
  if (typeof d1.createTransportForTestsOnly === 'function') {
    return d1.createTransportForTestsOnly(config, childEnvironment, monotonicMs)
  }
  if (arguments.length < 1 || arguments.length > 3
    || (childEnvironment !== undefined && Object.getPrototypeOf(childEnvironment) !== null)
    || (monotonicMs !== undefined && typeof monotonicMs !== 'function')) {
    d1.fail('production D1 transport rejects unsupported adapter overrides')
  }
  const privateEnvironment = childEnvironment ?? process.env
  const normalizedConfig = d1.validateConfig(config)
  const frozenBoundIdentity = d1.validateBoundArtifactsOrThrow(normalizedConfig)
  const bindingsSha256 = d1StageBindingsSha256(normalizedConfig)

  function budgetFor(request, spentMs = 0) {
    let actualOverallElapsedMs = request.overall_elapsed_ms + spentMs
    if (monotonicMs !== undefined) {
      const measured = monotonicMs()
      if (!Number.isSafeInteger(measured) || measured < 0) d1.fail('internal monotonic clock is invalid')
      actualOverallElapsedMs = Math.max(actualOverallElapsedMs, measured)
    }
    return d1.deadlineBudget(request, spentMs, actualOverallElapsedMs)
  }

  function runRequestBounded(executable, args, request, spentMs = 0) {
    const budget = budgetFor(request, spentMs)
    return runProductionD1Bounded(
      executable,
      args,
      budget.timeout_ms,
      privateEnvironment,
      budget.timeout_classification,
    )
  }

  function execute(request) {
    if (arguments.length !== 1) d1.fail('execute accepts exactly one request argument')
    const normalizedRequest = d1.validateRequest(request)
    d1.validateBoundArtifactsOrThrow(
      normalizedConfig,
      frozenBoundIdentity,
      D1_TRANSPORT_FAILURE_CLASSIFICATIONS.MANIFEST_DRIFT,
    )
    if (normalizedRequest.operation === 'd1_identity'
      || normalizedRequest.operation === 'clean_start_reset'
      || normalizedRequest.operation === 'empty_d1_proof') {
      const command = d1.buildD1Command(normalizedConfig, normalizedRequest)
      if (normalizedRequest.operation !== 'd1_identity') {
        return runRequestBounded(command.executable, command.args, normalizedRequest)
      }
      const infoCommand = runRequestBounded(command.executable, command.args, normalizedRequest)
      if (infoCommand.stderr !== '') return d1.identityResponse(normalizedConfig, infoCommand)
      if (normalizedConfig.mode === 'local') return d1.identityResponse(normalizedConfig, infoCommand)
      let whoamiCommand
      try {
        whoamiCommand = runRequestBounded(
          d1.wranglerPath,
          d1.buildRemoteWhoamiCommand(normalizedConfig),
          normalizedRequest,
          infoCommand.duration_ms,
        )
      } catch (error) {
        if (error instanceof D1TransportError) {
          throw new D1TransportError(
            error.classification,
            infoCommand.duration_ms + error.durationMs,
          )
        }
        throw error
      }
      return d1.identityResponse(normalizedConfig, infoCommand, whoamiCommand)
    }
    if (normalizedRequest.operation === 'migration_catalog') {
      return runRequestBounded(process.execPath, d1.canonicalRunnerCommand(normalizedConfig, 'catalog'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'migration_plan') {
      return runRequestBounded(process.execPath, d1.canonicalRunnerCommand(normalizedConfig, 'plan'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'migration_apply') {
      return runRequestBounded(process.execPath, d1.canonicalRunnerCommand(normalizedConfig, 'apply'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'migration_verify') {
      return runRequestBounded(process.execPath, d1.canonicalRunnerCommand(normalizedConfig, 'verify'), normalizedRequest)
    }
    if (normalizedRequest.operation === 'reconciliation') {
      return runRequestBounded(process.execPath, d1.rolloutSafetyCommand(normalizedConfig), normalizedRequest)
    }
    d1.fail('operation is not supported')
  }

  return Object.freeze({
    execute,
    bindings_sha256: bindingsSha256,
  })
}

const worker = WORKER_COMMAND_CONTRACT

function createProductionWorkerTransport(bindings, environments = { cloudflare: process.env, smoke: process.env }, monotonicMs = () => 0) {
  if (typeof worker.createTransportForTestsOnly === 'function') {
    return worker.createTransportForTestsOnly(bindings, environments, monotonicMs)
  }
  if (!bindings || typeof bindings !== 'object') worker.fail('bindings are required')
  for (const key of [
    'manifest_sha256', 'authorization_sha256', 'attempt_id', 'smoke_admin_credential',
    'config_path', 'config_sha256', 'artifact_archive_path', 'artifact_archive_sha256',
    'artifact_source_path', 'artifact_file_tree_sha256', 'artifact_file_tree_files', 'artifact_sha256',
    'candidate_id', 'worker_name', 'd1_database_id', 'rollout_safety_path', 'rollout_safety_sha256',
    'expected_reconciliation_path', 'expected_reconciliation_sha256', 'worker_upload_entry_path',
    'worker_upload_entry_sha256', 'wrangler_path', 'wrangler_sha256', 'node_path', 'node_sha256',
    'npm_path', 'npm_sha256', 'open_next_path', 'open_next_sha256', 'working_directory',
    'curl_path', 'curl_sha256', 'package_json_path',
    'package_json_sha256', 'lockfile_path', 'lockfile_sha256', 'database', 'origin', 'smoke', 'baseline',
  ]) if (!Object.hasOwn(bindings, key)) worker.fail(`${key} is required`)
  for (const key of [
    'config_path', 'artifact_archive_path', 'artifact_source_path', 'rollout_safety_path',
    'expected_reconciliation_path', 'worker_upload_entry_path', 'wrangler_path', 'node_path', 'npm_path',
    'open_next_path', 'working_directory', 'curl_path', 'package_json_path', 'lockfile_path',
  ]) worker.assertPath(bindings[key], key)
  for (const key of [
    'manifest_sha256', 'authorization_sha256', 'attempt_id',
    'config_sha256', 'artifact_archive_sha256', 'artifact_file_tree_sha256', 'artifact_sha256',
    'rollout_safety_sha256', 'expected_reconciliation_sha256', 'worker_upload_entry_sha256', 'wrangler_sha256',
    'node_sha256', 'npm_sha256', 'open_next_sha256', 'curl_sha256', 'package_json_sha256', 'lockfile_sha256',
  ]) worker.assertHash(bindings[key], key)
  if (!/^[a-f0-9]{40}$/u.test(bindings.candidate_id) || !worker.safeId(bindings.worker_name) || !worker.safeId(bindings.d1_database_id)
    || typeof bindings.smoke_admin_credential !== 'string'
    || !/^[A-Za-z0-9._~-]+$/u.test(bindings.smoke_admin_credential)
    || !worker.safeId(bindings.database) || typeof bindings.origin !== 'string' || !Array.isArray(bindings.smoke?.requests)
    || !worker.exact(bindings.baseline, ['deployment_id', 'version_id', 'd1_database_id', 'traffic'])
    || !worker.safeId(bindings.baseline.deployment_id) || !worker.safeId(bindings.baseline.version_id)
    || bindings.baseline.d1_database_id !== bindings.d1_database_id
    || !Array.isArray(bindings.baseline.traffic) || bindings.baseline.traffic.length !== 1
    || !worker.exact(bindings.baseline.traffic[0], ['version_id', 'percentage'])
    || bindings.baseline.traffic[0].version_id !== bindings.baseline.version_id
    || bindings.baseline.traffic[0].percentage !== 100
    || JSON.stringify(bindings.smoke.requests) !== JSON.stringify(worker.SMOKE_PATHS.map(([path, status]) => ({ path, status })))) {
    worker.fail('bindings are invalid')
  }
  const origin = new URL(bindings.origin)
  if (!['http:', 'https:'].includes(origin.protocol)) worker.fail('origin is invalid')

  function validateLocalBindings() {
    worker.assertBoundFile(bindings.config_path, bindings.config_sha256)
    worker.assertBoundFile(bindings.artifact_archive_path, bindings.artifact_archive_sha256)
    worker.validateArtifactSource(bindings)
    worker.assertBoundFile(bindings.rollout_safety_path, bindings.rollout_safety_sha256)
    worker.assertBoundFile(bindings.expected_reconciliation_path, bindings.expected_reconciliation_sha256)
    worker.assertBoundFile(bindings.worker_upload_entry_path, bindings.worker_upload_entry_sha256)
    worker.assertBoundFile(bindings.wrangler_path, bindings.wrangler_sha256)
    worker.assertBoundFile(bindings.node_path, bindings.node_sha256)
    worker.assertBoundFile(bindings.npm_path, bindings.npm_sha256)
    worker.assertBoundFile(bindings.open_next_path, bindings.open_next_sha256)
    worker.assertBoundDirectory(bindings.working_directory, 'working_directory')
    worker.assertBoundFile(bindings.curl_path, bindings.curl_sha256)
    worker.assertBoundFile(bindings.package_json_path, bindings.package_json_sha256)
    worker.assertBoundFile(bindings.lockfile_path, bindings.lockfile_sha256)
  }

  function invoke(executable, args, request, spent, env = environments.cloudflare, stdin = null) {
    validateLocalBindings()
    const actualSpent = Math.max(spent, monotonicMs() - request.elapsed_ms)
    const stageRemaining = request.timeout_ms - actualSpent
    const overallRemaining = worker.OVERALL_TIMEOUT_MS - request.elapsed_ms - actualSpent
    if (!Number.isSafeInteger(overallRemaining) || overallRemaining <= 0) {
      throw new WorkerTransportError('TIMEOUT', 'overall_timeout', 1)
    }
    if (!Number.isSafeInteger(stageRemaining) || stageRemaining <= 0) {
      throw new WorkerTransportError('TIMEOUT', 'stage_timeout', 1)
    }
    const timeoutClassification = overallRemaining <= stageRemaining
      ? 'overall_timeout'
      : 'stage_timeout'
    try {
      const result = runBoundedChild(
        executable,
        args,
        Math.min(stageRemaining, overallRemaining),
        worker.MAX_OUTPUT_BYTES,
        bindings.working_directory,
        env,
        stdin,
      )
      if (result.stderr !== '') throw new WorkerTransportError('UNCERTAIN', 'worker_adapter_uncertain', result.duration_ms)
      return result
    } catch (error) {
      if (error instanceof WorkerTransportError) throw error
      throw worker.childFailure(error, timeoutClassification)
    }
  }

  function deploymentStatus(request, spent, version) {
    const command = worker.deploymentStatusCommand(bindings)
    const result = invoke(command.executable, command.args, request, spent)
    return { value: worker.parseDeployment(result.stdout, version, bindings.d1_database_id, result.duration_ms), duration_ms: result.duration_ms }
  }
  function d1Identity(request, spent) {
    const command = worker.d1IdentityCommand(bindings)
    const result = invoke(command.executable, command.args, request, spent)
    worker.parseD1Identity(result.stdout, bindings.d1_database_id, result.duration_ms)
    return result.duration_ms
  }

  function livePreconditions(elapsed_ms = 0) {
    if (!Number.isSafeInteger(elapsed_ms) || elapsed_ms < 0 || elapsed_ms >= worker.OVERALL_TIMEOUT_MS) {
      return { outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: 1 }
    }
    const request = { timeout_ms: 120000, elapsed_ms }
    try {
      validateLocalBindings()
      const baseline = deploymentStatus(request, 0, bindings.baseline.version_id)
      if (baseline.value.deployment_id !== bindings.baseline.deployment_id) {
        throw new WorkerTransportError('NON_PASS', 'Manifest Drift', baseline.duration_ms)
      }
      const identityDuration = d1Identity(request, baseline.duration_ms)
      return { outcome: 'PASS', duration_ms: baseline.duration_ms + identityDuration }
    } catch (error) {
      const failure = error instanceof WorkerTransportError
        ? error
        : new WorkerTransportError('UNCERTAIN', 'live_preconditions_uncertain', 1)
      return { outcome: failure.outcome, classification: failure.classification, duration_ms: failure.duration_ms }
    }
  }

  const execute = (request) => {
    if (!worker.exact(request, ['operation', 'stage', 'timeout_ms', 'elapsed_ms', 'version_id', 'deployment_id'])
      || request.operation !== request.stage || !['worker_deploy', 'version_traffic_verification', 'smoke_control_t0'].includes(request.operation)
      || !Number.isSafeInteger(request.timeout_ms) || !Number.isSafeInteger(request.elapsed_ms)
      || request.timeout_ms <= 0 || request.elapsed_ms < 0) worker.fail('request is invalid')
    validateLocalBindings()
    if (request.operation === 'worker_deploy') {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-91-upload-')))
      chmodSync(root, 0o700)
      try {
        const output = join(root, 'upload.jsonl')
        const before = join(root, 'before.json')
        const after = join(root, 'after.json')
        const proof = join(root, 'proof.json')
        const destination = join(root, 'source')
        for (const path of [output, before, after, proof]) writeFileSync(path, '', { mode: 0o600 })
        const command = worker.uploadCommand(bindings, { destination, before, after, proof })
        const result = invoke(
          command.executable,
          command.args,
          request,
          0,
          { ...environments.cloudflare, WRANGLER_OUTPUT_FILE_PATH: output },
        )
        return worker.response(parseJson(result.stdout, 'upload_acceptance', result.duration_ms), result.duration_ms)
      } finally {
        worker.removeTransportTree(root)
      }
    }
    if (request.operation === 'version_traffic_verification') {
      if (!worker.safeId(request.version_id)) throw new WorkerTransportError('ERROR', 'worker_adapter_uncertain')
      let spent = 0
      const command = worker.versionDeployCommand(bindings, request.version_id)
      const deploy = invoke(command.executable, command.args, request, spent)
      spent += deploy.duration_ms
      const status = deploymentStatus(request, spent, request.version_id)
      spent += status.duration_ms
      const identityDuration = d1Identity(request, spent)
      spent += identityDuration
      return worker.response(status.value, spent)
    }
    if (!worker.safeId(request.version_id) || !worker.safeId(request.deployment_id)) {
      throw new WorkerTransportError('ERROR', 'worker_adapter_uncertain')
    }
    let spent = 0
    const before = deploymentStatus(request, spent, request.version_id)
    spent += before.duration_ms
    if (before.value.deployment_id !== request.deployment_id) throw new WorkerTransportError('NON_PASS', 'version_traffic_mismatch', spent)
    spent += d1Identity(request, spent)
    const checks = {}
    for (const { path, status } of bindings.smoke.requests) {
      const url = new URL(path, origin).toString()
      const command = worker.smokeCommand(bindings, url)
      const requestResult = invoke(
        command.executable,
        command.args,
        request,
        spent,
        environments.smoke,
        worker.smokeStdin(bindings.smoke_admin_credential),
      )
      spent += requestResult.duration_ms
      if (requestResult.stdout !== String(status)) {
        throw new WorkerTransportError('NON_PASS', 'smoke_control_contract_invalid', spent)
      }
      checks[path] = status
    }
    const after = deploymentStatus(request, spent, request.version_id)
    spent += after.duration_ms
    if (after.value.deployment_id !== request.deployment_id) throw new WorkerTransportError('NON_PASS', 'version_traffic_mismatch', spent)
    spent += d1Identity(request, spent)
    const controlsPlan = worker.controlsCommand(bindings)
    const controlsResult = invoke(controlsPlan.executable, controlsPlan.args, request, spent)
    spent += controlsResult.duration_ms
    const controls = worker.parseControls(controlsResult.stdout, controlsResult.duration_ms)
    const reconciliationPlan = worker.reconciliationCommand(bindings)
    const reconciliationResult = invoke(reconciliationPlan.executable, reconciliationPlan.args, request, spent)
    spent += reconciliationResult.duration_ms
    return worker.response({ before: before.value, after: after.value, checks, controls, reconciliation: worker.parseReconciliation(reconciliationResult.stdout, reconciliationResult.duration_ms) }, spent)
  }
  return Object.freeze({
    livePreconditions,
    execute,
  })
}

function productionAdapterFactories() {
  return Object.freeze({
    createD1Transport(bindings, environments, monotonicMs) {
      return createProductionD1Transport(bindings, environments.cloudflare, monotonicMs)
    },
    createWorkerTransport(bindings, environments, monotonicMs) {
      return createProductionWorkerTransport(bindings, environments, monotonicMs)
    },
    normalizeD1Result: normalizeProductionD1Result,
    normalizeD1Error: normalizeProductionD1Receipt,
    normalizeWorkerResult: normalizeProductionWorkerResult,
    resolveCredentials(manifest) {
      const slot = manifest.policy.authorization.credential_slots.find(({ name }) => (
        name === manifest.target.smoke.admin_credential_slot
      ))
      if (!slot || !sameJsonValue([...slot.scopes].sort(), ['admin:smoke'])) {
        const error = new Error('smoke authority policy is invalid')
        error.classification = 'smoke_auth_policy_invalid'
        throw error
      }
      const credential = process.env[SMOKE_CREDENTIAL_ENV]
      if (typeof credential !== 'string' || !SMOKE_CREDENTIAL_PATTERN.test(credential)) {
        const error = new Error('smoke authority is unavailable')
        error.classification = 'smoke_auth_unavailable'
        throw error
      }
      const cloudflareSlot = manifest.policy.authorization.credential_slots.find(({ name }) => (
        name === 'cloudflare_delivery'
      ))
      const token = process.env[CLOUDFLARE_TOKEN_ENV]
      const account = process.env[CLOUDFLARE_ACCOUNT_ENV]
      if (!cloudflareSlot || !sameJsonValue([...cloudflareSlot.scopes].sort(), CLOUDFLARE_SCOPES)
        || !CLOUDFLARE_TOKEN_PATTERN.test(token ?? '') || account !== manifest.target.account_id) {
        const error = new Error('Cloudflare delivery authority is unavailable')
        error.classification = 'cloudflare_auth_unavailable'
        throw error
      }
      return Object.freeze({
        smoke: credential,
        environments: Object.freeze({
          cloudflare: Object.freeze(projectedEnvironment({
            [CLOUDFLARE_TOKEN_ENV]: token,
            [CLOUDFLARE_ACCOUNT_ENV]: account,
          })),
          smoke: Object.freeze(Object.create(null)),
        }),
      })
    },
    d1Error(classification, d1, identity, outcome, entered) {
      return sanitizedD1Error(
        classification, d1, identity, PRODUCTION_D1_EVIDENCE_POLICY, outcome, entered,
      )
    },
    evidence: Object.freeze({
      source: 'production',
      production: true,
      promotable: null,
    }),
    zeroMutations: false,
  })
}

function activeAdapterFactories() {
  const context = currentFormalContext()
  return context ? formalAdapterFactories(context) : productionAdapterFactories()
}

function formalFaultResult(stage) {
  const fault = currentFormalFaultForTestsOnly()
  if (!currentFormalContext() || fault?.stage !== stage) return null
  if (fault.kind === 'failure') {
    return { outcome: 'NON_PASS', classification: 'formal_rehearsal_forced_failure', duration_ms: 1 }
  }
  if (fault.kind === 'timeout') {
    return { outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: 1 }
  }
  if (fault.kind === 'malformed') {
    return { outcome: 'ERROR', classification: 'formal_rehearsal_response_malformed', duration_ms: 1 }
  }
  if (fault.kind === 'drift') {
    return { outcome: 'NON_PASS', classification: 'Manifest Drift', duration_ms: 1 }
  }
  return { outcome: 'UNCERTAIN', classification: 'formal_rehearsal_uncertain', duration_ms: 1 }
}

function runLivePreconditions(manifest, d1, identity, credentials, elapsed_ms = 0, monotonicMs) {
  const adapters = activeAdapterFactories()
  let materialized
  try {
    materialized = materializeExpectedReconciliation(d1)
    const result = adapters.createWorkerTransport(workerBindings(
      manifest,
      materialized.path,
      identity,
      credentials.smoke,
    ), credentials.environments, monotonicMs)
      .livePreconditions(elapsed_ms)
    if (!isPlainRecord(result) || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(result.outcome)
      || !Number.isSafeInteger(result.duration_ms) || result.duration_ms <= 0
      || (result.outcome === 'PASS' ? Object.hasOwn(result, 'classification')
        : typeof result.classification !== 'string')) {
      return { outcome: 'ERROR', classification: 'live_preconditions_malformed', duration_ms: 1 }
    }
    return result.outcome === 'PASS'
      ? { outcome: 'PASS', duration_ms: result.duration_ms }
      : { outcome: result.outcome, classification: result.classification, duration_ms: result.duration_ms }
  } catch (error) {
    materialized ??= error?.materialized
    return { outcome: 'ERROR', classification: 'live_preconditions_error', duration_ms: 1 }
  } finally { disposeExpectedReconciliation(materialized) }
}

function reconciledProductionMutationCounts(d1Value, workerValue) {
  const d1Attempted = d1Value === null
    ? 0
    : d1Value.stage_counts.clean_start_reset + d1Value.stage_counts.migrations_001_006
  const d1TerminalIndex = d1Value === null ? -1 : PRODUCTION_D1_STAGES.indexOf(d1Value.first_terminal_stage)
  const d1Confirmed = d1Value === null ? 0 : d1Value.outcome === 'PASS'
    ? 2
    : d1TerminalIndex > PRODUCTION_D1_STAGES.indexOf('migrations_001_006') ? 2
      : d1TerminalIndex > PRODUCTION_D1_STAGES.indexOf('clean_start_reset') ? 1 : 0
  const attempted = d1Attempted + (workerValue?.mutation_counts.attempted ?? 0)
  const confirmed = d1Confirmed + (workerValue?.mutation_counts.confirmed ?? 0)
  return { production_writes: confirmed, attempted, confirmed }
}

function productionEvidenceHashes(d1Result, workerResult) {
  const d1Hashes = d1Result?.evidence_hashes ?? {}
  const workerHashes = workerResult?.evidence_hashes ?? {}
  return Object.fromEntries([
    ['d1_stage_receipt_sha256', d1Result?.sha256 ?? null],
    ...D1_EVIDENCE_HASHES.map((name) => [`d1_${name}`, d1Hashes[name] ?? null]),
    ['worker_stage_receipt_sha256', workerResult?.sha256 ?? null],
    ...WORKER_EVIDENCE_HASHES.map((name) => [`worker_${name}`, workerHashes[name] ?? null]),
  ])
}

export function productionEvidenceHashesForTestsOnly(d1Result, workerResult) {
  return productionEvidenceHashes(d1Result, workerResult)
}

function productionTrace(liveResult, d1Result, workerResult = null) {
  const trace = [{
    stage: 'live_preconditions', outcome: liveResult.outcome,
    ...(liveResult.outcome === 'PASS' ? {} : { classification: liveResult.classification }),
    duration_ms: liveResult.duration_ms,
  }]
  if (liveResult.outcome !== 'PASS') return trace
  for (const stage of PRODUCTION_D1_STAGES) {
    if (d1Result.stage_counts[stage] === 0) break
    const terminal = d1Result.outcome !== 'PASS' && stage === d1Result.first_terminal_stage
    trace.push({
      stage,
      outcome: terminal ? d1Result.outcome : 'PASS',
      ...(terminal ? { classification: d1Result.failure.classification } : {}),
      duration_ms: d1Result.stage_durations_ms[stage],
    })
    if (terminal) break
  }
  if (d1Result.outcome === 'PASS') {
    for (const stage of ['worker_deploy', 'version_traffic_verification', 'smoke_control_t0']) {
      if (workerResult.stage_counts[stage] === 0) break
      const terminal = workerResult.outcome !== 'PASS' && stage === workerResult.first_terminal_stage
      trace.push({ stage, outcome: terminal ? workerResult.outcome : 'PASS', ...(terminal ? { classification: workerResult.failure.classification } : {}), duration_ms: workerResult.stage_durations_ms[stage] })
      if (terminal) break
    }
  }
  return trace
}

function executeProduction(manifest, authorization) {
  const formal = currentFormalContext()
  const manifestBytes = validatePreparedManifest(manifest)
  const d1 = formal
    ? validateFormalRehearsalManifest(manifest.value, manifestBytes)
    : validateCanonicalManifest(manifest.value, manifestBytes)
  const attemptClock = createAttemptClock()
  const withinOverallDeadline = () => attemptClock.elapsedMilliseconds() <= OVERALL_TIMEOUT_SECONDS * 1000
  const authorizationDigest = acceptAuthorization(sha256(manifestBytes), authorization, withinOverallDeadline)
  const authorizationElapsed = attemptClock.elapsedMilliseconds()
  const identities = {
    manifest_sha256: sha256(manifestBytes),
    authorization_sha256: authorizationDigest,
  }
  const attemptId = sha256(canonicalJsonBytes({
    format: 'blogman-issue-23-attempt/v1',
    ...identities,
  }))
  const workerIdentity = Object.freeze({
    ...identities,
    attempt_id: attemptId,
    candidate_id: manifest.value.repository.commit,
  })
  const adapters = activeAdapterFactories()
  const authorizationFault = authorizationElapsed > DELIVERY_STAGE_POLICY[0].timeout_seconds * 1000
    ? { outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: authorizationElapsed }
    : formalFaultResult('authorization_accept')
  let credentials
  let liveResult
  // live_preconditions starts immediately after durable Authorization acceptance:
  // formal-entry closure, Wrangler target, repository identity, credential
  // resolution, and adapter live checks all consume its frozen 120s budget.
  const liveStarted = attemptClock.elapsedMilliseconds()
  const liveElapsed = () => attemptClock.elapsedMilliseconds() - liveStarted
  const liveDeadlineResult = () => {
    const measured = liveElapsed()
    if (measured > DELIVERY_STAGE_POLICY[1].timeout_seconds * 1000) {
      return { outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: Math.max(1, measured) }
    }
    if (!withinOverallDeadline()) {
      return { outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: Math.max(1, measured) }
    }
    return null
  }
  if (authorizationFault) {
    liveResult = authorizationFault
  } else {
    try {
      assertCurrentFormalEntryClosure(manifest.value)
      liveResult = liveDeadlineResult()
      if (!liveResult) {
        assertWranglerTargetBinding(manifest.value)
        liveResult = liveDeadlineResult()
      }
      if (!liveResult) {
        assertCurrentRepositoryIdentity(manifest.value)
        liveResult = liveDeadlineResult()
      }
    } catch {
      liveResult = {
        outcome: 'NON_PASS',
        classification: 'Manifest Drift',
        duration_ms: Math.max(1, liveElapsed()),
      }
    }
    if (!liveResult) {
      try {
        credentials = adapters.resolveCredentials(manifest.value)
        liveResult = liveDeadlineResult()
        if (!liveResult) {
          liveResult = runLivePreconditions(
            manifest.value,
            d1,
            workerIdentity,
            credentials,
            liveStarted,
            attemptClock.elapsedMilliseconds,
          )
          const liveMeasured = liveElapsed()
          liveResult.duration_ms = Math.max(liveResult.duration_ms, liveMeasured)
          if (liveMeasured > DELIVERY_STAGE_POLICY[1].timeout_seconds * 1000) {
            liveResult = { outcome: 'TIMEOUT', classification: 'stage_timeout', duration_ms: liveMeasured }
          } else if (!withinOverallDeadline()) {
            liveResult = { outcome: 'TIMEOUT', classification: 'overall_timeout', duration_ms: liveMeasured }
          }
        }
      } catch (error) {
        liveResult = {
          outcome: 'ERROR',
          classification: error?.classification ?? 'credential_authority_unavailable',
          duration_ms: Math.max(1, liveElapsed()),
        }
      }
    }
  }
  let materialized
  let d1Result
  let d1Receipt
  const durableD1Failure = (classification, outcome = 'ERROR', entered = true) => {
    d1Receipt = adapters.d1Error(classification, d1, workerIdentity, outcome, entered)
    return adapters.normalizeD1Error(d1Receipt, d1, workerIdentity)
  }
  let cleanup = { created: false, cleaned: true, observed_absent: true }
  if (liveResult.outcome === 'PASS') {
    // d1_identity starts before its closure recheck, expected-reconciliation
    // materialization, binding derivation, and real transport construction; the
    // original Stage start is seeded into the single D1 stage runner so setup
    // consumes the Stage duration and child budget and cannot be reset.
    const d1StageStarted = attemptClock.elapsedMilliseconds()
    try {
      try {
        assertCurrentFormalEntryClosure(manifest.value)
      } catch {
        d1Result = durableD1Failure('Manifest Drift', 'NON_PASS', true)
      }
      if (!d1Result) {
        if (!withinOverallDeadline()) throw new DeliverySinkDeadlineError()
        materialized = materializeExpectedReconciliation(d1)
        if (!withinOverallDeadline()) throw new DeliverySinkDeadlineError()
        const bindings = deriveProductionD1Bindings(d1, materialized.path, workerIdentity)
        let transport
        try {
          transport = adapters.createD1Transport(
            bindings,
            credentials.environments,
            attemptClock.elapsedMilliseconds,
          )
        } catch (error) {
          d1Result = error instanceof DeliverySinkDeadlineError || !withinOverallDeadline()
            ? durableD1Failure('overall_timeout', 'TIMEOUT', true)
            : durableD1Failure(formal ? 'formal_rehearsal_d1_setup_error' : 'production_d1_setup_error')
        }
        if (!d1Result) {
          try {
            d1Receipt = runD1Stages({
              bindings,
              transport,
              elapsed_ms: d1StageStarted,
              monotonic_ms: attemptClock.elapsedMilliseconds,
              initial_stage_started_ms: d1StageStarted,
            })
            d1Result = adapters.normalizeD1Result(d1Receipt, d1, workerIdentity)
            d1Receipt = d1Result.receipt ?? d1Receipt
          } catch {
            d1Result = durableD1Failure(formal ? 'formal_rehearsal_d1_adapter_error' : 'production_d1_adapter_error')
          }
        }
      }
    } catch (error) {
      materialized ??= error?.materialized
      d1Result = error instanceof DeliverySinkDeadlineError || !withinOverallDeadline()
        ? durableD1Failure('overall_timeout', 'TIMEOUT', true)
        : durableD1Failure(formal ? 'formal_rehearsal_d1_setup_error' : 'production_d1_setup_error')
    } finally {
      cleanup = disposeExpectedReconciliation(materialized)
    }
  }
  if (!d1Result && liveResult.outcome === 'PASS') {
    const receipt = adapters.d1Error(
      formal ? 'formal_rehearsal_d1_adapter_error' : 'production_d1_adapter_error',
      d1,
      workerIdentity,
    )
    d1Result = adapters.normalizeD1Result(receipt, d1, workerIdentity)
    d1Receipt = d1Result.receipt ?? receipt
  }
  d1Result ??= {
    outcome: 'ERROR',
    first_terminal_stage: 'd1_identity',
    failure: { classification: formal ? 'formal_rehearsal_d1_adapter_error' : 'production_d1_adapter_error' },
    stage_counts: Object.fromEntries(PRODUCTION_D1_STAGES.map((stage) => [stage, 0])),
    stage_durations_ms: Object.fromEntries(PRODUCTION_D1_STAGES.map((stage) => [stage, 0])),
    evidence_hashes: {},
    sha256: null,
  }
  let workerResult
  let workerReceipt
  if (d1Result.outcome === 'PASS') {
    // worker_deploy starts before Worker materialization, binding derivation,
    // and transport construction; the original Stage start is seeded into the
    // single Worker stage runner the same way.
    const workerStageStarted = attemptClock.elapsedMilliseconds()
    let workerExpected
    try {
      if (!withinOverallDeadline()) throw new DeliverySinkDeadlineError()
      workerExpected = materializeExpectedReconciliation(d1)
      if (!withinOverallDeadline()) throw new DeliverySinkDeadlineError()
      const bindings = workerBindings(
        manifest.value,
        workerExpected.path,
        workerIdentity,
        credentials.smoke,
      )
      workerReceipt = runWorkerStages({
        bindings,
        transport: adapters.createWorkerTransport(
          bindings,
          credentials.environments,
          attemptClock.elapsedMilliseconds,
        ),
        elapsed_ms: workerStageStarted,
        monotonic_ms: attemptClock.elapsedMilliseconds,
        initial_stage_started_ms: workerStageStarted,
      })
      workerResult = adapters.normalizeWorkerResult(workerReceipt, workerIdentity)
    } catch (error) {
      workerResult = error instanceof DeliverySinkDeadlineError || !withinOverallDeadline()
        ? preWorkerOverallTimeoutResult(adapters.evidence.production
          ? PRODUCTION_WORKER_EVIDENCE_POLICY
          : FORMAL_REHEARSAL_WORKER_EVIDENCE_POLICY, workerIdentity)
        : adapters.normalizeWorkerResult(null, workerIdentity)
    }
    finally { disposeExpectedReconciliation(workerExpected) }
  }
  const trace = authorizationFault
    ? [{ stage: 'authorization_accept', ...authorizationFault }]
    : [
      // Successful durable Authorization consumption is a real traced Stage with
      // its real monotonic duration; count and duration can never be zero here.
      { stage: 'authorization_accept', outcome: 'PASS', duration_ms: Math.max(1, authorizationElapsed) },
      ...productionTrace(liveResult, d1Result, workerResult),
    ]
  const terminal = trace.at(-1)
  if (!terminal) fail('production state machine did not run')
  const reconciledMutations = reconciledProductionMutationCounts(d1Result, workerResult)
  const evidenceSource = adapters.evidence.source
  const evidenceProduction = adapters.evidence.production
  const evidencePromotable = adapters.evidence.promotable === null
    ? terminal.outcome === 'PASS'
    : adapters.evidence.promotable
  const durableD1Receipt = d1Receipt !== undefined && d1Receipt !== null
    && d1Result.sha256 === d1Receipt.sha256
    ? d1Receipt
    : null
  const durableWorkerReceipt = workerResult?.receipt
    ?? (workerReceipt !== undefined && workerReceipt !== null
      && workerResult.sha256 === workerReceipt.sha256
      ? workerReceipt
      : null)
  const counts = stageCounts(trace)
  const durations = stageDurations(trace)
  const value = {
    format: TERMINAL_RESULT_FORMAT,
    identities,
    attempt_id: attemptId,
    started_at: attemptClock.started_at,
    ended_at: attemptClock.finish(Object.values(durations).reduce((sum, duration) => sum + duration, 0)),
    authorization_consumed: true,
    outcome: terminal.outcome,
    first_terminal_stage: terminal.stage,
    failure: terminal.outcome === 'PASS' ? null : { classification: terminal.classification },
    stage_counts: counts,
    stage_durations_ms: durations,
    mutation_counts: adapters.zeroMutations
      ? { production_writes: 0, attempted: 0, confirmed: 0 }
      : reconciledMutations,
    evidence: {
      source: evidenceSource,
      production: evidenceProduction,
      promotable: evidencePromotable,
      hashes: productionEvidenceHashes(
        durableD1Receipt === null ? null : d1Result,
        durableWorkerReceipt === null ? null : workerResult,
      ),
      cleanup,
    },
    finalized: true,
  }
  let result = terminalResult(value)
  const applyPersistenceElapsed = (elapsedMilliseconds) => {
    value.ended_at = attemptClock.finish(elapsedMilliseconds)
    if (terminal.outcome === 'PASS') {
      value.outcome = 'TIMEOUT'
      value.first_terminal_stage = terminal.stage
      value.failure = { classification: 'overall_timeout' }
      value.evidence.promotable = false
    }
    result = terminalResult(value)
  }
  const measuredBeforePersistence = attemptClock.elapsedMilliseconds()
  if (measuredBeforePersistence > OVERALL_TIMEOUT_SECONDS * 1000) {
    applyPersistenceElapsed(measuredBeforePersistence)
  }
  try {
    executionDeliverySink().persistTerminalResult({
      terminal: result,
      manifest,
      d1: durableD1Receipt,
      worker: durableWorkerReceipt,
    }, withinOverallDeadline)
  } catch (error) {
    if (!(error instanceof DeliverySinkDeadlineError)) throw error
    applyPersistenceElapsed(attemptClock.elapsedMilliseconds())
    executionDeliverySink().persistTerminalResult({
      terminal: result,
      manifest,
      d1: durableD1Receipt,
      worker: durableWorkerReceipt,
    })
  }
  return result
}

/**
 * Independently validates Production Evidence from the repository-owned durable
 * sink. Canonical bytes and their identities remain authoritative across copies
 * and process restarts; object identity is never consulted.
 */
export function validateProductionTerminalEvidence(result) {
  if (arguments.length !== 1 || !isPlainRecord(result)) fail('production terminal evidence is malformed')
  try {
    assertExactKeys(result, ['value', 'bytes', 'sha256'], 'terminal result')
  } catch {
    fail('production terminal evidence is malformed')
  }
  if (!isPlainRecord(result.value)
    || !(result.bytes instanceof Uint8Array)
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)) {
    fail('production terminal evidence is malformed')
  }
  let receipts
  try {
    receipts = canonicalDeliveryReader().readTerminalEvidence(result.sha256)
  } catch {
    fail('production terminal evidence is malformed')
  }
  const bytes = Buffer.from(result.bytes)
  if (!bytes.equals(receipts.terminal.bytes) || receipts.terminal.sha256 !== result.sha256) {
    fail('production terminal evidence is malformed')
  }
  if (sha256(bytes) !== result.sha256) fail('production terminal evidence is malformed')
  const text = bytes.toString('utf8')
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail('production terminal evidence is malformed')
  }
  let value
  try {
    value = JSON.parse(text.slice(0, -1))
  } catch {
    fail('production terminal evidence is malformed')
  }
  if (!isPlainRecord(value) || !bytes.equals(canonicalJsonBytes(value)) || !sameJsonValue(value, result.value)) {
    fail('production terminal evidence is malformed')
  }
  const startedAtMilliseconds = canonicalTimestampMilliseconds(value.started_at)
  const endedAtMilliseconds = canonicalTimestampMilliseconds(value.ended_at)
  if (!exact(value, [
    'format', 'identities', 'attempt_id', 'started_at', 'ended_at', 'authorization_consumed', 'outcome',
    'first_terminal_stage', 'failure', 'stage_counts', 'stage_durations_ms',
    'mutation_counts', 'evidence', 'finalized',
  ]) || value.format !== TERMINAL_RESULT_FORMAT
    || value.finalized !== true || value.authorization_consumed !== true
    || !isPlainRecord(value.identities)
    || !exact(value.identities, ['manifest_sha256', 'authorization_sha256'])
    || !Object.values(value.identities).every((identity) => typeof identity === 'string' && /^[a-f0-9]{64}$/u.test(identity))
    || typeof value.attempt_id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.attempt_id)
    || startedAtMilliseconds === null || endedAtMilliseconds === null
    || endedAtMilliseconds < startedAtMilliseconds
    || (endedAtMilliseconds - startedAtMilliseconds > OVERALL_TIMEOUT_SECONDS * 1000
      && value.outcome === 'PASS')
    || !['PASS', 'NON_PASS', 'ERROR', 'TIMEOUT', 'UNCERTAIN'].includes(value.outcome)
    || !isPlainRecord(value.stage_counts) || !exact(value.stage_counts, DELIVERY_STAGES)
    || !isPlainRecord(value.stage_durations_ms) || !exact(value.stage_durations_ms, DELIVERY_STAGES)
    || !isPlainRecord(value.mutation_counts) || !exact(value.mutation_counts, ['production_writes', 'attempted', 'confirmed'])
    || !isPlainRecord(value.evidence) || !exact(value.evidence, ['source', 'production', 'promotable', 'hashes', 'cleanup'])
    || value.evidence.source !== 'production' || value.evidence.production !== true
    || value.evidence.promotable !== (value.outcome === 'PASS')
    || !isPlainRecord(value.evidence.hashes) || !exact(value.evidence.hashes, TERMINAL_EVIDENCE_HASHES)
    || !isPlainRecord(value.evidence.cleanup) || !exact(value.evidence.cleanup, ['created', 'cleaned', 'observed_absent'])) {
    fail('production terminal evidence is invalid')
  }
  const expectedAttemptId = sha256(canonicalJsonBytes({
    format: 'blogman-issue-23-attempt/v1',
    ...value.identities,
  }))
  const terminalIndex = DELIVERY_STAGES.indexOf(value.first_terminal_stage)
  if (value.attempt_id !== expectedAttemptId
    || terminalIndex < 0
    || DELIVERY_STAGES.some((stage, index) => (
      !Number.isSafeInteger(value.stage_counts[stage]) || ![0, 1].includes(value.stage_counts[stage])
      || !Number.isSafeInteger(value.stage_durations_ms[stage]) || value.stage_durations_ms[stage] < 0
      || value.stage_counts[stage] !== (index <= terminalIndex ? 1 : 0)
      || (value.stage_counts[stage] === 0 && value.stage_durations_ms[stage] !== 0)
    ))
    || endedAtMilliseconds - startedAtMilliseconds
      < Object.values(value.stage_durations_ms).reduce((sum, duration) => sum + duration, 0)
    || Object.values(value.mutation_counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || value.mutation_counts.production_writes !== value.mutation_counts.confirmed
    || value.mutation_counts.confirmed > value.mutation_counts.attempted
    || value.mutation_counts.attempted > 4
    || (value.stage_counts.d1_identity === 0
      ? value.evidence.hashes.d1_stage_receipt_sha256 !== null
      : !/^[a-f0-9]{64}$/u.test(value.evidence.hashes.d1_stage_receipt_sha256))
    || (value.stage_counts.worker_deploy === 0
      ? value.evidence.hashes.worker_stage_receipt_sha256 !== null
      : !/^[a-f0-9]{64}$/u.test(value.evidence.hashes.worker_stage_receipt_sha256))
    || Object.values(value.evidence.hashes).some((hash) => hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)))
    || !Object.values(value.evidence.cleanup).every((flag) => typeof flag === 'boolean')) {
    fail('production terminal evidence is invalid')
  }
  if (value.outcome === 'PASS') {
    if (value.first_terminal_stage !== 'smoke_control_t0' || value.failure !== null) {
      fail('production terminal evidence is invalid')
    }
  } else if (!isPlainRecord(value.failure) || !exact(value.failure, ['classification'])
    || !validFailureClassification(value.outcome, value.failure.classification)) {
    fail('production terminal evidence is invalid')
  }
  const manifest = receipts.manifest
  if (!isPlainRecord(manifest) || !(manifest.bytes instanceof Uint8Array)
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    fail('production terminal evidence is invalid')
  }
  let parsedManifest
  try {
    parsedManifest = parseCanonicalManifest(manifest.bytes, manifest.sha256)
  } catch {
    fail('production terminal evidence is invalid')
  }
  const durableAuthorization = receipts.authorization
  if (value.identities.manifest_sha256 !== manifest.sha256
    || !isPlainRecord(durableAuthorization?.value)
    || !exact(durableAuthorization.value, ['format', 'authorization_id', 'manifest_sha256', 'decision'])
    || durableAuthorization.sha256 !== value.identities.authorization_sha256
    || durableAuthorization.value.format !== AUTHORIZATION_FORMAT
    || durableAuthorization.value.manifest_sha256 !== manifest.sha256
    || durableAuthorization.value.decision !== 'approve'
    || parsedManifest.repository.commit !== parsedManifest.ci.head_sha
    || parsedManifest.repository.tree !== parsedManifest.ci.tree) {
    fail('production terminal evidence is invalid')
  }

  const d1Receipt = receipts.d1
  if (value.stage_counts.d1_identity === 0) {
    if (d1Receipt !== null || D1_EVIDENCE_HASHES.some((name) => value.evidence.hashes[`d1_${name}`] !== null)) {
      fail('production terminal evidence is invalid')
    }
  } else {
    const normalizedD1 = normalizeProductionD1Receipt(d1Receipt, parsedManifest.d1, {
      ...value.identities,
      attempt_id: value.attempt_id,
      candidate_id: parsedManifest.repository.commit,
    })
    if (!isPlainRecord(d1Receipt?.value)
      || !Buffer.from(d1Receipt.bytes ?? []).equals(canonicalJsonBytes(d1Receipt.value))
      || normalizedD1.sha256 !== value.evidence.hashes.d1_stage_receipt_sha256
      || !D1_EVIDENCE_IDENTITIES.every((field) => d1Receipt.value.evidence[field] === ({
        ...value.identities,
        attempt_id: value.attempt_id,
        candidate_id: parsedManifest.repository.commit,
      })[field])
      || d1Receipt.value.evidence.source !== 'production'
      || d1Receipt.value.evidence.production !== true
      || d1Receipt.value.evidence.promotable !== (d1Receipt.value.outcome === 'PASS')
      || d1Receipt.value.evidence.candidate_id !== parsedManifest.repository.commit
      || d1Receipt.value.evidence.account_id !== parsedManifest.target.account_id
      || d1Receipt.value.evidence.d1_database_id !== parsedManifest.target.d1_database_id
      || d1Receipt.value.evidence.config_sha256 !== parsedManifest.d1.config_sha256
      || d1Receipt.value.evidence.wrangler_sha256 !== parsedManifest.d1.wrangler_sha256
      || d1Receipt.value.evidence.expected_reconciliation_sha256 !== parsedManifest.d1.expected_reconciliation_sha256
      || PRODUCTION_D1_STAGES.some((stage) => value.stage_counts[stage] !== normalizedD1.stage_counts[stage])
      || D1_EVIDENCE_HASHES.some((name) => value.evidence.hashes[`d1_${name}`] !== d1Receipt.value.evidence[name])) {
      fail('production terminal evidence is invalid')
    }
  }

  const workerHash = value.evidence.hashes.worker_stage_receipt_sha256
  if (workerHash === null) {
    if (receipts.worker !== null) fail('production terminal evidence is invalid')
  } else {
    const workerReceipt = receipts.worker
    const normalizedWorker = normalizeProductionWorkerReceipt(workerReceipt, {
      ...value.identities,
      attempt_id: value.attempt_id,
      candidate_id: parsedManifest.repository.commit,
    })
    if (!isPlainRecord(workerReceipt?.value)
      || !Buffer.from(workerReceipt.bytes ?? []).equals(canonicalJsonBytes(workerReceipt.value))
      || normalizedWorker.sha256 !== workerHash
      || workerReceipt.value.evidence.source !== 'production'
      || workerReceipt.value.evidence.production !== true
      || workerReceipt.value.evidence.promotable !== (workerReceipt.value.outcome === 'PASS')
      || WORKER_RESULT_STAGES.some((stage) => value.stage_counts[stage] !== normalizedWorker.stage_counts[stage])
      || WORKER_EVIDENCE_HASHES.some((name) => value.evidence.hashes[`worker_${name}`] !== workerReceipt.value.evidence.hashes[name])) {
      fail('production terminal evidence is invalid')
    }
  }
  const expectedMutations = reconciledProductionMutationCounts(
    d1Receipt?.value ?? null,
    receipts.worker?.value ?? null,
  )
  if (!Object.entries(expectedMutations).every(([name, count]) => value.mutation_counts[name] === count)) {
    fail('production terminal evidence is invalid')
  }
  return true
}

/**
 * Exact target-macOS no-network formal entry. Its only caller input is config;
 * the authorization and adapters are constructed privately from the validated manifest.
 */
export function runFormalRehearsal(config) {
  if (arguments.length !== 1) fail('runFormalRehearsal accepts exactly one config argument')
  if (platform() !== 'darwin') fail('runFormalRehearsal requires target macOS')
  const sink = []
  const sinkRoot = realpathSync(mkdtempSync(join(tmpdir(), 'blogman-issue-23-formal-sink-')))
  try {
    const context = Object.freeze({
      sink,
      deliverySinkRoot: sinkRoot,
      clock: Object.freeze({
        wallTimeMilliseconds: () => 0,
        monotonicNanoseconds: () => 0n,
      }),
    })
    return runInFormalRehearsalContext(context, () => {
      const manifest = prepare(config)
      const authorizationBytes = canonicalJsonBytes({
        format: AUTHORIZATION_FORMAT,
        authorization_id: `issue23-authorization-${manifest.sha256}`,
        manifest_sha256: manifest.sha256,
        decision: 'approve',
      })
      const authorization = Object.freeze({
        bytes: authorizationBytes,
        sha256: sha256(authorizationBytes),
      })
      const terminal = execute(manifest, authorization)
      if (terminal.value.evidence.production === true || terminal.value.evidence.source === 'production') {
        fail('formal rehearsal must not emit production evidence')
      }
      try {
        validateProductionTerminalEvidence(terminal)
        fail('formal rehearsal terminal result must not pass production evidence validation')
      } catch (error) {
        if (!/production terminal evidence/u.test(error.message)) throw error
      }
      return Object.freeze({
        manifest,
        terminal,
        operations: Object.freeze(sink.map((entry) => Object.freeze({ ...entry }))),
      })
    })
  } finally {
    rmSync(sinkRoot, { recursive: true, force: true })
  }
}

export function execute(manifest, authorization) {
  if (arguments.length !== 2) fail('execute accepts exactly two arguments')
  return executeProduction(manifest, authorization)
}
