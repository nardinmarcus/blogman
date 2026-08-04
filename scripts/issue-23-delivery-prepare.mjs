import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { runLocalRehearsal } from './issue-23-delivery-rehearsal.mjs'

const MANIFEST_SCHEMA_URL = new URL(
  '../schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
  import.meta.url,
)
const MANIFEST_SCHEMA = JSON.parse(readFileSync(MANIFEST_SCHEMA_URL, 'utf8'))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CANONICAL_MANIFEST_FORMAT = 'blogman-issue-23-canonical-frozen-manifest/v1'

export const DEFAULT_STAGE_POLICY = Object.freeze([
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

const EXPECTED_FROZEN_PRECONDITIONS = Object.freeze([
  'repository.commit',
  'repository.tree',
  'ci.head_sha',
  'ci.tree',
  'artifact.file_tree.sha256',
  'migration.catalog.sha256',
  'target.baseline',
])
const EXPECTED_OBSERVATIONS = Object.freeze([
  'target.deployment_id',
  'target.version_id',
  'target.traffic',
  'rehearsal.receipt_sha256',
])
const EXPECTED_EVIDENCE_EXCLUSIONS = Object.freeze([
  'secret_values',
  'raw_private_adapter_output',
  'sql_bodies',
  'private_operator_paths',
])
const EXPECTED_MIGRATIONS = Object.freeze(['001', '002', '003', '004', '005', '006'])
const ARTIFACT_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u
const ARTIFACT_EXCLUDED_PATH_PATTERN = /(^|\/)(?:private|operator|secret|credential|tmp)(?:\/|$)/iu

const CONFIG_SCHEMA = Object.freeze({
  ...MANIFEST_SCHEMA,
  required: MANIFEST_SCHEMA.required.filter((key) => key !== 'format'),
  properties: Object.fromEntries(
    Object.entries(MANIFEST_SCHEMA.properties).filter(([key]) => key !== 'format'),
  ),
})

function fail(message) {
  throw new Error(`Canonical Frozen Manifest: ${message}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateSchemaValue(value, schema, path = '$') {
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    fail(`${path} must equal its schema constant`)
  }

  if (schema.enum && !schema.enum.includes(value)) {
    fail(`${path} has an invalid value`)
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) fail(`${path} must be an object`)
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

  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(`${path} must be an array`)
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`${path} has too few items`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`${path} has too many items`)
    }
    if (schema.items && schema.items !== false) {
      value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`))
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

  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail(`${path} must be an integer`)
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`${path} is below its minimum`)
    }
    return
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    fail(`${path} must be a boolean`)
  }
}

function orderBySchema(value, schema) {
  if (schema.type === 'object') {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key]) => Object.hasOwn(value, key))
        .map(([key, childSchema]) => [key, orderBySchema(value[key], childSchema)]),
    )
  }
  if (schema.type === 'array') {
    return value.map((item) => orderBySchema(item, schema.items))
  }
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function command(repositoryPath, name, args) {
  try {
    return execFileSync(name, args, { cwd: repositoryPath, encoding: 'utf8' }).trim()
  } catch (error) {
    fail(`could not resolve ${name}: ${error.message}`)
  }
}

function resolveExecutable(repositoryPath, name) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  const executable = command(repositoryPath, lookup, [name]).split(/\r?\n/u)[0]?.trim()
  if (!executable) fail(`could not resolve ${name} executable path`)
  return executable
}

function resolveFile(repositoryPath, path, label, includeBytes = false) {
  const lexicalRoot = resolve(repositoryPath)
  const absolute = resolve(lexicalRoot, path)
  if (absolute !== lexicalRoot && !absolute.startsWith(`${lexicalRoot}${sep}`)) {
    fail(`${label} escapes repository`)
  }

  let canonicalRoot
  let canonicalTarget
  try {
    canonicalRoot = realpathSync(lexicalRoot)
    canonicalTarget = realpathSync(absolute)
  } catch {
    fail(`${label} could not be resolved`)
  }
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    fail(`${label} escapes repository`)
  }

  try {
    const bytes = readFileSync(canonicalTarget)
    return includeBytes
      ? { path, sha256: sha256(bytes), bytes: statSync(canonicalTarget).size }
      : { path, sha256: sha256(bytes) }
  } catch {
    fail(`${label} could not be resolved`)
  }
}

