import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { PHASE_B_STAGES } from './phase-b-sequence.mjs'
import {
  readArchiveEntries,
  verifyBuildDirectory as verifyBuildDirectoryPure,
} from './issue-23-build-proof.mjs'

const MAX_DOCUMENT_BYTES = 1024 * 1024
const INPUT_EVIDENCE_FILE_NAME = 'input-evidence-manifest.json'
const GIT_STORAGE_ENVIRONMENT_OVERRIDES = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE',
])
const PREFLIGHT_FORMAT = 'blogman-local-preflight-candidate/v2'
const INPUT_EVIDENCE_FORMAT = 'blogman-issue-23-input-evidence-manifest/v2'
const REQUEST_FORMAT = 'blogman-issue-23-local-reseal-request/v3'
const HISTORICAL_REQUEST_FORMATS = new Set([
  'blogman-issue-23-local-reseal-request/v1',
  'blogman-issue-23-local-reseal-request/v2',
])
const CURRENT_APPROVAL_FORMAT = 'blogman-issue-23-approval-packet/v4'
const CURRENT_PRE_CAS_FORMAT = 'blogman-issue-23-pre-cas-bindings/v4'
const CURRENT_MANIFEST_FORMAT = 'blogman-issue-23-package-manifest/v4'
const PACKAGE_FILE_NAMES = Object.freeze([
  'approval-packet.json',
  'package-manifest.json',
  'pre-cas-bindings.json',
  'preflight-candidate.json',
])
const SCHEMA_URLS = new Map([
  [INPUT_EVIDENCE_FORMAT, new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-input-evidence-manifest-v2.schema.json',
    import.meta.url,
  )],
  [PREFLIGHT_FORMAT, new URL(
    '../schemas/issue-23-reseal/blogman-local-preflight-candidate-v2.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-approval-packet/v2', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-approval-packet-v2.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-pre-cas-bindings/v2', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-pre-cas-bindings-v2.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-package-manifest/v2', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-package-manifest-v2.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-approval-packet/v3', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-approval-packet-v3.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-pre-cas-bindings/v3', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-pre-cas-bindings-v3.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-package-manifest/v3', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-package-manifest-v3.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-local-reseal-request/v1', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-local-reseal-request-v1.schema.json',
    import.meta.url,
  )],
  ['blogman-issue-23-local-reseal-request/v2', new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-local-reseal-request-v2.schema.json',
    import.meta.url,
  )],
  [CURRENT_APPROVAL_FORMAT, new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-approval-packet-v4.schema.json',
    import.meta.url,
  )],
  [CURRENT_PRE_CAS_FORMAT, new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-pre-cas-bindings-v4.schema.json',
    import.meta.url,
  )],
  [CURRENT_MANIFEST_FORMAT, new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-package-manifest-v4.schema.json',
    import.meta.url,
  )],
  [REQUEST_FORMAT, new URL(
    '../schemas/issue-23-reseal/blogman-issue-23-local-reseal-request-v3.schema.json',
    import.meta.url,
  )],
])

function fail(message) {
  throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function selectSchemaVariant(value, schema, path) {
  const matches = schema.oneOf.filter((candidateSchema) => {
    try {
      validateSchemaValue(value, candidateSchema, path)
      return true
    } catch {
      return false
    }
  })
  if (matches.length !== 1) fail(`${path} must match exactly one schema variant`)
  return matches[0]
}

function validateSchemaValue(value, schema, path = '$') {
  if (schema.oneOf) {
    validateSchemaValue(value, selectSchemaVariant(value, schema, path), path)
    return
  }

  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    fail(`${path} must equal its schema constant`)
  }

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${path} must be an object`)
    }
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) fail(`${path}.${key} is not allowed`)
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], childSchema, `${path}.${key}`)
    }
    return
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(`${path} must be a string`)
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`${path} is too short`)
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      fail(`${path} has an invalid value`)
    }
    return
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(`${path} must be an array`)
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`${path} has too few items`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`${path} has too many items`)
    }
    for (const [index, childSchema] of (schema.prefixItems ?? []).entries()) {
      if (index < value.length) validateSchemaValue(value[index], childSchema, `${path}[${index}]`)
    }
    if (schema.items && schema.items !== false) {
      const start = schema.prefixItems?.length ?? 0
      for (let index = start; index < value.length; index += 1) {
        validateSchemaValue(value[index], schema.items, `${path}[${index}]`)
      }
    }
    if (schema.items === false && value.length > (schema.prefixItems?.length ?? 0)) {
      fail(`${path} has an item that is not allowed`)
    }
    return
  }

  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail(`${path} must be an integer`)
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`${path} is below its minimum`)
    }
  }
}

function orderBySchema(value, schema) {
  if (schema.oneOf) {
    return orderBySchema(value, selectSchemaVariant(value, schema, '$'))
  }
  if (schema.type === 'object') {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key]) => Object.hasOwn(value, key))
        .map(([key, childSchema]) => [key, orderBySchema(value[key], childSchema)]),
    )
  }
  if (schema.type === 'array') {
    return value.map((item, index) => orderBySchema(
      item,
      schema.prefixItems?.[index] ?? schema.items,
    ))
  }
  return value
}

function loadSchema(format) {
  const schemaUrl = SCHEMA_URLS.get(format)
  if (!schemaUrl) fail('Unsupported Issue #23 reseal document format')
  return JSON.parse(readFileSync(schemaUrl, 'utf8'))
}

function canonicalBytes(value) {
  const schema = loadSchema(value.format)
  validateSchemaValue(value, schema)
  return Buffer.from(`${JSON.stringify(orderBySchema(value, schema), null, 2)}\n`)
}

function readValidatedDocument(documentPath, {
  label = 'package document',
  root,
} = {}) {
  const requestedPath = resolve(documentPath)
  const requestedRootPath = dirname(requestedPath)
  let requestedRootRealPath
  try {
    requestedRootRealPath = realpathSync(requestedRootPath)
  } catch {
    fail(`Issue #23 reseal ${label} root must exist`)
  }
  let stat
  try {
    stat = lstatSync(requestedPath)
  } catch {
    fail(`Issue #23 reseal ${label} must exist`)
  }
  if (!stat.isFile()) fail(`Issue #23 reseal ${label} must be a regular file`)
  if (stat.size > MAX_DOCUMENT_BYTES) fail(`Issue #23 reseal ${label} is too large`)

  const realPath = realpathSync(requestedPath)
  const snapshotRoot = root ?? requestedRootRealPath
  if (!pathWithin(snapshotRoot, realPath)) {
    fail(`Issue #23 reseal ${label} real path escapes its root`)
  }
  const raw = readFileSync(realPath)
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    fail(`Issue #23 reseal ${label} must contain valid JSON`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`Issue #23 reseal ${label} must contain a JSON object`)
  }

  const canonical = canonicalBytes(value)
  if (!raw.equals(canonical)) fail(`Issue #23 reseal ${label} is not canonical JSON`)

  return {
    raw,
    snapshot: {
      bytes: raw,
      label,
      realPath,
      relativePath: relative(snapshotRoot, realPath),
      requestedPath,
      requestedRootPath,
      requestedRootRealPath,
      root: snapshotRoot,
    },
    value,
    sha256: sha256(raw),
  }
}

export function validateDocument(documentPath) {
  const document = readValidatedDocument(documentPath)
  return {
    format: document.value.format,
    sha256: document.sha256,
    state: 'valid',
  }
}

export function loadCurrentResealRequest(documentPath) {
  const document = readValidatedDocument(documentPath, { label: 'current request' })
  if (document.value.format !== REQUEST_FORMAT) {
    fail('Issue #23 reseal request is stale for the current clean-start contract')
  }
  return document
}

function requireEqual(actual, expected, binding) {
  if (actual !== expected) fail(`Issue #23 reseal package has a mismatched ${binding} binding`)
}

function requireAbsolutePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail(`Issue #23 reseal ${label} must be an absolute normalized path`)
  }
}

function requireDirectory(directoryPath, label) {
  requireAbsolutePath(directoryPath, label)
  let stat
  try {
    stat = lstatSync(directoryPath)
  } catch {
    fail(`Issue #23 reseal ${label} must exist`)
  }
  if (!stat.isDirectory()) fail(`Issue #23 reseal ${label} must be a directory`)
  return realpathSync(directoryPath)
}

