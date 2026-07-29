import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
const shellSafeAbsolutePath = /^\/[A-Za-z0-9._/-]+$/
const uploadOperationId = /^issue-23-[a-f0-9]{40}-upload-1$/
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

async function bindUploadAssetsDirectory(configPath, uploadSourceDirectory) {
  if (!isAbsolute(configPath) || configPath !== resolve(configPath)
    || !shellSafeAbsolutePath.test(configPath)
    || !isAbsolute(uploadSourceDirectory) || uploadSourceDirectory !== resolve(uploadSourceDirectory)
    || !shellSafeAbsolutePath.test(uploadSourceDirectory)) {
    throw new Error()
  }
  if (!lstatSync(configPath).isFile() || realpathSync(configPath) !== configPath
    || !lstatSync(uploadSourceDirectory).isDirectory()
    || realpathSync(uploadSourceDirectory) !== uploadSourceDirectory) {
    throw new Error()
  }

  const uploadAssetsDirectory = resolve(uploadSourceDirectory, 'assets')
  if (!lstatSync(uploadAssetsDirectory).isDirectory()
    || realpathSync(uploadAssetsDirectory) !== uploadAssetsDirectory) {
    throw new Error()
  }

  const { unstable_readConfig: readWranglerConfig } = await import('wrangler')
  const config = await readWranglerConfig({ config: configPath }, { hideWarnings: true })
  if (config.configPath !== configPath
    || typeof config.assets?.directory !== 'string'
    || config.assets.directory.length === 0) {
    throw new Error()
  }
  const configuredAssetsDirectory = resolve(
    dirname(config.configPath),
    config.assets.directory,
  )
  if (configuredAssetsDirectory !== uploadAssetsDirectory) throw new Error()
  return uploadAssetsDirectory
}

function isWithin(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.size === right.size
}

function identityEntry(path, type, stat) {
  return Object.freeze({
    path,
    type,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    ctime_ns: stat.ctimeNs.toString(),
    mode: Number(stat.mode & 0o7777n),
    size: stat.size.toString(),
  })
}

function holdStablePath(path, type, mode) {
  if (!isAbsolute(path) || path !== resolve(path) || !shellSafeAbsolutePath.test(path)) {
    throw new Error()
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW
      | (type === 'directory' ? constants.O_DIRECTORY : 0),
  )
  try {
    const before = fstatSync(descriptor, { bigint: true })
    const current = lstatSync(path, { bigint: true })
    if ((type === 'directory' ? !before.isDirectory() : !before.isFile())
      || (mode !== undefined && (before.mode & 0o777n) !== BigInt(mode))
      || !sameIdentity(before, current)
      || realpathSync(path) !== path) {
      throw new Error()
    }
    return { before, descriptor, expectedMode: mode, path, type }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function refreshHeldPath(held) {
  const after = fstatSync(held.descriptor, { bigint: true })
  const current = lstatSync(held.path, { bigint: true })
  if ((held.type === 'directory' ? !after.isDirectory() : !after.isFile())
    || (held.expectedMode !== undefined
      && (after.mode & 0o777n) !== BigInt(held.expectedMode))
    || !sameIdentity(after, current)
    || realpathSync(held.path) !== held.path) {
    throw new Error()
  }
  held.before = after
}

function verifyHeldPath(held) {
  const after = fstatSync(held.descriptor, { bigint: true })
  const current = lstatSync(held.path, { bigint: true })
  if ((held.type === 'directory' ? !after.isDirectory() : !after.isFile())
    || !sameIdentity(held.before, after)
    || !sameIdentity(after, current)
    || realpathSync(held.path) !== held.path) {
    throw new Error()
  }
}

function requirePreparedEvidenceFile(path, reportDirectory) {
  if (!isAbsolute(path) || path !== resolve(path) || !shellSafeAbsolutePath.test(path)
    || dirname(path) !== reportDirectory) {
    throw new Error()
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || realpathSync(path) !== path) {
    throw new Error()
  }
}

function writeSnapshotProof(path, state, proof, destination) {
  writeFileSync(path, `${JSON.stringify({
    format: 'blogman-upload-source-snapshot/v1',
    state,
    worker_script: join(destination, 'worker.js'),
    assets_directory: join(destination, 'assets'),
    ...proof,
  })}\n`)
}

function stableRegularFileBytes(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) throw new Error()
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    const current = lstatSync(path, { bigint: true })
    if (!after.isFile()
      || !sameIdentity(before, after)
      || !sameIdentity(current, after)
      || realpathSync(path) !== path) {
      throw new Error()
    }
    return Object.freeze({ bytes, stat: before })
  } finally {
    closeSync(descriptor)
  }
}

