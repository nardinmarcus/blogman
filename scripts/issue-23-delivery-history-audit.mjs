import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path'

const MAX_DOCUMENT_BYTES = 1024 * 1024
const PREFLIGHT_FORMAT = 'blogman-local-preflight-candidate/v2'
const INPUT_EVIDENCE_FORMAT = 'blogman-issue-23-input-evidence-manifest/v2'
const REQUEST_FORMAT = 'blogman-issue-23-local-reseal-request/v3'
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

export function auditHistoricalDocument(documentPath) {
  const document = readValidatedDocument(documentPath)
  return {
    acceptance_authority: false,
    format: document.value.format,
    sha256: document.sha256,
    state: 'valid-historical',
  }
}

function requireEqual(actual, expected, binding) {
  if (actual !== expected) fail(`Issue #23 reseal package has a mismatched ${binding} binding`)
}

function requireAbsolutePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail(`Issue #23 reseal ${label} must be an absolute normalized path`)
  }
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

function pathWithin(root, child) {
  const childRelativePath = relative(root, child)
  return childRelativePath !== ''
    && childRelativePath !== '..'
    && !childRelativePath.startsWith('../')
    && !isAbsolute(childRelativePath)
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
    contract: 'historical-read-only',
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
      acceptance_authority: false,
      state: 'valid-historical',
    },
  }
}

export function auditHistoricalPackage(packagePath) {
  const packageSnapshot = readPackageSnapshot(packagePath)
  verifyPackageSnapshot(packageSnapshot)
  return packageSnapshot.summary
}

function runCli(args) {
  if (args.length === 3 && args[0] === 'audit' && args[1] === '--document') {
    return auditHistoricalDocument(resolve(args[2]))
  }
  if (args.length === 3 && args[0] === 'audit' && args[1] === '--package') {
    return auditHistoricalPackage(resolve(args[2]))
  }
  fail('Usage: issue-23-delivery-history-audit audit (--document <path> | --package <path>)')
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`)
  } catch (error) {
    process.stderr.write(`issue-23-delivery-history-audit: ${error.message}\n`)
    process.exitCode = 1
  }
}