function captureDirectoryIdentity(directoryPath, label) {
  requireAbsolutePath(directoryPath, label)
  const requestedPath = resolve(directoryPath)
  let stat
  try {
    stat = lstatSync(requestedPath)
  } catch {
    fail(`Issue #23 reseal ${label} must exist`)
  }
  if (!stat.isDirectory()) fail(`Issue #23 reseal ${label} must be a directory`)
  return {
    label,
    realPath: realpathSync(requestedPath),
    requestedPath,
  }
}

function verifyDirectoryIdentity(snapshot) {
  try {
    const stat = lstatSync(snapshot.requestedPath)
    if (
      !stat.isDirectory()
      || realpathSync(snapshot.requestedPath) !== snapshot.realPath
    ) {
      fail(`Issue #23 reseal ${snapshot.label} changed after validation`)
    }
  } catch {
    fail(`Issue #23 reseal ${snapshot.label} changed after validation`)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function appendCleanupErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) return primaryError
  const detail = cleanupErrors.map(errorMessage).join('; ')
  if (primaryError instanceof Error) {
    primaryError.message = `${primaryError.message}; cleanup failed: ${detail}`
    return primaryError
  }
  return new Error(`${String(primaryError)}; cleanup failed: ${detail}`)
}

function removeOwnedEmptyReservation(reservation) {
  let current
  try {
    current = lstatSync(reservation.path)
  } catch {
    fail('Issue #23 reseal output parent reservation disappeared during cleanup')
  }
  if (
    !current.isDirectory()
    || current.dev !== reservation.dev
    || current.ino !== reservation.ino
  ) {
    fail('Issue #23 reseal output parent reservation changed during cleanup')
  }
  if (readdirSync(reservation.path).length !== 0) {
    fail('Issue #23 reseal output parent reservation is not empty during cleanup')
  }
  rmdirSync(reservation.path)
}

function reserveOutputParent(outputPath, repositoryPath, frozenRoot) {
  const requestedParent = dirname(outputPath)
  const requestedGrandparent = dirname(requestedParent)
  const realGrandparent = requireDirectory(
    requestedGrandparent,
    'output grandparent',
  )
  const outputParent = join(realGrandparent, basename(requestedParent))
  const finalOutputPath = join(outputParent, basename(outputPath))
  if (
    pathAtOrWithin(frozenRoot, outputParent)
    || pathAtOrWithin(frozenRoot, finalOutputPath)
  ) {
    fail('Issue #23 reseal output real path must be outside the frozen evidence root')
  }
  if (
    outputParent === repositoryPath
    || pathWithin(repositoryPath, outputParent)
    || finalOutputPath === repositoryPath
    || pathWithin(repositoryPath, finalOutputPath)
  ) {
    fail('Issue #23 reseal output real path must be outside the repository')
  }
  if (typeof process.geteuid !== 'function') {
    fail('Issue #23 reseal output parent reservation requires local POSIX ownership')
  }

  try {
    mkdirSync(outputParent, { mode: 0o700, recursive: false })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('Issue #23 reseal output parent reservation must be fresh')
    }
    fail(`Issue #23 reseal could not create output parent reservation: ${errorMessage(error)}`)
  }

  let reservation
  try {
    const created = lstatSync(outputParent)
    reservation = {
      dev: created.dev,
      ino: created.ino,
      path: outputParent,
    }
    chmodSync(outputParent, 0o700)
    const verified = lstatSync(outputParent)
    if (
      !verified.isDirectory()
      || verified.dev !== reservation.dev
      || verified.ino !== reservation.ino
      || verified.uid !== process.geteuid()
      || (verified.mode & 0o7777) !== 0o700
      || realpathSync(outputParent) !== outputParent
    ) {
      fail('Issue #23 reseal output parent reservation failed POSIX identity checks')
    }
    return { finalOutputPath, outputParent, reservation }
  } catch (error) {
    const cleanupErrors = []
    if (reservation) {
      try {
        removeOwnedEmptyReservation(reservation)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    throw appendCleanupErrors(error, cleanupErrors)
  }
}

function pathEntryExists(entryPath) {
  try {
    lstatSync(entryPath)
    return true
  } catch {
    return false
  }
}

function pathWithin(root, child) {
  const childRelativePath = relative(root, child)
  return childRelativePath !== ''
    && childRelativePath !== '..'
    && !childRelativePath.startsWith('../')
    && !isAbsolute(childRelativePath)
}

function pathAtOrWithin(root, child) {
  return child === root || pathWithin(root, child)
}

function posixMode(stat) {
  return (Number(stat.mode) & 0o7777).toString(8).padStart(4, '0')
}

function transientDependencyPath(relativePath) {
  const parts = relativePath.split('/').filter(Boolean)
  return parts.includes('node_modules') || parts.includes('toolchain')
}

function scanFrozenTree(rootPath) {
  const counts = {
    regular_file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    hardlinked_regular_file_count: 0,
    special_file_count: 0,
    realpath_escape_count: 0,
    transient_dependency_entry_count: 0,
  }
  const anomalies = {
    hardlink: undefined,
    owner: undefined,
    realpathEscape: undefined,
    special: undefined,
    symlink: undefined,
    transientDependency: undefined,
  }
  const effectiveUid = typeof process.geteuid === 'function'
    ? BigInt(process.geteuid())
    : undefined
  const identityEntries = []

  const visit = (entryPath) => {
    let stat
    try {
      stat = lstatSync(entryPath, { bigint: true })
    } catch {
      fail('Issue #23 reseal frozen tree changed during traversal')
    }
    const relativePath = relative(rootPath, entryPath).split(sep).join('/')
    if (relativePath && transientDependencyPath(relativePath)) {
      counts.transient_dependency_entry_count += 1
      anomalies.transientDependency ??= relativePath
    }
    if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
      anomalies.owner ??= relativePath || '.'
    }

    let type
    let realPath
    let contentSha256
    if (stat.isSymbolicLink()) {
      type = 'symlink'
      counts.symlink_count += 1
      anomalies.symlink ??= relativePath || '.'
      try {
        realPath = realpathSync(entryPath)
      } catch {
        realPath = '<unresolved>'
      }
    } else if (stat.isDirectory()) {
      type = 'directory'
      counts.directory_count += 1
      realPath = realpathSync(entryPath)
    } else if (stat.isFile()) {
      type = 'regular'
      counts.regular_file_count += 1
      if (stat.nlink !== 1n) {
        counts.hardlinked_regular_file_count += 1
        anomalies.hardlink ??= relativePath || '.'
      }
      realPath = realpathSync(entryPath)
      try {
        contentSha256 = sha256(readFileSync(entryPath))
        const afterRead = lstatSync(entryPath, { bigint: true })
        if (
          afterRead.dev !== stat.dev
          || afterRead.ino !== stat.ino
          || afterRead.mode !== stat.mode
          || afterRead.nlink !== stat.nlink
          || afterRead.size !== stat.size
          || afterRead.uid !== stat.uid
          || afterRead.gid !== stat.gid
        ) {
          fail('Issue #23 reseal frozen tree changed during traversal')
        }
      } catch (error) {
        if (error?.message === 'Issue #23 reseal frozen tree changed during traversal') {
          throw error
        }
        fail('Issue #23 reseal frozen tree changed during traversal')
      }
    } else {
      type = 'special'
      counts.special_file_count += 1
      anomalies.special ??= relativePath || '.'
      try {
        realPath = realpathSync(entryPath)
      } catch {
        realPath = '<unresolved>'
      }
    }

    if (realPath !== '<unresolved>' && !pathAtOrWithin(rootPath, realPath)) {
      counts.realpath_escape_count += 1
      anomalies.realpathEscape ??= relativePath || '.'
    }
    identityEntries.push({
      gid: String(stat.gid),
      mode: posixMode(stat),
      nlink: String(stat.nlink),
      path: relativePath || '.',
      sha256: contentSha256 ?? null,
      size: String(stat.size),
      type,
      uid: String(stat.uid),
    })
    if (type === 'directory') {
      for (const name of readdirSync(entryPath).sort()) {
        visit(join(entryPath, name))
      }
    }
  }

  visit(rootPath)
  if (anomalies.symlink) {
    fail(`Issue #23 reseal frozen tree contains a symbolic link: ${anomalies.symlink}`)
  }
  if (anomalies.hardlink) {
    fail(`Issue #23 reseal frozen tree contains a hardlinked regular file: ${anomalies.hardlink}`)
  }
  if (anomalies.special) {
    fail(`Issue #23 reseal frozen tree contains a special file: ${anomalies.special}`)
  }
  if (anomalies.realpathEscape) {
    fail(`Issue #23 reseal frozen tree contains a realpath escape: ${anomalies.realpathEscape}`)
  }
  if (anomalies.transientDependency) {
    fail(`Issue #23 reseal frozen tree contains a transient dependency or toolchain entry: ${anomalies.transientDependency}`)
  }
  if (anomalies.owner) {
    fail(`Issue #23 reseal frozen tree contains an entry owned by another user: ${anomalies.owner}`)
  }
  return {
    counts,
    identitySha256: sha256(Buffer.from(`${JSON.stringify(identityEntries)}\n`)),
  }
}