function snapshotProof(entries, identities) {
  const canonical = Buffer.from(`${JSON.stringify(entries)}\n`)
  const canonicalIdentities = Buffer.from(`${JSON.stringify(identities)}\n`)
  return Object.freeze({
    file_count: entries.length,
    tree_sha256: sha256Bytes(canonical),
    identity_sha256: sha256Bytes(canonicalIdentities),
  })
}

function requireCanonicalDirectory(path, mode) {
  if (!isAbsolute(path) || path !== resolve(path) || !shellSafeAbsolutePath.test(path)) {
    throw new Error()
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || realpathSync(path) !== path
    || (mode !== undefined && (stat.mode & 0o777) !== mode)) {
    throw new Error()
  }
  return stat
}

function copyUploadSourceSnapshot(source, destination) {
  requireCanonicalDirectory(source)
  requireCanonicalDirectory(dirname(destination), 0o700)
  if (!isAbsolute(destination) || destination !== resolve(destination)
    || !shellSafeAbsolutePath.test(destination)
    || isWithin(source, destination) || isWithin(destination, source)) {
    throw new Error()
  }
  mkdirSync(destination, { mode: 0o700 })

  const visit = (sourceDirectory, destinationDirectory, relativeDirectory = '') => {
    const before = requireCanonicalDirectory(sourceDirectory)
    const names = readdirSync(sourceDirectory).sort((left, right) => left.localeCompare(right))
    for (const name of names) {
      const sourcePath = join(sourceDirectory, name)
      const destinationPath = join(destinationDirectory, name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
      const stat = lstatSync(sourcePath)
      if (stat.isDirectory() && realpathSync(sourcePath) === sourcePath) {
        mkdirSync(destinationPath, { mode: 0o700 })
        visit(sourcePath, destinationPath, relativePath)
        chmodSync(destinationPath, 0o500)
      } else if (stat.isFile() && realpathSync(sourcePath) === sourcePath) {
        const { bytes } = stableRegularFileBytes(sourcePath)
        const descriptor = openSync(
          destinationPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o400,
        )
        try {
          writeFileSync(descriptor, bytes)
        } finally {
          closeSync(descriptor)
        }
        chmodSync(destinationPath, 0o400)
      } else {
        throw new Error()
      }
    }
    const after = requireCanonicalDirectory(sourceDirectory)
    if (before.dev !== after.dev || before.ino !== after.ino
      || JSON.stringify(readdirSync(sourceDirectory).sort((left, right) => left.localeCompare(right)))
        !== JSON.stringify(names)) {
      throw new Error()
    }
  }
  visit(source, destination)
  chmodSync(destination, 0o500)
  return collectUploadSourceSnapshotProof(destination)
}

function collectUploadSourceSnapshotProof(directory) {
  requireCanonicalDirectory(directory, 0o500)
  requireCanonicalDirectory(dirname(directory), 0o700)
  const entries = []
  const identities = []
  const parent = dirname(directory)
  const parentDescriptor = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const parentBefore = fstatSync(parentDescriptor, { bigint: true })
    const parentCurrent = lstatSync(parent, { bigint: true })
    if (!parentBefore.isDirectory()
      || (parentBefore.mode & 0o777n) !== 0o700n
      || !sameIdentity(parentBefore, parentCurrent)
      || realpathSync(parent) !== parent) {
      throw new Error()
    }

    const visit = (path, relativeDirectory = '') => {
      const descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        const before = fstatSync(descriptor, { bigint: true })
        const current = lstatSync(path, { bigint: true })
        if (!before.isDirectory()
          || (before.mode & 0o777n) !== 0o500n
          || !sameIdentity(before, current)
          || realpathSync(path) !== path) {
          throw new Error()
        }
        identities.push(identityEntry(relativeDirectory || '.', 'directory', before))
        const names = readdirSync(path).sort((left, right) => left.localeCompare(right))
        for (const name of names) {
          const entryPath = join(path, name)
          const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
          const stat = lstatSync(entryPath, { bigint: true })
          if (stat.isDirectory() && (stat.mode & 0o777n) === 0o500n
            && realpathSync(entryPath) === entryPath) {
            visit(entryPath, relativePath)
          } else if (stat.isFile() && (stat.mode & 0o777n) === 0o400n
            && realpathSync(entryPath) === entryPath) {
            const stable = stableRegularFileBytes(entryPath)
            if ((stable.stat.mode & 0o777n) !== 0o400n) throw new Error()
            identities.push(identityEntry(relativePath, 'file', stable.stat))
            entries.push({
              path: relativePath,
              bytes: stable.bytes.byteLength,
              sha256: sha256Bytes(stable.bytes),
            })
          } else {
            throw new Error()
          }
        }
        const after = fstatSync(descriptor, { bigint: true })
        const currentAfter = lstatSync(path, { bigint: true })
        if (!sameIdentity(before, after)
          || !sameIdentity(after, currentAfter)
          || JSON.stringify(readdirSync(path).sort((left, right) => left.localeCompare(right)))
            !== JSON.stringify(names)) {
          throw new Error()
        }
      } finally {
        closeSync(descriptor)
      }
    }

    visit(directory)
    if (!identities.some((entry) => entry.path === 'worker.js' && entry.type === 'file')
      || !identities.some((entry) => entry.path === 'assets' && entry.type === 'directory')) {
      throw new Error()
    }
    const parentAfter = fstatSync(parentDescriptor, { bigint: true })
    const parentCurrentAfter = lstatSync(parent, { bigint: true })
    if (!sameIdentity(parentBefore, parentAfter)
      || !sameIdentity(parentAfter, parentCurrentAfter)) {
      throw new Error()
    }
  } finally {
    closeSync(parentDescriptor)
  }
  return snapshotProof(entries, identities)
}