function enumerateArtifactPaths(repositoryPath, configuredFiles) {
  const paths = command(repositoryPath, 'git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
    .split('\0')
    .filter((path) => path.length > 0)
    .filter((path) => ARTIFACT_PATH_PATTERN.test(path))
    .filter((path) => !ARTIFACT_EXCLUDED_PATH_PATTERN.test(path))
    .sort()
  const available = new Set(paths)
  for (const file of configuredFiles) {
    if (!available.has(file.path)) {
      fail(`artifact file ${file.path} is not in the complete public artifact tree`)
    }
  }
  return paths
}

function resolveRepositoryFacts(repositoryPath) {
  const commit = command(repositoryPath, 'git', ['rev-parse', 'HEAD'])
  const tree = command(repositoryPath, 'git', ['rev-parse', 'HEAD^{tree}'])
  const status = command(repositoryPath, 'git', ['status', '--porcelain'])
  const remote = command(repositoryPath, 'git', ['remote', 'get-url', 'origin'])
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree) || status !== '') {
    fail('resolved repository identity is not a valid Git commit/tree')
  }
  if (remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('resolved repository remote is not canonical')
  }
  return { commit, tree, clean: true }
}

function resolveCiFacts(repositoryPath, config, repository) {
  const rows = JSON.parse(command(repositoryPath, 'gh', [
    'run', 'list', '--repo', 'nardinmarcus/blogman', '--workflow', config.ci.workflow,
    '--commit', repository.commit, '--json',
    'databaseId,headSha,status,conclusion,event,attempt', '--limit', '20',
  ]))
  const run = rows.find((candidate) => (
    candidate.headSha === repository.commit
      && candidate.status === 'completed'
      && candidate.conclusion === 'success'
  ))
  if (!run) fail('resolved CI identity has no successful exact-head run')
  return {
    ...config.ci,
    run_id: run.databaseId,
    attempt: run.attempt,
    event: run.event,
    head_sha: repository.commit,
    tree: repository.tree,
    conclusion: run.conclusion,
  }
}

function resolveTargetFacts(target) {
  if (!isRecord(target) || !isRecord(target.baseline)
    || target.baseline.d1_database_id !== target.d1_database_id
    || target.baseline.traffic?.length !== 1
    || target.baseline.traffic[0]?.version_id !== target.baseline.version_id
    || target.baseline.traffic[0]?.percentage !== 100) {
    fail('resolved target facts are incomplete or inconsistent')
  }
  return structuredClone(target)
}