function requireMode(entryPath, expectedMode, label) {
  const stat = lstatSync(entryPath, { bigint: true })
  if (posixMode(stat) !== expectedMode) {
    fail(`Issue #23 reseal ${label} must have mode ${expectedMode}`)
  }
  if (stat.isFile() && stat.nlink !== 1n) {
    fail(`Issue #23 reseal ${label} must have link count one`)
  }
}

function requireNormalizedRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || isAbsolute(value)
    || value.includes('\\')
    || relative('.', value) !== value
  ) {
    fail(`Issue #23 reseal ${label} path must be normalized and relative`)
  }
}

function requireRegularFileWithin(root, relativePath, label) {
  requireNormalizedRelativePath(relativePath, label)
  const filePath = resolve(root, relativePath)
  if (!pathWithin(root, filePath)) fail(`Issue #23 reseal ${label} path escapes its root`)

  let stat
  try {
    stat = lstatSync(filePath)
  } catch {
    fail(`Issue #23 reseal ${label} must exist`)
  }
  if (!stat.isFile()) fail(`Issue #23 reseal ${label} must be a regular file`)
  const realFilePath = realpathSync(filePath)
  if (!pathWithin(root, realFilePath)) {
    fail(`Issue #23 reseal ${label} real path escapes its root`)
  }
  return realFilePath
}

function captureRegularFile(root, relativePath, label) {
  const realPath = requireRegularFileWithin(root, relativePath, label)
  const bytes = readFileSync(realPath)
  return {
    bytes,
    label,
    realPath,
    relativePath,
    root,
  }
}

function requireBoundFile(root, relativePath, expectedSha256, label) {
  const snapshot = captureRegularFile(root, relativePath, label)
  requireEqual(sha256(snapshot.bytes), expectedSha256, `${label} SHA-256`)
  return snapshot
}

function verifyFileSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    let currentRealPath
    let currentBytes
    try {
      if (snapshot.requestedPath) {
        const requestedStat = lstatSync(snapshot.requestedPath)
        if (
          !requestedStat.isFile()
          || realpathSync(snapshot.requestedRootPath) !== snapshot.requestedRootRealPath
        ) {
          fail(`Issue #23 reseal ${snapshot.label} changed after validation`)
        }
        currentRealPath = realpathSync(snapshot.requestedPath)
        if (!pathWithin(snapshot.root, currentRealPath)) {
          fail(`Issue #23 reseal ${snapshot.label} changed after validation`)
        }
      } else {
        currentRealPath = requireRegularFileWithin(
          snapshot.root,
          snapshot.relativePath,
          snapshot.label,
        )
      }
      currentBytes = readFileSync(currentRealPath)
    } catch {
      fail(`Issue #23 reseal ${snapshot.label} changed after validation`)
    }
    if (
      currentRealPath !== snapshot.realPath
      || !currentBytes.equals(snapshot.bytes)
    ) {
      fail(`Issue #23 reseal ${snapshot.label} changed after validation`)
    }
  }
}

function verifyPackageSnapshot(packageSnapshot) {
  const directory = packageSnapshot.directory
  const verifyDirectory = () => {
    verifyDirectoryIdentity(directory)
    if (
      JSON.stringify(readdirSync(directory.realPath).sort())
      !== JSON.stringify(directory.entries)
    ) {
      fail('Issue #23 reseal package directory changed after validation')
    }
  }
  verifyDirectory()
  verifyFileSnapshots(packageSnapshot.snapshots)
  verifyDirectory()
}

function migrationMemberNames(directoryPath) {
  return readdirSync(directoryPath)
    .filter((name) => /^\d{3}_.+\.(?:sql|data\.mjs)$/.test(name))
    .sort()
}

function verifyMigrationDirectorySnapshot(directory) {
  verifyDirectoryIdentity(directory)
  if (
    JSON.stringify(migrationMemberNames(directory.realPath))
    !== JSON.stringify(directory.entries)
  ) {
    fail('Issue #23 reseal migration directory changed after validation')
  }
}

function gitValue(repositoryPath, args, label) {
  try {
    return execFileSync('git', args, {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    fail(`Issue #23 reseal could not read Git ${label}`)
  }
}

function requireGitStoragePathWithinFrozenRoot({
  expectedType,
  frozenRoot,
  label,
  requestedPath,
}) {
  requireAbsolutePath(requestedPath, label)
  let stat
  let realPath
  try {
    stat = lstatSync(requestedPath)
    realPath = realpathSync(requestedPath)
  } catch {
    fail(`Issue #23 reseal ${label} must exist`)
  }
  if (
    (expectedType === 'directory' && !stat.isDirectory())
    || (expectedType === 'file' && !stat.isFile())
  ) {
    fail(`Issue #23 reseal ${label} has an invalid type`)
  }
  if (!pathAtOrWithin(frozenRoot, realPath)) {
    fail('Issue #23 reseal Git metadata storage escapes the frozen evidence root')
  }
  return realPath
}

function verifyGitStorageContainment(repositoryPath, frozenRoot) {
  const activeOverrides = GIT_STORAGE_ENVIRONMENT_OVERRIDES.filter(
    (name) => Object.hasOwn(process.env, name),
  )
  if (activeOverrides.length > 0) {
    fail('Issue #23 reseal Git storage environment overrides are not allowed')
  }

  const layout = gitValue(repositoryPath, [
    'rev-parse',
    '--path-format=absolute',
    '--is-inside-work-tree',
    '--is-bare-repository',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
    '--git-path',
    'objects',
    '--git-path',
    'index',
    '--git-path',
    'objects/info/alternates',
  ], 'storage layout').split(/\r?\n/u)
  if (layout.length !== 8) {
    fail('Issue #23 reseal could not resolve the complete Git storage layout')
  }
  const [
    insideWorktree,
    bareRepository,
    requestedTopLevel,
    requestedGitDirectory,
    requestedCommonDirectory,
    requestedObjectDirectory,
    requestedIndex,
    alternatesPath,
  ] = layout
  requireEqual(insideWorktree, 'true', 'Git worktree state')
  requireEqual(bareRepository, 'false', 'Git bare repository state')
  const topLevel = requireGitStoragePathWithinFrozenRoot({
    expectedType: 'directory',
    frozenRoot,
    label: 'Git worktree root',
    requestedPath: requestedTopLevel,
  })
  requireEqual(topLevel, repositoryPath, 'Git worktree root')

  requireGitStoragePathWithinFrozenRoot({
    expectedType: 'directory',
    frozenRoot,
    label: 'absolute Git directory',
    requestedPath: requestedGitDirectory,
  })
  requireGitStoragePathWithinFrozenRoot({
    expectedType: 'directory',
    frozenRoot,
    label: 'Git common directory',
    requestedPath: requestedCommonDirectory,
  })
  requireGitStoragePathWithinFrozenRoot({
    expectedType: 'directory',
    frozenRoot,
    label: 'Git object directory',
    requestedPath: requestedObjectDirectory,
  })
  requireGitStoragePathWithinFrozenRoot({
    expectedType: 'file',
    frozenRoot,
    label: 'Git index',
    requestedPath: requestedIndex,
  })

  requireAbsolutePath(alternatesPath, 'Git object alternates path')
  if (pathEntryExists(alternatesPath)) {
    requireGitStoragePathWithinFrozenRoot({
      expectedType: 'file',
      frozenRoot,
      label: 'Git object alternates file',
      requestedPath: alternatesPath,
    })
    if (readFileSync(alternatesPath).byteLength > 0) {
      fail('Issue #23 reseal Git object alternates are not allowed')
    }
  }
}

function safeArchivePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes('\\')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}


export function verifyBuildDirectory({
  archivePath,
  directoryPath,
  expectedArchiveSha256,
}) {
  return verifyBuildDirectoryPure({ archivePath, directoryPath, expectedArchiveSha256 })
}

function verifyBuildTree(
  archiveBytes,
  workerRelativePath,
  workerSha256,
  treeManifestRaw,
) {
  const archiveEntries = readArchiveEntries(archiveBytes)
  let treeManifest
  try {
    treeManifest = JSON.parse(treeManifestRaw.toString('utf8'))
  } catch {
    fail('Issue #23 reseal tree manifest must contain valid JSON')
  }
  if (!Array.isArray(treeManifest) || treeManifest.length === 0) {
    fail('Issue #23 reseal tree manifest must contain a non-empty file array')
  }

  const canonicalTreeManifest = []
  for (const entry of treeManifest) {
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry)) !== JSON.stringify(['path', 'bytes', 'sha256'])
      || !safeArchivePath(entry.path)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      fail('Issue #23 reseal tree manifest has an invalid entry')
    }
    canonicalTreeManifest.push({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })
  }
  const manifestPaths = canonicalTreeManifest.map((entry) => entry.path)
  const sortedManifestPaths = [...manifestPaths].sort(
    (left, right) => left.localeCompare(right),
  )
  if (JSON.stringify(manifestPaths) !== JSON.stringify(sortedManifestPaths)) {
    fail('Issue #23 reseal tree manifest paths must be sorted')
  }
  if (new Set(manifestPaths).size !== manifestPaths.length) {
    fail('Issue #23 reseal tree manifest paths must be unique')
  }
  const workerEntry = canonicalTreeManifest.find(
    (entry) => entry.path === workerRelativePath,
  )
  if (!workerEntry) {
    fail('Issue #23 reseal tree manifest does not bind the worker')
  }
  requireEqual(workerEntry.sha256, workerSha256, 'tree manifest worker SHA-256')
  const canonicalBytes = Buffer.from(`${JSON.stringify(canonicalTreeManifest, null, 2)}\n`)
  if (!treeManifestRaw.equals(canonicalBytes)) {
    fail('Issue #23 reseal tree manifest is not canonical JSON')
  }

  const archivePaths = [...archiveEntries.keys()]
  if (
    archivePaths.length !== manifestPaths.length
    || manifestPaths.some((entry) => !archiveEntries.has(entry))
  ) {
    fail('Issue #23 reseal build archive does not match the tree manifest')
  }

  for (const entry of canonicalTreeManifest) {
    const bytes = archiveEntries.get(entry.path)
    requireEqual(bytes.byteLength, entry.bytes, `archive ${entry.path} byte count`)
    requireEqual(sha256(bytes), entry.sha256, `archive ${entry.path} SHA-256`)
  }
}