function verifyUploadSourceSnapshot(directory, expectedTreeSha256, expectedIdentitySha256) {
  if (!sha256.test(expectedTreeSha256 || '')
    || !sha256.test(expectedIdentitySha256 || '')) {
    throw new Error()
  }
  const proof = collectUploadSourceSnapshotProof(directory)
  if (proof.tree_sha256 !== expectedTreeSha256
    || proof.identity_sha256 !== expectedIdentitySha256) {
    throw new Error()
  }
  return proof
}

async function runUploadSourceLifecycle({
  config,
  source,
  destination,
  operationId,
  proofBeforePath,
  proofAfterPath,
}) {
  if (!uploadOperationId.test(operationId || '')) throw new Error()
  const reportDirectory = dirname(destination)
  const reportAncestor = dirname(reportDirectory)
  const uploadOutputPath = process.env.WRANGLER_OUTPUT_FILE_PATH
  requirePreparedEvidenceFile(proofBeforePath, reportDirectory)
  requirePreparedEvidenceFile(proofAfterPath, reportDirectory)
  requirePreparedEvidenceFile(uploadOutputPath, reportDirectory)

  const held = []
  try {
    held.push(holdStablePath(reportAncestor, 'directory'))
    const heldReportDirectory = holdStablePath(reportDirectory, 'directory', 0o700)
    held.push(heldReportDirectory)
    held.push(holdStablePath(dirname(config), 'directory'))
    held.push(holdStablePath(config, 'file'))
    await bindUploadAssetsDirectory(config, source)
    const before = copyUploadSourceSnapshot(source, destination)
    refreshHeldPath(heldReportDirectory)
    held.push(holdStablePath(destination, 'directory', 0o500))
    writeSnapshotProof(proofBeforePath, 'created', before, destination)

    const upload = spawnSync('npm', [
      'exec', '--', 'opennextjs-cloudflare', 'upload',
      '-c', config, '--', join(destination, 'worker.js'),
      '--message', operationId,
      '--assets', join(destination, 'assets'),
    ], {
      env: process.env,
      stdio: 'inherit',
    })

    const after = verifyUploadSourceSnapshot(
      destination,
      before.tree_sha256,
      before.identity_sha256,
    )
    for (const path of held) verifyHeldPath(path)
    if (upload.error || upload.status !== 0) throw new Error()
    writeSnapshotProof(proofAfterPath, 'matched', after, destination)
  } finally {
    for (const path of held.reverse()) closeSync(path.descriptor)
  }
}