function resolveFacts(config, {
  repositoryPath = REPO_ROOT,
  ciResolver = resolveCiFacts,
  rehearsalRunner = runLocalRehearsal,
  targetResolver = resolveTargetFacts,
  repositoryResolver = resolveRepositoryFacts,
  productionWriteAdapter,
} = {}) {
  const repository = repositoryResolver(repositoryPath)
  if (repository.clean !== true) {
    fail('resolved repository identity is not a valid Git commit/tree')
  }
  if (config.repository.commit !== repository.commit || config.repository.tree !== repository.tree) {
    fail('caller-supplied repository identity does not match the resolved repository identity')
  }
  const preparation = {
    ...config.preparation,
    prepare_entry: resolveFile(repositoryPath, config.preparation.prepare_entry.path, 'prepare entry'),
    execute_entry: resolveFile(repositoryPath, config.preparation.execute_entry.path, 'execute entry'),
    manifest_schema: resolveFile(repositoryPath, config.preparation.manifest_schema.path, 'manifest schema'),
  }
  const ci = ciResolver(repositoryPath, config, repository)
  const npmExecutable = resolveExecutable(repositoryPath, 'npm')
  const npmVersion = command(repositoryPath, npmExecutable, ['--version']).replace(/^v/u, '')
  const wranglerVersion = command(repositoryPath, join(repositoryPath, 'node_modules', '.bin', 'wrangler'), ['--version'])
    .match(/([0-9]+\.[0-9]+\.[0-9]+)/u)?.[1]
  if (!wranglerVersion) fail('resolved Wrangler version is invalid')
  const packageJsonBytes = readFileSync(join(repositoryPath, 'package.json'))
  const lockfileBytes = readFileSync(join(repositoryPath, 'package-lock.json'))
  const lockfile = JSON.parse(lockfileBytes.toString('utf8'))
  const openNextVersion = lockfile.packages?.['node_modules/@opennextjs/cloudflare']?.version
  if (!openNextVersion) fail('resolved OpenNext version is missing')
  const toolchain = {
    ...config.toolchain,
    node: { version: process.versions.node, identity_sha256: sha256(readFileSync(process.execPath)) },
    npm: { version: npmVersion, identity_sha256: sha256(readFileSync(npmExecutable)) },
    wrangler: { version: wranglerVersion, identity_sha256: sha256(Buffer.from(wranglerVersion)) },
    opennextjs_cloudflare: { version: openNextVersion, identity_sha256: sha256(Buffer.from(openNextVersion)) },
    package_json_sha256: sha256(packageJsonBytes),
    lockfile_sha256: sha256(lockfileBytes),
  }
  const artifactPaths = enumerateArtifactPaths(repositoryPath, config.artifact.file_tree.files)
  const artifact = {
    ...config.artifact,
    archive: resolveFile(repositoryPath, config.artifact.archive.path, 'artifact archive', true),
    worker: resolveFile(repositoryPath, config.artifact.worker.path, 'worker artifact', true),
    file_tree: {
      ...config.artifact.file_tree,
      files: artifactPaths.map((path) => resolveFile(repositoryPath, path, 'artifact file', true)),
    },
  }
  const migration = {
    ...config.migration,
    reset_sql: resolveFile(repositoryPath, config.migration.reset_sql.path, 'reset SQL'),
    runner: resolveFile(repositoryPath, config.migration.runner.path, 'migration runner'),
    catalog: {
      ...config.migration.catalog,
      migrations: config.migration.catalog.migrations.map((entry) => ({
        ...entry,
        ...resolveFile(repositoryPath, entry.path, `migration ${entry.id}`),
      })),
    },
  }
  const catalogBytes = Buffer.from(command(repositoryPath, process.execPath, [
    join(repositoryPath, 'scripts', 'migrations.mjs'), 'catalog',
  ]))
  const resolvedCatalog = JSON.parse(catalogBytes.toString('utf8'))
  const configuredIds = config.migration.catalog.migrations.map((entry) => entry.id)
  const resolvedIds = resolvedCatalog.migrations.map((entry) => String(entry.number).padStart(3, '0'))
  if (JSON.stringify(configuredIds) !== JSON.stringify(resolvedIds)) {
    fail('resolved migration catalog does not match the configured migration set')
  }
  migration.catalog = {
    ...migration.catalog,
    sha256: sha256(catalogBytes),
    migrations: migration.catalog.migrations.map((entry, index) => ({
      ...entry,
      id: resolvedIds[index],
    })),
  }
  const target = targetResolver(config.target)
  const resolved = {
    ...config,
    preparation,
    repository: { ...config.repository, ...repository },
    ci,
    toolchain,
    artifact: { ...artifact, file_tree: { ...artifact.file_tree, sha256: sha256(Buffer.from(JSON.stringify(artifact.file_tree.files))) } },
    migration,
    target,
  }
  delete resolved.rehearsal
  const manifestDraftSha256 = sha256(Buffer.from(JSON.stringify(resolved)))
  const rehearsal = rehearsalRunner({ repositoryPath, manifestDraftSha256, productionWriteAdapter })
  if (rehearsal.production_write_adapter_calls !== 0) {
    fail('rehearsal observed a production-write adapter call')
  }
  return { ...resolved, target, rehearsal }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertPublicPath(path, label) {
  if (/(^|\/)(?:private|operator|secret|credential|tmp)(?:\/|$)/iu.test(path)) {
    fail(`${label} contains a private operator path`)
  }
}

function assertManifestRelationships(manifest) {
  if (manifest.repository.canonical !== 'nardinmarcus/blogman') {
    fail('repository.canonical must identify the canonical repository')
  }
  if (manifest.repository.remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('repository.remote must identify the canonical remote')
  }
  if (manifest.ci.head_sha !== manifest.repository.commit) {
    fail('ci.head_sha must equal repository.commit')
  }
  if (manifest.ci.tree !== manifest.repository.tree) {
    fail('ci.tree must equal repository.tree')
  }
  if (manifest.ci.conclusion !== 'success') {
    fail('ci.conclusion must be success')
  }

  const publicPaths = [
    ['preparation.prepare_entry.path', manifest.preparation.prepare_entry.path],
    ['preparation.execute_entry.path', manifest.preparation.execute_entry.path],
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
  for (const [label, path] of publicPaths) assertPublicPath(path, label)

  const filePaths = manifest.artifact.file_tree.files.map((file) => file.path)
  if (new Set(filePaths).size !== filePaths.length) {
    fail('artifact.file_tree.files must not contain duplicate paths')
  }
  if (!jsonEqual(filePaths, [...filePaths].sort())) {
    fail('artifact.file_tree.files must be ordered by public path')
  }

  const migrationIds = manifest.migration.catalog.migrations.map((migration) => migration.id)
  if (!jsonEqual(migrationIds, EXPECTED_MIGRATIONS)) {
    fail('migration.catalog.migrations must contain 001 through 006 in order')
  }

  if (manifest.target.baseline.d1_database_id !== manifest.target.d1_database_id) {
    fail('target.baseline.d1_database_id must equal target.d1_database_id')
  }
  if (manifest.target.baseline.traffic.length !== 1
    || manifest.target.baseline.traffic[0].version_id !== manifest.target.baseline.version_id
    || manifest.target.baseline.traffic[0].percentage !== 100) {
    fail('target.baseline.traffic must bind one 100% baseline version')
  }

  if (!jsonEqual(manifest.policy.stages, DEFAULT_STAGE_POLICY)) {
    fail('policy.stages must use the fixed Issue #23 order and timeouts')
  }
  if (!jsonEqual(manifest.policy.drift.frozen_preconditions, EXPECTED_FROZEN_PRECONDITIONS)) {
    fail('policy.drift.frozen_preconditions are not the Issue #23 set')
  }
  if (!jsonEqual(manifest.policy.drift.observations, EXPECTED_OBSERVATIONS)) {
    fail('policy.drift.observations are not the Issue #23 set')
  }
  if (!jsonEqual(manifest.policy.evidence.excluded, EXPECTED_EVIDENCE_EXCLUSIONS)) {
    fail('policy.evidence.excluded must name every prohibited value class')
  }
  if (manifest.rehearsal.runtime.node_version !== manifest.toolchain.node.version) {
    fail('rehearsal.runtime.node_version must equal toolchain.node.version')
  }
  if (manifest.rehearsal.production_write_adapter_calls !== 0) {
    fail('rehearsal must record zero production-write adapter calls')
  }
}

function validateManifestValue(value) {
  validateSchemaValue(value, MANIFEST_SCHEMA)
  assertManifestRelationships(value)
  return value
}

export function canonicalBytes(value) {
  validateManifestValue(value)
  const ordered = orderBySchema(value, MANIFEST_SCHEMA)
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

function assertUniqueJsonObjectKeys(json) {
  let index = 0

  function skipWhitespace() {
    while (index < json.length && /[ \t\n\r]/u.test(json[index])) index += 1
  }

  function scanString() {
    const start = index
    if (json[index] !== '"') throw new SyntaxError('expected JSON string')
    index += 1
    while (index < json.length) {
      if (json[index] === '"') {
        index += 1
        return JSON.parse(json.slice(start, index))
      }
      if (json[index] === '\\') index += 1
      index += 1
    }
    throw new SyntaxError('unterminated JSON string')
  }

  function scanPrimitive() {
    const start = index
    while (index < json.length && !',]} \t\n\r'.includes(json[index])) index += 1
    if (start === index) throw new SyntaxError('expected JSON value')
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
      if (json[index] !== ',') throw new SyntaxError('expected JSON array separator')
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError('unterminated JSON array')
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
      if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`)
      keys.add(key)
      skipWhitespace()
      if (json[index] !== ':') throw new SyntaxError('expected JSON object separator')
      index += 1
      scanValue()
      skipWhitespace()
      if (json[index] === '}') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError('expected JSON object separator')
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError('unterminated JSON object')
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
  if (index !== json.length) throw new SyntaxError('trailing JSON bytes')
}

function parseStrictJson(bytes) {
  const json = bytes.toString('utf8')
  if (!Buffer.from(json, 'utf8').equals(bytes)) fail('manifest bytes are not valid UTF-8')
  try {
    assertUniqueJsonObjectKeys(json)
    return JSON.parse(json)
  } catch (error) {
    fail(`manifest JSON is invalid: ${error.message}`)
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export function parseCanonicalManifest(bytes, expectedSha256) {
  const manifestBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes)
  if (typeof expectedSha256 !== 'string' || expectedSha256.length === 0) {
    fail('manifest identity is required')
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    fail('manifest identity has an invalid format')
  }
  if (sha256(manifestBytes) !== expectedSha256) {
    fail('manifest identity mismatch')
  }
  const value = parseStrictJson(manifestBytes)
  validateManifestValue(value)
  const canonical = canonicalBytes(value)
  if (!canonical.equals(manifestBytes)) {
    fail('manifest bytes are not canonical')
  }
  return value
}

function readProductionWriteCallCount(adapter) {
  if (adapter === undefined) return undefined
  if (!isRecord(adapter) || !Number.isSafeInteger(adapter.calls)) {
    fail('productionWriteAdapter must expose a safe integer calls counter')
  }
  return adapter.calls
}

function validateConfig(config) {
  validateSchemaValue(config, CONFIG_SCHEMA, '$.config')
  const manifest = { format: CANONICAL_MANIFEST_FORMAT, ...config }
  validateManifestValue(manifest)
  return orderBySchema(manifest, MANIFEST_SCHEMA)
}

export function prepare(config, options = {}) {
  const { productionWriteAdapter } = options
  const callsBefore = readProductionWriteCallCount(productionWriteAdapter)
  validateSchemaValue(config, CONFIG_SCHEMA, '$.config')
  const resolvedConfig = resolveFacts(config, options)
  const value = validateConfig(resolvedConfig)
  const bytes = canonicalBytes(value)
  const callsAfter = readProductionWriteCallCount(productionWriteAdapter)
  if (callsBefore !== undefined && callsAfter !== callsBefore) {
    fail('production-write adapter was called during read-only preparation')
  }
  return Object.freeze({
    value: deepFreeze(JSON.parse(bytes.toString('utf8'))),
    bytes,
    sha256: sha256(bytes),
  })
}

function readConfig(configPath) {
  const bytes = readFileSync(resolve(configPath))
  return parseStrictJson(bytes)
}

function runCli(argv) {
  const configIndex = argv.indexOf('--config')
  if (configIndex === -1 || !argv[configIndex + 1]) {
    throw new Error('Usage: node scripts/issue-23-delivery-prepare.mjs --config <path>')
  }
  const result = prepare(readConfig(argv[configIndex + 1]), { repositoryPath: REPO_ROOT })
  process.stdout.write(result.bytes)
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