function verifyLongRunnerCoverage(request, repositoryPath) {
  const longRunnerCoverage = request.github_evidence
    .canonical_long_migration_runner.coverage
  for (const [binding, path, expectedObject] of [
    [
      'long-run migration runner source blob',
      'scripts/migrations.mjs',
      longRunnerCoverage.migration_runner_source_blob,
    ],
    [
      'long-run migration runner test blob',
      'tests/migrations/migration-runner.test.ts',
      longRunnerCoverage.migration_runner_test_blob,
    ],
    [
      'long-run ledger migrations tree',
      'db/ledger-migrations',
      longRunnerCoverage.ledger_migrations_tree,
    ],
    [
      'long-run package lock blob',
      'package-lock.json',
      longRunnerCoverage.package_lock_blob,
    ],
    [
      'long-run schema fixture blob',
      'db/schema.sql',
      longRunnerCoverage.schema_blob,
    ],
    [
      'long-run seed fixture blob',
      'db/seed-template.sql',
      longRunnerCoverage.seed_template_blob,
    ],
    [
      'long-run historical migrations tree',
      'db/migrations',
      longRunnerCoverage.historical_migrations_tree,
    ],
    [
      'long-run Wrangler config blob',
      'wrangler.toml',
      longRunnerCoverage.wrangler_config_blob,
    ],
    [
      'long-run AI provider profile blob',
      'lib/ai-provider-profiles.ts',
      longRunnerCoverage.ai_provider_profiles_blob,
    ],
    [
      'long-run AI post generator constants blob',
      'lib/ai-post-generator/constants.ts',
      longRunnerCoverage.ai_post_generator_constants_blob,
    ],
  ]) {
    requireEqual(
      gitValue(repositoryPath, ['rev-parse', `HEAD:${path}`], binding),
      expectedObject,
      binding,
    )
  }
}

function verifyGitIdentity(request, repositoryPath, frozenRoot) {
  verifyGitStorageContainment(repositoryPath, frozenRoot)
  requireEqual(
    gitValue(repositoryPath, ['rev-parse', 'HEAD'], 'commit'),
    request.candidate.commit,
    'Git commit',
  )
  requireEqual(
    gitValue(repositoryPath, ['rev-parse', 'HEAD^{tree}'], 'tree'),
    request.candidate.tree,
    'Git tree',
  )
  requireEqual(
    gitValue(
      repositoryPath,
      ['status', '--porcelain', '--untracked-files=all'],
      'worktree status',
    ),
    '',
    'Git worktree cleanliness',
  )
}

function verifySealInputs(request, repositoryPath, artifactsPath, frozenRoot) {
  verifyGitIdentity(request, repositoryPath, frozenRoot)
  requireEqual(
    request.github_evidence.quick.head_sha,
    request.candidate.commit,
    'quick CI head',
  )
  requireEqual(
    request.github_evidence.quick.head_tree,
    request.candidate.tree,
    'quick CI tree',
  )
  requireEqual(
    request.github_evidence.quick.test_files_passed,
    request.github_evidence.quick.test_files_total,
    'quick CI test-file count',
  )
  requireEqual(
    request.github_evidence.quick.tests_passed,
    request.github_evidence.quick.tests_total,
    'quick CI test count',
  )
  requireEqual(
    request.github_evidence.quick.build_static_pages,
    request.local_gates.open_next_build.static_pages,
    'quick CI build page count',
  )
  const lockfileSnapshot = requireBoundFile(
    repositoryPath,
    request.repository.lockfile.path,
    request.repository.lockfile.sha256,
    'lockfile',
  )
  const runbookSnapshot = requireBoundFile(
    repositoryPath,
    request.repository.runbook.path,
    request.repository.runbook.sha256,
    'runbook',
  )
  const cleanStartResetSnapshot = requireBoundFile(
    repositoryPath,
    request.clean_start.reset_sql.path,
    request.clean_start.reset_sql.sha256,
    'clean-start reset SQL',
  )

  requireNormalizedRelativePath(
    request.repository.migrations.directory,
    'migration directory',
  )
  const requestedMigrationDirectory = resolve(
    repositoryPath,
    request.repository.migrations.directory,
  )
  if (!pathWithin(repositoryPath, requestedMigrationDirectory)) {
    fail('Issue #23 reseal migration directory escapes its root')
  }
  const migrationDirectorySnapshot = captureDirectoryIdentity(
    requestedMigrationDirectory,
    'migration directory',
  )
  const migrationDirectory = migrationDirectorySnapshot.realPath
  if (!pathWithin(repositoryPath, migrationDirectory)) {
    fail('Issue #23 reseal migration directory real path escapes its root')
  }

  const migrationEntries = migrationMemberNames(migrationDirectory)
  const migrationSnapshots = migrationEntries
    .map((name) => captureRegularFile(
        migrationDirectory,
        name,
        `migration member ${name}`,
      ))
  if (
    JSON.stringify(migrationMemberNames(migrationDirectory))
    !== JSON.stringify(migrationEntries)
  ) {
    fail('Issue #23 reseal migration directory changed after validation')
  }
  migrationDirectorySnapshot.entries = migrationEntries
  const migrationMembers = migrationSnapshots.map((snapshot) => ({
    name: snapshot.relativePath,
    sha256: sha256(snapshot.bytes),
  }))
  requireEqual(
    sha256(JSON.stringify(migrationMembers)),
    request.repository.migrations.set_sha256,
    'migration-set SHA-256',
  )

  const migrationSnapshotByName = new Map(
    migrationSnapshots.map((snapshot) => [snapshot.relativePath, snapshot]),
  )
  const migrationSqlSnapshot = migrationSnapshotByName.get('001_initial_schema.sql')
  const migrationBaselineSnapshot = migrationSnapshotByName.get(
    '001_initial_schema.baseline.sql',
  )
  const remoteBaselineSnapshot = migrationSnapshotByName.get(
    '001_initial_schema.remote.baseline.sql',
  )
  if (!migrationSqlSnapshot || !migrationBaselineSnapshot || !remoteBaselineSnapshot) {
    fail('Issue #23 reseal migration 001 inputs must exist in the migration set')
  }
  requireEqual(
    sha256(migrationSqlSnapshot.bytes),
    request.repository.migrations.migration_001_sql_sha256,
    'migration 001 SQL SHA-256',
  )
  requireEqual(
    sha256(migrationBaselineSnapshot.bytes),
    request.repository.migrations.migration_001_baseline_sha256,
    'migration 001 baseline SHA-256',
  )
  requireEqual(
    sha256(Buffer.concat([
      migrationSqlSnapshot.bytes,
      Buffer.from('\0'),
      migrationBaselineSnapshot.bytes,
    ])),
    request.repository.migrations.migration_001_ledger_checksum,
    'migration 001 ledger checksum',
  )
  requireEqual(
    sha256(remoteBaselineSnapshot.bytes),
    request.repository.migrations.remote_baseline_companion_sha256,
    'remote baseline companion SHA-256',
  )

  const archiveSnapshot = requireBoundFile(
    artifactsPath,
    request.build.archive_path,
    request.build.archive_sha256,
    'build archive',
  )
  const workerSnapshot = requireBoundFile(
    artifactsPath,
    request.build.worker_path,
    request.build.worker_sha256,
    'worker',
  )
  const treeManifestSnapshot = requireBoundFile(
    artifactsPath,
    request.build.tree_manifest_path,
    request.build.tree_manifest_sha256,
    'tree manifest',
  )
  verifyBuildTree(
    archiveSnapshot.bytes,
    request.build.worker_path,
    request.build.worker_sha256,
    treeManifestSnapshot.bytes,
  )

  let lockfile
  try {
    lockfile = JSON.parse(lockfileSnapshot.bytes.toString('utf8'))
  } catch {
    fail('Issue #23 reseal lockfile must contain valid JSON')
  }
  const wrangler = lockfile?.packages?.['node_modules/wrangler']?.version
  const openNext = lockfile?.packages?.['node_modules/@opennextjs/cloudflare']?.version
  if (typeof wrangler !== 'string' || typeof openNext !== 'string') {
    fail('Issue #23 reseal lockfile is missing frozen tool versions')
  }
  return {
    migrationDirectory: migrationDirectorySnapshot,
    snapshots: [
      lockfileSnapshot,
      runbookSnapshot,
      cleanStartResetSnapshot,
      ...migrationSnapshots,
      archiveSnapshot,
      workerSnapshot,
      treeManifestSnapshot,
    ],
    toolVersions: { openNext, wrangler },
  }
}