function isMainModule() {
  return process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

async function runCli() {
  if (process.argv[2] === 'run-upload-source-lifecycle') {
    try {
      if (process.argv.length !== 15
        || process.argv[3] !== '--config'
        || process.argv[5] !== '--source'
        || process.argv[7] !== '--destination'
        || process.argv[9] !== '--operation-id'
        || process.argv[11] !== '--proof-before'
        || process.argv[13] !== '--proof-after') {
        throw new Error()
      }
      await runUploadSourceLifecycle({
        config: process.argv[4],
        source: process.argv[6],
        destination: process.argv[8],
        operationId: process.argv[10],
        proofBeforePath: process.argv[12],
        proofAfterPath: process.argv[14],
      })
    } catch {
      process.stderr.write('Invalid Issue #23 upload source lifecycle\n')
      process.exitCode = 1
    }
    return
  }

  if (process.argv[2] === 'create-upload-source-snapshot') {
    try {
      if (process.argv.length !== 7
        || process.argv[3] !== '--source'
        || process.argv[5] !== '--destination') {
        throw new Error()
      }
      const proof = copyUploadSourceSnapshot(process.argv[4], process.argv[6])
      process.stdout.write(`${JSON.stringify({
        format: 'blogman-upload-source-snapshot/v1',
        state: 'created',
        ...proof,
      })}\n`)
    } catch {
      process.stderr.write('Invalid Issue #23 upload source snapshot\n')
      process.exitCode = 1
    }
    return
  }

  if (process.argv[2] === 'verify-upload-source-snapshot') {
    try {
      if (process.argv.length !== 9
        || process.argv[3] !== '--directory'
        || process.argv[5] !== '--tree-sha256'
        || process.argv[7] !== '--identity-sha256') {
        throw new Error()
      }
      const proof = verifyUploadSourceSnapshot(
        process.argv[4],
        process.argv[6],
        process.argv[8],
      )
      process.stdout.write(`${JSON.stringify({
        format: 'blogman-upload-source-snapshot/v1',
        state: 'matched',
        ...proof,
      })}\n`)
    } catch {
      process.stderr.write('Invalid Issue #23 upload source snapshot\n')
      process.exitCode = 1
    }
    return
  }

  if (process.argv[2] === 'bind-upload-assets-directory') {
    try {
      if (process.argv.length !== 7
        || process.argv[3] !== '--config'
        || process.argv[5] !== '--upload-source-directory') {
        throw new Error()
      }
      const assetsDirectory = await bindUploadAssetsDirectory(process.argv[4], process.argv[6])
      process.stdout.write(`${assetsDirectory}\n`)
    } catch {
      process.stderr.write('Invalid Issue #23 upload assets binding\n')
      process.exitCode = 1
    }
    return
  }

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

if (isMainModule()) await runCli()