function resealDocuments(request, toolVersions) {
  const preflight = {
    format: PREFLIGHT_FORMAT,
    state: 'sealed-local-only',
    produced_at: request.produced_at,
    candidate_id: request.candidate.commit,
    lockfile: {
      sha256: request.repository.lockfile.sha256,
      wrangler: toolVersions.wrangler,
      opennextjs_cloudflare: toolVersions.openNext,
    },
    migration_set_sha256: request.repository.migrations.set_sha256,
    runbook_sha256: request.repository.runbook.sha256,
    build: {
      archive_sha256: request.build.archive_sha256,
      worker_sha256: request.build.worker_sha256,
      tree_manifest_sha256: request.build.tree_manifest_sha256,
    },
    tests: {
      affected_phase_b: {
        state: 'passed',
        passed: request.local_gates.affected_phase_b.passed,
        failed: 0,
      },
      static_gates: 'passed',
      open_next_build: request.local_gates.open_next_build,
      canonical_long_migration_runner: {
        state: 'passed',
        passed: request.github_evidence.canonical_long_migration_runner.tests_passed,
        failed: 0,
      },
    },
    reviews: request.local_gates.reviews,
    production_counters_all_zero: true,
  }
  const preflightBytes = canonicalBytes(preflight)

  const approval = {
    format: CURRENT_APPROVAL_FORMAT,
    state: 'ready-for-fresh-production-authorization',
    produced_at: request.produced_at,
    delivery_mode: 'clean-start',
    clean_start: {
      decision: request.clean_start.decision,
      database_strategy: request.clean_start.database_strategy,
      reset_sql_sha256: request.clean_start.reset_sql.sha256,
      historical_data_export: request.clean_start.historical_data_export,
      double_restore: request.clean_start.double_restore,
      historical_baseline_queries: request.clean_start.historical_baseline_queries,
    },
    candidate_id: request.candidate.commit,
    local_preflight_candidate_sha256: sha256(preflightBytes),
    lockfile_sha256: request.repository.lockfile.sha256,
    migration_set_sha256: request.repository.migrations.set_sha256,
    runbook_sha256: request.repository.runbook.sha256,
    build_archive_sha256: request.build.archive_sha256,
    worker_sha256: request.build.worker_sha256,
    tree_manifest_sha256: request.build.tree_manifest_sha256,
    expected_baseline: request.expected_production_baseline,
    scope: [
      'one candidate-bound in-place D1 reset',
      'one empty D1 proof and plan',
      'one version upload',
      'migrations 001-006',
      'one 100% traffic deployment',
      'status-only smoke and reconciliation',
      'rollback and controls proof',
      'T0 event acceptance',
    ],
    old_lineages_invalid: true,
  }
  const approvalBytes = canonicalBytes(approval)

  const preCas = {
    format: CURRENT_PRE_CAS_FORMAT,
    state: 'sealed-local-only',
    produced_at: request.produced_at,
    executor_started: false,
    production_authorization_granted: false,
    formal_pre_migration_candidate_created: false,
    immutable_phase_b_bindings: {
      candidateId: request.candidate.commit,
      approvalPacketSha256: sha256(approvalBytes),
      buildArchiveSha256: request.build.archive_sha256,
      baselineDeploymentId: request.expected_production_baseline.deployment_id,
      baselineVersionId: request.expected_production_baseline.version_id,
      baselineD1DatabaseId: request.expected_production_baseline.d1_database_id,
      deliveryMode: 'clean-start',
      cleanStartResetSqlSha256: request.clean_start.reset_sql.sha256,
      historicalDataDisposition: {
        productionExport: request.clean_start.historical_data_export,
        doubleRestore: request.clean_start.double_restore,
        historicalBaselineQueries: request.clean_start.historical_baseline_queries,
      },
    },
    migration_set_sha256: request.repository.migrations.set_sha256,
    stage_counts: Object.fromEntries(PHASE_B_STAGES.map((stage) => [stage, 0])),
    historical_data_disposition: {
      production_export: request.clean_start.historical_data_export,
      double_restore: request.clean_start.double_restore,
      historical_baseline_queries: request.clean_start.historical_baseline_queries,
    },
    start_conditions: {
      fresh_candidate_bound_authorization_required: true,
      no_prior_lineage_reuse: true,
    },
  }
  const preCasBytes = canonicalBytes(preCas)

  const manifest = {
    format: CURRENT_MANIFEST_FORMAT,
    state: 'sealed-local-only',
    produced_at: request.produced_at,
    delivery_mode: 'clean-start',
    clean_start_reset_sql_sha256: request.clean_start.reset_sql.sha256,
    historical_data_disposition: {
      production_export: request.clean_start.historical_data_export,
      double_restore: request.clean_start.double_restore,
      historical_baseline_queries: request.clean_start.historical_baseline_queries,
    },
    candidate_id: request.candidate.commit,
    local_preflight_candidate_sha256: sha256(preflightBytes),
    approval_packet_sha256: sha256(approvalBytes),
    pre_cas_bindings_sha256: sha256(preCasBytes),
    build_archive_sha256: request.build.archive_sha256,
    migration_set_sha256: request.repository.migrations.set_sha256,
    formal_pre_migration_candidate_created: false,
    production_counters_all_zero: true,
    github_ci: 'pending',
  }

  return new Map([
    ['preflight-candidate.json', preflightBytes],
    ['approval-packet.json', approvalBytes],
    ['pre-cas-bindings.json', preCasBytes],
    ['package-manifest.json', canonicalBytes(manifest)],
  ])
}

function validateInputEvidenceBindings({
  artifacts,
  evidenceDocument,
  repository,
  requestDocument,
}) {
  const evidence = evidenceDocument.value
  requireEqual(evidence.format, INPUT_EVIDENCE_FORMAT, 'input-evidence format')

  const frozenRoot = requireDirectory(
    evidence.frozen_tree.root_path,
    'frozen evidence root',
  )
  requireEqual(frozenRoot, evidence.frozen_tree.root_path, 'frozen evidence root realpath')
  const frozenSnapshot = requireDirectory(
    evidence.frozen_tree.snapshot_path,
    'frozen snapshot',
  )
  requireEqual(frozenSnapshot, repository, 'frozen snapshot path')
  requireEqual(evidence.contracts.build.artifacts_path, artifacts, 'frozen artifacts path')
  if (!pathAtOrWithin(frozenRoot, repository) || !pathAtOrWithin(frozenRoot, artifacts)) {
    fail('Issue #23 reseal repository and artifacts must be inside the frozen evidence root')
  }
  requireEqual(
    evidence.frozen_tree.manifest_path,
    evidenceDocument.snapshot.requestedPath,
    'input-evidence manifest path',
  )
  requireEqual(
    evidenceDocument.snapshot.realPath,
    evidenceDocument.snapshot.requestedPath,
    'input-evidence manifest realpath',
  )
  requireEqual(
    evidence.contracts.reseal_request.path,
    requestDocument.snapshot.requestedPath,
    'reseal request path',
  )
  requireEqual(
    requestDocument.snapshot.realPath,
    requestDocument.snapshot.requestedPath,
    'reseal request realpath',
  )
  if (
    !pathAtOrWithin(frozenRoot, evidenceDocument.snapshot.realPath)
    || !pathAtOrWithin(frozenRoot, requestDocument.snapshot.realPath)
  ) {
    fail('Issue #23 reseal manifest and request must be inside the frozen evidence root')
  }
  requireMode(frozenRoot, evidence.frozen_tree.root_mode, 'frozen evidence root')
  requireMode(frozenSnapshot, evidence.frozen_tree.snapshot_mode, 'frozen snapshot')
  requireMode(
    evidenceDocument.snapshot.realPath,
    evidence.frozen_tree.manifest_mode,
    'input-evidence manifest',
  )
  requireMode(
    requestDocument.snapshot.realPath,
    evidence.frozen_tree.request_mode,
    'reseal request',
  )

  requireEqual(
    evidence.contracts.reseal_request.format,
    requestDocument.value.format,
    'input-evidence reseal request format',
  )
  requireEqual(
    evidence.contracts.reseal_request.sha256,
    requestDocument.sha256,
    'input-evidence reseal request SHA-256',
  )
  requireEqual(
    evidence.repository.candidate_commit,
    requestDocument.value.candidate.commit,
    'input-evidence candidate commit',
  )
  requireEqual(
    evidence.repository.candidate_tree,
    requestDocument.value.candidate.tree,
    'input-evidence candidate tree',
  )
  requireEqual(
    evidence.github.main_push.run_id,
    requestDocument.value.github_evidence.quick.run_id,
    'input-evidence quick CI run',
  )
  requireEqual(
    evidence.github.main_push.head_sha,
    requestDocument.value.github_evidence.quick.head_sha,
    'input-evidence quick CI head',
  )
  requireEqual(
    evidence.github.main_push.status,
    requestDocument.value.github_evidence.quick.status,
    'input-evidence quick CI status',
  )
  requireEqual(
    evidence.github.main_push.conclusion,
    requestDocument.value.github_evidence.quick.conclusion,
    'input-evidence quick CI conclusion',
  )

  verifyGitStorageContainment(repository, frozenRoot)
  const originUrl = gitValue(
    repository,
    ['config', '--get', 'remote.origin.url'],
    'origin URL',
  )
  requireEqual(originUrl, evidence.repository.origin_url, 'canonical origin URL')
  const parentCommits = gitValue(
    repository,
    ['rev-list', '--parents', '-n', '1', 'HEAD'],
    'parent commits',
  ).split(/\s+/u).slice(1)
  requireEqual(
    JSON.stringify(parentCommits),
    JSON.stringify(evidence.repository.parent_commits),
    'candidate parent commits',
  )

  const schemaSnapshot = requireBoundFile(
    repository,
    evidence.contracts.input_evidence_schema.path,
    evidence.contracts.input_evidence_schema.sha256,
    'input-evidence schema',
  )
  const repositorySchemaBytes = schemaSnapshot.bytes
  const toolSchemaBytes = readFileSync(SCHEMA_URLS.get(INPUT_EVIDENCE_FORMAT))
  if (!repositorySchemaBytes.equals(toolSchemaBytes)) {
    fail('Issue #23 reseal input-evidence schema differs from the running repository tool')
  }
  const localResealRunbookSnapshot = requireBoundFile(
    repository,
    evidence.contracts.local_reseal_runbook.path,
    evidence.contracts.local_reseal_runbook.sha256,
    'local reseal runbook',
  )
  requireEqual(
    evidence.contracts.phase_b_runbook.sha256,
    requestDocument.value.repository.runbook.sha256,
    'input-evidence Phase B runbook SHA-256',
  )
  requireEqual(
    evidence.contracts.phase_b_runbook.path,
    requestDocument.value.repository.runbook.path,
    'input-evidence Phase B runbook path',
  )

  for (const [binding, actual, expected] of [
    ['build archive path', evidence.contracts.build.archive_path, requestDocument.value.build.archive_path],
    ['build archive SHA-256', evidence.contracts.build.archive_sha256, requestDocument.value.build.archive_sha256],
    ['worker path', evidence.contracts.build.worker_path, requestDocument.value.build.worker_path],
    ['worker SHA-256', evidence.contracts.build.worker_sha256, requestDocument.value.build.worker_sha256],
    ['tree manifest path', evidence.contracts.build.tree_manifest_path, requestDocument.value.build.tree_manifest_path],
    ['tree manifest SHA-256', evidence.contracts.build.tree_manifest_sha256, requestDocument.value.build.tree_manifest_sha256],
  ]) {
    requireEqual(actual, expected, `input-evidence ${binding}`)
  }

  const denylistPaths = evidence.lineage_policy.denylist.map((entry) => entry.path)
  if (new Set(denylistPaths).size !== denylistPaths.length) {
    fail('Issue #23 reseal input-evidence denylist paths must be unique')
  }
  const boundInputPaths = [
    frozenRoot,
    repository,
    artifacts,
    evidenceDocument.snapshot.realPath,
    requestDocument.snapshot.realPath,
  ]
  for (const deniedPath of denylistPaths) {
    if (boundInputPaths.some((boundPath) => (
      pathAtOrWithin(deniedPath, boundPath)
      || pathAtOrWithin(boundPath, deniedPath)
    ))) {
      fail('Issue #23 reseal terminal lineage cannot be an input dependency')
    }
    if (requestDocument.raw.includes(Buffer.from(deniedPath))) {
      fail('Issue #23 reseal request cannot depend on a terminal lineage')
    }
  }

  return {
    root: frozenRoot,
    snapshots: [schemaSnapshot, localResealRunbookSnapshot],
  }
}

function captureFrozenTree(evidence, frozenRoot) {
  const snapshot = scanFrozenTree(frozenRoot)
  for (const [name, actual] of Object.entries(snapshot.counts)) {
    requireEqual(
      actual,
      evidence.frozen_tree[name],
      `frozen tree ${name}`,
    )
  }
  return {
    counts: snapshot.counts,
    identitySha256: snapshot.identitySha256,
    root: frozenRoot,
  }
}

function verifyFrozenTreeSnapshot(snapshot) {
  const current = scanFrozenTree(snapshot.root)
  if (
    JSON.stringify(current.counts) !== JSON.stringify(snapshot.counts)
    || current.identitySha256 !== snapshot.identitySha256
  ) {
    fail('Issue #23 reseal frozen tree changed after validation')
  }
}

function loadSealContext(inputPath, repositoryPath, artifactsPath) {
  requireAbsolutePath(inputPath, 'input')
  const repositoryDirectory = captureDirectoryIdentity(repositoryPath, 'repository')
  const artifactsDirectory = captureDirectoryIdentity(
    artifactsPath,
    'artifacts directory',
  )
  const repository = repositoryDirectory.realPath
  const artifacts = artifactsDirectory.realPath
  const evidencePath = resolve(dirname(inputPath), INPUT_EVIDENCE_FILE_NAME)
  const evidenceDocument = readValidatedDocument(evidencePath, {
    label: 'input-evidence manifest',
  })
  const requestDocument = readValidatedDocument(inputPath, {
    label: 'request document',
  })
  if (HISTORICAL_REQUEST_FORMATS.has(requestDocument.value.format)) {
    fail('Issue #23 historical reseal request is stale for current sealing')
  }
  requireEqual(requestDocument.value.format, REQUEST_FORMAT, 'request format')
  const inputEvidence = validateInputEvidenceBindings({
    artifacts,
    evidenceDocument,
    repository,
    requestDocument,
  })
  const sealInputs = verifySealInputs(
    requestDocument.value,
    repository,
    artifacts,
    inputEvidence.root,
  )
  const frozenTree = captureFrozenTree(evidenceDocument.value, inputEvidence.root)
  return {
    directories: [repositoryDirectory, artifactsDirectory],
    evidenceDocument,
    frozenTree,
    migrationDirectory: sealInputs.migrationDirectory,
    repository,
    requestDocument,
    snapshots: [
      evidenceDocument.snapshot,
      requestDocument.snapshot,
      ...inputEvidence.snapshots,
      ...sealInputs.snapshots,
    ],
    toolVersions: sealInputs.toolVersions,
  }
}

function verifySealContextUnchanged(context) {
  for (const directory of context.directories) verifyDirectoryIdentity(directory)
  verifyGitIdentity(
    context.requestDocument.value,
    context.repository,
    context.frozenTree.root,
  )
  verifyLongRunnerCoverage(
    context.requestDocument.value,
    context.repository,
  )
  verifyMigrationDirectorySnapshot(context.migrationDirectory)
  verifyFileSnapshots(context.snapshots)
  verifyMigrationDirectorySnapshot(context.migrationDirectory)
  verifyFrozenTreeSnapshot(context.frozenTree)
}

export function prepareInputEvidence({ inputPath, repositoryPath, artifactsPath }) {
  const context = loadSealContext(inputPath, repositoryPath, artifactsPath)
  verifySealContextUnchanged(context)
  return {
    candidate_id: context.requestDocument.value.candidate.commit,
    format: 'blogman-issue-23-input-evidence-preparation/v1',
    input_evidence_manifest_sha256: context.evidenceDocument.sha256,
    production_authorization_granted: false,
    production_counters_all_zero: true,
    state: 'prepared-local-only',
  }
}

export function sealPackage({ inputPath, repositoryPath, artifactsPath, outputPath }) {
  const context = loadSealContext(inputPath, repositoryPath, artifactsPath)
  requireAbsolutePath(outputPath, 'output')
  if (pathAtOrWithin(context.frozenTree.root, outputPath)) {
    fail('Issue #23 reseal output must be outside the frozen evidence root')
  }
  if (outputPath === context.repository || pathWithin(context.repository, outputPath)) {
    fail('Issue #23 reseal output must be outside the repository')
  }
  const {
    finalOutputPath,
    outputParent,
    reservation,
  } = reserveOutputParent(
    outputPath,
    context.repository,
    context.frozenTree.root,
  )
  let stagingPath
  try {
    if (pathEntryExists(finalOutputPath)) fail('Issue #23 reseal output must be fresh')
    stagingPath = mkdtempSync(join(outputParent, `.${basename(outputPath)}.tmp-`))
    chmodSync(stagingPath, 0o700)
    verifyLongRunnerCoverage(
      context.requestDocument.value,
      context.repository,
    )
    const documents = resealDocuments(
      context.requestDocument.value,
      context.toolVersions,
    )
    for (const [name, bytes] of documents) {
      const filePath = join(stagingPath, name)
      writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 })
      chmodSync(filePath, 0o400)
    }
    const sealedPackageSnapshot = readPackageSnapshot(stagingPath)
    verifyPackageSnapshot(sealedPackageSnapshot)
    const validation = sealedPackageSnapshot.summary
    verifySealContextUnchanged(context)
    verifyPackageSnapshot(sealedPackageSnapshot)
    if (pathEntryExists(finalOutputPath)) {
      fail('Issue #23 reseal output must remain fresh until rename')
    }
    renameSync(stagingPath, finalOutputPath)
    return {
      candidate_id: context.requestDocument.value.candidate.commit,
      format: 'blogman-issue-23-local-reseal-result/v1',
      package_manifest_sha256: validation.package_manifest_sha256,
      production_authorization_granted: false,
      production_counters_all_zero: true,
      state: 'sealed-local-only',
    }
  } catch (error) {
    const cleanupErrors = []
    if (stagingPath && pathEntryExists(stagingPath)) {
      try {
        rmSync(stagingPath, { recursive: true, force: false })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    try {
      removeOwnedEmptyReservation(reservation)
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    throw appendCleanupErrors(error, cleanupErrors)
  }
}

export function verifyPackage({
  inputPath,
  repositoryPath,
  artifactsPath,
  packagePath,
}) {
  requireAbsolutePath(packagePath, 'package')
  const context = loadSealContext(inputPath, repositoryPath, artifactsPath)
  verifyLongRunnerCoverage(
    context.requestDocument.value,
    context.repository,
  )
  const packageSnapshot = readPackageSnapshot(packagePath)
  verifyPackageSnapshot(packageSnapshot)
  if (packageSnapshot.contract !== 'current-clean-start-t0') {
    fail('Issue #23 historical reseal package is stale for current verification')
  }
  const validation = packageSnapshot.summary
  const expectedDocuments = resealDocuments(
    context.requestDocument.value,
    context.toolVersions,
  )
  for (const [name, expectedBytes] of expectedDocuments) {
    if (!packageSnapshot.documents.get(name).raw.equals(expectedBytes)) {
      fail(`Issue #23 reseal package does not match its ${name} seal input`)
    }
  }
  verifyPackageSnapshot(packageSnapshot)
  verifySealContextUnchanged(context)
  verifyPackageSnapshot(packageSnapshot)
  return {
    candidate_id: context.requestDocument.value.candidate.commit,
    format: 'blogman-issue-23-local-reseal-verification/v1',
    package_manifest_sha256: validation.package_manifest_sha256,
    production_authorization_granted: false,
    production_counters_all_zero: true,
    state: 'verified-local-only',
  }
}

function readPackageSnapshot(packagePath) {
  const requestedPackagePath = resolve(packagePath)
  const directory = captureDirectoryIdentity(requestedPackagePath, 'package directory')
  const realPackagePath = directory.realPath
  const entries = readdirSync(realPackagePath).sort()
  if (
    JSON.stringify(entries)
    !== JSON.stringify(PACKAGE_FILE_NAMES)
  ) {
    fail('Issue #23 reseal package must contain exactly the four documents')
  }

  const preflight = readValidatedDocument(
    resolve(realPackagePath, 'preflight-candidate.json'),
    { root: realPackagePath },
  )
  const approval = readValidatedDocument(
    resolve(realPackagePath, 'approval-packet.json'),
    { root: realPackagePath },
  )
  const preCas = readValidatedDocument(
    resolve(realPackagePath, 'pre-cas-bindings.json'),
    { root: realPackagePath },
  )
  const manifest = readValidatedDocument(
    resolve(realPackagePath, 'package-manifest.json'),
    { root: realPackagePath },
  )
  if (
    JSON.stringify(readdirSync(realPackagePath).sort())
    !== JSON.stringify(entries)
  ) {
    fail('Issue #23 reseal package directory changed after validation')
  }
  const p = preflight.value
  const a = approval.value
  const c = preCas.value
  const m = manifest.value
  const formats = [a.format, c.format, m.format]
  const historicalV2 = JSON.stringify(formats) === JSON.stringify([
    'blogman-issue-23-approval-packet/v2',
    'blogman-issue-23-pre-cas-bindings/v2',
    'blogman-issue-23-package-manifest/v2',
  ])
  const historicalV3 = JSON.stringify(formats) === JSON.stringify([
    'blogman-issue-23-approval-packet/v3',
    'blogman-issue-23-pre-cas-bindings/v3',
    'blogman-issue-23-package-manifest/v3',
  ])
  const historical = historicalV2 || historicalV3
  const current = JSON.stringify(formats) === JSON.stringify([
    CURRENT_APPROVAL_FORMAT,
    CURRENT_PRE_CAS_FORMAT,
    CURRENT_MANIFEST_FORMAT,
  ])
  if (!historical && !current) {
    fail('Issue #23 reseal package mixes historical and current contract versions')
  }

  requireEqual(a.produced_at, p.produced_at, 'produced_at')
  requireEqual(c.produced_at, p.produced_at, 'produced_at')
  requireEqual(m.produced_at, p.produced_at, 'produced_at')
  requireEqual(a.candidate_id, p.candidate_id, 'candidate')
  requireEqual(c.immutable_phase_b_bindings.candidateId, p.candidate_id, 'candidate')
  requireEqual(m.candidate_id, p.candidate_id, 'candidate')
  requireEqual(a.local_preflight_candidate_sha256, preflight.sha256, 'preflight SHA-256')
  requireEqual(m.local_preflight_candidate_sha256, preflight.sha256, 'preflight SHA-256')
  requireEqual(c.immutable_phase_b_bindings.approvalPacketSha256, approval.sha256, 'approval SHA-256')
  requireEqual(m.approval_packet_sha256, approval.sha256, 'approval SHA-256')
  requireEqual(m.pre_cas_bindings_sha256, preCas.sha256, 'PRE-CAS SHA-256')
  requireEqual(a.lockfile_sha256, p.lockfile.sha256, 'lockfile SHA-256')
  requireEqual(a.migration_set_sha256, p.migration_set_sha256, 'migration-set SHA-256')
  requireEqual(c.migration_set_sha256, p.migration_set_sha256, 'migration-set SHA-256')
  requireEqual(m.migration_set_sha256, p.migration_set_sha256, 'migration-set SHA-256')
  requireEqual(a.runbook_sha256, p.runbook_sha256, 'runbook SHA-256')
  requireEqual(a.build_archive_sha256, p.build.archive_sha256, 'build archive SHA-256')
  requireEqual(c.immutable_phase_b_bindings.buildArchiveSha256, p.build.archive_sha256, 'build archive SHA-256')
  requireEqual(m.build_archive_sha256, p.build.archive_sha256, 'build archive SHA-256')
  requireEqual(a.worker_sha256, p.build.worker_sha256, 'worker SHA-256')
  requireEqual(a.tree_manifest_sha256, p.build.tree_manifest_sha256, 'tree manifest SHA-256')
  requireEqual(
    c.immutable_phase_b_bindings.baselineDeploymentId,
    a.expected_baseline.deployment_id,
    'baseline deployment',
  )
  requireEqual(
    c.immutable_phase_b_bindings.baselineVersionId,
    a.expected_baseline.version_id,
    'baseline version',
  )
  if (!historicalV2) {
    requireEqual(
      c.immutable_phase_b_bindings.baselineD1DatabaseId,
      a.expected_baseline.d1_database_id,
      'baseline D1 database',
    )
  }
  if (current) {
    requireEqual(a.delivery_mode, 'clean-start', 'delivery mode')
    requireEqual(c.immutable_phase_b_bindings.deliveryMode, a.delivery_mode, 'delivery mode')
    requireEqual(m.delivery_mode, a.delivery_mode, 'delivery mode')
    requireEqual(
      c.immutable_phase_b_bindings.cleanStartResetSqlSha256,
      a.clean_start.reset_sql_sha256,
      'clean-start reset SQL',
    )
    requireEqual(
      m.clean_start_reset_sql_sha256,
      a.clean_start.reset_sql_sha256,
      'clean-start reset SQL',
    )
    requireEqual(
      JSON.stringify(c.immutable_phase_b_bindings.historicalDataDisposition),
      JSON.stringify({
        productionExport: a.clean_start.historical_data_export,
        doubleRestore: a.clean_start.double_restore,
        historicalBaselineQueries: a.clean_start.historical_baseline_queries,
      }),
      'historical-data disposition',
    )
    requireEqual(
      JSON.stringify(c.historical_data_disposition),
      JSON.stringify({
        production_export: a.clean_start.historical_data_export,
        double_restore: a.clean_start.double_restore,
        historical_baseline_queries: a.clean_start.historical_baseline_queries,
      }),
      'historical-data disposition',
    )
    requireEqual(
      JSON.stringify(m.historical_data_disposition),
      JSON.stringify({
        production_export: a.clean_start.historical_data_export,
        double_restore: a.clean_start.double_restore,
        historical_baseline_queries: a.clean_start.historical_baseline_queries,
      }),
      'historical-data disposition',
    )
  }

  return {
    directory: {
      label: directory.label,
      entries,
      realPath: realPackagePath,
      requestedPath: requestedPackagePath,
    },
    contract: historical ? 'historical-read-only' : 'current-clean-start-t0',
    documents: new Map([
      ['preflight-candidate.json', preflight],
      ['approval-packet.json', approval],
      ['pre-cas-bindings.json', preCas],
      ['package-manifest.json', manifest],
    ]),
    snapshots: [
      preflight.snapshot,
      approval.snapshot,
      preCas.snapshot,
      manifest.snapshot,
    ],
    summary: {
      candidate_id: p.candidate_id,
      format: 'blogman-issue-23-reseal-package-validation/v1',
      package_manifest_sha256: manifest.sha256,
      ...(historical ? { acceptance_authority: false } : {}),
      state: historical ? 'valid-historical' : 'valid',
    },
  }
}

export function validatePackage(packagePath) {
  const packageSnapshot = readPackageSnapshot(packagePath)
  verifyPackageSnapshot(packageSnapshot)
  return packageSnapshot.summary
}

export function loadCurrentResealPackage(packagePath) {
  const packageSnapshot = readPackageSnapshot(packagePath)
  verifyPackageSnapshot(packageSnapshot)
  if (packageSnapshot.contract !== 'current-clean-start-t0') {
    fail('Issue #23 reseal package is stale for the current clean-start contract')
  }
  return packageSnapshot
}

function runCli(args) {
  if (args.length === 3 && args[0] === 'validate' && args[1] === '--document') {
    return validateDocument(resolve(args[2]))
  }
  if (args.length === 3 && args[0] === 'validate' && args[1] === '--package') {
    return validatePackage(resolve(args[2]))
  }
  if (args.length === 7 && args[0] === 'verify-build-directory') {
    const options = Object.fromEntries([
      [args[1], args[2]],
      [args[3], args[4]],
      [args[5], args[6]],
    ])
    if (
      Object.keys(options).length === 3
      && options['--archive']
      && options['--directory']
      && options['--archive-sha256']
    ) {
      return verifyBuildDirectory({
        archivePath: resolve(options['--archive']),
        directoryPath: resolve(options['--directory']),
        expectedArchiveSha256: options['--archive-sha256'],
      })
    }
  }
  if (args.length === 7 && args[0] === 'prepare') {
    const options = Object.fromEntries([
      [args[1], args[2]],
      [args[3], args[4]],
      [args[5], args[6]],
    ])
    if (
      Object.keys(options).length === 3
      && options['--input']
      && options['--repo']
      && options['--artifacts']
    ) {
      return prepareInputEvidence({
        inputPath: options['--input'],
        repositoryPath: options['--repo'],
        artifactsPath: options['--artifacts'],
      })
    }
  }
  if (args.length === 9 && args[0] === 'seal') {
    const options = Object.fromEntries([
      [args[1], args[2]],
      [args[3], args[4]],
      [args[5], args[6]],
      [args[7], args[8]],
    ])
    if (
      Object.keys(options).length === 4
      && options['--input']
      && options['--repo']
      && options['--artifacts']
      && options['--output']
    ) {
      return sealPackage({
        inputPath: options['--input'],
        repositoryPath: options['--repo'],
        artifactsPath: options['--artifacts'],
        outputPath: options['--output'],
      })
    }
  }
  if (args.length === 9 && args[0] === 'verify') {
    const options = Object.fromEntries([
      [args[1], args[2]],
      [args[3], args[4]],
      [args[5], args[6]],
      [args[7], args[8]],
    ])
    if (
      Object.keys(options).length === 4
      && options['--input']
      && options['--repo']
      && options['--artifacts']
      && options['--package']
    ) {
      return verifyPackage({
        inputPath: options['--input'],
        repositoryPath: options['--repo'],
        artifactsPath: options['--artifacts'],
        packagePath: options['--package'],
      })
    }
  }
  fail('Usage: issue-23-reseal validate (--document <path> | --package <path>) | prepare --input <path> --repo <path> --artifacts <path> | verify-build-directory --archive <path> --directory <path> --archive-sha256 <sha256> | seal --input <path> --repo <path> --artifacts <path> --output <path> | verify --input <path> --repo <path> --artifacts <path> --package <path>')
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`)
  } catch (error) {
    process.stderr.write(`issue-23-reseal: ${error.message}\n`)
    process.exitCode = 1
  }
}
